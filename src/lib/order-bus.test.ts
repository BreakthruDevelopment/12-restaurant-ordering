import { afterEach, describe, expect, it, vi } from "vitest";
import { ORDER_STREAMS_PER_USER, ORDER_STREAMS_TOTAL, orderBus, type OrderBusEvent } from "@/lib/order-bus";

const event = (over: Partial<OrderBusEvent> = {}): OrderBusEvent => ({
  orderId: "order-1",
  version: 1,
  customerId: "cust-a",
  ...over,
});

afterEach(() => {
  orderBus.resetForTests();
  vi.restoreAllMocks();
});

describe("orderBus", () => {
  it("gives each user 3 streams and the process 100, then refuses", () => {
    expect(orderBus.tryAcquire("a")).toBe(true);
    expect(orderBus.tryAcquire("a")).toBe(true);
    expect(orderBus.tryAcquire("a")).toBe(true);
    expect(orderBus.tryAcquire("a")).toBe(false);
    expect(orderBus.countFor("a")).toBe(ORDER_STREAMS_PER_USER);
    // Someone else still can, until the process cap.
    expect(orderBus.tryAcquire("b")).toBe(true);
    orderBus.release("b");

    orderBus.resetForTests();
    for (let i = 0; i < ORDER_STREAMS_TOTAL; i++) expect(orderBus.tryAcquire(`u${i}`)).toBe(true);
    expect(orderBus.tryAcquire("one-more")).toBe(false);
    expect(orderBus.total()).toBe(ORDER_STREAMS_TOTAL);
    orderBus.release("u0");
    expect(orderBus.tryAcquire("one-more")).toBe(true);
    orderBus.release("u0"); // extra release does not make a free slot
    expect(orderBus.total()).toBe(ORDER_STREAMS_TOTAL);
  });

  it("publishes only {orderId, version, customerId}, and one throwing listener does not stop the next", () => {
    const seen: OrderBusEvent[] = [];
    orderBus.subscribe(() => {
      throw new Error("listener blew up");
    });
    orderBus.subscribe((e) => seen.push(e));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    orderBus.publish({ ...event(), note: "nope" } as OrderBusEvent);
    expect(seen).toEqual([event()]);
    expect(Object.keys(seen[0]).sort()).toEqual(["customerId", "orderId", "version"]);
    expect(spy).toHaveBeenCalled();
  });
});
