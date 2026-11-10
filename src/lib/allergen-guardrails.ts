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
 * The claim filter is a refusal list, not a denylist of known phrases: a general answer that contains ANY negation or
 * reassurance token falls back to the deterministic answer. A false refusal costs nothing; a missed claim is the
 * failure this whole feature exists to prevent. Tokens are matched on `normalizeText()` output (lower case, no
 * apostrophes, so "isn't" is "isnt"), in English, French, German, Spanish and Italian.
 */
const REFUSAL_TOKENS = new Set(
  ("no not none nothing zero never lacks lack skips skip without free fine ok okay worry worries worried worrying harmless trouble clean safe unsafe " +
    "pas keine kein non nicht sin ningun senza sans less nor nobody neither isnt arent wasnt werent dont doesnt didnt wont wouldnt cant cannot couldnt shouldnt " +
    "hasnt havent hadnt mustnt neednt ohne libre seguro segura sicher frei zonder veilig sem youll youre").split(" "),
);
/** Token prefixes: "worr" (worry, worried), "safe" (safely, safety), "reassur", "harmless". */
const REFUSAL_PREFIXES = ["safe", "worr", "harmless", "reassur", "gentle", "sensitiv", "tummy", "tummies", "guarantee", "hypoallerg", "suitab", "exclud", "omit", "contain", "friendly"];
/** Phrases that reassure without a refusal token. */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bno (?:\w+ ){0,2}(?:nuts?|peanuts?|dairy|milk|lactose|gluten|wheat|eggs?|soy|soya|sesame|fish|shellfish|shrimp|crab|seafood|allergens?|animal|traces?)/,
  /\b(?:good|great|perfect|ideal|right|fine|okay|ok) (?:for|to|if)\b/,
  /\b(?:for|with) you\b/,
  /\byou (?:can|will|may)\b/,
  /\bcan eat\b/,
  /\bhave nothing\b/,
];

/** True if `text` makes (or may make) a safety claim or any reassurance, in any of the forms normalisation folds together. */
export function containsSafetyClaim(text: string): boolean {
  const forms = [normalizeText(text), normalizeText(deleet(text.toLowerCase()))];
  return forms.some((n) => {
    if (CLAIM_PATTERNS.some((re) => re.test(n))) return true;
    return n.split(" ").some((t) => REFUSAL_TOKENS.has(t) || t.endsWith("free") || REFUSAL_PREFIXES.some((p) => t.startsWith(p)));
  });
}

/** Four or more single characters in a row: "s a f e", "n 0 n u t s". */
const SPELLED_OUT = /(?:^| )[a-z0-9](?: [a-z0-9]){3,}(?: |$)/;

const ENGLISH_WORDS = new Set(
  ("the a an and or of to in on for with is are it its this that these those we you your our they there here have has can be any at by from as if so but i me my what which some more most also ask staff menu dish dishes try like popular option options available about up all one two than under over per each serve serves served offer offers include includes made comes come really good very cost costs price priced spicy hot mild kids lunch dinner drink drinks dessert starter side special specials best favourite favorite tasty delicious hearty fresh crispy cheap cheapest pick picks choice").split(" "),
);

/** ASCII letters, digits and punctuation, plus the usual typographic quotes and dashes. Nothing else may reach a customer from a model. */
const PLAIN_ASCII = /^[\x20-\x7e\n\t‘’“”–—… ]*$/;

/**
 * The claim list is English, so a model answer must be plain ASCII English or it is refused: no accented or non-Latin
 * letters (look-alikes, other languages), no spelled-out letters ("s a f e"), and every answer, however short, needs
 * some English function words.
 */
export function looksLikeEnglishText(text: string): boolean {
  if (!PLAIN_ASCII.test(text)) return false;
  const norm = normalizeText(text);
  if (SPELLED_OUT.test(norm) || SPELLED_OUT.test(normalizeText(deleet(text.toLowerCase())))) return false;
  const tokens = norm.split(" ").filter((t) => t && !/^\d+$/.test(t) && !/^m\d{1,3}$/.test(t));
  if (tokens.length === 0) return true;
  return tokens.filter((t) => ENGLISH_WORDS.has(t)).length / tokens.length >= 0.15;
}

const REF_TOKEN = /\bM(\d{1,3})\b/gi;
const LINK = /https?:|www\.|\w\.(?:com|net|org|io|ai|co|app|dev)\b|@\w|\bdot\s*(?:com|net|org|io|ai|co|app|dev)\b|\bat\s+\w+\s+dot\b/i;
const NUMBER_WORDS = /\b(?:dollars?|bucks?|cents?|euros?|pounds?|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|fiver|tenner|quid)\b/i;
const SPELLED_DIGITS = /\b(?:(?:oh|zero|one|two|three|four|five|six|seven|eight|nine)[ -]+){3,}/i;

const MONEY_PATTERNS: readonly RegExp[] = [
  /[$€£]\s?(\d[\d,]*(?:\.\d+)?)/g,
  /(\d[\d,]*(?:\.\d+)?)\s?(?:dollars?|bucks|usd|eur|euros?|gbp|pounds?)\b/gi,
  /\b(?:usd|eur|gbp)\s?(\d[\d,]*(?:\.\d+)?)/gi,
  /\b(\d+\.\d{2})\b/g,
];
const OTHER_CURRENCY = /[€£]|\b(?:eur|euros?|gbp|pounds?)\b/i;

/** Every price-like amount in the answer, in cents. */
export function amountsInCents(text: string): number[] {
  const out: number[] = [];
  for (const re of MONEY_PATTERNS) for (const m of text.matchAll(re)) out.push(Math.round(parseFloat(m[1].replace(/,/g, "")) * 100));
  return out;
}

/** A capitalised word in the middle of a sentence is probably a dish name the model made up: refuse. */
function hasInventedName(text: string): boolean {
  const words = text.split(/\s+/);
  return words.some((w, i) => {
    if (i === 0 || /[.!?:]["')]*$/.test(words[i - 1]) || w === "I") return false;
    return /^[("']?[A-Z][a-z]/.test(w);
  });
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
 * A demo answer (from the recorded fixture) goes through exactly the same checks. The claim checks run twice: on the
 * model's text, and again on the FINAL text after dish names are substituted for refs, so a dish called
 * "Gluten-Free Rice Bowl" can't smuggle a claim in. A dish name that merely contains an allergen word ("Peanut Butter
 * Brownie") is fine: the lexicon runs on the model's text only.
 */
export function guardModelOutput(out: MenuQaOutput, ctx: GuardContext): AssistantReply {
  const replaceWithAllergenAnswer = () => allergenReply(ctx.question, ctx.menu, "guardrail", ctx.now);
  // What the customer would see if nothing else changed: angle brackets and control characters gone, so "sa<fe" is "safe".
  const cleaned = cleanText(out.answer);

  // 1. The model says the question concerns allergies or diets.
  if (out.mentionsAllergyOrDiet) return replaceWithAllergenAnswer();
  // 2 and 3. English-only plain text, the allergen lexicon, and the refusal filter, on the raw and the cleaned text.
  for (const text of [out.answer, cleaned]) {
    if (!looksLikeEnglishText(text) || scanLexicon(text).hit || containsSafetyClaim(text)) return replaceWithAllergenAnswer();
  }

  // 4. Refs: the model's list is filtered to real, available dishes; refs written in the text must be real too, and
  // there must be at least one, so the answer is about dishes that exist.
  const listed = out.itemRefs.filter((r) => ctx.refs.has(r));
  const inText = [...cleaned.matchAll(REF_TOKEN)].map((m) => `M${Number(m[1])}`);
  const valid = [...new Set([...listed, ...inText.filter((r) => ctx.refs.has(r))])].map((r) => ctx.refs.get(r) as AssistantItem);
  if (inText.length === 0 || inText.some((r) => !ctx.refs.has(r))) return neutralReply(valid);
  if (LINK.test(cleaned) || NUMBER_WORDS.test(cleaned) || SPELLED_DIGITS.test(cleaned) || hasInventedName(cleaned)) return neutralReply(valid);

  // Digits: only refs and exact menu prices of the referenced dishes may appear.
  const prices = new Set(valid.map((i) => i.priceCents));
  if (OTHER_CURRENCY.test(cleaned) || amountsInCents(cleaned).some((c) => !prices.has(c))) return neutralReply(valid);
  let rest = cleaned.replace(REF_TOKEN, " ");
  for (const re of MONEY_PATTERNS) rest = rest.replace(re, " ");
  if (/\d/.test(rest)) return neutralReply(valid);

  const final = cleanText(cleaned.replace(REF_TOKEN, (_m, n: string) => ctx.refs.get(`M${Number(n)}`)?.name ?? ""));
  if (!final) return neutralReply(valid);
  // The final text, with the dish names in it, must still be free of claims.
  if (containsSafetyClaim(final)) return replaceWithAllergenAnswer();
  return reply(ctx.demo ? "demo" : "general", final, valid.slice(0, 5).map(toItem), ctx.demo);
}
