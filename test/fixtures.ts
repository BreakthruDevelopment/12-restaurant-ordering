import postgres from "postgres";

/** Shared helpers for the integration tests. Test files run one at a time against one database. */

export type TestUser = { id: string; role: "user" | "staff" | "admin" };

export async function insertUsers(sql: postgres.Sql, users: TestUser[]) {
  for (const u of users) {
    await sql`insert into "user" (id, name, email, role) values (${u.id}, ${u.id}, ${u.id + "@test.local"}, ${u.role}) on conflict (id) do update set role = ${u.role}`;
  }
}

/**
 * Empty the menu and orders. The allergen log is append-only (a trigger refuses DELETE and TRUNCATE), so this switches
 * triggers off for one transaction with session_replication_role, which needs a superuser (the CI database user is one).
 */
export async function resetRestaurant(sql: postgres.Sql) {
  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`delete from "order"`;
    await tx`delete from allergen_change`;
    await tx`delete from menu_item_allergen`;
    await tx`delete from menu_item`;
    await tx`delete from menu_category`;
    await tx`update restaurant_setting set accepting_orders = true, pickup_minutes = 20`;
    await tx`delete from daily_counter`;
  });
}

export type SeedItem = { id: string; name: string; price: number };

/** A small menu inserted with raw SQL: Pad Thai (peanuts, egg), Rice (no declaration), Soup (may contain milk), Cake (sold out). */
export async function seedMenu(sql: postgres.Sql, staffId: string) {
  const [cat] = await sql`insert into menu_category (name, position) values ('Test mains', 1) returning id`;
  const mk = async (name: string, price: number, opts: { soldOut?: boolean; verified?: boolean } = {}): Promise<SeedItem> => {
    const [row] = await sql`
      insert into menu_item (category_id, name, price_cents, sold_out, allergens_verified_at, allergens_verified_by)
      values (${cat.id}, ${name}, ${price}, ${opts.soldOut ?? false}, ${opts.verified === false ? null : sql`now()`}, ${opts.verified === false ? null : staffId})
      returning id`;
    return { id: row.id as string, name, price };
  };
  const padThai = await mk("Pad Thai", 1450);
  const rice = await mk("Steamed Rice", 300);
  const soup = await mk("Miso Soup", 800);
  const cake = await mk("Chocolate Cake", 600, { soldOut: true });
  await sql`insert into menu_item_allergen (item_id, allergen, level) values
    (${padThai.id}, 'peanuts', 'contains'), (${padThai.id}, 'egg', 'contains'), (${soup.id}, 'milk', 'may_contain')`;
  return { categoryId: cat.id as string, padThai, rice, soup, cake };
}
