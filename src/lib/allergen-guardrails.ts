import {
  ASSISTANT_FOOTER,
  type AssistantItem,
  type ReplyItem,
  allergenAnswer,
  cleanText,
  deleet,
  normalizeText,
} from "@/lib/allergen-router";
import type { MenuQaOutput, MenuQaReason } from "@/lib/menu-qa";

/**
 * What a customer can receive from a general-mode (model) answer, and nothing else. The model's output is only
 * `{refs, reason}` (menu-qa.ts): the server writes the reply from a fixed template per reason, with dish names and
 * prices from the database. So no free model text ever reaches a customer, and there is no claim filter to defeat.
 *
 *   - refs must exist and be available, at most 3, and obey what the question says (a price cap) or the reason says
 *     (spicy needs the spicy tag); anything else is dropped;
 *   - a dish whose own name reads as a claim ("Gluten-Free Rice Bowl", "Nut Free Brownie") is dropped;
 *   - the reply always says "Ask staff about allergies." and carries the footer; the UI never colours or ticks anything.
 * Everything about allergies, diets and ingredients is answered by `allergenAnswer()` and never gets here: the router
 * only lets a question through when every word is on a fixed general vocabulary. Pure module (no database, no model).
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


const toItem = (i: AssistantItem): ReplyItem => ({ id: i.id, name: cleanText(i.name), priceCents: i.priceCents });
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export function reply(mode: AssistantMode, answer: string, items: ReplyItem[], demo: boolean): AssistantReply {
  return { mode, answer, items, footer: ASSISTANT_FOOTER, demo };
}

/** The deterministic allergen answer as a reply. `mode` is "allergen" for a routed question, "guardrail" for a refusal. */
export function allergenReply(question: string, menu: readonly AssistantItem[], mode: "allergen" | "guardrail", now?: Date): AssistantReply {
  const a = allergenAnswer(question, menu, { now, reason: mode === "guardrail" ? "guardrail" : "question" });
  return reply(mode, a.text, a.items, false);
}

/** Every sentence a general answer can contain besides dish names and prices. The property test pins this set. */
export const GENERAL_TEMPLATES: Record<MenuQaReason, string> = {
  popular: "Popular picks",
  spicy: "Spicy picks",
  mild_heat: "Milder picks",
  budget: "Budget picks",
  quick: "Quick picks",
  kid_friendly: "Picks to try with kids",
  shareable: "Dishes to share",
  dessert: "Dessert picks",
  drink: "Drink picks",
  other: "Dishes you might like",
};
export const GENERAL_CLOSING = "Ask staff about allergies.";
export const DEMO_PREFIX = "Demo answer (recorded sample).";
export const NO_MATCH_TEXT = "I couldn't find a good match for that. Please browse the menu or ask staff.";

/** "under $15", "below 12", "less than $9.50", "$15 or less": a price cap in cents, from the customer's question only. */
export function priceCapCents(question: string): number | null {
  const q = question.toLowerCase();
  const m = q.match(/(?:under|below|less than|up to|within|max(?:imum)?|cheaper than)\s*\$?\s*(\d{1,4}(?:\.\d{1,2})?)/) ?? q.match(/\$\s*(\d{1,4}(?:\.\d{1,2})?)\s*(?:or less|or under|max)/);
  return m ? Math.round(parseFloat(m[1]) * 100) : null;
}

/**
 * Render a general-mode answer. Never throws, never returns model text. A demo answer (the recorded fixture, same
 * `{refs, reason}` shape) goes through exactly the same code.
 */
export function renderGeneral(out: MenuQaOutput, ctx: GuardContext): AssistantReply {
  const cap = priceCapCents(ctx.question);
  const picked: AssistantItem[] = [];
  for (const ref of out.refs) {
    const item = ctx.refs.get(ref);
    if (!item || picked.includes(item)) continue;
    if (cap !== null && item.priceCents > cap) continue;
    if (out.reason === "spicy" && !item.dietaryTags.includes("spicy")) continue;
    // A dish whose own name reads as a claim is not suggested.
    if (containsSafetyClaim(cleanText(item.name))) continue;
    picked.push(item);
    if (picked.length === 3) break;
  }
  if (picked.length === 0) return reply("guardrail", NO_MATCH_TEXT, [], false);
  const heading = GENERAL_TEMPLATES[out.reason] + (cap !== null ? ` under ${money(cap)}` : "");
  const list = picked.map((i) => `${cleanText(i.name)} (${money(i.priceCents)})`).join(", ");
  const text = `${ctx.demo ? `${DEMO_PREFIX} ` : ""}${heading}: ${list}. ${GENERAL_CLOSING}`;
  return reply(ctx.demo ? "demo" : "general", text, picked.map(toItem), ctx.demo);
}
