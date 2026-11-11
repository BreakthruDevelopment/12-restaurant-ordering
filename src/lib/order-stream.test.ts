import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, TooManyRequestsError } from "@/lib/errors";
import type { Actor } from "@/lib/auth/rbac";
import { orderBus } from "@/lib/order-bus";
import { ORDER_STREAM_HEADERS, ORDER_STREAM_HEARTBEAT_MS, ORDER_STREAM_LIFETIME_MS, openOrderStream } from "@/lib/order-stream";

const customer = (id: string): Actor => ({ id, role: "user" });
const staff: Actor = { id: "staff-1", role: "staff" };
const decoder = new TextDecoder();

const responses: Response[] = [];

function open(actor: Actor): Response {
  const res = openOrderStream(actor);
  responses.push(res);
  return res;
}

async function read(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const { value, done } = await reader.read();
  reader.releaseLock();
  return done || !value ? "" : decoder.decode(value);
}

afterEach(async () => {
  vi.useRealTimers();
  for (const res of responses) await res.body?.cancel().catch(() => {});
  responses.length = 0;
  orderBus.resetForTests();
});

describe("openOrderStream", () => {
  it("refuses an admin before taking a slot, and sets the no-buffering headers", async () => {
    expect(() => openOrderStream({ id: "ada", role: "admin" })).toThrow(NotFoundError);
    expect(orderBus.total()).toBe(0);
    const res = open(customer("a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(ORDER_STREAM_HEADERS["Content-Type"]);
    expect(res.headers.get("cache-control")).toBe(ORDER_STREAM_HEADERS["Cache-Control"]);
    expect(res.headers.get("x-accel-buffering")).toBe(ORDER_STREAM_HEADERS["X-Accel-Buffering"]);
    expect(await read(res)).toBe(": open\n\n");
  });

  it("the 4th stream for a user throws 429, and closing one frees the slot", async () => {
    const held = [open(customer("a")), open(customer("a")), open(customer("a"))];
    expect(orderBus.countFor("a")).toBe(3);
    expect(() => openOrderStream(customer("a"))).toThrow(TooManyRequestsError);
    try {
      openOrderStream(customer("a"));
    } catch (err) {
      expect(err).toBeInstanceOf(TooManyRequestsError);
      expect((err as TooManyRequestsError).status).toBe(429);
    }
    expect(orderBus.countFor("a")).toBe(3);
    await held[0].body?.cancel();
    expect(orderBus.countFor("a")).toBe(2);
    const again = open(customer("a"));
    expect(again.status).toBe(200);
    expect(orderBus.countFor("a")).toBe(3);
  });

  it("sends a customer only their own event, as {orderId, version}, and sends staff every event", async () => {
    const a = open(customer("cust-a"));
    const b = open(customer("cust-b"));
    const kitchen = open(staff);
    expect(await read(a)).toBe(": open\n\n");
    expect(await read(b)).toBe(": open\n\n");
    expect(await read(kitchen)).toBe(": open\n\n");

    orderBus.publish({ orderId: "order-a", version: 2, customerId: "cust-a" });

    const raw = await read(a);
    expect(raw).toBe('data: {"orderId":"order-a","version":2}\n\n');
    expect(Object.keys(JSON.parse(raw.slice(6))).sort()).toEqual(["orderId", "version"]);
    expect(raw).not.toContain("customerId");

    const staffRaw = await read(kitchen);
    expect(JSON.parse(staffRaw.slice(6))).toEqual({ orderId: "order-a", version: 2 });

    const pending = b.body!.getReader().read().then(
      () => "event",
      () => "closed",
    );
    const quiet = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("quiet"), 50))]);
    expect(quiet).toBe("quiet");
  });

  it("writes a heartbeat comment every 25s and closes the stream after 10 minutes", async () => {
    vi.useFakeTimers();
    const res = open(customer("timer-user"));
    const reader = res.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe(": open\n\n");
    await vi.advanceTimersByTimeAsync(ORDER_STREAM_HEARTBEAT_MS);
    expect(decoder.decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    await vi.advanceTimersByTimeAsync(ORDER_STREAM_LIFETIME_MS);
    let done = false;
    for (let i = 0; i < 40; i++) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        break;
      }
      if (next.value) expect(decoder.decode(next.value)).toBe(": heartbeat\n\n");
    }
    expect(done).toBe(true);
    expect(orderBus.countFor("timer-user")).toBe(0);
  });
});
