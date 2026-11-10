/**
 * What an admin may see: counts only. Orders, names, notes and allergy details never appear, and the order
 * functions themselves answer 404 to an admin.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertUsers, resetRestaurant, seedMenu } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("admin counts (Postgres)", () => {
  let sql: postgres.Sql;
  const admin = { id: "as-admin", role: "admin" as const };
  const staff = { id: "as-staff", role: "staff" as const };
  const customer = { id: "as-cust", role: "user" as const };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'as-%'`;
    await insertUsers(sql, [admin, staff, customer]);
    await resetRestaurant(sql);
  });
  afterAll(async () => {
    await resetRestaurant(sql);
    await sql`delete from "user" where id like 'as-%'`;
    await sql.end();
  });

  it("returns orders by status per day, sold-out items and accounts by role, and nothing identifying", async () => {
    const m = await seedMenu(sql, staff.id);
    const orders = await import("@/lib/orders");
    const { adminStats } = await import("@/lib/admin-stats");
    const placed = await orders.placeOrder(customer, {
      lines: [{ itemId: m.padThai.id, qty: 1 }],
      pickupName: "Zebedee Quibble",
      note: "side door please",
      allergy: { has: true, allergens: ["peanuts"], note: "CANARY-note", confirmWithStaff: true },
      idempotencyKey: randomUUID(),
    });
    await orders.placeOrder(customer, { lines: [{ itemId: m.rice.id, qty: 1 }], pickupName: "Sam", allergy: { has: false }, idempotencyKey: randomUUID() });
    await orders.transitionOrder(customer, placed.order.id, { to: "cancelled", version: 1 });

    const stats = await adminStats(admin);
    expect(stats.ordersByDay).toHaveLength(1);
    expect(stats.ordersByDay[0]).toMatchObject({ total: 2, placed: 1, cancelled: 1, accepted: 0, preparing: 0, ready: 0, picked_up: 0 });
    expect(stats.soldOutItems).toBe(1);
    expect(stats.users.admins).toBeGreaterThanOrEqual(1);
    expect(stats.users.staff).toBeGreaterThanOrEqual(1);
    expect(stats.users.customers).toBeGreaterThanOrEqual(1);
    const json = JSON.stringify(stats);
    for (const secret of ["Zebedee", "side door", "CANARY", "peanuts", "Pad Thai", placed.order.id, customer.id, "A-0"]) expect(json).not.toContain(secret);
    // Only numbers and day labels.
    expect(Object.keys(stats).sort()).toEqual(["assistantByDay", "ordersByDay", "soldOutItems", "users"]);
  });

  it("is for administrators only: staff and customers get 403, and the same admin gets 404 on order functions", async () => {
    const { adminStats } = await import("@/lib/admin-stats");
    await expect(adminStats(staff)).rejects.toMatchObject({ status: 403 });
    await expect(adminStats(customer)).rejects.toMatchObject({ status: 403 });
    const orders = await import("@/lib/orders");
    await expect(orders.listOrders(admin)).rejects.toMatchObject({ status: 404 });
    await expect(orders.getOrder(admin, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(orders.acknowledgeAllergy(admin, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(orders.transitionOrder(admin, randomUUID(), { to: "accepted", version: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
