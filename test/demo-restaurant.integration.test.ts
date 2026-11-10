/**
 * The demo restaurant loader against a real Postgres (TEST_DATABASE_URL): the data it creates, that reloading is safe,
 * that it never touches real accounts or real menu rows, that a Postgres 23505 becomes a 409, and that the admin
 * route's rate limit and admin-only rule hold. Users are written with Drizzle, so the auth hooks don't get in the way.
 */
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { insertUsers, resetRestaurant } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "demo-password-123";

describe.skipIf(!url)("demo restaurant loader (Postgres)", () => {
  let sql: postgres.Sql;
  let demo: typeof import("@/lib/demo-restaurant");
  const admin = { id: "dm-admin", role: "admin" as const };
  const staff = { id: "dm-staff", role: "staff" as const };
  const customer = { id: "dm-cust", role: "user" as const };

  const wipeDemoUsers = async () => {
    await sql`delete from "user" where email like '%@demo.breakthru.test'`;
    await sql`delete from rate_event where kind = 'demo_load'`;
    await sql`delete from daily_usage where kind = 'demo_load'`;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'dm-%'`;
    await insertUsers(sql, [admin, staff, customer]);
    demo = await import("@/lib/demo-restaurant");
  });
  beforeEach(async () => {
    await wipeDemoUsers();
    await resetRestaurant(sql);
  });
  afterAll(async () => {
    await wipeDemoUsers();
    await resetRestaurant(sql);
    await sql`delete from "user" where id like 'dm-%'`;
    await sql.end();
  });

  const load = (mode: "admin" | "cli" = "admin", reserve = false) => demo.loadDemoRestaurant(admin, { mode }, new Date(), { reserve });
  const cliEnv = () => {
    vi.stubEnv("DEMO_SEED", "yes");
    vi.stubEnv("APP_URL", "http://localhost:3000");
    vi.stubEnv("DEMO_PASSWORD", PASSWORD);
    vi.stubEnv("DATABASE_URL", url!);
  };

  it("creates Demo Noodle Bar: 6 categories, 24 items with declarations, two unverified, one sold out", async () => {
    const result = await load();
    expect(result).toEqual({ users: 5, categories: 6, items: 24, orders: 8 });
    expect((await sql`select count(*)::int as n from menu_category`)[0].n).toBe(6);
    const items = await sql`select id, allergens_verified_at, sold_out from menu_item where archived_at is null`;
    expect(items).toHaveLength(24);
    expect(items.filter((i) => i.allergens_verified_at === null)).toHaveLength(2);
    expect(items.filter((i) => i.sold_out)).toHaveLength(1);
    // Every verified item has a change-log row, including the ones declaring nothing.
    expect((await sql`select count(distinct item_id)::int as n from allergen_change`)[0].n).toBe(24);
    // The assistant's eval dish: pad thai declares peanuts.
    const [pad] = await sql`select a.allergen, a.level from menu_item i join menu_item_allergen a on a.item_id = i.id where i.name = 'Pad Thai' and a.allergen = 'peanuts'`;
    expect(pad).toEqual({ allergen: "peanuts", level: "contains" });
    expect((await sql`select count(*)::int as n from menu_item_allergen`)[0].n).toBeGreaterThan(40);
    expect((await sql`select accepting_orders from restaurant_setting`)[0].accepting_orders).toBe(true);
  });

  it("creates 3 customers and 2 staff with the staff role, and no admin from the admin button", async () => {
    await load();
    const roles = await sql`select role, count(*)::int as n from "user" where email like '%@demo.breakthru.test' group by role order by role`;
    expect(roles.map((r) => [r.role, r.n])).toEqual([["staff", 2], ["user", 3]]);
    expect((await sql`select count(*)::int as n from "user" where email like '%@demo.breakthru.test' and image = 'urn:breakthru:restaurant-demo:v1'`)[0].n).toBe(5);
  });

  it("creates orders across every state, exactly one with an allergy alert, still unacknowledged", async () => {
    await load();
    const rows = await sql`select status, allergy_alert, allergy_ack_at, number, day::text as day, subtotal_cents, version from "order" order by created_at`;
    expect(rows).toHaveLength(8);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["placed", "accepted", "preparing", "ready", "picked_up", "cancelled"]));
    const alerts = rows.filter((r) => r.allergy_alert);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ status: "placed", allergy_ack_at: null });
    expect(new Set(rows.map((r) => `${r.day} ${r.number}`)).size).toBe(8);
    // Totals are integer cents and agree with the line snapshots.
    const sums = await sql`select o.id, o.subtotal_cents, sum(l.unit_price_cents * l.qty)::int as s from "order" o join order_line l on l.order_id = o.id group by o.id`;
    for (const r of sums) expect(r.subtotal_cents).toBe(r.s);
    // The alert order can be worked through the real flow: it can't be accepted before the acknowledgment.
    const orders = await import("@/lib/orders");
    const [alert] = await sql`select id, version from "order" where allergy_alert`;
    const staffUser = { id: (await sql`select id from "user" where email = 'avery.staff@demo.breakthru.test'`)[0].id as string, role: "staff" as const };
    await expect(orders.transitionOrder(staffUser, alert.id, { to: "accepted", version: alert.version })).rejects.toMatchObject({ status: 409 });
  });

  it("gives each demo order the restaurant day it was placed on, and numbers it within that day", async () => {
    const now = new Date();
    await demo.loadDemoRestaurant(admin, { mode: "admin" }, now);
    const { restaurantDay } = await import("@/lib/restaurant-time");
    const rows = await sql`select day::text as day, number, created_at from "order"`;
    for (const r of rows) expect(r.day).toBe(restaurantDay(r.created_at));
    const days = new Set(rows.map((r) => r.day));
    expect(days.size).toBe(2); // the 26-hour-old order is on the previous day
    // Numbers restart at A-001 each day and are gapless within it.
    for (const day of days) {
      const nums = rows.filter((r) => r.day === day).map((r) => Number(r.number.slice(2))).sort((a, b) => a - b);
      expect(nums[nums.length - 1] - nums[0]).toBe(nums.length - 1);
    }
    const { adminStats } = await import("@/lib/admin-stats");
    const stats = await adminStats(admin);
    expect(stats.ordersByDay).toHaveLength(2);
    expect(stats.ordersByDay.reduce((n, d) => n + d.total, 0)).toBe(8);
  });

  it("attributes declarations and verification stamps to the administrator who loaded it, not to a demo staff member", async () => {
    await load();
    const staffIds = (await sql`select id from "user" where role = 'staff' and email like '%@demo.breakthru.test'`).map((r) => r.id);
    expect(staffIds).toHaveLength(2);
    const actors = (await sql`select distinct actor_id from allergen_change`).map((r) => r.actor_id);
    expect(actors).toEqual([admin.id]);
    const stamps = (await sql`select distinct allergens_verified_by from menu_item where allergens_verified_at is not null`).map((r) => r.allergens_verified_by);
    expect(stamps).toEqual([admin.id]);
    // The trusted CLI actor isn't an account: the change log names it and the stamp keeps no reviewer.
    cliEnv();
    try {
      await demo.loadDemoRestaurant({ id: "demo-seed-cli", role: "admin" }, { mode: "cli" });
    } finally {
      vi.unstubAllEnvs();
    }
    expect((await sql`select count(*)::int as n from menu_item where allergens_verified_at is not null and allergens_verified_by is null`)[0].n).toBe(22);
  });

  it("never changes whether ordering is open", async () => {
    await sql`update restaurant_setting set accepting_orders = false, pickup_minutes = 55`;
    await load();
    expect((await sql`select accepting_orders, pickup_minutes from restaurant_setting`)[0]).toEqual({ accepting_orders: false, pickup_minutes: 55 });
  });

  it("only an administrator can load it: staff and customers get 403", async () => {
    await expect(demo.loadDemoRestaurant(staff, { mode: "admin" })).rejects.toMatchObject({ status: 403 });
    await expect(demo.loadDemoRestaurant(customer, { mode: "admin" })).rejects.toMatchObject({ status: 403 });
    expect((await sql`select count(*)::int as n from menu_item`)[0].n).toBe(0);
  });

  it("can't be asked for CLI mode credentials through odd options", async () => {
    for (const options of [{ mode: "cli", password: "x" }, { mode: "root" }, {}, null]) {
      await expect(demo.loadDemoRestaurant(admin, options)).rejects.toMatchObject({ name: "ZodError" });
    }
  });

  it("reloading replaces the demo orders and rewrites the same rows: no duplicates, no new log entries", async () => {
    await load();
    const ids = (await sql`select id from "user" where email like '%@demo.breakthru.test' order by id`).map((r) => r.id);
    const logged = (await sql`select count(*)::int as n from allergen_change`)[0].n;
    await load();
    expect((await sql`select count(*)::int as n from menu_item`)[0].n).toBe(24);
    expect((await sql`select count(*)::int as n from menu_category`)[0].n).toBe(6);
    expect((await sql`select count(*)::int as n from "order"`)[0].n).toBe(8);
    expect((await sql`select count(*)::int as n from allergen_change`)[0].n).toBe(logged);
    expect((await sql`select id from "user" where email like '%@demo.breakthru.test' order by id`).map((r) => r.id)).toEqual(ids);
  });

  it("a reload resets what staff changed on demo rows, and keeps real menu rows and real orders exactly as they were", async () => {
    await load();
    const [cat] = await sql`insert into menu_category (name, position) values ('Real category', 99) returning id`;
    const [real] = await sql`insert into menu_item (category_id, name, price_cents) values (${cat.id}, 'Real dish', 777) returning id, version`;
    await insertUsers(sql, [{ id: "dm-real-customer", role: "user" }]);
    await sql`insert into "order" (number, customer_id, pickup_name, subtotal_cents, idempotency_key, request_hash, ready_estimate_at) values ('R-1', 'dm-real-customer', 'Real', 777, gen_random_uuid(), 'x', now())`;
    await sql`update menu_item set price_cents = 1 where name = 'Pad Thai'`;
    await load();
    expect((await sql`select price_cents from menu_item where name = 'Pad Thai'`)[0].price_cents).toBe(1450);
    expect(await sql`select 1 from menu_item where id = ${real.id} and price_cents = 777 and version = ${real.version}`).toHaveLength(1);
    expect(await sql`select 1 from "order" where number = 'R-1'`).toHaveLength(1);
    await sql`delete from "user" where id = 'dm-real-customer'`;
  });

  it("refuses with 409 when a real account holds a demo email, and changes nothing", async () => {
    await sql`insert into "user" (id, name, email, role) values ('dm-squatter', 'Squatter', 'avery.staff@demo.breakthru.test', 'user')`;
    await expect(load()).rejects.toMatchObject({ status: 409 });
    expect((await sql`select role, image from "user" where id = 'dm-squatter'`)[0]).toEqual({ role: "user", image: null });
    expect((await sql`select count(*)::int as n from menu_item`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from "user" where email like '%@demo.breakthru.test'`)[0].n).toBe(1);
  });

  it("maps a Postgres unique violation (23505) during the user insert to 409, not 500", async () => {
    // Simulates a real account taking a demo email between the preflight check and the insert.
    await sql`create or replace function dm_race() returns trigger language plpgsql as $$ begin
      if new.email = 'devon@demo.breakthru.test' then raise exception 'duplicate' using errcode = '23505', constraint = 'user_email_unique'; end if; return new; end $$`;
    await sql`create trigger dm_race before insert on "user" for each row execute function dm_race()`;
    try {
      await expect(load()).rejects.toMatchObject({ status: 409, name: "ConflictError" });
      expect((await sql`select count(*)::int as n from menu_item`)[0].n).toBe(0);
    } finally {
      await sql`drop trigger dm_race on "user"`;
      await sql`drop function dm_race()`;
    }
  });

  it("CLI mode needs the guards, creates the admin too, and the accounts can sign in with the demo password", async () => {
    cliEnv();
    try {
      expect(await load("cli")).toMatchObject({ users: 6 });
      const { auth } = await import("@/lib/auth");
      const handler = auth().handler;
      const signIn = (email: string, password: string) =>
        handler(new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
      for (const [email, role] of [["blake.staff@demo.breakthru.test", "staff"], ["admin@demo.breakthru.test", "admin"], ["casey@demo.breakthru.test", "user"]] as const) {
        const res = await signIn(email, PASSWORD);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { user: { role: string } }).user.role).toBe(role);
      }
      // A production-looking APP_URL is refused before anything is written.
      vi.stubEnv("APP_URL", "https://app12.breakthruventures.ai");
      await expect(load("cli")).rejects.toThrow(/refused/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("admin-button loads give the demo accounts passwords nobody knows", async () => {
    cliEnv();
    try {
      await load("cli");
    } finally {
      vi.unstubAllEnvs();
    }
    await load("admin"); // rotates every demo password
    const { auth } = await import("@/lib/auth");
    const res = await auth().handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "avery.staff@demo.breakthru.test", password: PASSWORD }) }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("logs each demo staff grant as role.changed (via demo-load), with ids only", async () => {
    const { log } = await import("@/lib/log");
    const spy = vi.spyOn(log, "info").mockImplementation(() => {});
    try {
      await load();
      const grants = spy.mock.calls.filter(([msg]) => msg === "role.changed");
      expect(grants).toHaveLength(2);
      for (const [, f] of grants) expect(f).toMatchObject({ by: admin.id, role: "staff", via: "demo-load" });
      expect(JSON.stringify(spy.mock.calls)).not.toMatch(/@demo|password|peanut/i);
    } finally {
      spy.mockRestore();
    }
  });

  it("the admin button is limited to one load a minute (429) and a failed load gives its slot back", async () => {
    await load("admin", true);
    await expect(load("admin", true)).rejects.toMatchObject({ status: 429 });
    await wipeDemoUsers();
    await sql`insert into "user" (id, name, email, role) values ('dm-squatter2', 'S', 'blake.staff@demo.breakthru.test', 'user')`;
    await expect(load("admin", true)).rejects.toMatchObject({ status: 409 });
    expect((await sql`select count(*)::int as n from rate_event where kind = 'demo_load'`)[0].n).toBe(0);
    await sql`delete from "user" where id = 'dm-squatter2'`;
  });
});
