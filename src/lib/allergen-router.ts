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
  /** Match only a whole word ("no", "ill", "gf"), so it can't fire inside "now" or "illustrate". */
  exact?: boolean;
  /** Also match a token one typo away (two for 9+ letters), singular or plural: "penut", "peenuts". Terms of 6+ letters only. */
  fuzzy?: boolean;
  /** Also match with all spaces removed ("pea nut", "p e a n u t"). Distinctive 6+ letter terms only. */
  compact?: boolean;
  /** Also match with spaces or dots between the letters ("w h e a t", "whe at"; short words need two gaps). */
  spaced?: boolean;
  /** A pattern on the normalised text, for phrases that are not a fixed string. */
  re?: RegExp;
};

const NUTS: readonly Allergen[] = ["tree_nuts", "peanuts"];
const ANIMAL: readonly Allergen[] = ["milk", "egg", "fish", "crustacean_shellfish"];
const SHELL: readonly Allergen[] = ["crustacean_shellfish"];

const group = (a: readonly Allergen[], terms: string, opt: Partial<Term> = {}): Term[] => terms.split(" ").map((t) => ({ t: t.replace(/_/g, " "), a, ...opt }));

/**
 * Spec lexicon plus the misspellings and synonyms customers actually type, other languages, negative-constraint
 * wording ("can't", "avoid", "without", "sick", "hives"), ingredient questions and diets. Terms match at the start of a
 * word, so "nut" catches "nuts" and "nutty" but not "minutes". Matching is a deliberate over-reach; see the module
 * comment: when in doubt, this list sends the question to the deterministic answer.
 */
const LEXICON: readonly Term[] = [
  // milk
  ...group(["milk"], "dairy diary dairi lactose lactos milk cheese butter cream yogurt yoghurt whey casein ghee"),
  ...group(["milk"], "lactose cheese", { fuzzy: true }), ...group(["milk"], "milk dairy", { spaced: true }), ...group(["milk"], "lactose", { compact: true }),
  // egg
  ...group(["egg"], "egg mayo"), ...group(["egg"], "egg", { spaced: true }),
  // fish
  ...group(["fish"], "fish anchov salmon tuna sardine worcestershire"), ...group(["fish"], "fish", { spaced: true }),
  // shellfish and molluscs (spec names crustacean_shellfish only; molluscs are mapped there too, which over-warns)
  ...group(SHELL, "shrimp prawn crab lobster shellfish shelfish shelfsh shellfsh crustacean crawfish crayfish langoustine"),
  ...group(SHELL, "shrimp lobster shellfish crustacean", { fuzzy: true }), ...group(SHELL, "shrimp shellfish crustacean", { compact: true }),
  ...group(SHELL, "mollusc mollusk mollusks molluscs squid calamari octopus clam mussel oyster scallop cuttlefish whelk abalone"),
  { t: "seafood", a: ["fish", "crustacean_shellfish"] },
  // nuts: the bare word "nut" means tree nuts and peanuts both
  { t: "nut", a: NUTS }, { t: "nut", a: NUTS, spaced: true },
  ...group(["tree_nuts"], "almond cashew walnut pecan pistachio hazelnut macadamia coconut marzipan praline pesto nutella"),
  ...group(["tree_nuts"], "almond cashew walnut pistachio hazelnut macadamia", { fuzzy: true }), ...group(["tree_nuts"], "pistachio hazelnut", { compact: true }),
  ...group(["peanuts"], "peanut penut pnut groundnut satay"), ...group(["peanuts"], "peanut", { fuzzy: true, compact: true }),
  // legumes (peanuts are legumes; soy and lupin too): ask staff, with peanuts and soy named
  { t: "legume", a: ["peanuts", "soy"] }, { t: "lupin" }, { t: "chickpea" }, { t: "lentil" },
  // wheat and gluten (linked by RELATED_ALLERGENS, applied when answering)
  ...group(["wheat"], "wheat wheet whaet flour"), ...group(["wheat"], "wheat", { spaced: true }),
  ...group(["gluten"], "gluten glutten gluton gluteen gf"), { t: "gf", a: ["gluten"], exact: true }, ...group(["gluten"], "gluten", { fuzzy: true, compact: true }),
  ...group(["gluten"], "celiac coeliac", { severe: true, fuzzy: true, compact: true }), ...group(["gluten"], "celiak seliac", { severe: true }),
  // soy
  ...group(["soy"], "soy soya tofu"), ...group(["soy"], "soy", { spaced: true }),
  // sesame
  ...group(["sesame"], "sesame sesme tahini"), ...group(["sesame"], "sesame tahini", { fuzzy: true, compact: true }),
  // diets that imply animal products, and dairy-free shorthand
  { t: "vegan", a: ANIMAL }, { t: "df", a: ["milk"], exact: true }, { t: "plant based", a: ANIMAL }, { t: "plantbased", a: ANIMAL },
  // other allergens and diets the ten-value list does not cover: always ask staff
  ...group([], "vegetarian kosher halal keto carb sugar diabet pregnan alcohol mustard celery sulfite sulphite corn garlic onion msg histamine nightshade gelatin meat pork beef diet"),
  // allergy and intolerance words
  { t: "allerg", anywhere: true, compact: true }, { t: "alerg" }, { t: "allergic", fuzzy: true }, { t: "allergy", fuzzy: true }, { t: "allergen", fuzzy: true },
  { t: "intoleran", anywhere: true }, { t: "intolerant", fuzzy: true }, { t: "sensitiv" }, { t: "react", anywhere: true },
  // symptoms and harm
  ...group([], "sick vomit hives hive swell swollen swelling rash itch throat breath wheez hurt harm danger poison toxic faint dizz"),
  { t: "ill", exact: true }, { t: "die", exact: true }, { t: "dying", exact: true },
  // severity
  { t: "anaphyla", severe: true, anywhere: true, compact: true }, { t: "epipen", severe: true, fuzzy: true, compact: true }, { t: "epi pen", severe: true },
  { t: "severe", severe: true }, { t: "life threatening", severe: true }, { t: "deadly", severe: true }, { t: "fatal", severe: true }, { t: "hospital", severe: true }, { t: "emergency", severe: true },
  // negative-constraint wording: a question that can't, won't, mustn't or avoids something is a constraint question
  ...group([], "cant cannot wont dont doesnt isnt arent mustnt shouldnt couldnt avoid without refrain restrict forbid"),
  { t: "can not" }, { t: "do not" }, { t: "does not" }, { t: "must not" }, { t: "make me" }, { t: "no", exact: true }, { t: "not", exact: true },
  { t: "can", re: /\bcan \w+(?: \w+)? eat\b/ },
  // ingredient questions ("what comes with" stays general)
  ...group([], "ingredient recipe whats_in what_is_in whats_inside what_is_inside made_with made_of made_from made_using contents"),
  // claims customers ask for and models must not make
  ...group([], "safe unsafe free contain crosscontact"), { t: "cross contact" }, { t: "cross contamination" }, { t: "trace", exact: true }, { t: "traces", exact: true },
  // Spanish
  ...group(["peanuts"], "cacahuete cacahuate mani"), ...group(["peanuts"], "cacahuete cacahuate", { fuzzy: true }),
  ...group(["egg"], "huevo huevos"), ...group(["milk"], "leche lactosa queso mantequilla crema nata"), ...group(["tree_nuts"], "nuez nueces almendra avellana"),
  ...group(["wheat"], "trigo harina"), ...group(["soy"], "soja"), ...group(["sesame"], "sesamo ajonjoli"), ...group(SHELL, "marisco mariscos gamba gambas camaron camarones langosta"),
  ...group(["fish"], "pescado"), ...group([], "alergia alergico alergica intolerancia vegano celiaco celiaca apto libre seguro segura peligro enfermo"), { t: "sin", exact: true },
  // French
  ...group(["peanuts"], "arachide arachides cacahuete"), ...group(["tree_nuts"], "noix amande noisette"), ...group(["milk"], "lait fromage beurre creme"),
  ...group(["egg"], "oeuf oeufs"), { t: "\u0153uf", a: ["egg"] }, ...group(["wheat"], "ble farine"), ...group(["fish"], "poisson"), ...group(SHELL, "crevette crevettes crustace homard moule huitre"),
  ...group([], "allergie allergique intolerant sans danger malade"), { t: "pas", exact: true }, { t: "ne", exact: true },
  // German
  ...group(["peanuts"], "erdnuss erdnusse erdnuesse"), ...group(["tree_nuts"], "nuss nusse nuesse haselnuss mandel walnuss"), ...group(["milk"], "milch kase kaese sahne laktose"),
  ...group(["egg"], "eier"), { t: "ei", a: ["egg"], exact: true }, ...group(["wheat"], "weizen mehl"), ...group(["gluten"], "glutenfrei"), ...group(["fish"], "fisch"),
  ...group(SHELL, "garnele garnelen krebstiere meeresfruchte"), ...group(["sesame"], "sesam"), ...group([], "allergie unvertraglich unvertraeglich ohne keine kein nicht gefahr"),
  // Italian
  ...group(["peanuts"], "arachidi"), ...group(["tree_nuts"], "nocciole noci mandorle"), ...group(["milk"], "latte formaggio burro lattosio"), ...group(["egg"], "uova uovo"),
  ...group(["gluten"], "glutine celiachia"), ...group(["wheat"], "frumento farina"), ...group(["soy"], "soia"), ...group(["fish"], "pesce"), ...group(SHELL, "gamberi crostacei"),
  ...group([], "allergia intolleranza senza vegano pericolo"), { t: "non", exact: true },
];

export type Scan = { hit: boolean; allergens: Allergen[]; severe: boolean; nonLatin: boolean };

const compactOf = (s: string) => s.replace(/ /g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const spacedRe = new Map<string, RegExp>();
function spacedPattern(t: string): RegExp {
  let re = spacedRe.get(t);
  if (!re) spacedRe.set(t, (re = new RegExp([...t].map(esc).join(" ?"), "g")));
  return re;
}

/** Run the lexicon over one normalised string. */
function scanOne(norm: string, found: Set<Allergen>, flags: { hit: boolean; severe: boolean }) {
  if (!norm) return;
  const padded = ` ${norm}`;
  const tokens = norm.split(" ");
  const compact = compactOf(norm);
  for (const term of LEXICON) {
    let matched: boolean;
    if (term.re) matched = term.re.test(norm);
    else if (term.exact) matched = tokens.includes(term.t);
    else if (term.anywhere) matched = norm.includes(term.t);
    else matched = padded.includes(` ${term.t}`);
    if (!matched && term.compact && term.t.length >= 6) matched = compact.includes(compactOf(term.t));
    if (!matched && term.spaced) {
      const need = term.t.length <= 4 ? 2 : 1;
      for (const m of norm.matchAll(spacedPattern(term.t))) if ((m[0].match(/ /g) ?? []).length >= need) matched = true;
    }
    if (!matched && term.fuzzy && term.t.length >= 6) {
      const max = term.t.length >= 9 ? 2 : 1;
      const forms = [term.t, `${term.t}s`];
      matched = tokens.some((tok) => tok.length >= 5 && tok[0] === term.t[0] && forms.some((f) => Math.abs(tok.length - f.length) <= max && editDistance(tok, f) <= max));
    }
    if (!matched) continue;
    flags.hit = true;
    if (term.severe) flags.severe = true;
    for (const a of term.a ?? []) found.add(a);
  }
}

/** Cyrillic and Greek letters that look like Latin ones, folded so "pеanut" is read as "peanut". */
const CONFUSABLE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ѕ: "s", ј: "j", һ: "h", к: "k", м: "m", т: "t", н: "h", в: "b",
  α: "a", ε: "e", ο: "o", ρ: "p", τ: "t", υ: "u", ν: "v", κ: "k", ι: "i",
};
const foldConfusables = (s: string): string => s.replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (c) => CONFUSABLE[c.toLowerCase()] ?? c);
const NON_LATIN = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * Match `text` against the lexicon. Reads the text as typed, with digit and symbol look-alikes undone, and with
 * Cyrillic and Greek look-alike letters folded, and reports the union. `hit` is true for any lexicon term, including
 * safety words with no allergen ("safe", "free"), and for any text containing non-Latin letters (we can't read it, so
 * it goes to the ask-staff answer).
 */
export function scanLexicon(text: string): Scan {
  const found = new Set<Allergen>();
  const flags = { hit: false, severe: false };
  const nonLatin = NON_LATIN.test(text);
  const lowered = text.toLowerCase();
  const forms = new Set([normalizeText(text), normalizeText(deleet(lowered)), normalizeText(foldConfusables(lowered)), normalizeText(deleet(foldConfusables(lowered)))]);
  for (const f of forms) scanOne(f, found, flags);
  return { hit: flags.hit || nonLatin, allergens: ALLERGENS.filter((a) => found.has(a)), severe: flags.severe, nonLatin };
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

/**
 * The fixed notice every allergen answer ends with. Names every allergen declared anywhere on the menu, expanded
 * through RELATED_ALLERGENS (a menu that declares wheat also handles gluten, and the other way round).
 */
export function staffNotice(items: readonly AssistantItem[]): string {
  const declared = expandAllergens(items.flatMap((i) => i.allergens.map((d) => d.allergen)));
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
 * - Severe words, or no recognisable allergen, lead with "Please speak with staff before ordering." Severe answers
 *   never name a dish that has no matching declaration.
 * - No recognisable allergen (or one outside the list): ask staff, and list nothing but the named dish's declarations.
 * - `items` holds only dishes that contain or may contain what was asked about. A dish that is "not listed" or has
 *   unchecked data is never returned there, so a UI can't show it as a suggestion.
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
  const noun = asked.length > 1 ? "aren't" : "isn't";

  if (severe || asked.length === 0) lines.push(SPEAK_WITH_STAFF);

  if (asked.length === 0) {
    lines.push(
      opts.reason === "guardrail"
        ? "I can't answer that one reliably. For anything about allergies, diets or ingredients, please ask staff."
        : "I can't tell from your question which allergen you mean, so I can't say what is in our dishes.",
    );
    for (const item of named) {
      const contains = byAllergenOrder(item.allergens.filter((d) => d.level === "contains").map((d) => d.allergen));
      const may = byAllergenOrder(item.allergens.filter((d) => d.level === "may_contain").map((d) => d.allergen));
      const name = cleanText(item.name);
      if (contains.length) lines.push(`${name}: contains ${labels(contains)}.`);
      if (may.length) lines.push(`${name}: may contain ${labels(may)} (cross-contact).`);
      if (!contains.length && !may.length && isCurrent(item, now)) lines.push(`No allergens are listed for ${name} in our menu data. That isn't a guarantee: please ask staff.`);
      if (!isCurrent(item, now)) lines.push(`Allergen information for ${name} hasn't been checked recently: ask staff.`);
      if (contains.length || may.length) listed.push(item);
    }
  } else if (named.length > 0) {
    for (const item of named) {
      const hits = hitsFor(item, askedSet);
      const contains = byAllergenOrder(hits.filter((h) => h.level === "contains").map((h) => h.allergen));
      const may = byAllergenOrder(hits.filter((h) => h.level === "may_contain" && !contains.includes(h.allergen)).map((h) => h.allergen));
      // A severe answer never names a dish it has nothing to report about.
      const name = hits.length || !severe ? cleanText(item.name) : "the dish you asked about";
      if (contains.length) lines.push(`${name}: contains ${labels(contains)}.`);
      if (may.length) lines.push(`${name}: may contain ${labels(may)} (cross-contact).`);
      if (!hits.length && isCurrent(item, now)) lines.push(`${capitalise(labels(asked))} ${noun} listed for ${name} in our menu data. That isn't a guarantee: please ask staff.`);
      if (!isCurrent(item, now)) lines.push(`Allergen information for ${hits.length || !severe ? cleanText(item.name) : "a dish you asked about"} hasn't been checked recently: ask staff.`);
      if (hits.length) listed.push(item);
    }
  } else {
    // No dish named: every dish on the menu, grouped by what it declares. Each dish keeps its own declarations for
    // every asked allergen: containing one allergen never hides a may-contain for another.
    const withHits = menu.map((item) => ({ item, hits: hitsFor(item, askedSet) })).filter((x) => x.hits.length > 0);
    const present = byAllergenOrder(uniq(withHits.flatMap((x) => x.hits.map((h) => h.allergen))));
    const mark = (i: AssistantItem) => (isCurrent(i, now) ? cleanText(i.name) : `${cleanText(i.name)} (allergen information not checked recently: ask staff)`);
    for (const allergen of present) {
      const contain = withHits.filter((x) => x.hits.some((h) => h.allergen === allergen && h.level === "contains")).map((x) => x.item);
      const may = withHits.filter((x) => !contain.includes(x.item) && x.hits.some((h) => h.allergen === allergen && h.level === "may_contain")).map((x) => x.item);
      if (contain.length) lines.push(`Dishes that contain ${ALLERGEN_LABEL[allergen]}: ${contain.map(mark).join(", ")}.`);
      if (may.length) lines.push(`Dishes that may contain ${ALLERGEN_LABEL[allergen]} (cross-contact): ${may.map(mark).join(", ")}.`);
      listed.push(...contain, ...may);
    }
    if (withHits.length === 0) lines.push(`No dish on our menu is declared to contain or may contain ${labels(asked)}. That isn't a guarantee: please ask staff.`);
    if (menu.some((i) => !isCurrent(i, now))) lines.push(staleLine);
  }

  lines.push(allergenCoverageLine());
  lines.push(staffNotice(menu));
  return { text: lines.join("\n"), items: uniq(listed).map(toReplyItem), severe, allergens: asked };
}
