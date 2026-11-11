"use client";

import Link from "next/link";
import { useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { useCart } from "@/components/restaurant/use-cart";
import { MAX_LINES, MAX_QTY, addToCart, cartCount } from "@/lib/cart";

export function AddToCart({ userId, itemId, itemName, disabled }: { userId: string; itemId: string; itemName: string; disabled: boolean }) {
  const { cart, update } = useCart(userId);
  const [message, setMessage] = useState("");
  const inCart = cart.lines.find((l) => l.itemId === itemId)?.qty ?? 0;
  const full = inCart === 0 && cart.lines.length >= MAX_LINES;
  return (
    <div className="mt-auto flex flex-wrap items-center gap-3 pt-1">
      <button
        type="button"
        disabled={disabled || full || inCart >= MAX_QTY}
        onClick={() => {
          update((c) => addToCart(c, itemId));
          setMessage(`Added ${itemName}.`);
        }}
        className={`${buttonPrimary} w-full sm:w-auto`}
        aria-label={`Add ${itemName} to cart`}
      >
        Add to cart
      </button>
      {inCart > 0 && <span className="text-sm text-muted">In cart: {inCart}</span>}
      {full && <span className="text-sm text-muted">Your cart is full ({MAX_LINES} dishes).</span>}
      <span aria-live="polite" className="sr-only">
        {message}
      </span>
    </div>
  );
}

export function CartLink({ userId }: { userId: string }) {
  const { cart } = useCart(userId);
  const n = cartCount(cart);
  return (
    <Link href="/cart" className={buttonSecondary}>
      View cart{n > 0 ? ` (${n})` : ""}
    </Link>
  );
}
