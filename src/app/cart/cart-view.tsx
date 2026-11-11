"use client";

import Link from "next/link";
import { Panel } from "@/components/ui";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { AllergenChips } from "@/components/restaurant/allergen-chips";
import type { MenuItemLite } from "@/components/restaurant/menu-lite";
import { useCart } from "@/components/restaurant/use-cart";
import { MAX_QTY, setQty } from "@/lib/cart";
import { formatPrice } from "@/lib/labels";

const stepper = "inline-flex size-11 items-center justify-center rounded-card border border-border bg-surface text-lg font-semibold hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60";

export function CartView({ userId, items, acceptingOrders }: { userId: string; items: MenuItemLite[]; acceptingOrders: boolean }) {
  const { cart, update, ready } = useCart(userId);
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = cart.lines.map((l) => ({ ...l, item: byId.get(l.itemId) }));
  const unavailable = lines.filter((l) => !l.item || l.item.soldOut);
  const subtotal = lines.reduce((sum, l) => sum + (l.item && !l.item.soldOut ? l.item.priceCents * l.qty : 0), 0);

  if (!ready) return <Panel title="Dishes"><p className="text-muted">Loading your cart…</p></Panel>;
  if (lines.length === 0) {
    return (
      <Panel title="Dishes">
        <p className="mb-4 text-muted">Your cart is empty.</p>
        <Link href="/menu" className={buttonPrimary}>
          Browse the menu
        </Link>
      </Panel>
    );
  }

  return (
    <>
      <Panel title="Dishes" count={lines.length}>
        <ul className="divide-y divide-border">
          {lines.map((l) => (
            <li key={l.itemId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold break-words">{l.item?.name ?? "A dish that is no longer on the menu"}</p>
                {l.item && <p className="font-mono text-sm">{formatPrice(l.item.priceCents)} each</p>}
                {l.item && <AllergenChips allergens={l.item.allergens} />}
                {(!l.item || l.item.soldOut) && <p className="text-sm font-semibold text-blocked">{l.item ? "Sold out: remove it to order." : "Remove it to order."}</p>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button type="button" className={stepper} aria-label={`One fewer ${l.item?.name ?? "of this dish"}`} onClick={() => update((c) => setQty(c, l.itemId, l.qty - 1))}>
                  −
                </button>
                <span className="w-8 text-center font-semibold" aria-label={`Quantity ${l.qty}`}>
                  {l.qty}
                </span>
                <button type="button" className={stepper} disabled={l.qty >= MAX_QTY} aria-label={`One more ${l.item?.name ?? "of this dish"}`} onClick={() => update((c) => setQty(c, l.itemId, l.qty + 1))}>
                  +
                </button>
                <button type="button" className={`${buttonSecondary} ml-2`} onClick={() => update((c) => setQty(c, l.itemId, 0))}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
      <Panel title="Total">
        <p className="mb-1 flex justify-between font-semibold">
          <span>Subtotal</span>
          <span className="font-mono">{formatPrice(subtotal)}</span>
        </p>
        <p className="mb-4 text-sm text-muted">Prices are confirmed when you place the order. Pay at pickup.</p>
        {!acceptingOrders && <p role="status" className="mb-3 text-sm font-semibold text-blocked">We&apos;re not taking orders right now.</p>}
        {unavailable.length > 0 && <p className="mb-3 text-sm font-semibold text-blocked">Remove the unavailable dishes to continue.</p>}
        <div className="flex flex-wrap gap-3">
          {acceptingOrders && unavailable.length === 0 ? (
            <Link href="/checkout" className={`${buttonPrimary} w-full sm:w-auto`}>
              Go to checkout
            </Link>
          ) : (
            <button type="button" disabled className={`${buttonPrimary} w-full sm:w-auto`}>
              Go to checkout
            </button>
          )}
          <Link href="/menu" className={`${buttonSecondary} w-full sm:w-auto`}>
            Add more dishes
          </Link>
        </div>
      </Panel>
    </>
  );
}
