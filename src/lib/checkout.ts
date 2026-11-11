import type { Allergen } from "@/lib/db/schema";
import type { CartLine } from "@/lib/cart";

/** The order request the checkout page sends, without its idempotency key. Never carries a price. */
export type CheckoutRequest = {
  lines: CartLine[];
  pickupName: string;
  note: string;
  allergy: { has: boolean; allergens: Allergen[]; note: string; confirmWithStaff: boolean };
};

export function buildCheckoutRequest(input: {
  lines: readonly CartLine[];
  pickupName: string;
  note: string;
  hasAllergy: boolean;
  allergens: readonly Allergen[];
  allergyNote: string;
  /** Whether any dish matches a picked allergen, so the "I'll confirm with staff" tick applies. */
  conflicts: boolean;
  confirmWithStaff: boolean;
}): CheckoutRequest {
  const has = input.hasAllergy;
  return {
    lines: input.lines.map((l) => ({ itemId: l.itemId, qty: l.qty })),
    pickupName: input.pickupName.trim(),
    note: input.note.trim(),
    // With "No", the allergy details are dropped here: the server refuses details sent with has: false.
    allergy: {
      has,
      allergens: has ? [...input.allergens] : [],
      note: has ? input.allergyNote.trim() : "",
      confirmWithStaff: has && input.conflicts && input.confirmWithStaff,
    },
  };
}

export type KeyedAttempt = { key: string; body: string };

/**
 * One idempotency key per checkout attempt: retrying the same request (a double tap, a network retry) reuses the key, so
 * the server returns the first order; any change to the request gets a fresh key, because the server refuses a reused
 * key with a different body (409 idempotency_key_reused).
 */
export function attemptFor(previous: KeyedAttempt | null, request: CheckoutRequest, newKey: () => string): KeyedAttempt {
  const body = JSON.stringify(request);
  if (previous && previous.body === body) return previous;
  return { key: newKey(), body };
}
