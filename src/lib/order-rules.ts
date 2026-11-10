import { createHash } from "node:crypto";
import type { Allergen, AllergenLevel, OrderStatus } from "@/lib/db/schema";

/**
 * Pure rules for orders, kept free of the database so they are easy to test and read in one place.
 */

export const OPEN_STATUSES = ["placed", "accepted", "preparing", "ready"] as const satisfies readonly OrderStatus[];
export const FINAL_STATUSES = ["picked_up", "cancelled"] as const satisfies readonly OrderStatus[];

/** The forward chain. `cancelled` is reachable from every open status and is handled separately. */
const FORWARD: Partial<Record<OrderStatus, OrderStatus>> = {
  placed: "accepted",
  accepted: "preparing",
  preparing: "ready",
  ready: "picked_up",
};

export type Mover = "customer" | "staff";

export type TransitionVerdict = { ok: true } | { ok: false; reason: "final" | "not_allowed" | "forbidden" | "reason_required" };

/**
 * Whether `mover` may take an order from `from` to `to`.
 * - Staff: one step forward along placed, accepted, preparing, ready, picked_up; or cancel any open order with a reason.
 * - Customer: cancel, only while `placed`.
 * The allergy acknowledgment rule needs the order row, so it lives in orders.ts.
 */
export function checkTransition(mover: Mover, from: OrderStatus, to: OrderStatus, reason?: string | null): TransitionVerdict {
  if ((FINAL_STATUSES as readonly string[]).includes(from)) return { ok: false, reason: "final" };
  if (to === "cancelled") {
    if (mover === "customer") return from === "placed" ? { ok: true } : { ok: false, reason: "not_allowed" };
    return reason && reason.trim() ? { ok: true } : { ok: false, reason: "reason_required" };
  }
  if (FORWARD[from] !== to) return { ok: false, reason: "not_allowed" };
  return mover === "staff" ? { ok: true } : { ok: false, reason: "forbidden" };
}

export type Declared = { allergen: Allergen; level: AllergenLevel };

/**
 * Allergens that are sources of one another in the ten-value list. Matching over-warns on purpose: a customer who
 * picks one of a pair is warned about dishes declaring either, in both directions. Reviewed pair by pair:
 * - wheat and gluten: wheat is a source of gluten, and a gluten declaration may stand for wheat. Linked.
 * - peanuts and tree_nuts: separate allergens (peanuts are legumes). Not linked.
 * - fish, crustacean_shellfish, milk, egg, soy, sesame: no other value in the list is a source of them. Not linked.
 * This is the only place the relations live; add a pair here and the tests below cover it.
 */
export const RELATED_ALLERGENS: readonly (readonly [Allergen, Allergen])[] = [["wheat", "gluten"]];

/** The picked allergens plus everything related to them (see RELATED_ALLERGENS). */
export function expandAllergens(picked: readonly Allergen[]): Set<Allergen> {
  const out = new Set<Allergen>(picked);
  for (const [a, b] of RELATED_ALLERGENS) {
    if (out.has(a)) out.add(b);
    if (out.has(b)) out.add(a);
  }
  return out;
}

/** Items whose declaration contains or may contain a picked allergen, or one related to it. */
export function allergenConflicts<T extends { declared: readonly Declared[] }>(lines: readonly T[], picked: readonly Allergen[]): T[] {
  const set = expandAllergens(picked);
  return lines.filter((l) => l.declared.some((d) => set.has(d.allergen)));
}

export type PlaceOrderRequest = {
  lines: readonly { itemId: string; qty: number }[];
  pickupName: string;
  note: string;
  allergy: { has: boolean; allergens: readonly string[]; note: string; confirmWithStaff: boolean };
};

/**
 * SHA-256 of the order the customer asked for, independent of line order and of keys the schema drops. Stored on the
 * order so a retry that reuses an idempotency key with a different body (for example, adding an allergy) is refused
 * instead of silently returning the first order.
 */
export function requestHash(r: PlaceOrderRequest): string {
  const canonical = JSON.stringify({
    lines: [...r.lines].map((l) => [l.itemId, l.qty]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    pickupName: r.pickupName,
    note: r.note,
    allergy: { has: r.allergy.has, allergens: [...r.allergy.allergens].sort(), note: r.allergy.note, confirmWithStaff: r.allergy.has && r.allergy.confirmWithStaff },
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Money is integer cents everywhere. */
export function subtotalCents(lines: readonly { unitPriceCents: number; qty: number }[]): number {
  return lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0);
}

/** `A-042`: three digits at least, more once a day passes 999 orders. */
export function formatOrderNumber(n: number): string {
  return `A-${String(n).padStart(3, "0")}`;
}

export const ALLERGEN_STALE_DAYS = 90;

export type VerificationStatus = "current" | "stale" | "never";

/** "Unverified" for the menu assistant and the UI: no stamp, or a stamp older than 90 days. */
export function verificationStatus(verifiedAt: Date | null, now: Date = new Date()): VerificationStatus {
  if (!verifiedAt) return "never";
  return now.getTime() - verifiedAt.getTime() > ALLERGEN_STALE_DAYS * 86_400_000 ? "stale" : "current";
}
