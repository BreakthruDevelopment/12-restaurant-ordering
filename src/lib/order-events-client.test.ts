import { afterEach, describe, expect, it, vi } from "vitest";
import { ORDER_STREAM_PATH, parseOrderSignal, startOrderEventSubscription, type OrderSignal } from "@/lib/order-events-client";

class FakeEventSource extends EventTarget {
  static latest: FakeEventSource | undefined;
  readonly url: string;
  closed = false;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.latest = this;
  }
  close() {
    this.closed = true;
  }
  send(type: "open" | "error" | "message", data?: string) {
    const ev = new Event(type);
    if (data !== undefined) Object.defineProperty(ev, "data", { value: data });
    this.dispatchEvent(ev);
  }
}

afterEach(() => {
  vi.useRealTimers();
  FakeEventSource.latest = undefined;
});

describe("parseOrderSignal", () => {
  it("keeps orderId and version and drops everything else", () => {
    expect(parseOrderSignal(JSON.stringify({ orderId: "abc", version: 3, customerId: "a", allergy: "peanuts" }))).toEqual({ orderId: "abc", version: 3 });
    expect(parseOrderSignal("not-json")).toBeNull();
    expect(parseOrderSignal(JSON.stringify({ orderId: "", version: 1 }))).toBeNull();
    expect(parseOrderSignal(JSON.stringify({ orderId: "abc", version: 1.5 }))).toBeNull();
    expect(parseOrderSignal(JSON.stringify({ orderId: "abc", version: 0 }))).toBeNull();
    expect(parseOrderSignal(JSON.stringify(["abc", 1]))).toBeNull();
  });
});

describe("startOrderEventSubscription", () => {
  function start(over: { backstop?: boolean; EventSource?: typeof FakeEventSource } = {}) {
    const events: OrderSignal[] = [];
    const polls: number[] = [];
    const modes: string[] = [];
    const stop = startOrderEventSubscription({
      EventSource: over.EventSource === undefined ? FakeEventSource : over.EventSource,
      onEvent: (event) => events.push(event),
      onPoll: () => polls.push(polls.length + 1),
      onMode: (mode) => modes.push(mode),
      backstop: over.backstop,
    });
    return { events, polls, modes, stop, source: FakeEventSource.latest };
  }

  it("polls every 5s after two errors, and a healthy open resets the count", () => {
    vi.useFakeTimers();
    const sub = start();
    expect(sub.source?.url).toBe(ORDER_STREAM_PATH);
    sub.source?.send("message", JSON.stringify({ orderId: "o1", version: 1, customerId: "hidden", note: "nope" }));
    expect(sub.events).toEqual([{ orderId: "o1", version: 1 }]);

    sub.source?.send("error");
    expect(sub.modes).toEqual([]);
    expect(sub.source?.closed).toBe(false);
    sub.source?.send("open"); // reconnect after the 10-minute close: the first error does not stick
    sub.source?.send("error");
    expect(sub.modes).toEqual([]);
    sub.source?.send("error");
    expect(sub.modes).toEqual(["polling"]);
    expect(sub.source?.closed).toBe(true);

    vi.advanceTimersByTime(4_999);
    expect(sub.polls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sub.polls).toEqual([1]);
    vi.advanceTimersByTime(5_000);
    expect(sub.polls).toEqual([1, 2]);
    sub.stop();
    vi.advanceTimersByTime(15_000);
    expect(sub.polls).toEqual([1, 2]);
  });

  it("refetches every 15s while the kitchen stream is up, then every 5s once it gives up", () => {
    vi.useFakeTimers();
    const sub = start({ backstop: true });
    vi.advanceTimersByTime(15_000);
    expect(sub.polls).toEqual([1]);
    expect(sub.modes).toEqual([]);
    sub.source?.send("error");
    sub.source?.send("error");
    expect(sub.modes).toEqual(["polling"]);
    vi.advanceTimersByTime(15_000);
    // 5s polling only: the 15s backstop does not keep firing beside it.
    expect(sub.polls).toEqual([1, 2, 3, 4]);
    sub.stop();
  });

  it("polls immediately when EventSource is missing", () => {
    vi.useFakeTimers();
    const events: OrderSignal[] = [];
    const polls: number[] = [];
    const modes: string[] = [];
    const stop = startOrderEventSubscription({
      EventSource: undefined,
      onEvent: (event) => events.push(event),
      onPoll: () => polls.push(1),
      onMode: (mode) => modes.push(mode),
      backstop: true,
    });
    expect(modes).toEqual(["polling"]);
    vi.advanceTimersByTime(5_000);
    expect(polls).toEqual([1]);
    expect(events).toEqual([]);
    stop();
  });

  it("ignores a malformed message and does not count it as an error", () => {
    const sub = start();
    sub.source?.send("message", "nope");
    sub.source?.send("message", JSON.stringify({ orderId: "o1", version: "2" }));
    expect(sub.events).toEqual([]);
    expect(sub.modes).toEqual([]);
    sub.stop();
  });
});
