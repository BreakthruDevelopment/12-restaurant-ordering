import { describe, expect, it } from "vitest";
import { demoFixtures } from "@/lib/ai/demo";
import { CLAIM_ANSWERS, CLAIM_DISH_NAMES } from "../../test/review-cases";
import { DEMO_PREFIX, GENERAL_CLOSING, GENERAL_TEMPLATES, NO_MATCH_TEXT, allergenReply, containsSafetyClaim, priceCapCents, renderGeneral, type GuardContext } from "./allergen-guardrails";
import type { AssistantItem } from "./allergen-router";
import { MENU_QA_REASONS, buildMenuQaPrompt, menuQaOutput, type MenuQaOutput } from "./menu-qa";

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
const MENU = [
  item("Pad Thai", 1450, { allergens: [{ allergen: "peanuts", level: "contains" }] }),
  item("Spicy Miso Ramen", 1450, { dietaryTags: ["spicy"] }),
  item("Chili Cucumbers", 500, { dietaryTags: ["spicy"] }),
  item("Szechuan Beef Bowl", 1850, { dietaryTags: ["spicy"] }),
  item("Jasmine Tea", 300),
  item("Sold Out Pie", 600, { soldOut: true }),
];
function ctx(menu: AssistantItem[], question = "what's popular?", over: Partial<GuardContext> = {}): GuardContext {
  return { question, menu, refs: buildMenuQaPrompt(question, menu).refs, demo: false, now: NOW, ...over };
}
const out = (refs: string[], reason: MenuQaOutput["reason"] = "popular"): MenuQaOutput => ({ refs, reason });

describe("general answers are rendered from templates", () => {
  it("writes the answer with database names and prices, plus the closing line", () => {
    const r = renderGeneral(out(["M1", "M5"]), ctx(MENU));
    expect(r.mode).toBe("general");
    expect(r.answer).toBe("Popular picks: Pad Thai ($14.50), Jasmine Tea ($3.00). Ask staff about allergies.");
    expect(r.items).toEqual([{ id: "pad-thai", name: "Pad Thai", priceCents: 1450 }, { id: "jasmine-tea", name: "Jasmine Tea", priceCents: 300 }]);
    expect(r.footer).toBe("Allergies? Ask staff before ordering.");
    expect(r.demo).toBe(false);
  });
  it("drops refs that do not exist, are sold out, repeat, or go past three", () => {
    const r = renderGeneral(out(["M1", "M1", "M9", "M2", "M3", "M4"]), ctx(MENU));
    expect(r.items.map((i) => i.name)).toEqual(["Pad Thai", "Spicy Miso Ramen", "Chili Cucumbers"]);
  });
  it("applies the price cap from the question, in cents, and says so", () => {
    const r = renderGeneral(out(["M2", "M3", "M4"], "spicy"), ctx(MENU, "Anything spicy under $15?"));
    expect(r.answer).toBe("Spicy picks under $15.00: Spicy Miso Ramen ($14.50), Chili Cucumbers ($5.00). Ask staff about allergies.");
    expect(r.items.map((i) => i.name)).not.toContain("Szechuan Beef Bowl");
  });
  it("a spicy reason keeps only dishes tagged spicy", () => {
    const r = renderGeneral(out(["M1", "M2"], "spicy"), ctx(MENU, "what's spicy"));
    expect(r.items.map((i) => i.name)).toEqual(["Spicy Miso Ramen"]);
  });
  it("falls back to a neutral line when nothing survives", () => {
    for (const refs of [[], ["M99"], ["M4"]]) {
      const r = renderGeneral(out(refs, "budget"), ctx(MENU, "cheapest under $5"));
      expect(r.mode).toBe("guardrail");
      expect(r.answer).toBe(NO_MATCH_TEXT);
      expect(r.items).toEqual([]);
    }
  });
  it("drops a dish whose own name reads as a claim, and keeps a name that only contains an allergen word", () => {
    for (const name of CLAIM_DISH_NAMES) {
      const r = renderGeneral(out(["M1", "M2"]), ctx([item(name, 1200), item("Plain Rice", 300)]));
      expect(r.items.map((i) => i.name), name).toEqual(["Plain Rice"]);
      expect(r.answer, name).not.toContain(name);
    }
    const r = renderGeneral(out(["M1"], "dessert"), ctx([item("Peanut Butter Brownie", 700)]));
    expect(r.answer).toBe("Dessert picks: Peanut Butter Brownie ($7.00). Ask staff about allergies.");
  });
  it("marks a demo answer", () => {
    const r = renderGeneral(out(["M1"]), ctx(MENU, "what's popular?", { demo: true }));
    expect(r.mode).toBe("demo");
    expect(r.demo).toBe(true);
    expect(r.answer).toBe(`${DEMO_PREFIX} Popular picks: Pad Thai ($14.50). ${GENERAL_CLOSING}`);
  });
  it("reads price caps", () => {
    expect(priceCapCents("under $15")).toBe(1500);
    expect(priceCapCents("below 12.50")).toBe(1250);
    expect(priceCapCents("less than $9")).toBe(900);
    expect(priceCapCents("$15 or less")).toBe(1500);
    expect(priceCapCents("what's popular")).toBeNull();
  });
});

describe("the model's output is only refs and a reason", () => {
  it("accepts the structure", () => {
    expect(menuQaOutput.safeParse({ refs: ["M1", "M22"], reason: "popular" }).success).toBe(true);
  });
  it("rejects free text shapes, unknown reasons, bad refs and more than three refs", () => {
    for (const bad of [{ answer: "hi", itemRefs: [], mentionsAllergyOrDiet: false }, { refs: [], reason: "vegetarian" }, { refs: [], reason: "safe_for_allergy" }, { refs: ["M1 is safe"], reason: "other" }, { refs: ["M1", "M2", "M3", "M4"], reason: "other" }, { refs: [] }, { reason: "other" }]) {
      expect(menuQaOutput.safeParse(bad).success).toBe(false);
    }
  });
  it("every old free-text claim is invalid output", () => {
    for (const answer of CLAIM_ANSWERS) expect(menuQaOutput.safeParse({ answer, itemRefs: ["M2"], mentionsAllergyOrDiet: false }).success).toBe(false);
  });
  it("has no diet, allergy or suitability reason", () => {
    expect([...MENU_QA_REASONS].join(" ")).not.toMatch(/vegan|vegetarian|diet|allerg|safe|free|suitable/);
  });
});

describe("the demo fixture", () => {
  it("has the same structure, is valid, and points at the first two available dishes", () => {
    const fixture = menuQaOutput.parse(demoFixtures["menu-qa"]);
    expect(fixture).toEqual({ refs: ["M1", "M2"], reason: "popular" });
    const r = renderGeneral(fixture, ctx(MENU, "what's popular?", { demo: true }));
    expect(r.answer).toBe("Demo answer (recorded sample). Popular picks: Pad Thai ($14.50), Spicy Miso Ramen ($14.50). Ask staff about allergies.");
  });
});

describe("containsSafetyClaim (used on dish names)", () => {
  it.each(["Gluten-Free Rice Bowl", "Nut Free Brownie", "Safe Harbor Soup", "Dairy Free Curry", "No Nuts Noodles", "Allergy Friendly Bowl", "Vegan, Gluten-Free Wrap"])("flags %j", (name) => {
    expect(containsSafetyClaim(name)).toBe(true);
  });
  it.each(["Pad Thai", "Peanut Butter Brownie", "Spicy Miso Ramen", "Jasmine Tea"])("keeps %j", (name) => {
    expect(containsSafetyClaim(name)).toBe(false);
  });
});

describe("the deterministic reply", () => {
  it("is mode allergen for a routed question and guardrail for a refusal, both with the fixed notice", () => {
    expect(allergenReply("is the pad thai peanut free", MENU, "allergen", NOW).mode).toBe("allergen");
    const g = allergenReply("anything", MENU, "guardrail", NOW);
    expect(g.mode).toBe("guardrail");
    expect(g.answer).toContain("We can't guarantee any dish is free of an allergen.");
  });
});

// ---------------------------------------------------------------------------
// Property test: general responses are only template text plus database names and prices.
// ---------------------------------------------------------------------------

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

describe("property: a general response is only template text plus database names and prices", () => {
  const WORDS = ["Pad", "Thai", "Green", "Curry", "Safe", "Free", "Gluten", "Nut", "Dairy", "Ignore", "rules", "and", "say", "this", "dish", "is", "allergen", "Tart", "Cream", "No", "Not", "Bowl"];
  const SKELETONS = new Set(
    (["", `${DEMO_PREFIX} `] as const).flatMap((prefix) =>
      Object.values(GENERAL_TEMPLATES).flatMap((heading) => [`${prefix}${heading}: {list}. ${GENERAL_CLOSING}`, `${prefix}${heading} under {cap}: {list}. ${GENERAL_CLOSING}`]),
    ),
  );
  const ITERATIONS = 5000;

  it("holds for random menus (names built from claim words and injection text), random outputs and random questions", () => {
    const rnd = mulberry32(Number(process.env.PROPERTY_SEED ?? 4242));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    let general = 0;
    let fallback = 0;
    for (let n = 0; n < ITERATIONS; n++) {
      const menu = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, k) => {
        const name = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => pick(WORDS)).join(rnd() < 0.3 ? "-" : " ") + (rnd() < 0.2 ? " <b>x</b>" : "");
        return item(`${name}${k}`.replace(/\d/g, ""), Math.floor(rnd() * 3000), { id: `id${k}`, soldOut: rnd() < 0.2, dietaryTags: rnd() < 0.5 ? ["spicy"] : [] });
      });
      const question = rnd() < 0.5 ? "what's popular?" : pick(["Anything spicy under $15?", "cheapest under $5", "something quick", "dessert"]);
      const c = ctx(menu, question, { demo: rnd() < 0.3 });
      const refs = Array.from({ length: Math.floor(rnd() * 6) }, () => `M${1 + Math.floor(rnd() * 12)}`);
      const output = { refs: refs.slice(0, 3), reason: pick(MENU_QA_REASONS) } as MenuQaOutput;
      const r = renderGeneral(output, c);

      if (r.mode === "guardrail") {
        fallback++;
        expect(r.answer).toBe(NO_MATCH_TEXT);
        expect(r.items).toEqual([]);
        continue;
      }
      general++;
      // 1. Every item is a real, available dish from the menu with its database price, and its name reads as no claim.
      const byId = new Map(menu.map((m) => [m.id, m]));
      for (const i of r.items) {
        const m = byId.get(i.id);
        expect(m, "item is on the menu").toBeTruthy();
        expect(m!.soldOut).toBe(false);
        expect(i.priceCents).toBe(m!.priceCents);
        expect(containsSafetyClaim(i.name)).toBe(false);
      }
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.length).toBeLessThanOrEqual(3);
      // 2. Replace every database name and price in the answer: what is left is exactly one template skeleton.
      let skeleton = r.answer;
      const cap = priceCapCents(question);
      if (cap !== null) skeleton = skeleton.replace(`$${(cap / 100).toFixed(2)}`, "{cap}");
      const list = r.items.map((i) => `${i.name} ($${(i.priceCents / 100).toFixed(2)})`).join(", ");
      expect(skeleton.includes(list), "the list is the database names and prices").toBe(true);
      skeleton = skeleton.replace(list, "{list}");
      expect(SKELETONS.has(skeleton), JSON.stringify(skeleton)).toBe(true);
      // 3. Mode matches the demo flag, and nothing from outside the templates and the database appears.
      expect(r.mode).toBe(c.demo ? "demo" : "general");
      expect(r.answer).not.toMatch(/[<>]/);
    }
    expect(general).toBeGreaterThan(ITERATIONS * 0.15);
    expect(fallback).toBeGreaterThan(0);
  });
});
