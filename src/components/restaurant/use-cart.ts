"use client";

import { useCallback, useSyncExternalStore } from "react";
import { type Cart, EMPTY_CART, cartStorageKey, parseCart } from "@/lib/cart";

const EVENT = "restaurant-cart-change";
let cachedRaw: string | null | undefined;
let cachedCart: Cart = EMPTY_CART;

function read(key: string): Cart {
  const raw = typeof window === "undefined" ? null : window.localStorage.getItem(key);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedCart = parseCart(raw);
  }
  return cachedCart;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** The signed-in customer's cart from localStorage, shared by every component on the page and across tabs. */
export function useCart(userId: string): { cart: Cart; update: (fn: (cart: Cart) => Cart) => void; clear: () => void; ready: boolean } {
  const key = cartStorageKey(userId);
  const cart = useSyncExternalStore(subscribe, () => read(key), () => EMPTY_CART);
  // False during the server render and hydration, so pages don't flash "Your cart is empty" before storage is read.
  const ready = useSyncExternalStore(subscribe, () => true, () => false);
  const update = useCallback(
    (fn: (cart: Cart) => Cart) => {
      window.localStorage.setItem(key, JSON.stringify(fn(read(key))));
      window.dispatchEvent(new Event(EVENT));
    },
    [key],
  );
  const clear = useCallback(() => {
    window.localStorage.removeItem(key);
    window.dispatchEvent(new Event(EVENT));
  }, [key]);
  return { cart, update, clear, ready };
}
