import "server-only";
import { orderAccess } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { orderBus, type OrderBusEvent } from "@/lib/order-bus";
import { safeErrorFields } from "@/lib/safe-error";

/** How often a connected stream writes a comment so proxies don't close an idle connection. */
export const ORDER_STREAM_HEARTBEAT_MS = 25_000;
/** After this the stream closes. The client reconnects, which checks the session again. */
export const ORDER_STREAM_LIFETIME_MS = 10 * 60 * 1000;

export const ORDER_STREAM_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

const encoder = new TextEncoder();
const OPEN = encoder.encode(": open\n\n");
const HEARTBEAT = encoder.encode(": heartbeat\n\n");

/** The only bytes a client is allowed to see for one change. No customer id, no order body. */
export function encodeOrderSignal(event: { orderId: string; version: number }): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ orderId: event.orderId, version: event.version })}\n\n`);
}

function every(ms: number, fn: () => void): ReturnType<typeof setInterval> {
  const id = setInterval(fn, ms);
  id.unref?.();
  return id;
}

function later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const id = setTimeout(fn, ms);
  id.unref?.();
  return id;
}

/**
 * Open one SSE stream for `actor`. Admins are refused (404) before a slot is taken.
 * Customers receive events for their own orders; staff receive every order. Either way the
 * payload is `{orderId, version}` only, so a filter bug leaks an id and a version, not the order.
 */
export function openOrderStream(actor: Actor, signal?: AbortSignal): Response {
  const access = orderAccess(actor);
  if (!orderBus.tryAcquire(actor.id)) {
    log.info("order.stream.rejected", { userId: actor.id, role: actor.role });
    throw new TooManyRequestsError("Too many live order streams. Poll for updates instead.");
  }

  let closed = false;
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let lifetime: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};

  const releaseOnce = (closeController: boolean) => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    if (lifetime) clearTimeout(lifetime);
    unsubscribe?.();
    signal?.removeEventListener("abort", onAbort);
    orderBus.release(actor.id);
    log.info("order.stream.close", { userId: actor.id });
    if (closeController) {
      try {
        ctrl?.close();
      } catch {
        // The consumer already cancelled, which closes the controller itself.
      }
    }
  };

  onAbort = () => releaseOnce(true);

  const onEvent = (event: OrderBusEvent) => {
    if (closed) return;
    if (access.kind === "customer" && event.customerId !== access.customerId) return;
    if (typeof event.orderId !== "string" || typeof event.version !== "number") return;
    try {
      ctrl?.enqueue(encodeOrderSignal({ orderId: event.orderId, version: event.version }));
    } catch (err) {
      log.error("order.stream.enqueue_failed", { userId: actor.id, ...safeErrorFields(err) });
      releaseOnce(true);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (closed) return;
      ctrl = controller;
      // Subscribe before the open comment, and before this function returns, so a change
      // committed after the caller sees ": open" cannot be missed.
      unsubscribe = orderBus.subscribe(onEvent);
      heartbeat = every(ORDER_STREAM_HEARTBEAT_MS, () => {
        if (closed) return;
        try {
          controller.enqueue(HEARTBEAT);
        } catch {
          releaseOnce(true);
        }
      });
      lifetime = later(ORDER_STREAM_LIFETIME_MS, () => releaseOnce(true));
      controller.enqueue(OPEN);
      log.info("order.stream.open", { userId: actor.id, role: actor.role });
    },
    cancel() {
      releaseOnce(false);
    },
  });

  if (signal) {
    if (signal.aborted) releaseOnce(true);
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  return new Response(stream, { headers: ORDER_STREAM_HEADERS });
}
