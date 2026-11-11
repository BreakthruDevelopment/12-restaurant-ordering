"use client";

import { useEffect, useRef, useState } from "react";
import { startOrderEventSubscription, type OrderEventMode, type OrderSignal } from "@/lib/order-events-client";

export type { OrderEventMode, OrderSignal };

/**
 * Subscribe to live order signals.
 *
 * `onEvent` receives `{orderId, version}` only. Refetch `GET /api/orders/[id]` (customer tracker)
 * or `GET /api/orders` (kitchen board) from it; those routes apply the access rules.
 * After two EventSource errors, `onPoll` runs every 5s. Pass `backstop` on the kitchen board
 * so `onPoll` also runs every 15s while the stream is healthy.
 */
export function useOrderEvents(options: {
  onEvent: (event: OrderSignal) => void;
  onPoll: () => void;
  backstop?: boolean;
  enabled?: boolean;
}): { mode: OrderEventMode } {
  const { backstop = false, enabled = true } = options;
  const [mode, setMode] = useState<OrderEventMode>("live");
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    if (!enabled) return;
    return startOrderEventSubscription({
      EventSource: globalThis.EventSource,
      onEvent: (event) => optionsRef.current.onEvent(event),
      onPoll: () => optionsRef.current.onPoll(),
      onMode: setMode,
      backstop,
    });
  }, [enabled, backstop]);

  return { mode };
}
