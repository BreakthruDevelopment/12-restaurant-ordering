import { describe, expect, it } from "vitest";
import { demoFixtures } from "@/lib/ai/demo";
import { containsSafetyClaim, guardModelOutput, looksLikeEnglishText, amountsInCents, allergenReply, type GuardContext } from "./allergen-guardrails";
import { BAD_STRUCTURE_ANSWERS, CLAIM_ANSWERS, CLAIM_DISH_NAMES } from "../../test/review-cases";
import { type AssistantItem, scanLexicon } from "./allergen-router";
import { buildMenuQaPrompt, menuQaOutput, type MenuQaOutput } from "./menu-qa";

const NOW = new Date("2026-11-10T12:00:00Z");
const item = (name: string, priceCents: number, over: Partial<AssistantItem> = {}): AssistantItem => ({
  id: name.toLowerCase().replace(/\W+/g, "-"),
  name,
  description: "",
  priceCents,
  dietaryTags: [],
  soldOut: false,
  allergens: [],
  allergensVerifiedAt: "2026-11-01T00:00:00.000Z",
  ...over,
});

/** Dish names without any lexicon word, so substituted names can't trip the checks a property test makes on the final text. */
const PLAIN_MENU = [item("Spicy Noodles", 1450, { dietaryTags: ["spicy"] }), item("Rice Bowl", 1200), item("Jasmine Tea", 300), item("Sold Out Pie", 600, { soldOut: true })];
/** The menu from the review probes, with dishes whose names read as claims. */
const REVIEW_MENU = [
  item("Pad Thai", 1450), item("Green Curry", 1350), item("Gluten-Free Rice Bowl", 1200), item("Satay", 900),
  item("Nut Free Brownie", 600), item("Spring Rolls", 700), item("Safe Harbor Soup", 500),
];
const MENU = [
  item("Pad Thai", 1450, { allergens: [{ allergen: "peanuts", level: "contains" }] }),
  item("House Salad", 900),
  item("Spicy Miso Ramen", 1450, { dietaryTags: ["spicy"] }),
  item("Chili Cucumbers", 500, { dietaryTags: ["spicy"] }),
];

function ctx(menu: AssistantItem[], over: Partial<GuardContext> = {}): GuardContext {
  const { refs } = buildMenuQaPrompt("q", menu);
  return { question: "what salads do you have?", menu, refs, demo: false, now: NOW, ...over };
}
const out = (answer: string, itemRefs: string[] = [], mentionsAllergyOrDiet = false): MenuQaOutput => ({ answer, itemRefs, mentionsAllergyOrDiet });

describe("guardrail 1: the model flags allergies or diets", () => {
  it("discards the model text and returns the deterministic answer", () => {
    const c = ctx(MENU, { question: "Quais pratos t\u00eam ovo?" }); // Portuguese: not in the lexicon
    const r = guardModelOutput(out("Several dishes have eggs, ask at the counter. MODELTEXT", ["M1"], true), c);
    expect(r.mode).toBe("guardrail");
    expect(r.answer).not.toContain("MODELTEXT");
    expect(r.answer).toBe(allergenReply(c.question, MENU, "guardrail", NOW).answer);
    expect(r.answer.startsWith("Please speak with staff before ordering.")).toBe(true);
    expect(r.answer.endsWith("use the allergy question at checkout.")).toBe(true);
  });
});

describe("guardrail 2: the allergen lexicon on the answer", () => {
  it.each(["Try M1, it has peanuts on top.", "M2 comes with a creamy sauce.", "This dish has a nut crust.", "Good for dairy lovers, try M1.", "M1 is the best seller (we use sesame oil)."])("replaces %j", (answer) => {
    const r = guardModelOutput(out(answer, ["M1"]), ctx(MENU));
    expect(r.mode).toBe("guardrail");
    expect(r.answer).not.toContain(answer);
  });
});

describe("guardrail 3: safety-claim filter", () => {
  const CLAIMS = [
    "The house salad is safe for dairy allergies",
    "This is safe to eat",
    "It is free of nuts",
    "It is free from gluten",
    "A gluten-free choice",
    "nut free and tasty",
    "No nuts in this one",
    "no dairy here",
    "It doesn't contain peanuts",
    "It does not contain eggs",
    "Made without shellfish",
    "Suitable for vegans",
    "okay for celiacs",
    "ok for kids with allergies",
    "fine for you",
    "an allergy-friendly pick",
    "hypoallergenic",
    "I guarantee it",
    "allergen-free",
    "Sans gluten",
    "Sin gluten",
    "Es seguro",
    "Ist sicher",
  ];
  it.each(CLAIMS)("replaces %j", (claim) => {
    expect(containsSafetyClaim(claim)).toBe(true);
    const r = guardModelOutput(out(`Try M1. ${claim}. MODELTEXT`, ["M1"]), ctx(MENU));
    expect(r.mode).toBe("guardrail");
    expect(r.answer).not.toContain("MODELTEXT");
  });
  it("replaces a safety claim with exactly allergenAnswer() for the question", () => {
    const c = ctx(MENU, { question: "what salads do you have?" });
    const r = guardModelOutput(out("The house salad is safe for dairy allergies", ["M2"]), c);
    expect(r).toEqual(allergenReply("what salads do you have?", MENU, "guardrail", NOW));
  });
  it("does not flag ordinary menu talk", () => {
    for (const ok of ["Try M1 or M3 for a hot, filling meal.", "M3 is our spicy pick and a guest favourite.", "Ask staff about anything else."]) expect(containsSafetyClaim(ok)).toBe(false);
  });
});

describe("answers the English-only filters cannot read are refused", () => {
  it("non-Latin look-alikes", () => {
    expect(looksLikeEnglishText("Try M1, it is ѕafe")).toBe(false); // Cyrillic s
    expect(looksLikeEnglishText("安全")).toBe(false);
  });
  it("spelled-out letters", () => {
    expect(looksLikeEnglishText("It is s a f e to eat")).toBe(false);
    expect(guardModelOutput(out("Try M1, it is s a f e", ["M1"]), ctx(MENU)).mode).toBe("guardrail");
  });
  it("a sentence in another language", () => {
    const r = guardModelOutput(out("Este plato del restaurante es muy bueno para todos los clientes", ["M1"]), ctx(MENU));
    expect(r.mode).toBe("guardrail");
  });
  it("normal English passes", () => {
    expect(looksLikeEnglishText("Try M1 or M2 if you want something hot and filling for lunch.")).toBe(true);
  });
});

describe("guardrail 4: refs and prices", () => {
  it("drops refs that do not exist or are not available, and shows database names and prices", () => {
    const c = ctx(PLAIN_MENU);
    const r = guardModelOutput(out("Try M1 or M2 for lunch.", ["M1", "M9", "M4", "M2"]), c);
    expect(r.mode).toBe("general");
    // Only three dishes are available (the pie is sold out), so M4 and M9 do not exist.
    expect(r.items.map((i) => i.name)).toEqual(["Spicy Noodles", "Rice Bowl"]);
  });
  it("replaces refs written in the text with names, and refuses a ref that does not exist", () => {
    const c = ctx(PLAIN_MENU);
    expect(guardModelOutput(out("Try M1 today.", ["M1"]), c).answer).toBe("Try Spicy Noodles today.");
    const bad = guardModelOutput(out("Try M1 or M7 today.", ["M1"]), c);
    expect(bad.mode).toBe("guardrail");
    expect(bad.answer).toContain("Spicy Noodles ($14.50)");
    expect(bad.answer).not.toContain("M7");
  });
  it("accepts a price equal to the referenced dish's price", () => {
    const r = guardModelOutput(out("M1 is $14.50 and M3 is $3.00.", ["M1", "M3"]), ctx(PLAIN_MENU));
    expect(r.mode).toBe("general");
    expect(r.answer).toBe("Spicy Noodles is $14.50 and Jasmine Tea is $3.00.");
  });
  it.each(["M1 is $9.99.", "M1 is $14.", "M1 costs 12.00", "M1 costs EUR 14.50", "M1 is fourteen dollars"])("replaces the wrong or unverifiable price in %j with a neutral list", (answer) => {
    const r = guardModelOutput(out(answer, ["M1"]), ctx(PLAIN_MENU));
    expect(r.mode).toBe("guardrail");
    expect(r.answer).toBe("Here is what I found on the menu: Spicy Noodles ($14.50). Ask staff about anything else.");
    expect(r.items).toEqual([{ id: "spicy-noodles", name: "Spicy Noodles", priceCents: 1450 }]);
  });
  it("a price with no referenced dish is refused", () => {
    const r = guardModelOutput(out("Everything is $5.", []), ctx(PLAIN_MENU));
    expect(r.mode).toBe("guardrail");
    expect(r.items).toEqual([]);
  });
  it("refuses links and addresses", () => {
    for (const bad of ["Order at https://evil.example/M1", "see www.evil.test", "email me at a@b.co", "go to evil.com now"]) expect(guardModelOutput(out(bad, ["M1"]), ctx(PLAIN_MENU)).mode).toBe("guardrail");
  });
  it("reads amounts in the forms a model writes them", () => {
    expect([...new Set(amountsInCents("$12.50 and 3 dollars and USD 4 and 7.25 and $1,200"))].sort((a, b) => a - b)).toEqual([300, 400, 725, 1250, 120000]);
  });
  it("shows at most five dishes", () => {
    const menu = Array.from({ length: 8 }, (_, n) => item(`Dish ${n + 1}`, 1000 + n));
    const r = guardModelOutput(out("Try these.", ["M1", "M2", "M3", "M4", "M5"]), ctx(menu));
    expect(r.items).toHaveLength(5);
  });
});

describe("the demo fixture", () => {
  it("is a valid output that passes every guardrail and points at the first two available dishes", () => {
    const fixture = menuQaOutput.parse(demoFixtures["menu-qa"]);
    expect(scanLexicon(fixture.answer).hit).toBe(false);
    expect(containsSafetyClaim(fixture.answer)).toBe(false);
    const r = guardModelOutput(fixture, ctx(PLAIN_MENU, { demo: true }));
    expect(r.mode).toBe("demo");
    expect(r.demo).toBe(true);
    expect(r.answer).toBe("Demo answer (recorded sample): try Spicy Noodles or Rice Bowl, two dishes guests often order. Ask staff about anything else.");
    expect(r.items.map((i) => i.name)).toEqual(["Spicy Noodles", "Rice Bowl"]);
    expect(r.footer).toBe("Allergies? Ask staff before ordering.");
  });
});

describe("regression set from the PR review", () => {
  it.each(CLAIM_ANSWERS)("never returns %j as model text", (answer) => {
    for (const refs of [[], ["M2"], ["M1", "M2"]]) {
      const r = guardModelOutput(out(answer, refs), ctx(REVIEW_MENU, { question: "what do you recommend" }));
      expect(["general", "demo"], answer).not.toContain(r.mode);
    }
  });
  it.each(BAD_STRUCTURE_ANSWERS)("refuses %j", (answer) => {
    const r = guardModelOutput(out(answer, ["M2"]), ctx(REVIEW_MENU, { question: "what do you recommend" }));
    expect(["general", "demo"], answer).not.toContain(r.mode);
  });
  it("a claim that only appears once a dish name is substituted falls back to the deterministic answer", () => {
    for (const name of CLAIM_DISH_NAMES) {
      const menu = [item(name, 1200), item("Plain Rice", 300)];
      const r = guardModelOutput(out("Try M1 for lunch.", ["M1"]), ctx(menu, { question: "what is popular" }));
      expect(r.mode, name).toBe("guardrail");
      expect(r.answer, name).toBe(allergenReply("what is popular", menu, "guardrail", NOW).answer);
    }
  });
  it("a dish name that only contains an allergen word keeps the general answer", () => {
    const menu = [item("Peanut Butter Brownie", 700), item("Plain Rice", 300)];
    const r = guardModelOutput(out("Try M1 for dessert.", ["M1"]), ctx(menu));
    expect(r.mode).toBe("general");
    expect(r.answer).toBe("Try Peanut Butter Brownie for dessert.");
  });
  it("the angle-bracket trick: the check sees the text the customer would see", () => {
    for (const a of ["M1 is sa<fe.", "M1 is sa>fe.", "M1 is \u0073a\u200bfe."]) expect(guardModelOutput(out(a, ["M1"]), ctx(PLAIN_MENU)).mode).toBe("guardrail");
  });
  it("needs a ref in the text, and refuses any other digits, however short the answer", () => {
    for (const a of ["Try the noodles.", "Try M1 for 2 people.", "Try M1, 5 stars.", "Spicy!"]) expect(guardModelOutput(out(a, ["M1"]), ctx(PLAIN_MENU)).mode, a).toBe("guardrail");
    expect(guardModelOutput(out("Try M1 for lunch.", ["M1"]), ctx(PLAIN_MENU)).mode).toBe("general");
  });
  it("is ASCII English only, whatever the length", () => {
    for (const a of ["M1 \u00e9", "M1 muy bueno", "M1 \u4e0d\u9519", "M1 caf\u00e9"]) expect(guardModelOutput(out(a, ["M1"]), ctx(PLAIN_MENU)).mode, a).toBe("guardrail");
  });
});

// ---------------------------------------------------------------------------
// Property test: no code path returns model text that contains a safety-claim phrase.
// ---------------------------------------------------------------------------

/** A digit-free marker for run n: answers may not contain stray digits. */
const letters = (n: number): string => [...String(n)].map((d) => "abcdefghij"[Number(d)]).join("");

/** Small seeded generator, so a failure reproduces. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BENIGN = [
  "try M1", "or M2", "for a hot lunch", "it is a guest favourite", "served with rice and vegetables", "ask staff about anything else",
  "our spicy pick is M1", "M3 is a light option", "both are popular today", "a filling meal for us", "order ahead for pickup",
];
// Each phrase is something the spec or the task says must never reach a customer from the model.
const CLAIMS = [
  // every claim string from the PR review
  ...CLAIM_ANSWERS,
  "this is safe", "safe for dairy allergies", "perfectly safe", "free of nuts", "free from gluten", "gluten-free", "nut free", "dairy-free", "peanut-free",
  "no nuts", "no dairy", "no gluten", "no added dairy", "doesn't contain peanuts", "does not contain eggs", "doesnt contain soy", "without shellfish",
  "without any nuts", "suitable for vegans", "suitable for allergies", "okay for celiacs", "ok for kids with allergies", "fine for you", "allergy-friendly",
  "hypoallergenic", "I guarantee it", "no guarantee needed", "allergen-free", "allergen free", "peanut free", "totally safe", "unsafe", "sans gluten", "sin gluten",
  "ohne nuesse", "senza glutine", "es seguro", "ist sicher", "is vegan", "this contains no milk", "free of any allergens", "safe if you are celiac",
];

const ZERO_WIDTH = ["​", "‌", "‍", "⁠", "﻿"];
const FULLWIDTH = (c: string) => String.fromCharCode(c.charCodeAt(0) + 0xfee0);
function mutate(phrase: string, rnd: () => number): string {
  let s = phrase;
  const pick = (n: number) => Math.floor(rnd() * n);
  if (rnd() < 0.5) s = [...s].map((c) => (rnd() < 0.4 ? c.toUpperCase() : c)).join("");
  if (rnd() < 0.3) s = s.replace(/ /g, () => [" ", "  ", "\n", "\t", "  "][pick(5)]);
  if (rnd() < 0.3) s = [...s].map((c) => (/[a-z]/i.test(c) && rnd() < 0.15 ? c + ZERO_WIDTH[pick(5)] : c)).join("");
  if (rnd() < 0.2) s = s.replace(/'/g, "’");
  if (rnd() < 0.2) s = s.replace(/-/g, [" ", "‐", "‑", "–", ""][pick(5)]);
  if (rnd() < 0.2) s = [...s].map((c) => (/[a-z]/i.test(c) && rnd() < 0.2 ? FULLWIDTH(c) : c)).join("");
  if (rnd() < 0.15) s = s.replace(/e/g, "é").replace(/a/g, "à");
  if (rnd() < 0.1) s = s.replace(/a/g, "4").replace(/e/g, "3");
  if (rnd() < 0.1) s = [...s].filter((c) => c !== " ").join(" "); // s p e l l e d out
  if (rnd() < 0.1) s = s.replace(/[aeos]/g, (c) => ({ a: "а", e: "е", o: "о", s: "ѕ" })[c] as string); // Cyrillic look-alikes
  return s;
}

describe("property: no path returns model text containing a safety claim", () => {
  const ITERATIONS = 6000;
  const menu = PLAIN_MENU;
  const base = ctx(menu, { question: "what is popular?" });

  it("replaces every generated answer that carries a claim phrase, however it is disguised", () => {
    const rnd = mulberry32(Number(process.env.PROPERTY_SEED ?? 12_345));
    let passedThrough = 0;
    let withClaim = 0;
    for (let n = 0; n < ITERATIONS; n++) {
      const marker = `zqx${letters(n)}`;
      const parts: string[] = [];
      const pieces = 1 + Math.floor(rnd() * 4);
      for (let p = 0; p < pieces; p++) parts.push(BENIGN[Math.floor(rnd() * BENIGN.length)]);
      const claim = rnd() < 0.7;
      if (claim) parts.splice(Math.floor(rnd() * (parts.length + 1)), 0, mutate(CLAIMS[Math.floor(rnd() * CLAIMS.length)], rnd));
      const answer = `Try M1. ${parts.join(". ")}. ${marker}`;
      const refs = ["M1", "M2", "M3", "M4", "M9"].filter(() => rnd() < 0.4);
      const output: MenuQaOutput = { answer: answer.slice(0, 500), itemRefs: refs.slice(0, 5), mentionsAllergyOrDiet: rnd() < 0.05 };
      const reply = guardModelOutput(output, { ...base, demo: rnd() < 0.3 });

      const modelTextShown = reply.answer.includes(marker);
      if (modelTextShown) {
        passedThrough++;
        // Whatever reached the customer as model text is clean by every independent measure.
        expect(claim, `claim leaked: ${JSON.stringify(answer)}`).toBe(false);
        expect(output.mentionsAllergyOrDiet).toBe(false);
        expect(containsSafetyClaim(reply.answer), JSON.stringify(reply.answer)).toBe(false);
        expect(scanLexicon(reply.answer).hit, JSON.stringify(reply.answer)).toBe(false);
        expect(reply.answer).not.toMatch(/\b(safe|free|contain|without|suitable|guarantee|allergen|allergy)/i);
      }
      if (claim) {
        withClaim++;
        expect(modelTextShown, `claim leaked: ${JSON.stringify(answer)}`).toBe(false);
      }
      expect(reply.footer).toBe("Allergies? Ask staff before ordering.");
      expect(["general", "demo", "guardrail"]).toContain(reply.mode);
    }
    // Not vacuous: plenty of clean answers got through, plenty of claims were generated.
    expect(passedThrough).toBeGreaterThan(ITERATIONS * 0.2);
    expect(withClaim).toBeGreaterThan(ITERATIONS * 0.6);
  });

  it("never passes model text through when the model flagged the question, whatever the text says", () => {
    for (let n = 0; n < 500; n++) {
      const answer = `try M1 zqy${letters(n)}`;
      const reply = guardModelOutput({ answer, itemRefs: ["M1"], mentionsAllergyOrDiet: true }, base);
      expect(reply.answer).not.toContain(`zqy${letters(n)}`);
      expect(reply.mode).toBe("guardrail");
    }
  });

  it("holds for random word salad built from every phrase and every benign fragment", () => {
    const rnd = mulberry32(99);
    const words = [...BENIGN, ...CLAIMS].join(" ").split(" ");
    for (let n = 0; n < 3000; n++) {
      const len = 3 + Math.floor(rnd() * 25);
      const answer = Array.from({ length: len }, () => words[Math.floor(rnd() * words.length)]).join(" ");
      const reply = guardModelOutput({ answer: `Try M1 ${answer} zqz${letters(n)}`, itemRefs: [], mentionsAllergyOrDiet: false }, base);
      if (reply.answer.includes(`zqz${letters(n)}`)) {
        expect(containsSafetyClaim(reply.answer), reply.answer).toBe(false);
        expect(scanLexicon(reply.answer).hit, reply.answer).toBe(false);
      }
    }
  });
});
