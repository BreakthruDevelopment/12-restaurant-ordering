"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Panel } from "@/components/ui";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { placeOrderAction } from "@/app/actions/orders";
import type { MenuItemLite } from "@/components/restaurant/menu-lite";
import { useCart } from "@/components/restaurant/use-cart";
import { allergenConflicts } from "@/lib/allergen-match";
import { type KeyedAttempt, attemptFor, buildCheckoutRequest } from "@/lib/checkout";
import type { Allergen } from "@/lib/db/schema";
import { ALLERGEN_LABELS, ALLERGEN_ORDER, declarationLabel, formatPrice } from "@/lib/labels";

const choice =
  "flex min-h-11 cursor-pointer items-center gap-3 rounded-card border border-border bg-surface px-3 py-2 text-sm font-medium has-[:checked]:border-accent has-[:checked]:bg-accent-soft";

/**
 * Pickup name, note, the required allergy question and "Place order". If a dish declares an allergen the customer
 * picked (wheat and gluten count as one), those dishes are listed in red and the customer must tick "I'll confirm with
 * staff before eating". The server applies the same rule (409 allergy_confirmation_required) and its list wins.
 */
export function CheckoutForm({ userId, defaultName, items, acceptingOrders }: { userId: string; defaultName: string; items: MenuItemLite[]; acceptingOrders: boolean }) {
  const router = useRouter();
  const { cart, clear, ready } = useCart(userId);
  const [pickupName, setPickupName] = useState(defaultName);
  const [note, setNote] = useState("");
  const [hasAllergy, setHasAllergy] = useState<boolean | null>(null);
  const [allergens, setAllergens] = useState<Allergen[]>([]);
  const [allergyNote, setAllergyNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [serverConflicts, setServerConflicts] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<KeyedAttempt | null>(null);

  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = cart.lines.map((l) => ({ ...l, item: byId.get(l.itemId), declared: byId.get(l.itemId)?.allergens ?? [] }));
  const unavailable = lines.filter((l) => !l.item || l.item.soldOut);
  const subtotal = lines.reduce((sum, l) => sum + (l.item ? l.item.priceCents * l.qty : 0), 0);
  const localConflicts = hasAllergy ? allergenConflicts(lines, allergens) : [];
  const conflictIds = new Set([...localConflicts.map((l) => l.itemId), ...(hasAllergy ? serverConflicts : [])]);
  const conflicts = lines.filter((l) => conflictIds.has(l.itemId));

  if (!ready) return <Panel title="Your order"><p className="text-muted">Loading your cart…</p></Panel>;
  if (lines.length === 0) {
    return (
      <Panel title="Your order">
        <p className="mb-4 text-muted">Your cart is empty.</p>
        <Link href="/menu" className={buttonPrimary}>
          Browse the menu
        </Link>
      </Panel>
    );
  }

  function toggleAllergen(a: Allergen) {
    setAllergens((cur) => (cur.includes(a) ? cur.filter((x) => x !== a) : [...cur, a]));
    setServerConflicts([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (hasAllergy === null) return setError("Answer the allergy question to continue.");
    if (hasAllergy && allergens.length === 0 && !allergyNote.trim()) return setError("Pick the allergens or describe the allergy.");
    if (conflicts.length > 0 && !confirm) return setError("Tick “I'll confirm with staff before eating” to continue.");
    const request = buildCheckoutRequest({ lines: cart.lines, pickupName, note, hasAllergy, allergens, allergyNote, conflicts: conflicts.length > 0, confirmWithStaff: confirm });
    attempt.current = attemptFor(attempt.current, request, () => crypto.randomUUID());
    setPending(true);
    const result = await placeOrderAction({ ...request, idempotencyKey: attempt.current.key });
    if (result.ok) {
      clear();
      router.push(`/orders/${result.data.orderId}`);
      return;
    }
    setPending(false);
    const details = (result.details ?? {}) as { code?: string; items?: { itemId: string }[] };
    if (details.code === "allergy_confirmation_required" && Array.isArray(details.items)) {
      setServerConflicts(details.items.map((i) => i.itemId));
      setError("Some dishes declare an allergen you picked. Review them below and confirm you'll check with staff.");
      return;
    }
    if (details.code === "idempotency_key_reused") attempt.current = null;
    setError(result.error);
    router.refresh(); // pick up sold-out dishes or a closed kitchen
  }

  return (
    <form onSubmit={submit} className="space-y-0" noValidate>
      <Panel title="Your order" count={lines.length}>
        <ul className="divide-y divide-border">
          {lines.map((l) => (
            <li key={l.itemId} className="flex items-start justify-between gap-3 py-2">
              <span className="min-w-0 break-words">
                {l.qty} × {l.item?.name ?? "A dish that is no longer on the menu"}
                {l.item?.soldOut && <span className="ml-2 text-sm font-semibold text-blocked">Sold out</span>}
              </span>
              <span className="shrink-0 font-mono text-sm">{l.item ? formatPrice(l.item.priceCents * l.qty) : "—"}</span>
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between border-t border-border pt-2 font-semibold">
          <span>Subtotal (pay at pickup)</span>
          <span className="font-mono">{formatPrice(subtotal)}</span>
        </p>
        <Link href="/cart" className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-accent underline underline-offset-2">
          Change the cart
        </Link>
      </Panel>

      <Panel title="Pickup">
        <div className="space-y-4">
          <label className={labelClass}>
            <span>Name for pickup</span>
            <input value={pickupName} onChange={(e) => setPickupName(e.target.value)} maxLength={40} required autoComplete="given-name" className={inputClass} />
          </label>
          <label className={labelClass}>
            <span>Note for the kitchen (optional)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} rows={2} className={inputClass} />
          </label>
        </div>
      </Panel>

      <Panel title="Allergies">
        <fieldset className="space-y-3">
          <legend className="mb-2 font-semibold">Does anyone in this order have a food allergy?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={choice}>
              <input type="radio" name="has-allergy" checked={hasAllergy === true} onChange={() => setHasAllergy(true)} className="size-5" required />
              Yes
            </label>
            <label className={choice}>
              <input type="radio" name="has-allergy" checked={hasAllergy === false} onChange={() => setHasAllergy(false)} className="size-5" />
              No
            </label>
          </div>
        </fieldset>

        {hasAllergy && (
          <div className="mt-4 space-y-4">
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">Which allergens?</legend>
              <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2 md:grid-cols-3">
                {ALLERGEN_ORDER.map((a) => (
                  <label key={a} className={choice}>
                    <input type="checkbox" checked={allergens.includes(a)} onChange={() => toggleAllergen(a)} className="size-5" />
                    {ALLERGEN_LABELS[a]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className={labelClass}>
              <span>Anything else staff should know (optional)</span>
              <textarea value={allergyNote} onChange={(e) => setAllergyNote(e.target.value)} maxLength={200} rows={2} className={inputClass} />
            </label>
            <p className="text-sm text-muted">Staff will review your allergy with the kitchen before they start your order.</p>
          </div>
        )}

        {hasAllergy && conflicts.length > 0 && (
          <div className="mt-4 rounded-card border-2 border-blocked bg-blocked-soft p-4 text-blocked">
            <p className="font-semibold">These dishes declare an allergen you picked:</p>
            <ul className="mt-2 space-y-1">
              {conflicts.map((l) => (
                <li key={l.itemId} className="break-words">
                  <span className="font-semibold">{l.item?.name ?? "A dish"}</span>
                  {l.declared.length > 0 && <span>: {l.declared.map(declarationLabel).join(", ")}</span>}
                </li>
              ))}
            </ul>
            <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
              <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="size-5" />
              I&apos;ll confirm with staff before eating
            </label>
          </div>
        )}
      </Panel>

      {!acceptingOrders && <p role="status" className="mb-4 font-semibold text-blocked">We&apos;re not taking orders right now.</p>}
      {unavailable.length > 0 && <p className="mb-4 font-semibold text-blocked">Some dishes are unavailable. Change the cart to continue.</p>}
      {error && (
        <p role="alert" className="mb-4 font-medium text-danger">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending || !acceptingOrders || unavailable.length > 0} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Placing your order…" : `Place order · ${formatPrice(subtotal)}`}
      </button>
    </form>
  );
}
