import { describe, expect, it } from "vitest";
import type { Allergen } from "@/lib/db/schema";
import { CONSTRAINT_QUESTIONS, GENERAL_QUESTIONS } from "../../test/review-cases";
import { type AssistantItem, allergenAnswer, namedItems, normalizeText, routeQuestion, scanLexicon } from "./allergen-router";

/** Allergen mode: the router must send these to the deterministic path. Second column: allergens it should recognise (subset check). */
const ALLERGEN_PHRASINGS: [string, Allergen[]][] = [
  ["Is the pad thai peanut free?", ["peanuts"]],
  ["Does the pad thai have peanuts?", ["peanuts"]],
  ["Is there penut in the satay?", ["peanuts"]],
  ["any peenut dishes?", ["peanuts"]],
  ["pea nut allergy here", ["peanuts"]],
  ["What's nut-free?", ["tree_nuts", "peanuts"]],
  ["do you have anything with nuts", ["tree_nuts", "peanuts"]],
  ["Are there nuts in the brownie?", ["tree_nuts", "peanuts"]],
  ["almonds in the matcha?", ["tree_nuts"]],
  ["cashew sauce?", ["tree_nuts"]],
  ["walnuts anywhere", ["tree_nuts"]],
  ["pecan pie contents", ["tree_nuts"]],
  ["pistachio or hazelnut in desserts?", ["tree_nuts"]],
  ["Is the ramen glutten free?", ["gluten"]],
  ["is this gluten free", ["gluten"]],
  ["gluton intolerance, what can I eat", ["gluten"]],
  ["I'm celiac", ["gluten"]],
  ["i am coeliac what do you recommend", ["gluten"]],
  ["Celiac disease options?", ["gluten"]],
  ["Does the tempura have wheat?", ["wheat"]],
  ["wheet in the noodles?", ["wheat"]],
  ["is flour used in the batter", ["wheat"]],
  ["what has dairy", ["milk"]],
  ["Is anything dairy-free?", ["milk"]],
  ["diary free options", ["milk"]],
  ["I'm lactose intolerant", ["milk"]],
  ["lactos intolerant, what's ok", ["milk"]],
  ["does the ramen have cheese", ["milk"]],
  ["butter in the noodles?", ["milk"]],
  ["is there cream in the dessert", ["milk"]],
  ["which dishes have egg", ["egg"]],
  ["eggs in fried rice?", ["egg"]],
  ["Any shellfish dishes?", ["crustacean_shellfish"]],
  ["shelfish allergy", ["crustacean_shellfish"]],
  ["shell fish in the pad thai?", ["crustacean_shellfish"]],
  ["Is there shrimp in the fried rice?", ["crustacean_shellfish"]],
  ["prawns?", ["crustacean_shellfish"]],
  ["crab or lobster dishes", ["crustacean_shellfish"]],
  ["seafood options", ["fish", "crustacean_shellfish"]],
  ["does the kimchi have fish", ["fish"]],
  ["anchovies in the sauce", ["fish"]],
  ["fish sauce in the noodles?", ["fish"]],
  ["Is there soy in the sauce?", ["soy"]],
  ["soya free?", ["soy"]],
  ["tofu dishes with soy sauce", ["soy"]],
  ["sesame seeds on the bowl?", ["sesame"]],
  ["sesme oil in the salad", ["sesame"]],
  ["tahini in the dessert?", ["sesame"]],
  ["Is the Miso soup vegan?", ["milk", "egg", "fish", "crustacean_shellfish"]],
  ["any vegan desserts", ["milk", "egg"]],
  ["I have an allergy", []],
  ["I'm allergic to something", []],
  ["alergic to mustard", []],
  ["my son has allergies", []],
  ["food allergen info please", []],
  ["hypoallergenic options?", []],
  ["I have an intolerance", []],
  ["intolerant to garlic", []],
  ["what if I have a reaction", []],
  ["I carry an epipen", []],
  ["I use an epi-pen, what's safe?", []],
  ["Risk of anaphylaxis, can I eat here", []],
  ["severe reaction risk", []],
  ["Is the soup safe?", []],
  ["which dishes are safe for me", []],
  ["Is the curry free of anything?", []],
  ["gluten-free options", ["gluten"]],
  ["does the sauce contain anything weird", []],
  ["what does the katsu contain?", []],
  ["cross-contact risk in the fryer?", []],
  ["cross contamination in your kitchen", []],
  ["IS THE RAMEN GLUTEN FREE???", ["gluten"]],
  ["p3anut oil?", ["peanuts"]],
  ["s@fe for kids with gluten?", ["gluten"]],
  ["Do you have gl uten free noodles", ["gluten"]],
  ["peanut​ free?", ["peanuts"]],
  ["ＰＥＡＮＵＴ free", ["peanuts"]],
  ["crème brûlée has cream?", ["milk"]],
  ["sulfite allergy?", []],
  ["¿Qué platos llevan huevo?", ["egg"]],
  ["¿El pad thai tiene maní?", ["peanuts"]],
  ["le pad thai contient-il des arachides ?", ["peanuts"]],
  ["Enthält das Gericht Erdnüsse?", ["peanuts"]],
  ["Ha il glutine?", ["gluten"]],
  ["is the pad thai GF", ["gluten"]],
  ["peenuts", ["peanuts"]],
  ["peanots", ["peanuts"]],
  ["w h e a t", ["wheat"]],
  ["whe at", ["wheat"]],
];

/** General mode: nothing here touches an allergen, so the model path may answer them. */
const GENERAL_PHRASINGS: string[] = [
  "What's spicy?",
  "What comes with the burger?",
  "Something for kids?",
  "Anything spicy under $15?",
  "What are your most popular dishes?",
  "How long is pickup?",
  "How many minutes until my order is ready?",
  "Tell me about the soup",
  "What drinks do you have?",
  "Which dessert is the best?",
  "What's the cheapest main?",
  "Do you have something light?",
  "What should I order for two people?",
  "Is the ramen spicy?",
  "What's better, the ramen or the pad thai?",
  "Where do I pick up my order?",
  "What time do you open?",
  "How big is the portion?",
  "What are today's specials?",
  "Recommend a starter",
  "Quel plat est le plus populaire ?",
  "What's the price of the katsu curry?",
  "Is there anything hot and filling?",
  "Which bowls come with rice?",
  "Do you have a kids menu",
  "What is a good side for the teriyaki?",
  "Can I get my order in 10 minutes?",
  "What's the wait right now?",
];

describe("allergen router: phrasings that must reach the deterministic answer", () => {
  it("has at least 60 allergen phrasings", () => {
    expect(ALLERGEN_PHRASINGS.length).toBeGreaterThanOrEqual(60);
  });
  it.each(ALLERGEN_PHRASINGS)("routes %j to allergen mode", (question, allergens) => {
    const route = routeQuestion(question);
    expect(route.mode).toBe("allergen");
    for (const a of allergens) expect(route.allergens).toContain(a);
  });
});

describe("allergen router: every question from the PR review reaches the deterministic path", () => {
  it.each(CONSTRAINT_QUESTIONS)("routes %j to allergen mode", (q) => {
    expect(routeQuestion(q).mode).toBe("allergen");
  });
  it("keeps plainly general questions general", () => {
    for (const q of GENERAL_QUESTIONS) expect(routeQuestion(q).mode).toBe("general");
  });
  it("sends anything with non-Latin letters to the ask-staff answer", () => {
    for (const q of ["ピーナッツ", "what is 花生", "Привет menu", "pеanut"]) {
      expect(routeQuestion(q).mode).toBe("allergen");
      const a = allergenAnswer(q, MENU, { now: NOW });
      expect(a.text.startsWith("Please speak with staff before ordering.") || a.allergens.length > 0).toBe(true);
    }
    expect(allergenAnswer("ピーナッツ", MENU, { now: NOW }).items).toEqual([]);
  });
  it("reads Cyrillic look-alikes as the Latin letters they imitate", () => {
    expect(routeQuestion("реаnut").allergens).toContain("peanuts");
  });
});

describe("allergen router: general questions stay general", () => {
  it.each(GENERAL_PHRASINGS)("routes %j to general mode", (question) => {
    expect(routeQuestion(question).mode).toBe("general");
  });
});

describe("severe words", () => {
  it.each(["I'm celiac", "my daughter has anaphylaxis", "I carry an epipen", "I have an epi-pen", "severe peanut allergy", "coeliac disease", "celiak here"])("flags %j as severe", (q) => {
    expect(scanLexicon(q).severe).toBe(true);
  });
  it("does not flag an ordinary allergen question", () => {
    expect(scanLexicon("does it have peanuts").severe).toBe(false);
  });
});

describe("normalizeText", () => {
  it("folds case, accents, full-width letters, zero-width characters and apostrophes", () => {
    expect(normalizeText("Doesn’t  CONTAIN​ Ｎuts, crème!")).toBe("doesnt contain nuts creme");
  });
});

const item = (over: Partial<AssistantItem> & { name: string }): AssistantItem => ({
  id: over.name.toLowerCase().replace(/\W+/g, "-"),
  description: "",
  priceCents: 1000,
  dietaryTags: [],
  soldOut: false,
  allergens: [],
  allergensVerifiedAt: new Date("2026-11-01T00:00:00Z").toISOString(),
  ...over,
});
const NOW = new Date("2026-11-10T12:00:00Z");
const STALE = new Date("2026-06-01T00:00:00Z").toISOString();

const MENU: AssistantItem[] = [
  item({ name: "Pad Thai", allergens: [{ allergen: "peanuts", level: "contains" }, { allergen: "egg", level: "contains" }, { allergen: "crustacean_shellfish", level: "may_contain" }] }),
  item({ name: "Steamed Rice" }),
  item({ name: "Miso Soup", allergens: [{ allergen: "soy", level: "contains" }, { allergen: "milk", level: "may_contain" }] }),
  item({ name: "Almond Cookie", allergens: [{ allergen: "tree_nuts", level: "contains" }, { allergen: "wheat", level: "contains" }] }),
  item({ name: "Plain Bun", allergens: [{ allergen: "gluten", level: "contains" }] }),
  item({ name: "Crispy Tofu Bites", allergens: [{ allergen: "wheat", level: "may_contain" }] }),
  item({ name: "House Kimchi", allergens: [{ allergen: "fish", level: "may_contain" }], allergensVerifiedAt: null }),
  item({ name: "Old Stamp Salad", allergens: [], allergensVerifiedAt: STALE }),
];

const NOTICE_START = "We can't guarantee any dish is free of an allergen. Our kitchen handles ";
const NOTICE_END = ", and cross-contact can happen. Please tell staff about your allergy before ordering, and use the allergy question at checkout.";

describe("allergenAnswer", () => {
  it("always ends with the fixed notice, naming every allergen declared on the menu", () => {
    for (const q of ["is the pad thai peanut free", "I have an allergy", "what has dairy", "mustard allergy", "tell me about the soup is it safe"]) {
      const { text } = allergenAnswer(q, MENU, { now: NOW });
      expect(text.endsWith(NOTICE_END)).toBe(true);
      const notice = text.slice(text.lastIndexOf(NOTICE_START));
      for (const label of ["milk", "egg", "fish", "shellfish", "tree nuts", "peanuts", "wheat", "soy", "gluten"]) expect(notice).toContain(label);
      expect(notice).not.toContain("sesame"); // declared nowhere in this menu
    }
  });

  it("says a named dish contains peanuts and never calls it free or safe", () => {
    const { text, items } = allergenAnswer("Is the pad thai peanut free?", MENU, { now: NOW });
    expect(text).toContain("Pad Thai: contains peanuts.");
    expect(items.map((i) => i.name)).toEqual(["Pad Thai"]);
    expect(stripFixedSentences(text)).not.toMatch(/\bsafe\b|free of|allergen.free|suitable|no peanuts/i);
  });

  it("surfaces cross-contact for a named dish", () => {
    const { text } = allergenAnswer("does the pad thai have shellfish?", MENU, { now: NOW });
    expect(text).toContain("Pad Thai: may contain shellfish (cross-contact).");
  });

  it("lists dishes that contain or may contain what was asked, and no dish as safe, for an unnamed question", () => {
    const { text } = allergenAnswer("What's nut-free?", MENU, { now: NOW });
    expect(text).toContain("Dishes that contain peanuts: Pad Thai.");
    expect(text).toContain("Dishes that contain tree nuts: Almond Cookie.");
    expect(text).not.toMatch(/Steamed Rice|Plain Bun/);
    expect(stripFixedSentences(text)).not.toMatch(/\bsafe\b|free of|allergen.free|suitable/i);
  });

  it("links wheat and gluten in both directions", () => {
    const wheat = allergenAnswer("anything with wheat?", MENU, { now: NOW }).text;
    expect(wheat).toContain("Plain Bun"); // declares gluten only
    expect(wheat).toContain("Dishes that may contain wheat (cross-contact): Crispy Tofu Bites");
    const gluten = allergenAnswer("anything with gluten?", MENU, { now: NOW }).text;
    expect(gluten).toContain("Almond Cookie"); // declares wheat only
    expect(gluten).toContain("Crispy Tofu Bites");
  });

  it("says 'not listed' only for a verified named dish, with the 'not a guarantee' sentence", () => {
    const { text } = allergenAnswer("does the steamed rice have peanuts?", MENU, { now: NOW });
    expect(text).toContain("Peanuts isn't listed for Steamed Rice in our menu data. That isn't a guarantee: please ask staff.");
  });

  it("tells the customer to ask staff when a dish's data is unverified or stale, and does not say 'not listed'", () => {
    const unverified = allergenAnswer("does the house kimchi have peanuts?", MENU, { now: NOW }).text;
    expect(unverified).toContain("Allergen information for House Kimchi hasn't been checked recently: ask staff.");
    expect(unverified).not.toContain("isn't listed for House Kimchi");
    const stale = allergenAnswer("does the old stamp salad have milk?", MENU, { now: NOW }).text;
    expect(stale).toContain("Allergen information for Old Stamp Salad hasn't been checked recently: ask staff.");
    expect(stale).not.toContain("isn't listed for Old Stamp Salad");
    const unnamed = allergenAnswer("which dishes have fish?", MENU, { now: NOW }).text;
    expect(unnamed).toContain("House Kimchi (allergen information not checked recently: ask staff)");
    expect(unnamed).toContain("Allergen information for some dishes hasn't been checked recently: ask staff.");
  });

  it("a stamp exactly at the 90-day edge is current, one day later it is stale", () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
    const q = "does the pad thai have milk?";
    const edge = allergenAnswer(q, [item({ name: "Pad Thai", allergensVerifiedAt: at(90) })], { now: NOW }).text;
    const over = allergenAnswer(q, [item({ name: "Pad Thai", allergensVerifiedAt: at(91) })], { now: NOW }).text;
    expect(edge).toContain("isn't listed for Pad Thai");
    expect(over).toContain("hasn't been checked recently");
  });

  it("severe words lead with 'speak with staff' and name the dishes that contain or may contain the allergen", () => {
    const { text, items } = allergenAnswer("I'm celiac, what can I eat?", MENU, { now: NOW });
    expect(text.startsWith("Please speak with staff before ordering.")).toBe(true);
    expect(text).toContain("Dishes that contain gluten: Plain Bun.");
    expect(text).toContain("Dishes that contain wheat: Almond Cookie."); // wheat is linked to gluten, so it is asked about too
    expect(text).toContain("Dishes that may contain wheat (cross-contact): Crispy Tofu Bites.");
    expect(items.map((i) => i.name).sort()).toEqual(["Almond Cookie", "Crispy Tofu Bites", "Plain Bun"]);
  });

  it("a severe answer never names a dish it has nothing to report about", () => {
    const { text, items } = allergenAnswer("severe peanut allergy, is the steamed rice ok?", MENU, { now: NOW });
    expect(text.startsWith("Please speak with staff before ordering.")).toBe(true);
    expect(text).not.toContain("Steamed Rice");
    expect(text).toContain("Peanuts isn't listed for the dish you asked about in our menu data. That isn't a guarantee: please ask staff.");
    expect(items).toEqual([]);
  });

  it("severe with a named dish that only may contain: the dish is named with its cross-contact", () => {
    const { text, items } = allergenAnswer("severe wheat allergy, is the crispy tofu bites ok?", MENU, { now: NOW });
    expect(text.startsWith("Please speak with staff before ordering.")).toBe(true);
    expect(text).toContain("Crispy Tofu Bites: may contain wheat (cross-contact).");
    expect(items.map((i) => i.name)).toEqual(["Crispy Tofu Bites"]);
  });

  it("keeps each dish's may-contain for other allergens even when it contains one asked allergen (multi-allergen, severe or not)", () => {
    const menu = [item({ name: "Egg Noodles", allergens: [{ allergen: "egg", level: "contains" }, { allergen: "sesame", level: "may_contain" }] })];
    for (const q of ["severe egg and sesame allergy", "egg and sesame allergy", "does the egg noodles have egg or sesame, severe allergy", "egg and sesame in the egg noodles"]) {
      const { text } = allergenAnswer(q, menu, { now: NOW });
      expect(text, q).toMatch(/contains egg\.|contain egg: Egg Noodles\./);
      expect(text, q).toMatch(/may contain sesame \(cross-contact\)/);
    }
  });

  it("the notice names a related allergen too: a menu that declares only wheat also handles gluten, and the other way round", () => {
    const wheat = allergenAnswer("does it have soy", [item({ name: "A", allergens: [{ allergen: "wheat", level: "contains" }] })], { now: NOW }).text;
    expect(wheat).toContain("Our kitchen handles wheat and gluten,");
    const gluten = allergenAnswer("does it have soy", [item({ name: "A", allergens: [{ allergen: "gluten", level: "contains" }] })], { now: NOW }).text;
    expect(gluten).toContain("Our kitchen handles wheat and gluten,");
  });

  it("returns in `items` only dishes that contain or may contain what was asked: never a 'not listed' or unchecked dish", () => {
    expect(allergenAnswer("does the steamed rice have peanuts?", MENU, { now: NOW }).items).toEqual([]);
    expect(allergenAnswer("does the house kimchi have peanuts?", MENU, { now: NOW }).items).toEqual([]);
    expect(allergenAnswer("does the old stamp salad have milk?", MENU, { now: NOW }).items).toEqual([]);
    expect(allergenAnswer("is the pad thai safe for me?", MENU, { now: NOW }).items.map((i) => i.name)).toEqual(["Pad Thai"]);
    expect(allergenAnswer("anything with sesame?", MENU, { now: NOW }).items).toEqual([]);
  });

  it("an ambiguous or out-of-list question says to ask staff and lists no dishes", () => {
    for (const q of ["I have an allergy", "mustard allergy", "is the soup safe?", "alergic to celery"]) {
      const { text, items } = allergenAnswer(q, MENU, { now: NOW });
      expect(text.startsWith("Please speak with staff before ordering.")).toBe(true);
      expect(text).toContain("Our menu data covers only milk, egg, fish, shellfish, tree nuts, peanuts, wheat, soy, sesame and gluten. For any other allergen, please ask staff.");
      expect(items).toEqual([]);
    }
  });

  it("an ambiguous question about a named dish lists that dish's own declarations and nothing else", () => {
    const { text } = allergenAnswer("is the pad thai safe for me?", MENU, { now: NOW });
    expect(text).toContain("Pad Thai: contains egg and peanuts.");
    expect(text).toContain("Pad Thai: may contain shellfish (cross-contact).");
    expect(text).not.toContain("Miso Soup");
  });

  it("says no dish is declared (with the 'not a guarantee' sentence) when nothing matches, never 'none contain'", () => {
    const { text } = allergenAnswer("anything with sesame?", MENU, { now: NOW });
    expect(text).toContain("No dish on our menu is declared to contain or may contain sesame. That isn't a guarantee: please ask staff.");
  });

  it("matches a dish by name, by plural, and by all of its significant words", () => {
    expect(namedItems("is the pad thai ok", MENU).map((i) => i.name)).toEqual(["Pad Thai"]);
    expect(namedItems("pad-thai?", MENU).map((i) => i.name)).toEqual(["Pad Thai"]);
    expect(namedItems("crispy bites of tofu", MENU).map((i) => i.name)).toEqual(["Crispy Tofu Bites"]);
    expect(namedItems("what about the soup", MENU)).toEqual([]);
  });
});

/** Remove the sentences the spec fixes or that deny a guarantee, so the rest can be searched for claims. */
function stripFixedSentences(text: string): string {
  return text
    .replace(/We can't guarantee[^\n]*/g, "")
    .replace(/[^.\n]*That isn't a guarantee: please ask staff\./g, "");
}
