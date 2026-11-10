import {
  ASSISTANT_FOOTER,
  type AssistantItem,
  type ReplyItem,
  allergenAnswer,
  cleanText,
  deleet,
  normalizeText,
  scanLexicon,
} from "@/lib/allergen-router";
import type { MenuQaOutput } from "@/lib/menu-qa";

/**
 * Guardrails for the general-mode model answer (spec 12, guardrails 1 to 5). The model is never trusted: its answer
 * reaches a customer only if every check below passes, and any doubt about safety is answered by the deterministic
 * `allergenAnswer()` instead. Pure module (no database, no model).
 *
 *   1. The model flagged allergies or diets            -> allergenAnswer()
 *   2. The answer touches the allergen lexicon          -> allergenAnswer()
 *   3. The answer makes a safety claim (list below)     -> allergenAnswer()
 *      Also here: letters outside the Latin script, spaced-out letters and text that doesn't read as English, because
 *      the claim list is English and an answer in another language could slip past it.
 *   4. Refs must exist and be available (else dropped); prices must equal a referenced dish's price; links and
 *      unknown refs in the text are refused  -> neutral list of the referenced dishes with database prices
 *   5. The footer is part of every reply (`ASSISTANT_FOOTER`); the UI never colours or ticks anything.
 */

export type AssistantMode = "allergen" | "general" | "guardrail" | "demo";

export type AssistantReply = {
  mode: AssistantMode;
  /** Plain text. Render it as text, never as HTML or markdown. */
  answer: string;
  /** Dishes the answer is about, with names and prices from the database. */
  items: ReplyItem[];
  footer: string;
  /** True when the answer is a recorded demo answer rather than a live model's. */
  demo: boolean;
};

export type GuardContext = {
  question: string;
  /** Every non-archived dish, for the deterministic answer. */
  menu: readonly AssistantItem[];
  /** `M1..Mn` -> the available dish it names in this request's prompt. */
  refs: ReadonlyMap<string, AssistantItem>;
  demo: boolean;
  now?: Date;
};

/**
 * Safety-claim phrases, matched against `normalizeText()` output (lower case, no apostrophes or hyphens). Beyond the
 * spec's list this adds "free" on its own, the common translations of "free of"/"without", and a few ways of saying a
 * dish is fine to eat. The router lexicon ("safe", "free", "contain", "allerg" and the allergen words) is checked
 * separately and covers most of the same ground; keeping both is deliberate.
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bsafe/,
  /\bfree\b/,
  /\bno (?:\w+ ){0,2}(?:nuts?|peanuts?|dairy|milk|lactose|gluten|wheat|eggs?|soy|soya|sesame|fish|shellfish|shrimp|crab|seafood|allergens?|animal|traces?)/,
  /\b(?:has|have|had|with) no\b/,
  /\bnot made with\b/,
  /\bcontain/,
  /\bwithout\b/,
  /\bsuitable\b/,
  /\b(?:okay|ok|fine) (?:for|to)\b/,
  /\bfriendly\b/,
  /\bhypoallergenic/,
  /\bguarantee/,
  /\bcan eat\b/,
  /\bexclud/,
  /\bfrei\b|\blibre\b|\bsans\b|\bsin\b|\bohne\b|\bsenza\b|\bzonder\b|\bveilig\b|\bsicher|\bseguro|\bsegura|\bsem\b/,
];

/** True if `text` makes (or may make) a safety claim, in any of the forms normalisation folds together. */
export function containsSafetyClaim(text: string): boolean {
  const forms = [normalizeText(text), normalizeText(deleet(text.toLowerCase()))];
  return forms.some((n) => CLAIM_PATTERNS.some((re) => re.test(n)));
}

/** Four or more single characters in a row: "s a f e", "n 0 n u t s". */
const SPELLED_OUT = /(?:^| )[a-z0-9](?: [a-z0-9]){3,}(?: |$)/;

const ENGLISH_WORDS = new Set(
  ("the a an and or of to in on for with is are it its this that these those we you your our they there here have has can be any at by from as if so but not i me my what which some more most also ask staff menu dish dishes try like popular option options available about up all one two than under over per each serve serves served offer offers include includes made comes come really good very").split(" "),
);

/**
 * The claim list is English. Refuse text that is not plausibly English: any letter outside the Latin script (Cyrillic
 * look-alikes, CJK, Arabic), single letters spelled out ("s a f e"), or a sentence with almost no English function
 * words. A refusal falls back to the deterministic answer, so this errs toward refusing.
 */
export function looksLikeEnglishText(text: string): boolean {
  if (/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(text)) return false;
  const norm = normalizeText(text);
  if (SPELLED_OUT.test(norm) || SPELLED_OUT.test(normalizeText(deleet(text.toLowerCase())))) return false;
  const tokens = norm.split(" ").filter((t) => t && !/^\d+$/.test(t) && !/^m\d{1,3}$/.test(t));
  if (tokens.length < 6) return true;
  const known = tokens.filter((t) => ENGLISH_WORDS.has(t)).length;
  return known / tokens.length >= 0.15;
}

const REF_TOKEN = /\bM(\d{1,3})\b/gi;
const LINK = /https?:|www\.|\w\.(?:com|net|org|io|ai|co|app|dev)\b|@\w/i;

const MONEY_PATTERNS: readonly RegExp[] = [
  /[$€£]\s?(\d[\d,]*(?:\.\d+)?)/g,
  /(\d[\d,]*(?:\.\d+)?)\s?(?:dollars?|bucks|usd|eur|euros?|gbp|pounds?)\b/gi,
  /\b(?:usd|eur|gbp)\s?(\d[\d,]*(?:\.\d+)?)/gi,
  /\b(\d+\.\d{2})\b/g,
];
/** Spelled-out amounts ("fourteen dollars") can't be checked, and the menu is in dollars: refuse other currencies outright. */
const CURRENCY_WORD = /\b(?:dollars?|bucks|euros?|pounds?)\b/i;
const OTHER_CURRENCY = /[€£]|\b(?:eur|euros?|gbp|pounds?)\b/i;

/** Every price-like amount in the answer, in cents. */
export function amountsInCents(text: string): number[] {
  const out: number[] = [];
  for (const re of MONEY_PATTERNS) for (const m of text.matchAll(re)) out.push(Math.round(parseFloat(m[1].replace(/,/g, "")) * 100));
  return out;
}

const moneyText = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const toItem = (i: AssistantItem): ReplyItem => ({ id: i.id, name: cleanText(i.name), priceCents: i.priceCents });

function reply(mode: AssistantMode, answer: string, items: ReplyItem[], demo: boolean): AssistantReply {
  return { mode, answer, items, footer: ASSISTANT_FOOTER, demo };
}

/** The deterministic allergen answer as a reply. `mode` is "allergen" for a routed question, "guardrail" for a replaced model answer. */
export function allergenReply(question: string, menu: readonly AssistantItem[], mode: "allergen" | "guardrail", now?: Date): AssistantReply {
  const a = allergenAnswer(question, menu, { now, reason: mode === "guardrail" ? "guardrail" : "question" });
  return reply(mode, a.text, a.items, false);
}

function neutralReply(items: readonly AssistantItem[]): AssistantReply {
  const text = items.length
    ? `Here is what I found on the menu: ${items.map((i) => `${cleanText(i.name)} (${moneyText(i.priceCents)})`).join(", ")}. Ask staff about anything else.`
    : "I couldn't match that to specific dishes. Please browse the menu or ask staff.";
  return reply("guardrail", text, items.map(toItem), false);
}

/**
 * Turn the model's output into the reply the customer sees. Never throws; every failure path is a deterministic reply.
 * A demo answer (from the recorded fixture) goes through exactly the same checks.
 */
export function guardModelOutput(out: MenuQaOutput, ctx: GuardContext): AssistantReply {
  const replaceWithAllergenAnswer = () => allergenReply(ctx.question, ctx.menu, "guardrail", ctx.now);
  const raw = out.answer;

  // 1. The model says the question concerns allergies or diets.
  if (out.mentionsAllergyOrDiet) return replaceWithAllergenAnswer();
  // 2 and 3. Lexicon and claim filter on the answer; text the English-only filters can't read is refused too.
  if (!looksLikeEnglishText(raw) || scanLexicon(raw).hit || containsSafetyClaim(raw)) return replaceWithAllergenAnswer();

  // 4. Refs: the model's list is filtered to real, available dishes; refs written in the text must be real too.
  const listed = out.itemRefs.filter((r) => ctx.refs.has(r));
  const inText = [...raw.matchAll(REF_TOKEN)].map((m) => `M${Number(m[1])}`);
  const valid = [...new Set([...listed, ...inText.filter((r) => ctx.refs.has(r))])].map((r) => ctx.refs.get(r) as AssistantItem);
  if (inText.some((r) => !ctx.refs.has(r))) return neutralReply(valid);
  if (LINK.test(raw)) return neutralReply(valid);

  const amounts = amountsInCents(raw);
  const prices = new Set(valid.map((i) => i.priceCents));
  if (OTHER_CURRENCY.test(raw) || amounts.some((c) => !prices.has(c)) || (amounts.length === 0 && CURRENCY_WORD.test(raw))) return neutralReply(valid);

  const text = cleanText(raw.replace(REF_TOKEN, (_m, n: string) => ctx.refs.get(`M${Number(n)}`)?.name ?? ""));
  if (!text) return neutralReply(valid);
  return reply(ctx.demo ? "demo" : "general", text, valid.slice(0, 5).map(toItem), ctx.demo);
}
