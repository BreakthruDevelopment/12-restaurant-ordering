/**
 * The cart lives in the browser (localStorage), keyed per signed-in customer: it holds item ids and quantities only.
 * Prices, names and availability always come from the server's menu, and placeOrder() re-reads them at order time.
 */

export type CartLine = { itemId: string; qty: number };
export type Cart = { lines: CartLine[] };

export const MAX_QTY = 20;
export const MAX_LINES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EMPTY_CART: Cart = { lines: [] };

export function cartStorageKey(userId: string): string {
  return `restaurant-cart:v1:${userId}`;
}

const clampQty = (n: number) => Math.min(MAX_QTY, Math.max(1, Math.trunc(n)));

/** Whatever is in storage, as a valid cart: bad JSON, bad ids, duplicates and out-of-range quantities are dropped or clamped. */
export function parseCart(raw: string | null | undefined): Cart {
  if (!raw) return EMPTY_CART;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_CART;
  }
  const lines = (value as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return EMPTY_CART;
  const seen = new Set<string>();
  const out: CartLine[] = [];
  for (const l of lines) {
    const itemId = (l as { itemId?: unknown })?.itemId;
    const qty = (l as { qty?: unknown })?.qty;
    if (typeof itemId !== "string" || !UUID.test(itemId) || seen.has(itemId)) continue;
    if (typeof qty !== "number" || !Number.isFinite(qty) || qty < 1) continue;
    seen.add(itemId);
    out.push({ itemId, qty: clampQty(qty) });
    if (out.length >= MAX_LINES) break;
  }
  return { lines: out };
}

/** Add one (or `qty`) of an item. A new line past the 20-line cap is refused (returns the cart unchanged). */
export function addToCart(cart: Cart, itemId: string, qty = 1): Cart {
  const existing = cart.lines.find((l) => l.itemId === itemId);
  if (existing) return { lines: cart.lines.map((l) => (l.itemId === itemId ? { ...l, qty: clampQty(l.qty + qty) } : l)) };
  if (cart.lines.length >= MAX_LINES) return cart;
  return { lines: [...cart.lines, { itemId, qty: clampQty(qty) }] };
}

/** Set a line's quantity; 0 or less removes it. */
export function setQty(cart: Cart, itemId: string, qty: number): Cart {
  if (qty < 1) return { lines: cart.lines.filter((l) => l.itemId !== itemId) };
  return { lines: cart.lines.map((l) => (l.itemId === itemId ? { ...l, qty: clampQty(qty) } : l)) };
}

export function cartCount(cart: Cart): number {
  return cart.lines.reduce((n, l) => n + l.qty, 0);
}
