import { ALLERGENS, type Allergen, type AllergenLevel } from "@/lib/db/schema";
import { expandAllergens, verificationStatus } from "@/lib/order-rules";

/**
 * The allergen router and the deterministic allergen answer (spec 12, "AI feature").
 *
 * Safety design, in one place:
 * - A question that touches allergens, intolerances, diets or safety words never reaches a model. `routeQuestion`
 *   decides, from a fixed lexicon, using only string matching. It over-routes on purpose: a false "allergen" costs the
 *   customer one extra "ask staff"; a false "general" could put a model in front of an allergy question.
 * - `allergenAnswer` builds the whole answer from the structured declarations. It lists dishes that contain or may
 *   contain what was asked about, never dishes that are "safe", "free of" or "suitable", and always ends with the
 *   fixed notice. Anything ambiguous or outside the ten-value allergen list says "ask staff".
 * - The same lexicon is run over every model answer (allergen-guardrails.ts), so one list governs both directions.
 *
 * Pure module: no database, no model, no logging. Question text is never logged here or anywhere else.
 */

export const ALLERGEN_LABEL: Record<Allergen, string> = {
  milk: "milk",
  egg: "egg",
  fish: "fish",
  crustacean_shellfish: "shellfish",
  tree_nuts: "tree nuts",
  peanuts: "peanuts",
  wheat: "wheat",
  soy: "soy",
  sesame: "sesame",
  gluten: "gluten",
};

export const ASSISTANT_FOOTER = "Allergies? Ask staff before ordering.";
export const SPEAK_WITH_STAFF = "Please speak with staff before ordering.";

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Lower-case, fold accents and compatibility forms (full-width letters, ligatures), drop invisible format characters
 * (zero-width joiners and the like), remove apostrophes ("doesn't" becomes "doesnt"), and turn every other run of
 * punctuation into one space. The result is the only form the lexicon and the claim filter ever look at.
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
/** "p3anut", "gl uten" and "s@fe" are read the way a person would read them. */
export const deleet = (s: string): string => s.replace(/[013457@$]/g, (c) => LEET[c]);

/** Optimal-string-alignment edit distance (insert, delete, substitute, swap neighbours). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// ---------------------------------------------------------------------------
// The lexicon
// ---------------------------------------------------------------------------

type Term = {
  /** Already normalised: lower case, no punctuation. */
  t: string;
  /** Which of the ten allergens the term asks about. Empty for general safety words ("safe", "allergic"). */
  a?: readonly Allergen[];
  /** Words that mean the customer may be at serious risk (spec: anaphyla, epipen, severe, celiac). */
  severe?: boolean;
  /** Match inside a word too, not only at its start. For long, distinctive stems ("allerg" in "hypoallergenic"). */
  anywhere?: boolean;
  /** Also match a token one typo away (two for 9+ letters): "penut", "glutten", "shelfish". Terms of 6+ letters only. */
  fuzzy?: boolean;
  /** Also match with all spaces removed ("pea nut", "p e a n u t"). Distinctive 6+ letter terms only. */
  compact?: boolean;
};

const NUTS: readonly Allergen[] = ["tree_nuts", "peanuts"];
const ANIMAL: readonly Allergen[] = ["milk", "egg", "fish", "crustacean_shellfish"];

/**
 * Spec lexicon plus the misspellings and synonyms customers actually type. Terms match at the start of a word, so
 * "nut" catches "nuts" and "nutty" but not "minutes". Matching is a deliberate over-reach; see the module comment.
 */
const LEXICON: readonly Term[] = [
  // milk
  { t: "dairy", a: ["milk"] }, { t: "diary", a: ["milk"] }, { t: "dairi", a: ["milk"] }, { t: "lactose", a: ["milk"], fuzzy: true, compact: true },
  { t: "lactos", a: ["milk"] }, { t: "milk", a: ["milk"] }, { t: "cheese", a: ["milk"], fuzzy: true }, { t: "butter", a: ["milk"] },
  { t: "cream", a: ["milk"] }, { t: "yogurt", a: ["milk"] }, { t: "yoghurt", a: ["milk"] }, { t: "whey", a: ["milk"] }, { t: "casein", a: ["milk"] }, { t: "ghee", a: ["milk"] },
  // egg
  { t: "egg", a: ["egg"] }, { t: "mayo", a: ["egg"] },
  // fish
  { t: "fish", a: ["fish"] }, { t: "anchov", a: ["fish"] }, { t: "salmon", a: ["fish"] }, { t: "tuna", a: ["fish"] }, { t: "sardine", a: ["fish"] },
  // shellfish (spec names crustacean_shellfish only; molluscs are mapped there too, which over-warns)
  { t: "shrimp", a: ["crustacean_shellfish"], fuzzy: true, compact: true }, { t: "prawn", a: ["crustacean_shellfish"] }, { t: "crab", a: ["crustacean_shellfish"] },
  { t: "lobster", a: ["crustacean_shellfish"], fuzzy: true }, { t: "shellfish", a: ["crustacean_shellfish"], fuzzy: true, compact: true }, { t: "shelfish", a: ["crustacean_shellfish"] },
  { t: "crustacean", a: ["crustacean_shellfish"], fuzzy: true, compact: true }, { t: "crawfish", a: ["crustacean_shellfish"] }, { t: "crayfish", a: ["crustacean_shellfish"] },
  { t: "clam", a: ["crustacean_shellfish"] }, { t: "oyster", a: ["crustacean_shellfish"] }, { t: "mussel", a: ["crustacean_shellfish"] }, { t: "scallop", a: ["crustacean_shellfish"] },
  { t: "seafood", a: ["fish", "crustacean_shellfish"] },
  // nuts: the bare word "nut" means tree nuts and peanuts both
  { t: "nut", a: NUTS }, { t: "almond", a: ["tree_nuts"], fuzzy: true }, { t: "cashew", a: ["tree_nuts"], fuzzy: true }, { t: "walnut", a: ["tree_nuts"], fuzzy: true },
  { t: "pecan", a: ["tree_nuts"] }, { t: "pistachio", a: ["tree_nuts"], fuzzy: true, compact: true }, { t: "hazelnut", a: ["tree_nuts"], fuzzy: true, compact: true },
  { t: "macadamia", a: ["tree_nuts"], fuzzy: true }, { t: "coconut", a: ["tree_nuts"] },
  { t: "peanut", a: ["peanuts"], fuzzy: true, compact: true }, { t: "penut", a: ["peanuts"] }, { t: "groundnut", a: ["peanuts"] },
  // wheat and gluten (linked by RELATED_ALLERGENS, applied when answering)
  { t: "wheat", a: ["wheat"] }, { t: "wheet", a: ["wheat"] }, { t: "whaet", a: ["wheat"] }, { t: "flour", a: ["wheat"] },
  { t: "gluten", a: ["gluten"], fuzzy: true, compact: true }, { t: "glutten", a: ["gluten"] }, { t: "gluton", a: ["gluten"] }, { t: "gluteen", a: ["gluten"] },
  { t: "celiac", a: ["gluten"], severe: true, fuzzy: true, compact: true }, { t: "coeliac", a: ["gluten"], severe: true, fuzzy: true, compact: true },
  { t: "celiak", a: ["gluten"], severe: true }, { t: "seliac", a: ["gluten"], severe: true },
  // soy
  { t: "soy", a: ["soy"] }, { t: "soya", a: ["soy"] }, { t: "tofu", a: ["soy"] },
  // sesame
  { t: "sesame", a: ["sesame"], fuzzy: true, compact: true }, { t: "sesme", a: ["sesame"] }, { t: "tahini", a: ["sesame"], fuzzy: true },
  // diets that imply animal products
  { t: "vegan", a: ANIMAL },
  // allergy and intolerance words
  { t: "allerg", anywhere: true, compact: true }, { t: "alerg" }, { t: "allergic", fuzzy: true }, { t: "allergy", fuzzy: true }, { t: "allergen", fuzzy: true },
  { t: "intoleran", anywhere: true }, { t: "intolerant", fuzzy: true }, { t: "sensitiv" }, { t: "reaction", anywhere: true },
  // severity
  { t: "anaphyla", severe: true, anywhere: true, compact: true }, { t: "epipen", severe: true, fuzzy: true, compact: true }, { t: "epi pen", severe: true },
  { t: "severe", severe: true }, { t: "life threatening", severe: true }, { t: "deadly", severe: true }, { t: "fatal", severe: true }, { t: "hospital", severe: true }, { t: "emergency", severe: true },
  // claims customers ask for and models must not make
  { t: "safe" }, { t: "unsafe" }, { t: "free" }, { t: "contain" }, { t: "cross contact" }, { t: "cross contamination" }, { t: "crosscontact" },
];

export type Scan = { hit: boolean; allergens: Allergen[]; severe: boolean };

const compactOf = (s: string) => s.replace(/ /g, "");

/** Run the lexicon over one normalised string. */
function scanOne(norm: string, found: Set<Allergen>, flags: { hit: boolean; severe: boolean }) {
  if (!norm) return;
  const padded = ` ${norm}`;
  const tokens = norm.split(" ");
  const compact = compactOf(norm);
  for (const term of LEXICON) {
    let matched = term.anywhere ? norm.includes(term.t) : padded.includes(` ${term.t}`);
    if (!matched && term.compact && term.t.length >= 6) matched = compact.includes(compactOf(term.t));
    if (!matched && term.fuzzy && term.t.length >= 6) {
      const max = term.t.length >= 9 ? 2 : 1;
      matched = tokens.some((tok) => tok.length >= 5 && tok[0] === term.t[0] && Math.abs(tok.length - term.t.length) <= max && editDistance(tok, term.t) <= max);
    }
    if (!matched) continue;
    flags.hit = true;
    if (term.severe) flags.severe = true;
    for (const a of term.a ?? []) found.add(a);
  }
}

/**
 * Match `text` against the lexicon. Reads the text twice, as typed and with digit and symbol look-alikes undone, and
 * reports the union. `hit` is true for any lexicon term, including safety words with no allergen ("safe", "free").
 */
export function scanLexicon(text: string): Scan {
  const found = new Set<Allergen>();
  const flags = { hit: false, severe: false };
  scanOne(normalizeText(text), found, flags);
  const lowered = text.toLowerCase();
  const leet = normalizeText(deleet(lowered));
  if (leet !== normalizeText(lowered)) scanOne(leet, found, flags);
  return { hit: flags.hit, allergens: ALLERGENS.filter((a) => found.has(a)), severe: flags.severe };
}

export type Route = { mode: "allergen" | "general"; allergens: Allergen[]; severe: boolean };

/** The router: lexicon hit means allergen mode, otherwise general mode. Deterministic and offline. */
export function routeQuestion(question: string): Route {
  const scan = scanLexicon(question);
  return { mode: scan.hit ? "allergen" : "general", allergens: scan.allergens, severe: scan.severe };
}

/** True when `text` (a question or a model answer) touches anything in the lexicon. */
export function touchesAllergens(text: string): boolean {
  return scanLexicon(text).hit;
}

// ---------------------------------------------------------------------------
// The deterministic answer
// ---------------------------------------------------------------------------

/** What the answer functions need to know about a dish. `PublicMenuItem` satisfies it. */
export type AssistantItem = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  dietaryTags: readonly string[];
  soldOut: boolean;
  allergens: readonly { allergen: Allergen; level: AllergenLevel }[];
  allergensVerifiedAt: string | null;
};

export type ReplyItem = { id: string; name: string; priceCents: number };

export type AllergenAnswer = { text: string; items: ReplyItem[]; severe: boolean; allergens: Allergen[] };

/** Names come from staff-edited data; keep them plain text. */
export const cleanText = (s: string): string => s.replace(/[<>]/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

const toReplyItem = (i: AssistantItem): ReplyItem => ({ id: i.id, name: cleanText(i.name), priceCents: i.priceCents });

const NAME_STOPWORDS = new Set(["the", "and", "with", "a", "of", "in", "on", "for", "to"]);

/** Dishes the question names: the whole name appears, or every significant word of it does. */
export function namedItems(question: string, items: readonly AssistantItem[]): AssistantItem[] {
  const q = ` ${normalizeText(question)} `;
  const qTokens = new Set(q.trim().split(" "));
  return items.filter((item) => {
    const name = normalizeText(item.name);
    if (!name) return false;
    if (q.includes(` ${name} `) || q.includes(` ${name}s `)) return true;
    const words = name.split(" ").filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
    return words.length >= 2 && words.every((w) => qTokens.has(w) || qTokens.has(`${w}s`));
  });
}

function joinList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
const labels = (as: readonly Allergen[]): string => joinList(as.map((a) => ALLERGEN_LABEL[a]));
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export function allergenCoverageLine(): string {
  return `Our menu data covers only ${joinList(ALLERGENS.map((a) => ALLERGEN_LABEL[a]))}. For any other allergen, please ask staff.`;
}

/** The fixed notice every allergen answer ends with. Names every allergen declared anywhere on the menu. */
export function staffNotice(items: readonly AssistantItem[]): string {
  const declared = new Set<Allergen>();
  for (const i of items) for (const d of i.allergens) declared.add(d.allergen);
  const list = declared.size ? labels(ALLERGENS.filter((a) => declared.has(a))) : "common food allergens";
  return `We can't guarantee any dish is free of an allergen. Our kitchen handles ${list}, and cross-contact can happen. Please tell staff about your allergy before ordering, and use the allergy question at checkout.`;
}

type Hit = { allergen: Allergen; level: AllergenLevel };

/** Declarations on `item` that match what was asked, including related allergens (wheat and gluten). */
function hitsFor(item: AssistantItem, asked: ReadonlySet<Allergen>): Hit[] {
  return item.allergens.filter((d) => asked.has(d.allergen)).map((d) => ({ allergen: d.allergen, level: d.level }));
}

const isCurrent = (item: AssistantItem, now: Date): boolean => verificationStatus(item.allergensVerifiedAt ? new Date(item.allergensVerifiedAt) : null, now) === "current";

const uniq = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];
const byAllergenOrder = (xs: readonly Allergen[]): Allergen[] => ALLERGENS.filter((a) => xs.includes(a));

/**
 * Build the allergen answer from the structured declarations only. No model is involved, and nothing here ever
 * calls a dish safe, free of anything, or suitable: it lists dishes that contain or may contain what was asked, says
 * when a dish's data is unchecked, and finishes with the fixed notice.
 *
 * - Named dishes (by name) get their own lines; otherwise every dish on the menu is considered.
 * - Dishes whose declarations are unverified (no stamp, or older than 90 days) say "ask staff".
 * - Severe words lead with "Please speak with staff before ordering." and name only dishes that contain the allergen;
 *   cross-contact ("may contain") is still stated, as a count, without naming those dishes.
 * - No recognisable allergen (or one outside the list): ask staff, and list nothing but the named dish's declarations.
 *
 * `reason: "guardrail"` is used when a model answer was discarded; it only changes the wording when no allergen was named.
 */
export function allergenAnswer(
  question: string,
  menu: readonly AssistantItem[],
  opts: { now?: Date; reason?: "question" | "guardrail" } = {},
): AllergenAnswer {
  const now = opts.now ?? new Date();
  const scan = scanLexicon(question);
  const asked = scan.allergens;
  const askedSet = expandAllergens(asked);
  const severe = scan.severe;
  const named = namedItems(question, menu).slice(0, 8);
  const lines: string[] = [];
  const listed: AssistantItem[] = [];
  const staleLine = "Allergen information for some dishes hasn't been checked recently: ask staff.";

  if (severe || asked.length === 0) lines.push(SPEAK_WITH_STAFF);

  if (asked.length === 0) {
    lines.push(
      opts.reason === "guardrail"
        ? "I can't answer that one reliably. For anything about allergies or ingredients, please ask staff."
        : "I can't tell from your question which allergen you mean, so I can't say what is in our dishes.",
    );
    if (!severe) {
      for (const item of named) {
        const declared = item.allergens;
        const contains = byAllergenOrder(declared.filter((d) => d.level === "contains").map((d) => d.allergen));
        const may = byAllergenOrder(declared.filter((d) => d.level === "may_contain").map((d) => d.allergen));
        const name = cleanText(item.name);
        if (contains.length) lines.push(`${name}: contains ${labels(contains)}.`);
        if (may.length) lines.push(`${name}: may contain ${labels(may)} (cross-contact).`);
        if (!contains.length && !may.length && isCurrent(item, now)) lines.push(`No allergens are listed for ${name} in our menu data. That isn't a guarantee: please ask staff.`);
        if (!isCurrent(item, now)) lines.push(`Allergen information for ${name} hasn't been checked recently: ask staff.`);
        listed.push(item);
      }
    }
  } else if (named.length > 0) {
    if (!severe) {
      for (const item of named) {
        const name = cleanText(item.name);
        const hits = hitsFor(item, askedSet);
        const contains = byAllergenOrder(hits.filter((h) => h.level === "contains").map((h) => h.allergen));
        const may = byAllergenOrder(hits.filter((h) => h.level === "may_contain" && !contains.includes(h.allergen)).map((h) => h.allergen));
        if (contains.length) lines.push(`${name}: contains ${labels(contains)}.`);
        if (may.length) lines.push(`${name}: may contain ${labels(may)} (cross-contact).`);
        if (!contains.length && !may.length && isCurrent(item, now)) {
          const noun = asked.length > 1 ? "aren't" : "isn't";
          lines.push(`${capitalise(labels(asked))} ${noun} listed for ${name} in our menu data. That isn't a guarantee: please ask staff.`);
        }
        if (!isCurrent(item, now)) lines.push(`Allergen information for ${name} hasn't been checked recently: ask staff.`);
        listed.push(item);
      }
    } else {
      // Severe: dish names only when the dish contains the allergen.
      const containing = named.filter((i) => hitsFor(i, askedSet).some((h) => h.level === "contains"));
      const mayOnly = named.filter((i) => !containing.includes(i) && hitsFor(i, askedSet).length > 0);
      const none = named.filter((i) => hitsFor(i, askedSet).length === 0);
      for (const item of containing) {
        const contains = byAllergenOrder(hitsFor(item, askedSet).filter((h) => h.level === "contains").map((h) => h.allergen));
        lines.push(`${cleanText(item.name)}: contains ${labels(contains)}.`);
        listed.push(item);
      }
      if (mayOnly.length) lines.push(`${mayOnly.length === 1 ? "The dish you asked about" : `${mayOnly.length} of the dishes you asked about`} may contain ${labels(asked)} through cross-contact: ask staff.`);
      if (none.some((i) => isCurrent(i, now))) lines.push(`${capitalise(labels(asked))} ${asked.length > 1 ? "aren't" : "isn't"} listed for the other dish${none.length === 1 ? "" : "es"} in our menu data. That isn't a guarantee: please ask staff.`);
      if (named.some((i) => !isCurrent(i, now))) lines.push(staleLine);
    }
  } else {
    // No dish named: every dish on the menu, grouped by what it declares.
    const withHits = menu.map((item) => ({ item, hits: hitsFor(item, askedSet) })).filter((x) => x.hits.length > 0);
    const present = byAllergenOrder(uniq(withHits.flatMap((x) => x.hits.map((h) => h.allergen))));
    for (const allergen of present) {
      const contain = withHits.filter((x) => x.hits.some((h) => h.allergen === allergen && h.level === "contains")).map((x) => x.item);
      const may = withHits.filter((x) => !contain.includes(x.item) && x.hits.some((h) => h.allergen === allergen && h.level === "may_contain")).map((x) => x.item);
      const mark = (i: AssistantItem) => (isCurrent(i, now) ? cleanText(i.name) : `${cleanText(i.name)} (allergen information not checked recently: ask staff)`);
      if (contain.length) {
        lines.push(`Dishes that contain ${ALLERGEN_LABEL[allergen]}: ${contain.map(mark).join(", ")}.`);
        listed.push(...contain);
      }
      if (may.length) {
        if (severe) lines.push(`${may.length} other dish${may.length === 1 ? "" : "es"} may contain ${ALLERGEN_LABEL[allergen]} through cross-contact: ask staff which.`);
        else {
          lines.push(`Dishes that may contain ${ALLERGEN_LABEL[allergen]} (cross-contact): ${may.map(mark).join(", ")}.`);
          listed.push(...may);
        }
      }
    }
    if (withHits.length === 0) {
      lines.push(`No dish on our menu is declared to contain or may contain ${labels(asked)}. That isn't a guarantee: please ask staff.`);
    }
    if (menu.some((i) => !isCurrent(i, now))) lines.push(staleLine);
  }

  lines.push(allergenCoverageLine());
  lines.push(staffNotice(menu));
  const items = uniq(listed).map(toReplyItem);
  return { text: lines.join("\n"), items, severe, allergens: asked };
}
