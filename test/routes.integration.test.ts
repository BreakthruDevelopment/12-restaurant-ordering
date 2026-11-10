/**
 * The HTTP boundary, end to end through the route handlers with real Better Auth sessions: sign-in required,
 * same-origin required on every mutation, zod and size limits, role checks per route, and error bodies without
 * internals. Data rules themselves are covered in orders/menu integration tests.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetRestaurant, seedMenu } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const ORIGIN = "http://localhost:3000";

const cookieJar = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(cookieJar.cookie ? { cookie: cookieJar.cookie } : {}) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

type Ctx = { params: Promise<{ id: string }> };
const ctx = (id: string): Ctx => ({ params: Promise.resolve({ id }) });

describe.skipIf(!url)("HTTP routes (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let m: Awaited<ReturnType<typeof seedMenu>>;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const R: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any

  /** Call a route handler as `who` ("anon" for nobody). Mutations send our own Origin unless `origin` says otherwise. */
  async function call(handler: (req: Request, c: Ctx) => Promise<Response>, method: string, who: string, body?: unknown, opts: { origin?: string | null; id?: string; raw?: BodyInit; path?: string } = {}) {
    cookieJar.cookie = who === "anon" ? "" : cookies[who];
    const origin = opts.origin === undefined ? ORIGIN : opts.origin;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    const res = await handler(
      new Request(`${ORIGIN}${opts.path ?? "/api/x"}`, { method, headers, body: opts.raw ?? (body === undefined ? undefined : JSON.stringify(body)) }),
      ctx(opts.id ?? ""),
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  }
  const order = (extra: Record<string, unknown> = {}, lines = [{ itemId: m.rice.id, qty: 1 }]) => ({ lines, pickupName: "Sam", allergy: { has: false }, idempotencyKey: randomUUID(), ...extra });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where email like 'rt-%@test.local'`;
    await resetRestaurant(sql);
    const { auth } = await import("@/lib/auth");
    const handler = auth().handler;
    const post = (path: string, body: unknown) =>
      handler(new Request(`${ORIGIN}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    for (const [who, role] of [["alice", "user"], ["bob", "user"], ["sue", "staff"], ["ada", "admin"]] as const) {
      const email = `rt-${who}@test.local`;
      const up = await post("/sign-up/email", { name: who, email, password: PASSWORD });
      expect(up.status).toBe(200);
      ids[who] = ((await up.json()) as { user: { id: string } }).user.id;
      await sql`update "user" set role = ${role} where id = ${ids[who]}`;
      const inn = await post("/sign-in/email", { email, password: PASSWORD });
      cookies[who] = inn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    }
    m = await seedMenu(sql, ids.sue);
    R.menu = await import("@/app/api/menu/route");
    R.items = await import("@/app/api/menu/items/route");
    R.item = await import("@/app/api/menu/items/[id]/route");
    R.allergens = await import("@/app/api/menu/items/[id]/allergens/route");
    R.soldOut = await import("@/app/api/menu/items/[id]/sold-out/route");
    R.categories = await import("@/app/api/menu/categories/route");
    R.settings = await import("@/app/api/settings/route");
    R.orders = await import("@/app/api/orders/route");
    R.orderOne = await import("@/app/api/orders/[id]/route");
    R.transition = await import("@/app/api/orders/[id]/transition/route");
    R.ack = await import("@/app/api/orders/[id]/allergy-ack/route");
    R.stats = await import("@/app/api/admin/stats/route");
    R.assistant = await import("@/app/api/assistant/route");
    R.demo = await import("@/app/api/admin/demo/route");
  });
  afterAll(async () => {
    cookieJar.cookie = "";
    await resetRestaurant(sql);
    await sql`delete from "user" where email like 'rt-%@test.local'`;
    await sql.end();
  });

  describe("public menu", () => {
    it("is readable without signing in and carries declarations but no staff fields", async () => {
      const res = await call(R.menu.GET, "GET", "anon");
      expect(res.status).toBe(200);
      const pad = res.body.categories.flatMap((c: any) => c.items).find((i: any) => i.name === "Pad Thai"); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(pad.allergens).toEqual([{ allergen: "egg", level: "contains" }, { allergen: "peanuts", level: "contains" }]);
      expect(res.text).not.toMatch(/"version"|VerifiedBy|archivedAt/);
    });
  });

  describe("placing orders", () => {
    it("needs our own Origin on every mutation (403 for none or a foreign one), before anything else", async () => {
      for (const origin of [null, "https://evil.example", "http://localhost:3001"]) {
        expect((await call(R.orders.POST, "POST", "alice", order(), { origin })).status).toBe(403);
        expect((await call(R.transition.POST, "POST", "alice", { to: "cancelled", version: 1 }, { origin, id: randomUUID() })).status).toBe(403);
        expect((await call(R.allergens.PUT, "PUT", "sue", { version: 1, verified: true, allergens: [] }, { origin, id: m.rice.id })).status).toBe(403);
        expect((await call(R.soldOut.PATCH, "PATCH", "sue", { soldOut: true }, { origin, id: m.rice.id })).status).toBe(403);
        expect((await call(R.settings.PATCH, "PATCH", "sue", { acceptingOrders: true }, { origin })).status).toBe(403);
        expect((await call(R.demo.POST, "POST", "ada", undefined, { origin })).status).toBe(403);
      }
    });

    it("needs a session (401) and rejects malformed, oversized and invalid bodies (400, 413, 400)", async () => {
      expect((await call(R.orders.POST, "POST", "anon", order())).status).toBe(401);
      expect((await call(R.orders.POST, "POST", "alice", undefined, { raw: "{nope" })).status).toBe(400);
      expect((await call(R.orders.POST, "POST", "alice", undefined, { raw: JSON.stringify({ x: "y".repeat(20_000) }) })).status).toBe(413);
      const bad = await call(R.orders.POST, "POST", "alice", order({ lines: [{ itemId: m.rice.id, qty: 99 }] }));
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe("Invalid input");
      expect(bad.text).not.toMatch(/at \w+ \(|node_modules|stack/i);
    });

    it("creates (201) then replays the same key (200, same order), and ignores prices from the client", async () => {
      const body = order({ unitPriceCents: 1, subtotalCents: 1 }, [{ itemId: m.padThai.id, qty: 2, priceCents: 1 } as never]);
      const first = await call(R.orders.POST, "POST", "alice", body);
      expect(first.status).toBe(201);
      expect(first.body.order.subtotalCents).toBe(2900);
      const again = await call(R.orders.POST, "POST", "alice", body);
      expect(again.status).toBe(200);
      expect(again.body.order.id).toBe(first.body.order.id);
      const mine = await call(R.orders.GET, "GET", "alice");
      expect(mine.body.orders.filter((o: any) => o.id === first.body.order.id)).toHaveLength(1); // eslint-disable-line @typescript-eslint/no-explicit-any
      ids.firstOrder = first.body.order.id;
    });

    it("answers a sold-out item with 409 and the list of items", async () => {
      const res = await call(R.orders.POST, "POST", "bob", order({}, [{ itemId: m.cake.id, qty: 1 }]));
      expect(res.status).toBe(409);
      expect(res.body.details.unavailable[0]).toMatchObject({ name: "Chocolate Cake", reason: "sold_out" });
    });

    it("staff can't place orders (403) and admins get 404", async () => {
      expect((await call(R.orders.POST, "POST", "sue", order())).status).toBe(403);
      expect((await call(R.orders.POST, "POST", "ada", order())).status).toBe(404);
    });
  });

  describe("reading orders", () => {
    it("a stranger gets 404 for someone else's order, an admin gets 404, anonymous gets 401, staff and the owner get it", async () => {
      const id = ids.firstOrder;
      expect((await call(R.orderOne.GET, "GET", "alice", undefined, { id })).status).toBe(200);
      expect((await call(R.orderOne.GET, "GET", "sue", undefined, { id })).status).toBe(200);
      expect((await call(R.orderOne.GET, "GET", "bob", undefined, { id })).status).toBe(404);
      expect((await call(R.orderOne.GET, "GET", "ada", undefined, { id })).status).toBe(404);
      expect((await call(R.orderOne.GET, "GET", "anon", undefined, { id })).status).toBe(401);
      expect((await call(R.orders.GET, "GET", "ada")).status).toBe(404);
      expect((await call(R.orders.GET, "GET", "bob")).body.orders.some((o: any) => o.id === id)).toBe(false); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect((await call(R.orders.GET, "GET", "sue")).body.orders.some((o: any) => o.id === id)).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
  });

  describe("the allergy flow over HTTP", () => {
    it("accept before acknowledgment is 409; the acknowledgment is staff only; then accept works", async () => {
      const placed = await call(R.orders.POST, "POST", "bob", order({ allergy: { has: true, allergens: ["peanuts"], note: "", confirmWithStaff: true } }, [{ itemId: m.padThai.id, qty: 1 }]));
      expect(placed.status).toBe(201);
      const { id, version } = placed.body.order;
      expect((await call(R.transition.POST, "POST", "sue", { to: "accepted", version }, { id })).status).toBe(409);
      expect((await call(R.ack.POST, "POST", "bob", {}, { id })).status).toBe(403);
      expect((await call(R.ack.POST, "POST", "ada", {}, { id })).status).toBe(403);
      expect((await call(R.ack.POST, "POST", "anon", {}, { id })).status).toBe(401);
      expect((await call(R.ack.POST, "POST", "sue", { sneaky: true }, { id })).status).toBe(400);
      const acked = await call(R.ack.POST, "POST", "sue", undefined, { id });
      expect(acked.status).toBe(200);
      expect(acked.body.order.allergy.acknowledged).toBe(true);
      expect((await call(R.transition.POST, "POST", "sue", { to: "accepted", version }, { id })).status).toBe(409); // stale
      expect((await call(R.transition.POST, "POST", "sue", { to: "accepted", version: acked.body.order.version }, { id })).status).toBe(200);
      // The customer sees the acknowledgment but not who gave it.
      const seen = await call(R.orderOne.GET, "GET", "bob", undefined, { id });
      expect(seen.body.order.allergy).toMatchObject({ alert: true, acknowledged: true });
      expect(seen.text).not.toContain(ids.sue);
    });

    it("a customer can't move an order forward over HTTP (403)", async () => {
      expect((await call(R.transition.POST, "POST", "alice", { to: "accepted", version: 1 }, { id: ids.firstOrder })).status).toBe(403);
    });
  });

  describe("menu writes over HTTP", () => {
    it("are staff only: customers, admins and anonymous visitors are refused", async () => {
      for (const who of ["alice", "ada"]) {
        expect((await call(R.items.POST, "POST", who, { categoryId: m.categoryId, name: "x", priceCents: 1 })).status).toBe(403);
        expect((await call(R.allergens.PUT, "PUT", who, { version: 1, verified: true, allergens: [] }, { id: m.rice.id })).status).toBe(403);
        expect((await call(R.soldOut.PATCH, "PATCH", who, { soldOut: true }, { id: m.rice.id })).status).toBe(403);
        expect((await call(R.item.PATCH, "PATCH", who, { version: 1, name: "x" }, { id: m.rice.id })).status).toBe(403);
        expect((await call(R.item.DELETE, "DELETE", who, undefined, { id: m.rice.id })).status).toBe(403);
        expect((await call(R.settings.PATCH, "PATCH", who, { acceptingOrders: false })).status).toBe(403);
        expect((await call(R.categories.POST, "POST", who, { name: "x" })).status).toBe(403);
        expect((await call(R.items.GET, "GET", who)).status).toBe(403);
        expect((await call(R.item.GET, "GET", who, undefined, { id: m.rice.id })).status).toBe(403);
      }
      expect((await call(R.allergens.PUT, "PUT", "anon", { version: 1, verified: true, allergens: [] }, { id: m.rice.id })).status).toBe(401);
      expect((await call(R.items.GET, "GET", "anon")).status).toBe(401);
    });

    it("the allergen PUT is refused without verified: true (400) and works with it, logging the change", async () => {
      const v = (await sql`select version from menu_item where id = ${m.rice.id}`)[0].version;
      const allergens = [{ allergen: "sesame", level: "contains" }];
      expect((await call(R.allergens.PUT, "PUT", "sue", { version: v, allergens }, { id: m.rice.id })).status).toBe(400);
      expect((await call(R.allergens.PUT, "PUT", "sue", { version: v, verified: false, allergens }, { id: m.rice.id })).status).toBe(400);
      const ok = await call(R.allergens.PUT, "PUT", "sue", { version: v, verified: true, allergens }, { id: m.rice.id });
      expect(ok.status).toBe(200);
      expect(ok.body.item.allergensVerifiedBy).toBe(ids.sue);
      expect((await call(R.allergens.PUT, "PUT", "sue", { version: v, verified: true, allergens }, { id: m.rice.id })).status).toBe(409); // stale
      const detail = await call(R.item.GET, "GET", "sue", undefined, { id: m.rice.id });
      expect(detail.body.item.changes).toHaveLength(1);
    });

    it("sold-out and settings work for staff and show on the public menu", async () => {
      expect((await call(R.soldOut.PATCH, "PATCH", "sue", { soldOut: true }, { id: m.soup.id })).status).toBe(200);
      expect((await call(R.settings.PATCH, "PATCH", "sue", { pickupMinutes: 45 })).status).toBe(200);
      const pub = (await call(R.menu.GET, "GET", "anon")).body;
      expect(pub.pickupMinutes).toBe(45);
      expect(pub.categories.flatMap((c: any) => c.items).find((i: any) => i.id === m.soup.id).soldOut).toBe(true); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect((await call(R.settings.PATCH, "PATCH", "sue", { pickupMinutes: 4 })).status).toBe(400);
      await call(R.soldOut.PATCH, "PATCH", "sue", { soldOut: false }, { id: m.soup.id });
      await call(R.settings.PATCH, "PATCH", "sue", { pickupMinutes: 20 });
    });

    it("a malformed item id is 404, not 500", async () => {
      expect((await call(R.item.GET, "GET", "sue", undefined, { id: "nope" })).status).toBe(404);
    });
  });

  describe("menu assistant route", () => {
    const ask = (who: string, question: unknown, opts: { origin?: string | null; raw?: BodyInit } = {}) =>
      call(R.assistant.POST, "POST", who, { question }, { path: "/api/assistant", ...opts });

    it("needs a session (401) and our own Origin (403, checked first)", async () => {
      expect((await ask("anon", "what is popular?")).status).toBe(401);
      for (const origin of [null, "https://evil.example"]) expect((await ask("alice", "what is popular?", { origin })).status).toBe(403);
      expect((await ask("anon", "x", { origin: "https://evil.example" })).status).toBe(403);
    });

    it("rejects an empty or over-long question, unknown fields, malformed JSON and big bodies", async () => {
      expect((await ask("alice", "")).status).toBe(400);
      expect((await ask("alice", "x".repeat(301))).status).toBe(400);
      expect((await ask("alice", 42)).status).toBe(400);
      expect((await call(R.assistant.POST, "POST", "alice", { question: "hi", extra: 1 }, { path: "/api/assistant" })).status).toBe(400);
      expect((await call(R.assistant.POST, "POST", "alice", undefined, { path: "/api/assistant", raw: "{nope" })).status).toBe(400);
      expect((await call(R.assistant.POST, "POST", "alice", undefined, { path: "/api/assistant", raw: JSON.stringify({ question: "x".repeat(40_000) }) })).status).toBe(413);
    });

    it("answers the spec's allergen question deterministically, for any signed-in role", async () => {
      for (const who of ["alice", "sue", "ada"]) {
        const res = await ask(who, "is the pad thai peanut free");
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(["answer", "demo", "footer", "items", "mode"]);
        expect(res.body.mode).toBe("allergen");
        expect(res.body.answer).toContain("Pad Thai: contains peanuts.");
        expect(res.body.answer).toContain("We can't guarantee any dish is free of an allergen.");
        expect(res.body.footer).toBe("Allergies? Ask staff before ordering.");
      }
    });

    it("answers a general question from the recorded demo fixture when no model key is set", async () => {
      const res = await ask("bob", "what is popular?");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ mode: "demo", demo: true });
      expect(res.body.items.length).toBe(2);
    });
  });

  describe("admin routes", () => {
    it("stats are admin only and counts only", async () => {
      expect((await call(R.stats.GET, "GET", "ada")).status).toBe(200);
      for (const who of ["alice", "sue"]) expect((await call(R.stats.GET, "GET", who)).status).toBe(403);
      expect((await call(R.stats.GET, "GET", "anon")).status).toBe(401);
      const stats = (await call(R.stats.GET, "GET", "ada")).body;
      expect(Object.keys(stats).sort()).toEqual(["assistantByDay", "ordersByDay", "soldOutItems", "users"]);
    });

    it("the demo button is admin only (staff and customers 403)", async () => {
      for (const who of ["alice", "sue"]) expect((await call(R.demo.POST, "POST", who)).status).toBe(403);
      expect((await call(R.demo.POST, "POST", "anon")).status).toBe(401);
    });
  });
});
