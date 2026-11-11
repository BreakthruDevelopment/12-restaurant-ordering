import { describe, expect, it } from "vitest";
import { ALLERGENS, ORDER_STATUSES } from "@/lib/db/schema";
import { ALLERGEN_LABELS, ALLERGEN_ORDER, NEXT_STEP, STATUS_LABELS, declarationLabel, formatPrice, formatTime, parsePrice } from "./labels";
import { checkTransition } from "./order-rules";

describe("labels", () => {
  it("covers every allergen and status, in the schema's order", () => {
    expect(ALLERGEN_ORDER).toEqual([...ALLERGENS]);
    for (const s of ORDER_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
    for (const a of ALLERGENS) expect(ALLERGEN_LABELS[a]).toBeTruthy();
  });

  it("never words a declaration as safe or free", () => {
    for (const a of ALLERGENS) {
      for (const level of ["contains", "may_contain"] as const) expect(declarationLabel({ allergen: a, level })).not.toMatch(/free|safe|✓|✔/i);
    }
    expect(declarationLabel({ allergen: "tree_nuts", level: "may_contain" })).toBe("May contain tree nuts");
  });

  it("offers staff only moves the state machine allows", () => {
    for (const [from, step] of Object.entries(NEXT_STEP)) expect(checkTransition("staff", from as never, step!.to)).toEqual({ ok: true });
  });

  it("formats and parses prices", () => {
    expect(formatPrice(1250)).toBe("$12.50");
    expect(parsePrice("12.5")).toBe(1250);
    expect(parsePrice("$12")).toBe(1200);
    expect(parsePrice("0.05")).toBe(5);
    expect(parsePrice("12.345")).toBeNull();
    expect(parsePrice("-1")).toBeNull();
    expect(parsePrice("abc")).toBeNull();
  });

  it("formats times in the restaurant's zone", () => {
    expect(formatTime("2026-11-11T18:05:00Z", "America/Chicago")).toBe("12:05 PM");
  });
});
