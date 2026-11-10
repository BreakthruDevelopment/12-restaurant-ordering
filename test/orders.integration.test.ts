/**
 * Orders and the allergy flow against a real Postgres (TEST_DATABASE_URL): placement (server-side prices, snapshots,
 * idempotency, numbers, caps), access rules (own orders, staff queue, admin 404), the status machine and its races,
 * and the allergy rules (confirmation, immutability, acknowledgment before accept), including the database backstops.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { insertUsers, resetRestaurant, seedMenu } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("orders data layer (Postgres)", () => {
  let sql: postgres.Sql;
  let orders: typeof import("@/lib/orders");
  let menu: typeof import("@/lib/menu");
  let m: Awaited<ReturnType<typeof seedMenu>>;
  const staff = { id: "od-staff", role: "staff" as const };
  const staff2 = { id: "od-staff2", role: "staff" as const };
  const admin = { id: "od-admin", role: "admin" as const };
  let n = 0;
  const customers: { id: string; role: "user" }[] = [];

  /** A fresh customer per test keeps rate limits and the open-order cap out of each other's way. */
  async function customer() {
    const c = { id: `od-c${++n}`, role: "user" as const };
    await insertUsers(sql, [c]);
    customers.push(c);
    return c;
  }
  const noAllergy = { has: false };
  const place = (actor: { id: string; role: "user" | "staff" | "admin" }, lines: { itemId: string; qty: number }[], extra: Record<string, unknown> = {}) =>
    orders.placeOrder(actor, { lines, pickupName: "Sam", allergy: noAllergy, idempotencyKey: randomUUID(), ...extra });
  const one = (actor: { id: string; role: "user" }, extra: Record<string, unknown> = {}) => place(actor, [{ itemId: m.rice.id, qty: 1 }], extra).then((r) => r.order);
  const alertOrder = (actor: { id: string; role: "user" }) =>
    place(actor, [{ itemId: m.padThai.id, qty: 1 }], { allergy: { has: true, allergens: ["peanuts"], note: "carries an epipen", confirmWithStaff: true } }).then((r) => r.order);
  const move = (actor: { id: string; role: "user" | "staff" | "admin" }, id: string, to: string, version: number, reason?: string) =>
    orders.transitionOrder(actor, id, { to, version, ...(reason ? { reason } : {}) });
  const status = async (id: string) => (await sql`select status, version from "order" where id = ${id}`)[0] as { status: string; version: number };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    await sql`delete from "user" where id like 'od-%'`;
    await insertUsers(sql, [staff, staff2, admin]);
    await resetRestaurant(sql);
    m = await seedMenu(sql, staff.id);
    orders = await import("@/lib/orders");
    menu = await import("@/lib/menu");
  });
  afterEach(async () => {
    await menu.updateSettings(staff, { acceptingOrders: true, pickupMinutes: 20 });
  });
  afterAll(async () => {
    await resetRestaurant(sql);
    await sql`delete from "user" where id like 'od-%'`;
    await sql.end();
  });

  describe("placement", () => {
    it("computes the total on the server, in integer cents, from current menu prices", async () => {
      const c = await customer();
      const { order, created } = await place(c, [{ itemId: m.padThai.id, qty: 2 }, { itemId: m.rice.id, qty: 3 }]);
      expect(created).toBe(true);
      expect(order.subtotalCents).toBe(2 * 1450 + 3 * 300);
      expect(Number.isInteger(order.subtotalCents)).toBe(true);
      expect(order.lines.map((l) => [l.name, l.unitPriceCents, l.qty, l.lineTotalCents])).toEqual([
        ["Pad Thai", 1450, 2, 2900],
        ["Steamed Rice", 300, 3, 900],
      ]);
      expect(order.status).toBe("placed");
      expect(order.version).toBe(1);
      expect(order.number).toMatch(/^A-\d{3,}$/);
    });

    it("ignores prices, totals, status and ids the client sends", async () => {
      const c = await customer();
      const { order } = await orders.placeOrder(c, {
        lines: [{ itemId: m.rice.id, qty: 2, unitPriceCents: 1, priceCents: 1, price: 0.01, name: "Free rice", allergens: [] }],
        pickupName: "Sam",
        allergy: noAllergy,
        idempotencyKey: randomUUID(),
        subtotalCents: 1,
        totalCents: 1,
        status: "ready",
        customerId: "od-staff",
        version: 99,
        id: randomUUID(),
      });
      expect(order.subtotalCents).toBe(600);
      expect(order.lines[0]).toMatchObject({ name: "Steamed Rice", unitPriceCents: 300 });
      expect(order.status).toBe("placed");
      expect(order.version).toBe(1);
      expect((await sql`select customer_id from "order" where id = ${order.id}`)[0].customer_id).toBe(c.id);
    });

    it("snapshots names, prices and allergen declarations: later menu edits don't change the order", async () => {
      const c = await customer();
      const item = await menu.createItem(staff, { categoryId: m.categoryId, name: "Snapshot Soup", priceCents: 1000 });
      await menu.setAllergens(staff, item.id, { version: item.version, verified: true, allergens: [{ allergen: "soy", level: "contains" }] });
      const { order } = await place(c, [{ itemId: item.id, qty: 2 }]);
      const cur = (await sql`select version from menu_item where id = ${item.id}`)[0].version;
      await menu.updateItem(staff, item.id, { version: cur, name: "Renamed Soup", priceCents: 9999 });
      await menu.setAllergens(staff, item.id, { version: cur + 1, verified: true, allergens: [{ allergen: "fish", level: "contains" }] });
      const later = await orders.getOrder(c, order.id);
      expect(later.subtotalCents).toBe(2000);
      expect(later.lines[0]).toMatchObject({ name: "Snapshot Soup", unitPriceCents: 1000, allergens: [{ allergen: "soy", level: "contains" }] });
      // A new order uses the new price.
      expect((await place(await customer(), [{ itemId: item.id, qty: 1 }])).order.subtotalCents).toBe(9999);
    });

    it("refuses sold-out, unknown and archived items with a 409 that lists them", async () => {
      const c = await customer();
      const gone = await menu.createItem(staff, { categoryId: m.categoryId, name: "Archived dish", priceCents: 100 });
      await menu.archiveItem(staff, gone.id);
      const unknown = randomUUID();
      const err = await place(c, [{ itemId: m.cake.id, qty: 1 }, { itemId: unknown, qty: 1 }, { itemId: gone.id, qty: 1 }, { itemId: m.rice.id, qty: 1 }]).catch((e) => e);
      expect(err).toMatchObject({ status: 409 });
      expect(err.message).toContain("Chocolate Cake");
      expect(err.details.unavailable).toEqual([
        { itemId: m.cake.id, name: "Chocolate Cake", reason: "sold_out" },
        { itemId: unknown, name: null, reason: "unknown" },
        { itemId: gone.id, name: null, reason: "unknown" },
      ]);
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(0);
    });

    it("refuses when ordering is closed (409), but still returns an order placed earlier with the same key", async () => {
      const c = await customer();
      const key = randomUUID();
      const first = await place(c, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      await menu.updateSettings(staff, { acceptingOrders: false });
      await expect(place(await customer(), [{ itemId: m.rice.id, qty: 1 }])).rejects.toMatchObject({ status: 409 });
      const again = await place(c, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      expect(again).toMatchObject({ created: false, order: { id: first.order.id } });
    });

    it("validates input: quantities 1 to 20, at most 20 distinct lines, names, notes, key format, a required allergy answer", async () => {
      const c = await customer();
      const rice = { itemId: m.rice.id, qty: 1 };
      const base = { lines: [rice], pickupName: "Sam", allergy: noAllergy, idempotencyKey: randomUUID() };
      const bad: Record<string, unknown>[] = [
        { lines: [] }, { lines: [{ ...rice, qty: 0 }] }, { lines: [{ ...rice, qty: 21 }] }, { lines: [{ ...rice, qty: 1.5 }] }, { lines: [{ itemId: "nope", qty: 1 }] },
        { lines: [rice, rice] }, { lines: Array.from({ length: 21 }, () => ({ itemId: randomUUID(), qty: 1 })) },
        { pickupName: "" }, { pickupName: "   " }, { pickupName: "x".repeat(41) }, { note: "x".repeat(201) }, { idempotencyKey: "abc" }, { idempotencyKey: undefined },
        { allergy: undefined }, { allergy: {} }, { allergy: { has: "no" } },
      ];
      for (const b of bad) await expect(orders.placeOrder(c, { ...base, ...b })).rejects.toMatchObject({ name: "ZodError" });
      await expect(orders.placeOrder(c, { ...base, lines: [{ ...rice, qty: 20 }] })).resolves.toBeTruthy();
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(1);
    });

    it("hands out distinct daily numbers even when orders race", async () => {
      const cs = await Promise.all(Array.from({ length: 8 }, () => customer()));
      const placed = await Promise.all(cs.map((c) => one(c)));
      const nums = placed.map((o) => o.number).sort();
      expect(new Set(nums).size).toBe(8);
      const ints = nums.map((x) => Number(x.slice(2))).sort((a, b) => a - b);
      expect(ints[7] - ints[0]).toBe(7); // gapless
    });

    it("limits a customer to 3 open orders (409) and frees a slot when one finishes", async () => {
      const c = await customer();
      const [a] = [await one(c), await one(c), await one(c)];
      await expect(one(c)).rejects.toMatchObject({ status: 409 });
      await move(c, a.id, "cancelled", a.version);
      await expect(one(c)).resolves.toBeTruthy();
    });

    it("limits a customer to 10 orders an hour (429) and counts per customer", async () => {
      const c = await customer();
      await sql`insert into rate_event (user_id, kind) select ${c.id}, 'order' from generate_series(1, 10)`;
      await expect(one(c)).rejects.toMatchObject({ status: 429 });
      await expect(one(await customer())).resolves.toBeTruthy();
    });

    it("only customers place orders: staff 403, admin 404", async () => {
      await expect(place(staff, [{ itemId: m.rice.id, qty: 1 }])).rejects.toMatchObject({ status: 403 });
      await expect(place(admin, [{ itemId: m.rice.id, qty: 1 }])).rejects.toMatchObject({ status: 404 });
    });
  });

  describe("idempotency", () => {
    it("the same key yields one order, and the replay isn't charged to the caps", async () => {
      const c = await customer();
      const key = randomUUID();
      const a = await place(c, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      const b = await place(c, [{ itemId: m.padThai.id, qty: 5 }], { idempotencyKey: key, pickupName: "Other" });
      expect(a.created).toBe(true);
      expect(b).toMatchObject({ created: false, order: { id: a.order.id, subtotalCents: 300, pickupName: "Sam" } });
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(1);
      expect((await sql`select count(*)::int as n from rate_event where user_id = ${c.id} and kind = 'order'`)[0].n).toBe(1);
    });

    it("ten simultaneous requests with one key create exactly one order", async () => {
      const c = await customer();
      const key = randomUUID();
      const results = await Promise.all(Array.from({ length: 10 }, () => place(c, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key })));
      expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(1);
    });

    it("is scoped to the customer: another customer using the same key gets their own order, never the first", async () => {
      const [a, b] = [await customer(), await customer()];
      const key = randomUUID();
      const first = await place(a, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      const second = await place(b, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      expect(second.created).toBe(true);
      expect(second.order.id).not.toBe(first.order.id);
    });

    it("the unique index is the backstop", async () => {
      const c = await customer();
      const key = randomUUID();
      await place(c, [{ itemId: m.rice.id, qty: 1 }], { idempotencyKey: key });
      await expect(
        sql`insert into "order" (number, customer_id, pickup_name, subtotal_cents, idempotency_key, ready_estimate_at) values ('Z-1', ${c.id}, 'x', 0, ${key}, now())`,
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("access rules", () => {
    it("a customer sees only their own orders; another customer gets 404; staff see all; admin gets 404", async () => {
      const [a, b] = [await customer(), await customer()];
      const oa = await one(a);
      const ob = await one(b);
      expect((await orders.listOrders(a)).map((o) => o.id)).toEqual([oa.id]);
      expect((await orders.listOrders(b)).map((o) => o.id)).toEqual([ob.id]);
      expect((await orders.getOrder(a, oa.id)).id).toBe(oa.id);
      await expect(orders.getOrder(b, oa.id)).rejects.toMatchObject({ status: 404 });
      await expect(orders.getOrder(a, randomUUID())).rejects.toMatchObject({ status: 404 }); // same answer as someone else's
      await expect(orders.getOrder(a, "not-a-uuid")).rejects.toMatchObject({ status: 404 });
      const queue = (await orders.listOrders(staff)).map((o) => o.id);
      expect(queue).toEqual(expect.arrayContaining([oa.id, ob.id]));
      expect((await orders.getOrder(staff2, oa.id)).id).toBe(oa.id);
      await expect(orders.listOrders(admin)).rejects.toMatchObject({ status: 404 });
      await expect(orders.getOrder(admin, oa.id)).rejects.toMatchObject({ status: 404 });
    });

    it("the staff queue is open orders oldest first; history filters by status", async () => {
      const c = await customer();
      const o = await one(c);
      // created_at is fixed by a trigger; backdate with triggers off, as a test-only shortcut.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update "order" set created_at = now() - interval '1 day' where id = ${o.id}`;
      });
      const queue = await orders.listOrders(staff);
      expect(queue[0].id).toBe(o.id);
      expect(queue.every((x) => ["placed", "accepted", "preparing", "ready"].includes(x.status))).toBe(true);
      const cancelled = await orders.listOrders(staff, { status: "cancelled" });
      expect(cancelled.every((x) => x.status === "cancelled")).toBe(true);
      await expect(orders.listOrders(staff, { status: "bogus" })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("customers can't move another customer's order or cancel it", async () => {
      const [a, b] = [await customer(), await customer()];
      const oa = await one(a);
      await expect(move(b, oa.id, "cancelled", oa.version)).rejects.toMatchObject({ status: 404 });
      await expect(move(admin, oa.id, "cancelled", oa.version, "x")).rejects.toMatchObject({ status: 404 });
      expect((await status(oa.id)).status).toBe("placed");
    });

    it("a customer view never carries the staff member's identity, and staff views do", async () => {
      const c = await customer();
      const o = await alertOrder(c);
      await orders.acknowledgeAllergy(staff, o.id);
      expect((await orders.getOrder(c, o.id)).allergy).not.toHaveProperty("acknowledgedBy");
      expect((await orders.getOrder(staff, o.id)).allergy.acknowledgedBy).toMatchObject({ id: staff.id, name: staff.id });
    });
  });

  describe("status machine", () => {
    it("walks placed, accepted, preparing, ready, picked_up, bumping the version each time", async () => {
      const c = await customer();
      let o = await one(c);
      for (const to of ["accepted", "preparing", "ready", "picked_up"]) {
        o = await move(staff, o.id, to, o.version);
        expect(o.status).toBe(to);
      }
      expect(o.version).toBe(5);
    });

    it("refuses skipping steps, going back, and any move out of a final state (409)", async () => {
      const c = await customer();
      const o = await one(c);
      await expect(move(staff, o.id, "preparing", o.version)).rejects.toMatchObject({ status: 409 });
      await expect(move(staff, o.id, "picked_up", o.version)).rejects.toMatchObject({ status: 409 });
      const acc = await move(staff, o.id, "accepted", o.version);
      await expect(move(staff, o.id, "placed" as never, acc.version)).rejects.toMatchObject({ name: "ZodError" });
      const done = await move(staff, o.id, "cancelled", acc.version, "Kitchen closed");
      for (const to of ["accepted", "preparing", "ready", "picked_up", "cancelled"]) await expect(move(staff, o.id, to, done.version, "again")).rejects.toMatchObject({ status: 409 });
      expect(done.cancelReason).toBe("Kitchen closed");
    });

    it("a stale version is 409 and changes nothing", async () => {
      const c = await customer();
      const o = await one(c);
      await move(staff, o.id, "accepted", o.version);
      await expect(move(staff2, o.id, "preparing", o.version)).rejects.toMatchObject({ status: 409 });
      await expect(move(staff2, o.id, "preparing", 99)).rejects.toMatchObject({ status: 409 });
      expect((await status(o.id)).status).toBe("accepted");
    });

    it("staff cancel needs a reason (400); the reason is stored and capped at 200", async () => {
      const c = await customer();
      const o = await one(c);
      await expect(move(staff, o.id, "cancelled", o.version)).rejects.toMatchObject({ status: 400 });
      await expect(move(staff, o.id, "cancelled", o.version, "   ")).rejects.toMatchObject({ status: 400 });
      await expect(move(staff, o.id, "cancelled", o.version, "x".repeat(201))).rejects.toMatchObject({ name: "ZodError" });
      expect((await move(staff, o.id, "cancelled", o.version, "Can't safely prepare")).cancelReason).toBe("Can't safely prepare");
    });

    it("a customer may cancel only while placed: forward moves are 403, a later cancel is 409", async () => {
      const c = await customer();
      const o = await one(c);
      await expect(move(c, o.id, "accepted", o.version)).rejects.toMatchObject({ status: 403 });
      await expect(move(c, o.id, "picked_up", o.version)).rejects.toMatchObject({ status: 403 });
      expect((await status(o.id)).status).toBe("placed");
      const acc = await move(staff, o.id, "accepted", o.version);
      await expect(move(c, o.id, "cancelled", acc.version)).rejects.toMatchObject({ status: 409 });
      const o2 = await one(c);
      expect(await move(c, o2.id, "cancelled", o2.version)).toMatchObject({ status: "cancelled", cancelReason: null });
    });

    it("rejects malformed transitions: unknown status, missing version, extra keys", async () => {
      const c = await customer();
      const o = await one(c);
      for (const body of [{ to: "teleported", version: 1 }, { to: "accepted" }, { version: 1 }, { to: "accepted", version: 1, status: "ready" }, { to: "accepted", version: 0 }, { to: "accepted", version: "1" }]) {
        await expect(orders.transitionOrder(staff, o.id, body)).rejects.toMatchObject({ name: "ZodError" });
      }
    });

    it("racing accepts with one version: exactly one wins, the rest are 409", async () => {
      const c = await customer();
      const o = await one(c);
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => move(i % 2 ? staff : staff2, o.id, "accepted", o.version)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(await status(o.id)).toEqual({ status: "accepted", version: 2 });
    });

    it("a staff accept racing a customer cancel: exactly one wins and the order is consistent", async () => {
      for (let i = 0; i < 5; i++) {
        const c = await customer();
        const o = await one(c);
        const results = await Promise.allSettled([move(staff, o.id, "accepted", o.version), move(c, o.id, "cancelled", o.version)]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const s = await status(o.id);
        expect(["accepted", "cancelled"]).toContain(s.status);
        expect(s.version).toBe(2);
      }
    });

    it("racing two different moves from the same state never lets both through", async () => {
      const c = await customer();
      const o = await one(c);
      const acc = await move(staff, o.id, "accepted", o.version);
      const results = await Promise.allSettled([move(staff, o.id, "preparing", acc.version), move(staff2, o.id, "cancelled", acc.version, "Closing")]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect((await status(o.id)).version).toBe(3);
    });
  });

  describe("the allergy flow", () => {
    it("requires the allergy answer, and never silently drops allergy details", async () => {
      const c = await customer();
      const lines = [{ itemId: m.rice.id, qty: 1 }];
      const key = () => randomUUID();
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key() })).rejects.toMatchObject({ name: "ZodError" });
      // Details with has: false are an error, not a discard.
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key(), allergy: { has: false, allergens: ["peanuts"] } })).rejects.toMatchObject({ name: "ZodError" });
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key(), allergy: { has: false, note: "nuts" } })).rejects.toMatchObject({ name: "ZodError" });
      // Yes, but nothing said.
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key(), allergy: { has: true } })).rejects.toMatchObject({ name: "ZodError" });
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key(), allergy: { has: true, allergens: ["celery"] } })).rejects.toMatchObject({ name: "ZodError" });
      await expect(orders.placeOrder(c, { lines, pickupName: "Sam", idempotencyKey: key(), allergy: { has: true, allergens: ["milk", "milk"] } })).rejects.toMatchObject({ name: "ZodError" });
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(0);
    });

    it("stores the allergens and note exactly, as an alert, for the customer and staff", async () => {
      const c = await customer();
      const { order } = await place(c, [{ itemId: m.rice.id, qty: 1 }], { allergy: { has: true, allergens: ["sesame", "milk"], note: "Cross-contact matters" } });
      for (const viewer of [c, staff]) {
        const seen = await orders.getOrder(viewer, order.id);
        expect(seen.allergy).toMatchObject({ alert: true, allergens: ["sesame", "milk"], note: "Cross-contact matters", acknowledged: false, acknowledgedAt: null });
      }
      expect((await orders.listOrders(staff)).find((o) => o.id === order.id)?.allergy.alert).toBe(true);
    });

    it("a note alone (an allergy outside the ten) still raises the alert", async () => {
      const c = await customer();
      const { order } = await place(c, [{ itemId: m.rice.id, qty: 1 }], { allergy: { has: true, note: "celery" } });
      expect(order.allergy).toMatchObject({ alert: true, allergens: [], note: "celery" });
    });

    it("refuses an order whose dish declares a picked allergen until the customer confirms (409), listing the dishes", async () => {
      const c = await customer();
      const body = { allergy: { has: true, allergens: ["peanuts"], note: "" } };
      const err = await place(c, [{ itemId: m.padThai.id, qty: 1 }, { itemId: m.rice.id, qty: 1 }], body).catch((e) => e);
      expect(err).toMatchObject({ status: 409, details: { code: "allergy_confirmation_required", items: [{ itemId: m.padThai.id, name: "Pad Thai" }] } });
      await expect(place(c, [{ itemId: m.padThai.id, qty: 1 }], { allergy: { ...body.allergy, confirmWithStaff: false } })).rejects.toMatchObject({ status: 409 });
      expect(await sql`select 1 from "order" where customer_id = ${c.id}`).toHaveLength(0);
      const { order } = await place(c, [{ itemId: m.padThai.id, qty: 1 }], { allergy: { ...body.allergy, confirmWithStaff: true } });
      expect(order.allergy).toMatchObject({ alert: true, customerConfirmed: true });
    });

    it("a may-contain declaration counts as a conflict too", async () => {
      const c = await customer();
      await expect(place(c, [{ itemId: m.soup.id, qty: 1 }], { allergy: { has: true, allergens: ["milk"] } })).rejects.toMatchObject({ status: 409 });
    });

    it("no conflict, no confirmation needed; and 'not declared' is never treated as safe (the alert is still raised)", async () => {
      const c = await customer();
      const { order } = await place(c, [{ itemId: m.rice.id, qty: 1 }], { allergy: { has: true, allergens: ["peanuts"] } });
      expect(order.allergy).toMatchObject({ alert: true, customerConfirmed: false });
      expect((await status(order.id)).status).toBe("placed");
    });

    it("saying no stores no alert and needs no acknowledgment", async () => {
      const c = await customer();
      const o = await one(c);
      expect(o.allergy).toMatchObject({ alert: false, allergens: [], note: "", acknowledged: false });
      expect((await move(staff, o.id, "accepted", o.version)).status).toBe("accepted");
    });

    it("accepting before acknowledgment is 409 and the order stays placed", async () => {
      const c = await customer();
      const o = await alertOrder(c);
      await expect(move(staff, o.id, "accepted", o.version)).rejects.toMatchObject({ status: 409 });
      // Later steps can't be reached by any route either.
      for (const to of ["preparing", "ready", "picked_up"]) await expect(move(staff, o.id, to, o.version)).rejects.toMatchObject({ status: 409 });
      expect(await status(o.id)).toEqual({ status: "placed", version: 1 });
    });

    it("staff acknowledge (who and when), then can accept; acknowledging again keeps the first record", async () => {
      const c = await customer();
      const o = await alertOrder(c);
      const acked = await orders.acknowledgeAllergy(staff, o.id);
      expect(acked.allergy).toMatchObject({ acknowledged: true, acknowledgedBy: { id: staff.id } });
      expect(acked.allergy.acknowledgedAt).toBeTruthy();
      expect(acked.version).toBe(o.version + 1);
      const again = await orders.acknowledgeAllergy(staff2, o.id);
      expect(again.allergy).toMatchObject({ acknowledgedBy: { id: staff.id }, acknowledgedAt: acked.allergy.acknowledgedAt });
      expect(again.version).toBe(acked.version);
      // The stale version from before the acknowledgment is refused; the fresh one works.
      await expect(move(staff, o.id, "accepted", o.version)).rejects.toMatchObject({ status: 409 });
      expect((await move(staff, o.id, "accepted", acked.version)).status).toBe("accepted");
    });

    it("racing acknowledgments record one reviewer and one version bump", async () => {
      const c = await customer();
      const o = await alertOrder(c);
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => orders.acknowledgeAllergy(i % 2 ? staff : staff2, o.id)));
      expect(new Set(results.map((r) => r.allergy.acknowledgedBy?.id)).size).toBe(1);
      expect((await status(o.id)).version).toBe(2);
    });

    it("only staff acknowledge: a customer (even the owner) gets 403, an admin 404, a stranger no order data", async () => {
      const c = await customer();
      const o = await alertOrder(c);
      await expect(orders.acknowledgeAllergy(c, o.id)).rejects.toMatchObject({ status: 403 });
      await expect(orders.acknowledgeAllergy(admin, o.id)).rejects.toMatchObject({ status: 404 });
      expect((await sql`select allergy_ack_at from "order" where id = ${o.id}`)[0].allergy_ack_at).toBeNull();
    });

    it("acknowledging an order without an alert is 409; a missing order is 404; after cancel it is 409", async () => {
      const c = await customer();
      const plain = await one(c);
      await expect(orders.acknowledgeAllergy(staff, plain.id)).rejects.toMatchObject({ status: 409 });
      await expect(orders.acknowledgeAllergy(staff, randomUUID())).rejects.toMatchObject({ status: 404 });
      const o = await alertOrder(c);
      await move(staff, o.id, "cancelled", o.version, "Can't safely prepare");
      await expect(orders.acknowledgeAllergy(staff, o.id)).rejects.toMatchObject({ status: 409 });
    });

    it("staff can always cancel an unacknowledged alert order, and so can the customer", async () => {
      const [a, b] = [await customer(), await customer()];
      const o1 = await alertOrder(a);
      expect((await move(staff, o1.id, "cancelled", o1.version, "Can't safely prepare")).status).toBe("cancelled");
      const o2 = await alertOrder(b);
      expect((await move(b, o2.id, "cancelled", o2.version)).status).toBe("cancelled");
    });

    it("another customer can't read the alert; the order is 404 to them", async () => {
      const [a, b] = [await customer(), await customer()];
      const o = await alertOrder(a);
      await expect(orders.getOrder(b, o.id)).rejects.toMatchObject({ status: 404 });
      expect(JSON.stringify(await orders.listOrders(b))).not.toContain("epipen");
    });

    describe("database backstops (a bug or a hand-written query can't break the rules)", () => {
      it("allergy data and the other fixed fields can't be updated after placement", async () => {
        const c = await customer();
        const o = await alertOrder(c);
        for (const change of [
          sql`update "order" set allergy_alert = false where id = ${o.id}`,
          sql`update "order" set allergy_allergens = '{}' where id = ${o.id}`,
          sql`update "order" set allergy_note = '' where id = ${o.id}`,
          sql`update "order" set allergy_customer_confirmed = false where id = ${o.id}`,
          sql`update "order" set subtotal_cents = 1 where id = ${o.id}`,
          sql`update "order" set customer_id = 'od-staff' where id = ${o.id}`,
          sql`update "order" set number = 'A-999' where id = ${o.id}`,
          sql`update "order" set idempotency_key = gen_random_uuid() where id = ${o.id}`,
          sql`update "order" set created_at = now() - interval '1 year' where id = ${o.id}`,
        ]) await expect(change).rejects.toMatchObject({ code: "55000" });
        const [row] = await sql`select allergy_alert, allergy_allergens, allergy_note, subtotal_cents from "order" where id = ${o.id}`;
        expect(row).toMatchObject({ allergy_alert: true, allergy_allergens: ["peanuts"], allergy_note: "carries an epipen", subtotal_cents: 1450 });
      });

      it("order lines are immutable", async () => {
        const c = await customer();
        const o = await one(c);
        await expect(sql`update order_line set unit_price_cents = 1 where order_id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        await expect(sql`update order_line set qty = 20 where order_id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        await expect(sql`update order_line set allergens = '[]'::jsonb where order_id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
      });

      it("an alert order can't leave 'placed' for a cooking state without an acknowledgment, whoever writes the SQL", async () => {
        const c = await customer();
        const o = await alertOrder(c);
        for (const to of ["accepted", "preparing", "ready", "picked_up"]) {
          await expect(sql`update "order" set status = ${to} where id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        }
        await sql`update "order" set status = 'cancelled', cancel_reason = 'x' where id = ${o.id}`; // cancelling is allowed
      });

      it("the acknowledgment can't be rewritten or cleared; final states stay final", async () => {
        const c = await customer();
        const o = await alertOrder(c);
        await orders.acknowledgeAllergy(staff, o.id);
        await expect(sql`update "order" set allergy_ack_at = null where id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        await expect(sql`update "order" set allergy_ack_by = ${staff2.id} where id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        await expect(sql`update "order" set allergy_ack_at = now() - interval '1 day' where id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
        const fresh = await orders.getOrder(staff, o.id);
        await move(staff, o.id, "cancelled", fresh.version, "Done");
        await expect(sql`update "order" set status = 'placed' where id = ${o.id}`).rejects.toMatchObject({ code: "55000" });
      });

      it("deleting a staff account keeps the acknowledgment time and blanks only who", async () => {
        await insertUsers(sql, [{ id: "od-temp-staff", role: "staff" }]);
        const c = await customer();
        const o = await alertOrder(c);
        await orders.acknowledgeAllergy({ id: "od-temp-staff", role: "staff" }, o.id);
        await sql`delete from "user" where id = 'od-temp-staff'`;
        const [row] = await sql`select allergy_ack_by, allergy_ack_at from "order" where id = ${o.id}`;
        expect(row.allergy_ack_by).toBeNull();
        expect(row.allergy_ack_at).toBeTruthy();
      });

      it("deleting a customer deletes their orders and lines (the privacy path still works)", async () => {
        const c = await customer();
        const o = await alertOrder(c);
        await sql`delete from "user" where id = ${c.id}`;
        expect(await sql`select 1 from "order" where id = ${o.id}`).toHaveLength(0);
        expect(await sql`select 1 from order_line where order_id = ${o.id}`).toHaveLength(0);
      });

      it("a line can't point at another customer's order (composite foreign key)", async () => {
        const [a, b] = [await customer(), await customer()];
        const o = await one(a);
        await expect(
          sql`insert into order_line (order_id, customer_id, menu_item_id, name, unit_price_cents, qty, allergens) values (${o.id}, ${b.id}, ${m.rice.id}, 'x', 1, 1, '[]')`,
        ).rejects.toMatchObject({ code: "23503" });
      });
    });

    it("logs carry ids and statuses only: never allergens, notes, names or prices", async () => {
      const { log } = await import("@/lib/log");
      const spies = (["debug", "info", "warn", "error"] as const).map((k) => vi.spyOn(log, k).mockImplementation(() => {}));
      try {
        const c = await customer();
        const { order } = await place(c, [{ itemId: m.padThai.id, qty: 1 }], {
          pickupName: "Zebedee Quibble",
          note: "ring the bell twice",
          allergy: { has: true, allergens: ["peanuts"], note: "CANARY-allergy-note", confirmWithStaff: true },
        });
        await orders.acknowledgeAllergy(staff, order.id);
        await move(staff, order.id, "accepted", order.version + 1);
        await expect(move(staff, order.id, "ready", 1)).rejects.toBeTruthy();
        const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
        expect(logged).toContain("order.placed");
        for (const secret of ["peanuts", "CANARY-allergy-note", "Zebedee", "ring the bell", "epipen", "Pad Thai", "1450"]) expect(logged).not.toContain(secret);
      } finally {
        for (const s of spies) s.mockRestore();
      }
    });
  });
});
