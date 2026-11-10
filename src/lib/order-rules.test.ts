import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/db/schema";
import { ALLERGENS } from "@/lib/db/schema";
import { RELATED_ALLERGENS, allergenConflicts, checkTransition, expandAllergens, formatOrderNumber, requestHash, subtotalCents, verificationStatus } from "./order-rules";

describe("checkTransition: staff", () => {
  it("walks the chain one step at a time", () => {
    const chain: OrderStatus[] = ["placed", "accepted", "preparing", "ready", "picked_up"];
    for (let i = 0; i < chain.length - 1; i++) expect(checkTransition("staff", chain[i], chain[i + 1])).toEqual({ ok: true });
  });

  it("refuses skipping, going back and standing still", () => {
    expect(checkTransition("staff", "placed", "preparing")).toMatchObject({ ok: false, reason: "not_allowed" });
    expect(checkTransition("staff", "placed", "picked_up")).toMatchObject({ ok: false });
    expect(checkTransition("staff", "ready", "preparing")).toMatchObject({ ok: false });
    expect(checkTransition("staff", "accepted", "accepted")).toMatchObject({ ok: false });
  });

  it("cancels any open order, but only with a reason", () => {
    for (const from of ["placed", "accepted", "preparing", "ready"] as const) {
      expect(checkTransition("staff", from, "cancelled", "Can't safely prepare")).toEqual({ ok: true });
      expect(checkTransition("staff", from, "cancelled")).toMatchObject({ ok: false, reason: "reason_required" });
      expect(checkTransition("staff", from, "cancelled", "   ")).toMatchObject({ ok: false, reason: "reason_required" });
    }
  });

  it("treats picked_up and cancelled as final", () => {
    for (const from of ["picked_up", "cancelled"] as const) {
      for (const to of ORDER_STATUSES) expect(checkTransition("staff", from, to, "x")).toMatchObject({ ok: false, reason: "final" });
    }
  });
});

describe("checkTransition: customer", () => {
  it("may cancel only while placed, with or without a reason", () => {
    expect(checkTransition("customer", "placed", "cancelled")).toEqual({ ok: true });
    expect(checkTransition("customer", "placed", "cancelled", "changed my mind")).toEqual({ ok: true });
    for (const from of ["accepted", "preparing", "ready"] as const) {
      expect(checkTransition("customer", from, "cancelled")).toMatchObject({ ok: false, reason: "not_allowed" });
    }
  });

  it("can never move an order forward", () => {
    expect(checkTransition("customer", "placed", "accepted")).toMatchObject({ ok: false, reason: "forbidden" });
    expect(checkTransition("customer", "ready", "picked_up")).toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("allergenConflicts", () => {
  const lines = [
    { name: "Pad Thai", declared: [{ allergen: "peanuts", level: "contains" }, { allergen: "egg", level: "contains" }] },
    { name: "Soup", declared: [{ allergen: "milk", level: "may_contain" }] },
    { name: "Rice", declared: [] },
  ] as const;

  it("flags dishes that contain or may contain a picked allergen", () => {
    expect(allergenConflicts(lines, ["peanuts"]).map((l) => l.name)).toEqual(["Pad Thai"]);
    expect(allergenConflicts(lines, ["milk", "egg"]).map((l) => l.name)).toEqual(["Pad Thai", "Soup"]);
  });

  it("flags nothing when no declared allergen matches (and never treats 'not declared' as safe)", () => {
    expect(allergenConflicts(lines, ["sesame"])).toEqual([]);
    expect(allergenConflicts(lines, [])).toEqual([]);
  });
});

describe("money and numbers", () => {
  it("sums integer cents", () => {
    expect(subtotalCents([{ unitPriceCents: 1450, qty: 2 }, { unitPriceCents: 305, qty: 3 }])).toBe(3815);
    expect(subtotalCents([])).toBe(0);
  });

  it("formats daily numbers", () => {
    expect(formatOrderNumber(1)).toBe("A-001");
    expect(formatOrderNumber(42)).toBe("A-042");
    expect(formatOrderNumber(1234)).toBe("A-1234");
  });
});

describe("verificationStatus", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  it("is never without a stamp, current inside 90 days and stale after", () => {
    expect(verificationStatus(null, now)).toBe("never");
    expect(verificationStatus(new Date("2026-11-01T00:00:00Z"), now)).toBe("current");
    expect(verificationStatus(new Date("2026-08-12T12:00:00Z"), now)).toBe("current"); // exactly 90 days
    expect(verificationStatus(new Date("2026-08-12T11:59:00Z"), now)).toBe("stale");
  });
});

describe("expandAllergens and related allergens", () => {
  it("links gluten and wheat in both directions", () => {
    expect([...expandAllergens(["gluten"])].sort()).toEqual(["gluten", "wheat"]);
    expect([...expandAllergens(["wheat"])].sort()).toEqual(["gluten", "wheat"]);
    expect([...expandAllergens(["wheat", "gluten"])].sort()).toEqual(["gluten", "wheat"]);
  });

  it("leaves every other allergen alone", () => {
    for (const a of ALLERGENS.filter((x) => x !== "wheat" && x !== "gluten")) expect([...expandAllergens([a])]).toEqual([a]);
    expect([...expandAllergens([])]).toEqual([]);
  });

  it("only relates allergens that exist in the list, and each pair is symmetric by construction", () => {
    for (const [a, b] of RELATED_ALLERGENS) {
      expect(ALLERGENS).toContain(a);
      expect(ALLERGENS).toContain(b);
      expect(expandAllergens([a]).has(b)).toBe(true);
      expect(expandAllergens([b]).has(a)).toBe(true);
    }
  });

  it("makes a gluten pick match a wheat-only dish (the demo's Crispy Tofu Bites) and wheat match gluten-only", () => {
    const tofu = { name: "Crispy Tofu Bites", declared: [{ allergen: "wheat", level: "may_contain" }] } as const;
    const bun = { name: "Bun", declared: [{ allergen: "gluten", level: "contains" }] } as const;
    expect(allergenConflicts([tofu], ["gluten"]).map((l) => l.name)).toEqual(["Crispy Tofu Bites"]);
    expect(allergenConflicts([bun], ["wheat"]).map((l) => l.name)).toEqual(["Bun"]);
    expect(allergenConflicts([tofu, bun], ["peanuts", "tree_nuts"])).toEqual([]);
  });
});

describe("requestHash", () => {
  const base = { lines: [{ itemId: "a", qty: 1 }, { itemId: "b", qty: 2 }], pickupName: "Sam", note: "", allergy: { has: false, allergens: [], note: "", confirmWithStaff: false } };

  it("is stable across line order and allergen order", () => {
    expect(requestHash({ ...base, lines: [...base.lines].reverse() })).toBe(requestHash(base));
    const a = { ...base, allergy: { has: true, allergens: ["milk", "egg"], note: "n", confirmWithStaff: true } };
    expect(requestHash({ ...a, allergy: { ...a.allergy, allergens: ["egg", "milk"] } })).toBe(requestHash(a));
  });

  it("changes with anything the customer asked for, the allergy answer first of all", () => {
    const h = requestHash(base);
    for (const other of [
      { ...base, allergy: { ...base.allergy, has: true, allergens: ["peanuts"] } },
      { ...base, allergy: { ...base.allergy, has: true, note: "celery" } },
      { ...base, pickupName: "Other" },
      { ...base, note: "x" },
      { ...base, lines: [{ itemId: "a", qty: 2 }, { itemId: "b", qty: 2 }] },
      { ...base, lines: [{ itemId: "a", qty: 1 }] },
    ]) expect(requestHash(other)).not.toBe(h);
  });

  it("ignores a confirmation that means nothing without an allergy", () => {
    expect(requestHash({ ...base, allergy: { ...base.allergy, confirmWithStaff: true } })).toBe(requestHash(base));
  });
});
