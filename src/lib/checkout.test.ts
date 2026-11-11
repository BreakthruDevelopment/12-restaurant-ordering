import { describe, expect, it } from "vitest";
import { attemptFor, buildCheckoutRequest } from "./checkout";
import { placeOrderInput } from "./orders";

const line = { itemId: "00000000-0000-4000-8000-000000000001", qty: 2 };
const base = { lines: [line], pickupName: " Sam ", note: "", hasAllergy: false, allergens: [], allergyNote: "", conflicts: false, confirmWithStaff: false };

describe("checkout request", () => {
  it("drops allergy details when the answer is No, so the server doesn't refuse them", () => {
    const r = buildCheckoutRequest({ ...base, allergens: ["peanuts"], allergyNote: "severe", confirmWithStaff: true });
    expect(r.allergy).toEqual({ has: false, allergens: [], note: "", confirmWithStaff: false });
    expect(r.pickupName).toBe("Sam");
    expect(placeOrderInput.safeParse({ ...r, idempotencyKey: crypto.randomUUID() }).success).toBe(true);
  });

  it("sends the confirmation only when a dish matched", () => {
    const yes = { ...base, hasAllergy: true, allergens: ["peanuts" as const], confirmWithStaff: true };
    expect(buildCheckoutRequest({ ...yes, conflicts: false }).allergy.confirmWithStaff).toBe(false);
    expect(buildCheckoutRequest({ ...yes, conflicts: true }).allergy.confirmWithStaff).toBe(true);
    expect(placeOrderInput.safeParse({ ...buildCheckoutRequest({ ...yes, conflicts: true }), idempotencyKey: crypto.randomUUID() }).success).toBe(true);
  });

  it("never carries a price", () => {
    const r = buildCheckoutRequest({ ...base, lines: [{ ...line, priceCents: 1 } as typeof line] });
    expect(JSON.stringify(r)).not.toContain("price");
  });
});

describe("idempotency key per attempt", () => {
  let n = 0;
  const key = () => `key-${++n}`;
  it("reuses the key for the same request and makes a new one when it changes", () => {
    const r1 = buildCheckoutRequest(base);
    const a1 = attemptFor(null, r1, key);
    expect(attemptFor(a1, buildCheckoutRequest(base), key)).toBe(a1);
    const a2 = attemptFor(a1, buildCheckoutRequest({ ...base, lines: [{ ...line, qty: 3 }] }), key);
    expect(a2.key).not.toBe(a1.key);
    const a3 = attemptFor(a2, buildCheckoutRequest({ ...base, lines: [{ ...line, qty: 3 }], hasAllergy: true, allergens: ["sesame"] }), key);
    expect(a3.key).not.toBe(a2.key);
  });
});
