/**
 * Browser side of the order stream. No server imports: this file is pulled into the client bundle
 * by `useOrderEvents`. The stream is a signal; the page refetches the order through the authorized API.
 */

export const ORDER_STREAM_PATH = "/api/orders/stream";
/** After this many EventSource errors the page stops reconnecting and polls. */
export const ORDER_EVENT_ERRORS_BEFORE_POLL = 2;
export const ORDER_EVENT_POLL_MS = 5_000;
/** Kitchen board backstop while the stream is still up. */
export const ORDER_EVENT_BACKSTOP_MS = 15_000;

export type OrderSignal = { orderId: string; version: number };
export type OrderEventMode = "live" | "polling";

/** Accept a stream payload only when it is a real signal. Extra fields are dropped, not forwarded. */
export function parseOrderSignal(data: string): OrderSignal | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.orderId !== "string" || rec.orderId.length < 1 || rec.orderId.length > 64) return null;
  if (typeof rec.version !== "number" || !Number.isInteger(rec.version) || rec.version < 1 || rec.version > 1_000_000_000) return null;
  return { orderId: rec.orderId, version: rec.version };
}

export type OrderEventSource = {
  addEventListener(type: "message", listener: (ev: Event) => void): void;
  addEventListener(type: "error", listener: (ev: Event) => void): void;
  addEventListener(type: "open", listener: (ev: Event) => void): void;
  removeEventListener(type: "message", listener: (ev: Event) => void): void;
  removeEventListener(type: "error", listener: (ev: Event) => void): void;
  removeEventListener(type: "open", listener: (ev: Event) => void): void;
  /** 0 connecting, 1 open, 2 closed. A closed source will not reconnect on its own. */
  readonly readyState: number;
  close(): void;
};

export type OrderEventSubscription = {
  EventSource: (new (url: string) => OrderEventSource) | undefined;
  onEvent: (event: OrderSignal) => void;
  onPoll: () => void;
  onMode?: (mode: OrderEventMode) => void;
  /** Also call `onPoll` every 15s while the stream is healthy (the kitchen board). */
  backstop?: boolean;
  pollMs?: number;
  backstopMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
};

function eventData(ev: Event): string {
  if (!("data" in ev)) return "";
  const data = (ev as Event & { data?: unknown }).data;
  return typeof data === "string" ? data : "";
}

/**
 * Listen until the stream has failed twice (a 429 or a dead connection both surface as error events),
 * then poll. A successful `open` or `message` clears the error count, so the 10-minute server close
 * reconnects instead of falling back. Returns a stop function.
 */
export function startOrderEventSubscription(deps: OrderEventSubscription): () => void {
  const setInt = deps.setInterval ?? setInterval;
  const clearInt = deps.clearInterval ?? clearInterval;
  const pollMs = deps.pollMs ?? ORDER_EVENT_POLL_MS;
  const backstopMs = deps.backstopMs ?? ORDER_EVENT_BACKSTOP_MS;

  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let backstopTimer: ReturnType<typeof setInterval> | undefined;
  let source: OrderEventSource | undefined;
  let detach = () => {};
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    detach();
    source?.close();
    source = undefined;
    if (pollTimer !== undefined) clearInt(pollTimer);
    if (backstopTimer !== undefined) clearInt(backstopTimer);
  };

  const startPolling = () => {
    if (stopped || pollTimer !== undefined) return;
    if (backstopTimer !== undefined) {
      clearInt(backstopTimer);
      backstopTimer = undefined;
    }
    detach();
    source?.close();
    source = undefined;
    deps.onMode?.("polling");
    pollTimer = setInt(() => deps.onPoll(), pollMs);
  };

  if (deps.backstop) {
    backstopTimer = setInt(() => deps.onPoll(), backstopMs);
  }

  // A browser without EventSource (or a privacy setting that blocks it) polls from the start.
  if (typeof deps.EventSource !== "function") {
    startPolling();
    return stop;
  }

  source = new deps.EventSource(ORDER_STREAM_PATH);
  let errors = 0;
  let gaveUp = false;
  const onMessage = (ev: Event) => {
    if (gaveUp) return;
    errors = 0;
    const signal = parseOrderSignal(eventData(ev));
    if (signal) deps.onEvent(signal);
  };
  const onOpen = () => {
    if (!gaveUp) errors = 0;
  };
  const onError = () => {
    if (gaveUp) return;
    errors += 1;
    // A non-200 reply (401, 404, 429) fires one error and closes the source for good, so do not wait for a second.
    if (source?.readyState === 2 || errors >= ORDER_EVENT_ERRORS_BEFORE_POLL) {
      gaveUp = true;
      startPolling();
    }
  };
  source.addEventListener("message", onMessage);
  source.addEventListener("error", onError);
  source.addEventListener("open", onOpen);
  detach = () => {
    source?.removeEventListener("message", onMessage);
    source?.removeEventListener("error", onError);
    source?.removeEventListener("open", onOpen);
  };

  return stop;
}
