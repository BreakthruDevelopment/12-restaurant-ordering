/**
 * Menu, allergen declarations, sold-out and settings against a real Postgres (TEST_DATABASE_URL):
 * staff edit, customers and admins can't, declarations need the verified tick and the current version, every change
 * is logged, and the log can't be edited or deleted, even by SQL.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type SeedItem, insertUsers, resetRestaurant, seedMenu } from "./fixtures";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("menu data layer (Postgres)", () => {
  let sql: postgres.Sql;
  let menu: typeof import("@/lib/menu");
  const staff = { id: "mn-staff", role: "staff" as const };
  const staff2 = { id: "mn-staff2", role: "staff" as const };
  const customer = { id: "mn-cust", role: "user" as const };
  const admin = { id: "mn-admin", role: "admin" as const };
  let seeded: Awaited<ReturnType<typeof seedMenu>>;
  let item: SeedItem;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    await sql`delete from "user" where id like 'mn-%'`;
    await insertUsers(sql, [staff, staff2, customer, admin]);
    await resetRestaurant(sql);
    seeded = await seedMenu(sql, staff.id);
    item = seeded.rice;
    menu = await import("@/lib/menu");
  });
  afterAll(async () => {
    await resetRestaurant(sql);
    await sql`delete from "user" where id like 'mn-%'`;
    await sql.end();
  });

  const version = async (id: string) => (await sql`select version from menu_item where id = ${id}`)[0].version as number;
  const declare = (actor: typeof staff, id: string, allergens: unknown[], extra: Record<string, unknown> = {}, v?: number) =>
    version(id).then((cur) => menu.setAllergens(actor, id, { version: v ?? cur, verified: true, allergens, ...extra }));

  describe("access rules", () => {
    it("staff may write; a customer is blocked; an admin is blocked too (counts only)", async () => {
      const input = { categoryId: seeded.categoryId, name: "Access test", priceCents: 500 };
      const made = await menu.createItem(staff, input);
      expect(made.name).toBe("Access test");
      for (const other of [customer, admin]) {
        await expect(menu.createItem(other, input)).rejects.toMatchObject({ status: 403 });
        await expect(menu.updateItem(other, made.id, { version: 1, name: "x" })).rejects.toMatchObject({ status: 403 });
        await expect(menu.archiveItem(other, made.id)).rejects.toMatchObject({ status: 403 });
        await expect(menu.setAllergens(other, made.id, { version: 1, verified: true, allergens: [] })).rejects.toMatchObject({ status: 403 });
        await expect(menu.setSoldOut(other, made.id, { soldOut: true })).rejects.toMatchObject({ status: 403 });
        await expect(menu.updateSettings(other, { acceptingOrders: false })).rejects.toMatchObject({ status: 403 });
        await expect(menu.createCategory(other, { name: "Nope" })).rejects.toMatchObject({ status: 403 });
        await expect(menu.listMenuForStaff(other)).rejects.toMatchObject({ status: 403 });
        await expect(menu.getMenuItemForStaff(other, made.id)).rejects.toMatchObject({ status: 403 });
      }
      expect((await sql`select name from menu_item where id = ${made.id}`)[0].name).toBe("Access test");
    });

    it("the public menu is readable by anyone and has no staff fields", async () => {
      const pub = await menu.getPublicMenu();
      const json = JSON.stringify(pub);
      expect(pub.categories.length).toBeGreaterThan(0);
      expect(json).not.toMatch(/"version"|verifiedBy|allergensVerifiedBy|archivedAt|actorId/);
      const padThai = pub.categories.flatMap((c) => c.items).find((i) => i.name === "Pad Thai")!;
      expect(padThai.allergens).toEqual([
        { allergen: "egg", level: "contains" },
        { allergen: "peanuts", level: "contains" },
      ]);
      expect(padThai.priceCents).toBe(1450);
    });

    it("the public menu hides archived items and shows sold-out ones as sold out", async () => {
      const gone = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Archive me", priceCents: 100 });
      await menu.archiveItem(staff, gone.id);
      await menu.archiveItem(staff, gone.id); // idempotent
      const all = (await menu.getPublicMenu()).categories.flatMap((c) => c.items);
      expect(all.find((i) => i.id === gone.id)).toBeUndefined();
      expect(all.find((i) => i.id === seeded.cake.id)?.soldOut).toBe(true);
      // Archived items stay in the staff view.
      expect((await menu.listMenuForStaff(staff)).items.some((i) => i.id === gone.id && i.archivedAt)).toBe(true);
    });

    it("an item with no declaration is shown as never verified, not as free of anything", async () => {
      const fresh = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Undeclared", priceCents: 100 });
      const shown = (await menu.getPublicMenu()).categories.flatMap((c) => c.items).find((i) => i.id === fresh.id)!;
      expect(shown.allergens).toEqual([]);
      expect(shown.allergensCheck).toBe("never");
      expect(shown.allergensVerifiedAt).toBeNull();
    });
  });

  describe("allergen declarations", () => {
    it("are refused without verified: true (missing, false, or any other value)", async () => {
      const v = await version(item.id);
      for (const verified of [undefined, false, "true", 1, null]) {
        const body: Record<string, unknown> = { version: v, allergens: [{ allergen: "milk", level: "contains" }] };
        if (verified !== undefined) body.verified = verified;
        await expect(menu.setAllergens(staff, item.id, body)).rejects.toMatchObject({ name: "ZodError" });
      }
      expect(await sql`select 1 from menu_item_allergen where item_id = ${item.id}`).toHaveLength(0);
      expect(await sql`select 1 from allergen_change where item_id = ${item.id}`).toHaveLength(0);
    });

    it("are structured: unknown allergens, unknown levels, duplicates and extra keys are refused", async () => {
      const v = await version(item.id);
      const bad = [
        [{ allergen: "celery", level: "contains" }],
        [{ allergen: "milk", level: "free_of" }],
        [{ allergen: "milk", level: "contains" }, { allergen: "milk", level: "may_contain" }],
        [{ allergen: "milk", level: "contains", note: "free text" }],
        ["milk"],
      ];
      for (const allergens of bad) await expect(menu.setAllergens(staff, item.id, { version: v, verified: true, allergens })).rejects.toMatchObject({ name: "ZodError" });
      await expect(menu.setAllergens(staff, item.id, { version: v, verified: true, allergens: [], extra: 1 })).rejects.toMatchObject({ name: "ZodError" });
      expect(await sql`select 1 from menu_item_allergen where item_id = ${item.id}`).toHaveLength(0);
    });

    it("the database refuses a made-up allergen or level too", async () => {
      await expect(sql`insert into menu_item_allergen (item_id, allergen, level) values (${item.id}, 'celery', 'contains')`).rejects.toMatchObject({ code: "23514" });
      await expect(sql`insert into menu_item_allergen (item_id, allergen, level) values (${item.id}, 'milk', 'free_of')`).rejects.toMatchObject({ code: "23514" });
    });

    it("save the declarations, stamp who verified and when, and bump the version", async () => {
      const before = await version(item.id);
      const saved = await declare(staff, item.id, [
        { allergen: "sesame", level: "may_contain" },
        { allergen: "soy", level: "contains" },
      ]);
      expect(saved.allergens).toEqual([
        { allergen: "sesame", level: "may_contain" },
        { allergen: "soy", level: "contains" },
      ]);
      expect(saved.version).toBe(before + 1);
      expect(saved.allergensVerifiedBy).toBe(staff.id);
      expect(saved.allergensVerifiedAt).toBeInstanceOf(Date);
      expect(saved.allergensCheck).toBe("current");
    });

    it("replace the old declarations rather than add to them", async () => {
      await declare(staff, item.id, [{ allergen: "milk", level: "contains" }]);
      const rows = await sql`select allergen from menu_item_allergen where item_id = ${item.id}`;
      expect(rows.map((r) => r.allergen)).toEqual(["milk"]);
      await declare(staff, item.id, []);
      expect(await sql`select 1 from menu_item_allergen where item_id = ${item.id}`).toHaveLength(0);
    });

    it("refuse a stale version (409) and leave the declarations and the log alone", async () => {
      const v = await version(item.id);
      await declare(staff, item.id, [{ allergen: "egg", level: "contains" }]);
      const logged = (await sql`select count(*)::int as n from allergen_change where item_id = ${item.id}`)[0].n;
      await expect(menu.setAllergens(staff2, item.id, { version: v, verified: true, allergens: [{ allergen: "fish", level: "contains" }] })).rejects.toMatchObject({ status: 409 });
      expect((await sql`select allergen from menu_item_allergen where item_id = ${item.id}`).map((r) => r.allergen)).toEqual(["egg"]);
      expect((await sql`select count(*)::int as n from allergen_change where item_id = ${item.id}`)[0].n).toBe(logged);
    });

    it("racing writers with the same version: exactly one wins", async () => {
      const v = await version(item.id);
      const results = await Promise.allSettled(
        (["milk", "fish", "soy", "wheat", "sesame", "egg"] as const).map((a) =>
          menu.setAllergens(staff, item.id, { version: v, verified: true, allergens: [{ allergen: a, level: "contains" }] }),
        ),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((r) => r.status === "rejected")) expect((r as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect((await sql`select count(*)::int as n from menu_item_allergen where item_id = ${item.id}`)[0].n).toBe(1);
    });

    it("write a before/after row to the change log for every change, with the actor", async () => {
      const target = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Logged", priceCents: 100 });
      await declare(staff, target.id, [{ allergen: "peanuts", level: "contains" }]);
      await declare(staff2, target.id, [{ allergen: "tree_nuts", level: "may_contain" }, { allergen: "peanuts", level: "contains" }]);
      const detail = await menu.getMenuItemForStaff(staff, target.id);
      expect(detail.changes).toHaveLength(2);
      const [newest, oldest] = detail.changes;
      expect(oldest).toMatchObject({ actorId: staff.id, before: [], after: [{ allergen: "peanuts", level: "contains" }] });
      expect(newest).toMatchObject({ actorId: staff2.id, before: [{ allergen: "peanuts", level: "contains" }] });
      expect(newest.after).toEqual([{ allergen: "peanuts", level: "contains" }, { allergen: "tree_nuts", level: "may_contain" }]);
    });

    it("re-verifying unchanged declarations still logs and refreshes the stamp", async () => {
      const target = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Reverified", priceCents: 100 });
      await declare(staff, target.id, [{ allergen: "soy", level: "contains" }]);
      await sql`update menu_item set allergens_verified_at = now() - interval '100 days' where id = ${target.id}`;
      expect((await menu.getMenuItemForStaff(staff, target.id)).allergensCheck).toBe("stale");
      await declare(staff, target.id, [{ allergen: "soy", level: "contains" }]);
      const detail = await menu.getMenuItemForStaff(staff, target.id);
      expect(detail.allergensCheck).toBe("current");
      expect(detail.changes).toHaveLength(2);
    });

    it("can't be written through PATCH, creation or sold-out (strict inputs)", async () => {
      const v = await version(item.id);
      for (const extra of [{ allergens: [] }, { allergensVerifiedAt: "2026-01-01T00:00:00Z" }, { allergensVerifiedBy: staff.id }, { soldOut: true }, { archivedAt: null }, { id: "x" }]) {
        await expect(menu.updateItem(staff, item.id, { version: v, name: "Renamed", ...extra })).rejects.toMatchObject({ name: "ZodError" });
      }
      await expect(menu.createItem(staff, { categoryId: seeded.categoryId, name: "x", priceCents: 1, allergens: [{ allergen: "milk", level: "contains" }] })).rejects.toMatchObject({ name: "ZodError" });
      await expect(menu.createItem(staff, { categoryId: seeded.categoryId, name: "x", priceCents: 1, allergensVerifiedAt: new Date().toISOString() })).rejects.toMatchObject({ name: "ZodError" });
      await expect(menu.setSoldOut(staff, item.id, { soldOut: true, allergens: [] })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("an archived item's declarations can't be edited", async () => {
      const gone = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Gone", priceCents: 100 });
      await menu.archiveItem(staff, gone.id);
      await expect(declare(staff, gone.id, [])).rejects.toMatchObject({ status: 409 });
    });
  });

  describe("the allergen change log is append-only", () => {
    it("refuses UPDATE, DELETE and TRUNCATE", async () => {
      await declare(staff, item.id, [{ allergen: "soy", level: "contains" }]);
      await expect(sql`update allergen_change set actor_id = 'someone-else'`).rejects.toMatchObject({ code: "55000" });
      await expect(sql`update allergen_change set after = '[]'::jsonb where item_id = ${item.id}`).rejects.toMatchObject({ code: "55000" });
      await expect(sql`delete from allergen_change where item_id = ${item.id}`).rejects.toMatchObject({ code: "55000" });
      await expect(sql`delete from allergen_change`).rejects.toMatchObject({ code: "55000" });
      await expect(sql`truncate allergen_change`).rejects.toMatchObject({ code: "55000" });
      expect((await sql`select count(*)::int as n from allergen_change where item_id = ${item.id}`)[0].n).toBeGreaterThan(0);
    });

    it("keeps the record when the staff account is deleted (no foreign key to user)", async () => {
      await sql`insert into "user" (id, name, email, role) values ('mn-temp', 'temp', 'mn-temp@test.local', 'staff')`;
      await declare({ id: "mn-temp", role: "staff" }, item.id, [{ allergen: "fish", level: "may_contain" }]);
      await sql`delete from "user" where id = 'mn-temp'`;
      expect(await sql`select 1 from allergen_change where actor_id = 'mn-temp'`).toHaveLength(1);
      expect((await sql`select allergens_verified_by from menu_item where id = ${item.id}`)[0].allergens_verified_by).toBeNull();
    });
  });

  describe("items, categories, sold-out and settings", () => {
    it("PATCH needs the current version, and a stale one is 409 while a missing item is 404", async () => {
      const made = await menu.createItem(staff, { categoryId: seeded.categoryId, name: "Patch me", priceCents: 1000 });
      const updated = await menu.updateItem(staff, made.id, { version: made.version, priceCents: 1100, dietaryTags: ["vegan", "spicy"] });
      expect(updated).toMatchObject({ priceCents: 1100, version: made.version + 1, dietaryTags: ["vegan", "spicy"] });
      await expect(menu.updateItem(staff, made.id, { version: made.version, priceCents: 1 })).rejects.toMatchObject({ status: 409 });
      await expect(menu.updateItem(staff, "00000000-0000-4000-8000-000000000000", { version: 1, priceCents: 1 })).rejects.toMatchObject({ status: 404 });
      expect((await sql`select price_cents from menu_item where id = ${made.id}`)[0].price_cents).toBe(1100);
    });

    it("validates input: price in integer cents 0 to 100,000, lengths, tags, category", async () => {
      const base = { categoryId: seeded.categoryId, name: "Valid", priceCents: 500 };
      for (const bad of [
        { priceCents: -1 }, { priceCents: 100_001 }, { priceCents: 12.5 }, { priceCents: "500" }, { name: "" }, { name: "x".repeat(81) },
        { description: "x".repeat(301) }, { dietaryTags: ["gluten-free"] }, { dietaryTags: ["vegan", "vegan"] }, { categoryId: "nope" },
      ]) {
        await expect(menu.createItem(staff, { ...base, ...bad })).rejects.toMatchObject({ name: "ZodError" });
      }
      await expect(menu.createItem(staff, { ...base, categoryId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ status: 409 });
      await expect(menu.createItem(staff, { ...base, priceCents: 100_000 })).resolves.toBeTruthy();
      await expect(menu.createItem(staff, { ...base, priceCents: 0 })).resolves.toBeTruthy();
    });

    it("sold-out is set, not toggled, and is staff only", async () => {
      await menu.setSoldOut(staff, seeded.soup.id, { soldOut: true });
      await menu.setSoldOut(staff2, seeded.soup.id, { soldOut: true });
      expect((await sql`select sold_out from menu_item where id = ${seeded.soup.id}`)[0].sold_out).toBe(true);
      await menu.setSoldOut(staff, seeded.soup.id, { soldOut: false });
      expect((await sql`select sold_out from menu_item where id = ${seeded.soup.id}`)[0].sold_out).toBe(false);
      await expect(menu.setSoldOut(staff, seeded.soup.id, { soldOut: "yes" })).rejects.toMatchObject({ name: "ZodError" });
    });

    it("categories: validated, capped at 20, and only empty ones can be deleted", async () => {
      await expect(menu.createCategory(staff, { name: "" })).rejects.toMatchObject({ name: "ZodError" });
      await expect(menu.deleteCategory(staff, seeded.categoryId)).rejects.toMatchObject({ status: 409 });
      const [{ n }] = await sql`select count(*)::int as n from menu_category`;
      const made = [];
      for (let i = n; i < 20; i++) made.push(await menu.createCategory(staff, { name: `Cap ${i}` }));
      await expect(menu.createCategory(staff, { name: "One too many" })).rejects.toMatchObject({ status: 409 });
      await menu.deleteCategory(staff, made[0].id);
      await expect(menu.createCategory(staff, { name: "Fits again" })).resolves.toBeTruthy();
      await expect(menu.deleteCategory(staff, made[0].id)).rejects.toMatchObject({ status: 404 });
    });

    it("items are capped at 200", async () => {
      const [{ n }] = await sql`select count(*)::int as n from menu_item where archived_at is null`;
      await sql`insert into menu_item (category_id, name, price_cents) select ${seeded.categoryId}, 'bulk ' || g, 100 from generate_series(1, ${200 - n}::int) g`;
      await expect(menu.createItem(staff, { categoryId: seeded.categoryId, name: "Too many", priceCents: 100 })).rejects.toMatchObject({ status: 409 });
      await sql`delete from menu_item where name like 'bulk %'`;
    });

    it("settings: staff only, pickup minutes 5 to 90", async () => {
      expect(await menu.updateSettings(staff, { acceptingOrders: false, pickupMinutes: 35 })).toMatchObject({ acceptingOrders: false, pickupMinutes: 35 });
      expect((await menu.getPublicMenu()).acceptingOrders).toBe(false);
      for (const bad of [{ pickupMinutes: 4 }, { pickupMinutes: 91 }, { pickupMinutes: 10.5 }, {}, { id: 2 }]) {
        await expect(menu.updateSettings(staff, bad)).rejects.toMatchObject({ name: "ZodError" });
      }
      await menu.updateSettings(staff, { acceptingOrders: true, pickupMinutes: 20 });
    });

    it("menu writes are limited to 120 per staff member per hour (429), per member", async () => {
      await sql`insert into rate_event (user_id, kind) select ${staff2.id}, 'menu_write' from generate_series(1, 120)`;
      await expect(menu.setSoldOut(staff2, seeded.rice.id, { soldOut: false })).rejects.toMatchObject({ status: 429 });
      await expect(menu.setSoldOut(staff, seeded.rice.id, { soldOut: false })).resolves.toBeTruthy();
      await sql`delete from rate_event where user_id = ${staff2.id}`;
    });
  });
});
