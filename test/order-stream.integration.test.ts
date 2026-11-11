/**
 * Real-time order signals against Postgres and the stream route: a rolled-back transaction publishes nothing,
 * customer B's stream stays quiet for A's order, the event bytes are `{orderId, version}` only, and the 4th stream is 429.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetRestaurant, seedMenu } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const ORIGIN = "http://localhost:3000";

const cookieJar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(cookieJar.cookie ? { cookie: cookieJar.cookie } : {}) }));

describe.skipIf(!url)("order stream (Postgres)", () => {
  let sqlc: postgres.Sql;
  let orders: typeof import("@/lib/orders");
  let bus: typeof import("@/lib/order-bus").orderBus;
  let txmod: typeof import("@/lib/order-tx");
  let GET: (typeof import("@/app/api/orders/stream/route"))["GET"];
  let m: Awaited<ReturnType<typeof seedMenu>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const stops: AbortController[] = [];

  const actor = (who: "alice" | "bob" | "sue" | "ada") => ({ id: ids[who], role: who === "sue" ? ("staff" as const) : who === "ada" ? ("admin" as const) : ("user" as const) });

  function place(who: "alice" | "bob", itemId: string, extra: Record<string, unknown> = {}) {
    return orders.placeOrder(actor(who), {
      lines: [{ itemId, qty: 1 }],
      pickupName: "Sam",
      note: "",
      allergy: { has: false },
      idempotencyKey: randomUUID(),
      ...extra,
    });
  }

  async function connect(who: string): Promise<Response> {
    const ac = new AbortController();
    stops.push(ac);
    cookieJar.cookie = who === "anon" ? "" : cookies[who];
    return GET(new Request(`${ORIGIN}/api/orders/stream`, { signal: ac.signal }));
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sqlc = postgres(url!, { max: 2, onnotice: () => {} });
    await sqlc`delete from "user" where email like 'ss-%@test.local'`;
    await resetRestaurant(sqlc);
    const { auth } = await import("@/lib/auth");
    const handler = auth().handler;
    const post = (path: string, body: unknown) =>
      handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    for (const [who, role] of [["alice", "user"], ["bob", "user"], ["sue", "staff"], ["ada", "admin"]] as const) {
      const email = `ss-${who}@test.local`;
      const up = await post("/sign-up/email", { name: who, email, password: PASSWORD });
      expect(up.status).toBe(200);
      ids[who] = ((await up.json()) as { user: { id: string } }).user.id;
      await sqlc`update "user" set role = ${role} where id = ${ids[who]}`;
      const inn = await post("/sign-in/email", { email, password: PASSWORD });
      cookies[who] = inn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    }
    m = await seedMenu(sqlc, ids.sue);
    orders = await import("@/lib/orders");
    bus = (await import("@/lib/order-bus")).orderBus;
    txmod = await import("@/lib/order-tx");
    GET = (await import("@/app/api/orders/stream/route")).GET;
  });

  afterEach(() => {
    for (const ac of stops) ac.abort();
    stops.length = 0;
    cookieJar.cookie = "";
    bus.resetForTests();
  });

  afterAll(async () => {
    cookieJar.cookie = "";
    await resetRestaurant(sqlc);
    await sqlc`delete from "user" where email like 'ss-%@test.local'`;
    await sqlc.end();
  });

  async function readChunk(res: Response): Promise<string> {
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    reader.releaseLock();
    return done || !value ? "" : new TextDecoder().decode(value);
  }

  /** True when no chunk is already queued. A leaked event is sitting in the stream, so the read returns immediately. */
  async function staysQuiet(res: Response): Promise<boolean> {
    const reader = res.body!.getReader();
    const pending = reader.read().then(
      (chunk) => (chunk.done || !chunk.value ? "" : new TextDecoder().decode(chunk.value)),
      () => "closed",
    );
    const result = await Promise.race([pending, new Promise<string>((resolve) => setTimeout(() => resolve("quiet"), 150))]);
    return result === "quiet";
  }

  it("never sends an event that was queued inside a rolled-back transaction", async () => {
    const seen: { orderId: string; version: number; customerId: string }[] = [];
    const stop = bus.subscribe((event) => seen.push(event));
    try {
      await expect(
        txmod.transactionWithOrderEvents(async (tx) => {
          txmod.enqueueOrderEvent(tx, { orderId: randomUUID(), version: 1, customerId: "ghost" });
          expect(seen).toEqual([]);
          await tx.execute(sql`select 1/0`);
        }),
      ).rejects.toBeTruthy();
      expect(seen).toEqual([]);

      const id = randomUUID();
      await txmod.transactionWithOrderEvents(async (tx) => {
        txmod.enqueueOrderEvent(tx, { orderId: id, version: 7, customerId: "ghost" });
        await tx.execute(sql`select 1`);
        expect(seen).toEqual([]);
      });
      expect(seen).toEqual([{ orderId: id, version: 7, customerId: "ghost" }]);
    } finally {
      stop();
    }
  });

  it("publishes a placed order only after it commits, not a sold-out attempt or an idempotent replay", async () => {
    const seen: { orderId: string; version: number; customerId: string }[] = [];
    const stop = bus.subscribe((event) => seen.push(event));
    try {
      await expect(place("alice", m.cake.id)).rejects.toMatchObject({ status: 409 });
      expect(seen).toEqual([]);

      const key = randomUUID();
      const same = { idempotencyKey: key, pickupName: "Zebedee", note: "CANARY-note" };
      const first = await place("alice", m.rice.id, same);
      expect(seen).toEqual([{ orderId: first.order.id, version: 1, customerId: ids.alice }]);
      const replay = await place("alice", m.rice.id, same);
      expect(replay.created).toBe(false);
      expect(seen).toHaveLength(1);

      const cancelled = await orders.transitionOrder(actor("alice"), first.order.id, { to: "cancelled", version: 1 });
      expect(cancelled.version).toBe(2);
      expect(seen[1]).toEqual({ orderId: first.order.id, version: 2, customerId: ids.alice });
      await expect(orders.transitionOrder(actor("alice"), first.order.id, { to: "cancelled", version: 1 })).rejects.toMatchObject({ status: 409 });
      expect(seen).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("gives B nothing for A's order, and the event is exactly {orderId, version}", async () => {
    const [resA, resB, resS] = [await connect("alice"), await connect("bob"), await connect("sue")];
    expect(resA.status).toBe(200);
    expect(resA.headers.get("content-type")).toBe("text/event-stream");
    expect(resA.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(resA.headers.get("x-accel-buffering")).toBe("no");
    expect(await readChunk(resA)).toBe(": open\n\n");
    expect(await readChunk(resB)).toBe(": open\n\n");
    expect(await readChunk(resS)).toBe(": open\n\n");

    const placed = await place("alice", m.padThai.id, {
      pickupName: "Secret Name",
      note: "ring the bell",
      allergy: { has: true, allergens: ["peanuts"], note: "CANARY-allergy", confirmWithStaff: true },
    });
    const raw = await readChunk(resA);
    expect(raw).not.toContain("customerId");
    expect(raw).not.toContain("CANARY");
    expect(raw).not.toContain("peanut");
    expect(raw).not.toContain("Secret");
    expect(JSON.parse(raw.slice("data: ".length))).toEqual({ orderId: placed.order.id, version: placed.order.version });
    expect(Object.keys(JSON.parse(raw.slice("data: ".length))).sort()).toEqual(["orderId", "version"]);

    const staffRaw = await readChunk(resS);
    expect(JSON.parse(staffRaw.slice("data: ".length))).toEqual({ orderId: placed.order.id, version: 1 });
    expect(staffRaw).not.toContain("CANARY");
    expect(staffRaw).not.toContain("customerId");

    const acked = await orders.acknowledgeAllergy(actor("sue"), placed.order.id);
    expect(JSON.parse((await readChunk(resA)).slice("data: ".length))).toEqual({ orderId: placed.order.id, version: acked.version });
    expect(await staysQuiet(resB)).toBe(true);

    await orders.transitionOrder(actor("sue"), placed.order.id, { to: "cancelled", version: acked.version, reason: "test cleanup" });
  });

  it("answers anonymous with 401 and an admin with 404", async () => {
    expect((await connect("anon")).status).toBe(401);
    expect((await connect("ada")).status).toBe(404);
    expect(bus.total()).toBe(0);
  });

  it("answers the 4th stream for one user with 429", async () => {
    const open = [await connect("bob"), await connect("bob"), await connect("bob")];
    for (const res of open) expect(res.status).toBe(200);
    expect(bus.countFor(ids.bob)).toBe(3);
    const blocked = await connect("bob");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("content-type")).toContain("application/json");
    expect(await blocked.json()).toMatchObject({ error: expect.stringMatching(/stream/i) });
    expect(bus.countFor(ids.bob)).toBe(3);

    stops[0].abort();
    // abort releases the slot before the next connect. The controller stays in `stops` and aborting again is harmless.
    const resumed = await connect("bob");
    expect(resumed.status).toBe(200);
    expect(bus.countFor(ids.bob)).toBe(3);
  });

  it("answers the 101st stream in the process with 429", async () => {
    for (let i = 0; i < 100; i++) expect(bus.tryAcquire(`filler-${i}`)).toBe(true);
    const blocked = await connect("alice");
    expect(blocked.status).toBe(429);
    expect(bus.countFor(ids.alice)).toBe(0);
  });
});
