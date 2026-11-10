import { describe, expect, it } from "vitest";
import { ORDER_STATUSES, type OrderStatus } from "@/lib/db/schema";
import { allergenConflicts, checkTransition, formatOrderNumber, subtotalCents, verificationStatus } from "./order-rules";

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
