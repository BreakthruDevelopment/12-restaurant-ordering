import { describe, expect, it } from "vitest";
import { EMPTY_CART, MAX_LINES, MAX_QTY, addToCart, cartCount, cartStorageKey, parseCart, setQty } from "./cart";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("cart", () => {
  it("parses only valid lines from storage", () => {
    expect(parseCart(null)).toEqual(EMPTY_CART);
    expect(parseCart("{nope")).toEqual(EMPTY_CART);
    expect(parseCart(JSON.stringify({ lines: "x" }))).toEqual(EMPTY_CART);
    const raw = JSON.stringify({
      lines: [
        { itemId: id(1), qty: 2 },
        { itemId: id(1), qty: 5 }, // duplicate: dropped
        { itemId: "not-a-uuid", qty: 1 },
        { itemId: id(2), qty: 0 },
        { itemId: id(3), qty: 99 }, // clamped
        { itemId: id(4), qty: 1.7, priceCents: 1 }, // truncated; extra keys ignored
      ],
    });
    expect(parseCart(raw)).toEqual({ lines: [{ itemId: id(1), qty: 2 }, { itemId: id(3), qty: MAX_QTY }, { itemId: id(4), qty: 1 }] });
  });

  it("caps lines at 20 when parsing and adding", () => {
    const many = { lines: Array.from({ length: 25 }, (_, i) => ({ itemId: id(i + 1), qty: 1 })) };
    const cart = parseCart(JSON.stringify(many));
    expect(cart.lines).toHaveLength(MAX_LINES);
    expect(addToCart(cart, id(99))).toBe(cart);
    expect(addToCart(cart, id(1)).lines[0].qty).toBe(2);
  });

  it("adds, sets, removes and counts", () => {
    let cart = addToCart(EMPTY_CART, id(1));
    cart = addToCart(cart, id(1));
    cart = addToCart(cart, id(2), 3);
    expect(cartCount(cart)).toBe(5);
    cart = setQty(cart, id(1), 50);
    expect(cart.lines[0].qty).toBe(MAX_QTY);
    cart = setQty(cart, id(1), 0);
    expect(cart.lines).toEqual([{ itemId: id(2), qty: 3 }]);
  });

  it("keys the cart per customer", () => {
    expect(cartStorageKey("a")).not.toBe(cartStorageKey("b"));
  });
});
