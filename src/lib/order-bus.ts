import "server-only";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";

/**
 * In-process order bus. One container on Oracle, so one process hears every committed change.
 * With more than one instance this process-local fan-out misses events; replace `publish` with
 * Postgres `LISTEN/NOTIFY` and keep the same event shape (see the README).
 *
 * The bus event includes `customerId` so a stream can filter. What leaves the process on the
 * wire is a smaller object, built by the stream, never this one.
 */
export type OrderBusEvent = { orderId: string; version: number; customerId: string };

/** Spec caps: a 4th stream for one user, or the 101st stream overall, is refused. */
export const ORDER_STREAMS_PER_USER = 3;
export const ORDER_STREAMS_TOTAL = 100;

type Listener = (event: OrderBusEvent) => void;

/**
 * The bus state lives on `globalThis`, not in module scope. Next.js bundles route handlers (the SSE stream) and pages
 * with their server actions (the kitchen board, checkout, the tracker's cancel) separately, so each bundle gets its own
 * copy of this module; module-level state would give each its own bus, and a change made through a server action would
 * never reach a stream. One process, one bus.
 */
type BusState = { listeners: Set<Listener>; perUser: Map<string, number>; total: number };
const BUS_KEY = Symbol.for("restaurant-ordering.order-bus");
const state: BusState = ((globalThis as { [BUS_KEY]?: BusState })[BUS_KEY] ??= { listeners: new Set(), perUser: new Map(), total: 0 });
const { listeners, perUser } = state;

function clean(event: OrderBusEvent): OrderBusEvent {
  return { orderId: event.orderId, version: event.version, customerId: event.customerId };
}

export const orderBus = {
  /** Deliver a committed change. One listener throwing must not stop the others or the caller. */
  publish(event: OrderBusEvent): void {
    const payload = clean(event);
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (err) {
        log.error("order.bus.listener_failed", safeErrorFields(err));
      }
    }
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Take one stream slot. Synchronous, so two requests can't both pass the check:
   * Node runs this to completion before the next one starts.
   */
  tryAcquire(userId: string): boolean {
    const mine = perUser.get(userId) ?? 0;
    if (mine >= ORDER_STREAMS_PER_USER || state.total >= ORDER_STREAMS_TOTAL) return false;
    perUser.set(userId, mine + 1);
    state.total += 1;
    return true;
  },

  /** Give a slot back. Extra releases (a double cancel) do not drive the count negative. */
  release(userId: string): void {
    const mine = perUser.get(userId) ?? 0;
    if (mine <= 0 || state.total <= 0) return;
    state.total -= 1;
    if (mine === 1) perUser.delete(userId);
    else perUser.set(userId, mine - 1);
  },

  total(): number {
    return state.total;
  },

  countFor(userId: string): number {
    return perUser.get(userId) ?? 0;
  },

  /** Tests only. Does not stop timers owned by an open stream; cancel the response first. */
  resetForTests(): void {
    listeners.clear();
    perUser.clear();
    state.total = 0;
  },
};
