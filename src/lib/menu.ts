import "server-only";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { assertStaff } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ALLERGENS, ALLERGEN_LEVELS, DIETARY_TAGS, type Allergen, type AllergenLevel } from "@/lib/db/schema";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { type VerificationStatus, verificationStatus } from "@/lib/order-rules";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Menu, allergen declarations, sold-out and settings. Reading the menu is public. Every write is staff only (admins
 * get 403: they see counts, not the kitchen's data), rate limited at 120 per staff member per hour, and validated
 * with zod. Allergen declarations are structured (an enum), carry a verification stamp, and every change is
 * written to the append-only `allergen_change` log in the same transaction.
 */

export const MAX_CATEGORIES = 20;
export const MAX_ITEMS = 200;
export const MENU_WRITES_PER_HOUR = 120;
const WRITE_LIMIT_MESSAGE = "Too many menu changes this hour. Try again later.";

const id = z.uuid();
/** A malformed id in a path is the same answer as a missing one (404), never a 400. */
const parseId = (value: string): string => {
  const parsed = id.safeParse(value);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
};
const version = z.number().int().min(1).max(1_000_000);

export const categoryInput = z.object({ name: z.string().trim().min(1).max(60), position: z.number().int().min(0).max(1000).default(0) }).strict();
export const categoryPatch = z.object({ name: z.string().trim().min(1).max(60).optional(), position: z.number().int().min(0).max(1000).optional() }).strict();

const itemFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300),
  priceCents: z.number().int().min(0).max(100_000),
  dietaryTags: z
    .array(z.enum(DIETARY_TAGS))
    .max(DIETARY_TAGS.length)
    .refine((a) => new Set(a).size === a.length, "Duplicate dietary tag"),
  categoryId: id,
  position: z.number().int().min(0).max(1000),
};

/** New items start with no declarations and no verification stamp: they can only be declared through the allergen PUT. */
export const newItemInput = z
  .object({
    categoryId: itemFields.categoryId,
    name: itemFields.name,
    description: itemFields.description.default(""),
    priceCents: itemFields.priceCents,
    dietaryTags: itemFields.dietaryTags.default([]),
    position: itemFields.position.default(0),
  })
  .strict();

/** Strict on purpose: `allergens`, `soldOut` and the verification stamp can't be smuggled in through a PATCH. */
export const itemPatch = z
  .object({
    version,
    name: itemFields.name.optional(),
    description: itemFields.description.optional(),
    priceCents: itemFields.priceCents.optional(),
    dietaryTags: itemFields.dietaryTags.optional(),
    categoryId: itemFields.categoryId.optional(),
    position: itemFields.position.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 1, "Nothing to change");

export const allergenInput = z
  .object({
    version,
    // Declarations are only ever saved with the explicit "I checked these against the recipe" tick.
    verified: z.literal(true, { error: "Confirm you checked these against the recipe (verified: true)." }),
    allergens: z
      .array(z.object({ allergen: z.enum(ALLERGENS), level: z.enum(ALLERGEN_LEVELS) }).strict())
      .max(ALLERGENS.length)
      .refine((a) => new Set(a.map((x) => x.allergen)).size === a.length, "Each allergen can be declared once"),
  })
  .strict();

export const soldOutInput = z.object({ soldOut: z.boolean() }).strict();
export const settingsInput = z
  .object({ acceptingOrders: z.boolean().optional(), pickupMinutes: z.number().int().min(5).max(90).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");

type Declared = { allergen: Allergen; level: AllergenLevel };
const canonical = (a: readonly Declared[]): Declared[] => [...a].sort((x, y) => x.allergen.localeCompare(y.allergen)).map(({ allergen, level }) => ({ allergen, level }));

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type PublicMenuItem = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  dietaryTags: string[];
  soldOut: boolean;
  /** Declared allergens. An allergen that isn't listed is NOT declared free: the UI must never say "free of". */
  allergens: Declared[];
  allergensVerifiedAt: string | null;
  allergensCheck: VerificationStatus;
};
export type PublicMenu = {
  acceptingOrders: boolean;
  pickupMinutes: number;
  categories: { id: string; name: string; items: PublicMenuItem[] }[];
};

export async function getSettings(executor: Pick<ReturnType<typeof db>, "insert" | "select"> = db()) {
  await executor.insert(schema.restaurantSetting).values({ id: 1 }).onConflictDoNothing();
  const [row] = await executor.select().from(schema.restaurantSetting).where(eq(schema.restaurantSetting.id, 1));
  return row;
}

async function declarationsFor(itemIds: string[], executor: Pick<ReturnType<typeof db>, "select"> = db()) {
  const map = new Map<string, Declared[]>();
  if (itemIds.length === 0) return map;
  const rows = await executor.select().from(schema.menuItemAllergen).where(inArray(schema.menuItemAllergen.itemId, itemIds));
  for (const r of rows) map.set(r.itemId, [...(map.get(r.itemId) ?? []), { allergen: r.allergen, level: r.level }]);
  for (const [k, v] of map) map.set(k, canonical(v));
  return map;
}

/** Public: available (not archived) items with declarations and no staff fields (no versions, no staff ids). */
export async function getPublicMenu(now: Date = new Date()): Promise<PublicMenu> {
  const { menuCategory, menuItem } = schema;
  const settings = await getSettings();
  const categories = await db().select().from(menuCategory).orderBy(asc(menuCategory.position), asc(menuCategory.name));
  const items = await db().select().from(menuItem).where(isNull(menuItem.archivedAt)).orderBy(asc(menuItem.position), asc(menuItem.name));
  const declared = await declarationsFor(items.map((i) => i.id));
  return {
    acceptingOrders: settings.acceptingOrders,
    pickupMinutes: settings.pickupMinutes,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      items: items
        .filter((i) => i.categoryId === c.id)
        .map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description,
          priceCents: i.priceCents,
          dietaryTags: i.dietaryTags,
          soldOut: i.soldOut,
          allergens: declared.get(i.id) ?? [],
          allergensVerifiedAt: i.allergensVerifiedAt?.toISOString() ?? null,
          allergensCheck: verificationStatus(i.allergensVerifiedAt, now),
        })),
    })),
  };
}

/** Staff: every item including archived ones, with versions and who verified. */
export async function listMenuForStaff(actor: Actor) {
  assertStaff(actor);
  const { menuCategory, menuItem } = schema;
  const categories = await db().select().from(menuCategory).orderBy(asc(menuCategory.position), asc(menuCategory.name));
  const items = await db().select().from(menuItem).orderBy(asc(menuItem.position), asc(menuItem.name));
  const declared = await declarationsFor(items.map((i) => i.id));
  return {
    settings: await getSettings(),
    categories,
    items: items.map((i) => ({ ...i, allergens: declared.get(i.id) ?? [], allergensCheck: verificationStatus(i.allergensVerifiedAt) })),
  };
}

/** Staff: one item with its allergen change log (newest first). */
export async function getMenuItemForStaff(actor: Actor, itemId: string) {
  assertStaff(actor);
  const parsed = id.safeParse(itemId);
  if (!parsed.success) throw new NotFoundError();
  const { menuItem, allergenChange } = schema;
  const [item] = await db().select().from(menuItem).where(eq(menuItem.id, parsed.data));
  if (!item) throw new NotFoundError();
  const declared = await declarationsFor([item.id]);
  const changes = await db().select().from(allergenChange).where(eq(allergenChange.itemId, item.id)).orderBy(desc(allergenChange.at));
  return { ...item, allergens: declared.get(item.id) ?? [], allergensCheck: verificationStatus(item.allergensVerifiedAt), changes };
}

// ---------------------------------------------------------------------------
// Writes (staff only)
// ---------------------------------------------------------------------------

/** Run `fn` in a transaction that first spends one of the staff member's 120 hourly menu writes. */
async function menuWrite<T>(actor: Actor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertStaff(actor);
  return db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "menu_write", MENU_WRITES_PER_HOUR, WRITE_LIMIT_MESSAGE);
    return fn(tx);
  });
}

export async function createCategory(actor: Actor, input: unknown) {
  assertStaff(actor);
  const data = categoryInput.parse(input);
  return menuWrite(actor, async (tx) => {
    await advisoryLock(tx, "menu:categories");
    const [{ n }] = await tx.select({ n: count() }).from(schema.menuCategory);
    if (n >= MAX_CATEGORIES) throw new ConflictError(`A menu can have at most ${MAX_CATEGORIES} categories.`);
    const [row] = await tx.insert(schema.menuCategory).values(data).returning();
    log.info("menu.category_created", { categoryId: row.id, by: actor.id });
    return row;
  });
}

export async function updateCategory(actor: Actor, categoryId: string, input: unknown) {
  assertStaff(actor);
  const parsedId = parseId(categoryId);
  const data = categoryPatch.refine((v) => Object.keys(v).length > 0, "Nothing to change").parse(input);
  return menuWrite(actor, async (tx) => {
    const [row] = await tx.update(schema.menuCategory).set(data).where(eq(schema.menuCategory.id, parsedId)).returning();
    if (!row) throw new NotFoundError();
    return row;
  });
}

/** Only an empty category (no items at all, archived ones included, since they stay referenced) can go. */
export async function deleteCategory(actor: Actor, categoryId: string) {
  assertStaff(actor);
  const parsedId = parseId(categoryId);
  return menuWrite(actor, async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(schema.menuItem).where(eq(schema.menuItem.categoryId, parsedId));
    if (n > 0) throw new ConflictError("Move or archive this category's items first (archived items still belong to it).");
    const gone = await tx.delete(schema.menuCategory).where(eq(schema.menuCategory.id, parsedId)).returning({ id: schema.menuCategory.id });
    if (gone.length === 0) throw new NotFoundError();
  });
}

export async function createItem(actor: Actor, input: unknown) {
  assertStaff(actor);
  const data = newItemInput.parse(input);
  return menuWrite(actor, async (tx) => {
    await advisoryLock(tx, "menu:items");
    const [cat] = await tx.select({ id: schema.menuCategory.id }).from(schema.menuCategory).where(eq(schema.menuCategory.id, data.categoryId));
    if (!cat) throw new ConflictError("That category doesn't exist.");
    const [{ n }] = await tx.select({ n: count() }).from(schema.menuItem).where(isNull(schema.menuItem.archivedAt));
    if (n >= MAX_ITEMS) throw new ConflictError(`A menu can have at most ${MAX_ITEMS} items.`);
    const [row] = await tx.insert(schema.menuItem).values(data).returning();
    log.info("menu.item_created", { itemId: row.id, by: actor.id });
    return { ...row, allergens: [] as Declared[], allergensCheck: verificationStatus(null) };
  });
}

export async function updateItem(actor: Actor, itemId: string, input: unknown) {
  assertStaff(actor);
  const parsedId = parseId(itemId);
  const { version: expected, ...fields } = itemPatch.parse(input);
  return menuWrite(actor, async (tx) => {
    const { menuItem } = schema;
    if (fields.categoryId) {
      const [cat] = await tx.select({ id: schema.menuCategory.id }).from(schema.menuCategory).where(eq(schema.menuCategory.id, fields.categoryId));
      if (!cat) throw new ConflictError("That category doesn't exist.");
    }
    const [current] = await tx.select().from(menuItem).where(eq(menuItem.id, parsedId)).for("update");
    if (!current) throw new NotFoundError();
    if (current.archivedAt || current.version !== expected) throw new ConflictError("This item was changed by someone else. Reload and try again.");
    // A new name or description may describe a different recipe: the allergen check no longer stands until staff redo it.
    const recipeChanged = (fields.name !== undefined && fields.name !== current.name) || (fields.description !== undefined && fields.description !== current.description);
    const [row] = await tx
      .update(menuItem)
      .set({
        ...fields,
        ...(recipeChanged ? { allergensVerifiedAt: null, allergensVerifiedBy: null } : {}),
        version: sql`${menuItem.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(menuItem.id, parsedId))
      .returning();
    log.info("menu.item_updated", { itemId: row.id, by: actor.id });
    return { ...row, allergensCheck: verificationStatus(row.allergensVerifiedAt) };
  });
}

/** DELETE archives: the item leaves the public menu but stays for order lines and the allergen log. Idempotent. */
export async function archiveItem(actor: Actor, itemId: string) {
  assertStaff(actor);
  const parsedId = parseId(itemId);
  return menuWrite(actor, async (tx) => {
    const { menuItem } = schema;
    const [row] = await tx
      .update(menuItem)
      .set({ archivedAt: sql`coalesce(${menuItem.archivedAt}, now())`, version: sql`${menuItem.version} + 1`, updatedAt: sql`now()` })
      .where(eq(menuItem.id, parsedId))
      .returning({ id: menuItem.id });
    if (!row) throw new NotFoundError();
    log.info("menu.item_archived", { itemId: row.id, by: actor.id });
  });
}

/**
 * Replace an item's allergen declarations. Needs the current `version` and `verified: true`; stamps who verified and
 * when; writes before/after to the append-only change log; all in one transaction with the row locked.
 */
export async function setAllergens(actor: Actor, itemId: string, input: unknown) {
  assertStaff(actor);
  const parsedId = parseId(itemId);
  const data = allergenInput.parse(input);
  return menuWrite(actor, async (tx) => {
    const { menuItem, menuItemAllergen, allergenChange } = schema;
    const [item] = await tx.select().from(menuItem).where(eq(menuItem.id, parsedId)).for("update");
    if (!item) throw new NotFoundError();
    if (item.archivedAt) throw new ConflictError("This item is archived.");
    if (item.version !== data.version) throw new ConflictError("This item was changed by someone else. Reload and try again.");
    const before = canonical((await declarationsFor([item.id], tx)).get(item.id) ?? []);
    const after = canonical(data.allergens);
    await tx.delete(menuItemAllergen).where(eq(menuItemAllergen.itemId, item.id));
    if (after.length) await tx.insert(menuItemAllergen).values(after.map((a) => ({ itemId: item.id, ...a })));
    await tx.insert(allergenChange).values({ itemId: item.id, actorId: actor.id, before, after });
    const [row] = await tx
      .update(menuItem)
      .set({ allergensVerifiedAt: sql`now()`, allergensVerifiedBy: actor.id, version: sql`${menuItem.version} + 1`, updatedAt: sql`now()` })
      .where(eq(menuItem.id, item.id))
      .returning();
    // Who and which item only: never the declarations themselves.
    log.info("menu.allergens_changed", { itemId: item.id, by: actor.id });
    return { ...row, allergens: after, allergensCheck: verificationStatus(row.allergensVerifiedAt) };
  });
}

/** Idempotent set (not a toggle), so two staff members can't undo each other by accident. Doesn't bump `version`. */
export async function setSoldOut(actor: Actor, itemId: string, input: unknown) {
  assertStaff(actor);
  const parsedId = parseId(itemId);
  const { soldOut } = soldOutInput.parse(input);
  return menuWrite(actor, async (tx) => {
    const [row] = await tx
      .update(schema.menuItem)
      .set({ soldOut, updatedAt: sql`now()` })
      .where(and(eq(schema.menuItem.id, parsedId), isNull(schema.menuItem.archivedAt)))
      .returning();
    if (!row) throw new NotFoundError();
    log.info("menu.sold_out_set", { itemId: row.id, soldOut, by: actor.id });
    return row;
  });
}

export async function updateSettings(actor: Actor, input: unknown) {
  assertStaff(actor);
  const data = settingsInput.parse(input);
  return menuWrite(actor, async (tx) => {
    await getSettings(tx);
    const [row] = await tx
      .update(schema.restaurantSetting)
      .set({ ...data, updatedAt: sql`now()` })
      .where(eq(schema.restaurantSetting.id, 1))
      .returning();
    log.info("settings.updated", { by: actor.id, ...data });
    return row;
  });
}
