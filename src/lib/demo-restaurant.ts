import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import type { Allergen, AllergenLevel, DietaryTag, OrderStatus } from "@/lib/db/schema";
import { DEMO_EMAIL_DOMAIN, MARKER } from "@/lib/demo-identity";
import { demoSeedConfig } from "@/lib/demo-seed-config";
import { ConflictError, TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { allocateOrderNumber } from "@/lib/orders";
import { subtotalCents } from "@/lib/order-rules";
import { releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

/**
 * "Demo Noodle Bar": 6 categories, 24 items with allergen declarations (two unverified, one sold out), 3 customers,
 * 2 staff, 1 admin, and 8 orders across every state, exactly one of them with an unacknowledged allergy alert.
 *
 * Two ways in, both through `loadDemoRestaurant`: the admin button (`POST /api/admin/demo`, rate limited, demo users get
 * random passwords nobody knows, and no admin account is created) and the local CLI (`scripts/seed-demo.mts`, which
 * refuses production hosts first, sets a known DEMO_PASSWORD and also creates the demo admin).
 *
 * Users are written with Drizzle, never through Better Auth (its hooks refuse demo identities), and a Postgres 23505
 * (a real account took a demo email) is a 409, not a 500. Menu rows have fixed ids, so a load only ever touches
 * demo rows: it never deletes or edits a real menu item, and items are never deleted (the allergen log is append-only).
 */

const optionsSchema = z.discriminatedUnion("mode", [z.object({ mode: z.literal("admin") }).strict(), z.object({ mode: z.literal("cli") }).strict()]);

/** One admin load per minute and this many per UTC day, for the whole app. */
export const DEMO_LOADS_PER_DAY = 5;

const PEOPLE = {
  casey: { name: "Casey Rivera", local: "casey", role: "user" },
  devon: { name: "Devon Park", local: "devon", role: "user" },
  emery: { name: "Emery Lane", local: "emery", role: "user" },
  avery: { name: "Avery Stone", local: "avery.staff", role: "staff" },
  blake: { name: "Blake Moreno", local: "blake.staff", role: "staff" },
  admin: { name: "Demo Admin", local: "admin", role: "admin" },
} as const;
type Person = keyof typeof PEOPLE;
export const demoEmail = (p: Person) => `${PEOPLE[p].local}@${DEMO_EMAIL_DOMAIN}`;

/** A stable, valid v8-style UUID per demo row, so reloads update the same rows. */
export function demoId(kind: string, slug: string): string {
  const h = createHash("sha256").update(`demo-noodle-bar:${kind}:${slug}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type Decl = [Allergen, AllergenLevel];
type DemoItem = { slug: string; name: string; description: string; priceCents: number; tags?: DietaryTag[]; allergens: Decl[]; unverified?: true; soldOut?: true };
type DemoCategory = { slug: string; name: string; items: DemoItem[] };

const c = (a: Allergen): Decl => [a, "contains"];
const m = (a: Allergen): Decl => [a, "may_contain"];

export const DEMO_MENU: DemoCategory[] = [
  {
    slug: "starters",
    name: "Starters",
    items: [
      { slug: "spring-rolls", name: "Vegetable Spring Rolls", description: "Crisp rolls with cabbage and glass noodles, sweet chili dip.", priceCents: 650, tags: ["vegetarian", "vegan"], allergens: [c("wheat"), c("gluten"), m("soy")] },
      { slug: "edamame", name: "Salted Edamame", description: "Steamed soybeans with sea salt.", priceCents: 500, tags: ["vegetarian", "vegan"], allergens: [c("soy")] },
      { slug: "gyoza", name: "Pork Gyoza", description: "Pan-fried dumplings, ponzu dip.", priceCents: 800, allergens: [c("wheat"), c("gluten"), c("soy"), m("sesame")] },
      { slug: "tofu-bites", name: "Crispy Tofu Bites", description: "Fried tofu with a tamari glaze.", priceCents: 700, tags: ["vegetarian", "vegan"], allergens: [c("soy"), m("wheat")] },
    ],
  },
  {
    slug: "noodles",
    name: "Noodles",
    items: [
      { slug: "pad-thai", name: "Pad Thai", description: "Rice noodles, tamarind sauce, egg, bean sprouts, crushed peanuts.", priceCents: 1450, allergens: [c("peanuts"), c("egg"), c("fish"), c("soy"), m("crustacean_shellfish")] },
      { slug: "tonkotsu-ramen", name: "Tonkotsu Ramen", description: "Pork broth, wheat noodles, soft egg, scallion.", priceCents: 1500, allergens: [c("wheat"), c("gluten"), c("soy"), c("egg"), m("sesame")] },
      { slug: "spicy-miso-ramen", name: "Spicy Miso Ramen", description: "Miso broth with chili paste and corn.", priceCents: 1450, tags: ["spicy"], allergens: [c("wheat"), c("gluten"), c("soy"), c("sesame"), m("milk")] },
      { slug: "garlic-butter-noodles", name: "Garlic Butter Noodles", description: "Wheat noodles, garlic butter, parmesan.", priceCents: 1250, tags: ["vegetarian"], allergens: [c("wheat"), c("gluten"), c("milk")] },
    ],
  },
  {
    slug: "rice-bowls",
    name: "Rice Bowls",
    items: [
      { slug: "teriyaki-chicken", name: "Teriyaki Chicken Bowl", description: "Grilled chicken, teriyaki glaze, rice, greens.", priceCents: 1400, allergens: [c("soy"), c("wheat"), c("gluten"), m("sesame")] },
      { slug: "katsu-curry", name: "Katsu Curry Bowl", description: "Breaded cutlet, mild curry sauce, rice.", priceCents: 1450, allergens: [c("wheat"), c("gluten"), c("egg"), m("milk")] },
      { slug: "veggie-fried-rice", name: "Veggie Fried Rice", description: "Wok-fried rice with egg and seasonal vegetables.", priceCents: 1200, tags: ["vegetarian"], allergens: [c("egg"), c("soy"), m("sesame")] },
      { slug: "shrimp-fried-rice", name: "Shrimp Fried Rice", description: "Wok-fried rice with shrimp, egg and scallion.", priceCents: 1500, allergens: [c("crustacean_shellfish"), c("egg"), c("soy")] },
    ],
  },
  {
    slug: "sides",
    name: "Sides",
    items: [
      { slug: "steamed-rice", name: "Steamed Rice", description: "A bowl of jasmine rice.", priceCents: 300, tags: ["vegetarian", "vegan"], allergens: [] },
      { slug: "kimchi", name: "House Kimchi", description: "Fermented napa cabbage with chili.", priceCents: 450, tags: ["spicy"], allergens: [m("fish")], unverified: true },
      { slug: "seaweed-salad", name: "Seaweed Salad", description: "Wakame with sesame dressing.", priceCents: 450, tags: ["vegetarian", "vegan"], allergens: [c("sesame"), m("soy")] },
      { slug: "chili-cucumbers", name: "Chili Oil Cucumbers", description: "Smashed cucumbers, chili oil, garlic.", priceCents: 500, tags: ["vegetarian", "vegan", "spicy"], allergens: [c("sesame"), c("soy")] },
    ],
  },
  {
    slug: "desserts",
    name: "Desserts",
    items: [
      { slug: "mochi", name: "Mochi Ice Cream", description: "Two pieces, vanilla and green tea.", priceCents: 600, tags: ["vegetarian"], allergens: [c("milk"), m("soy")] },
      { slug: "mango-sticky-rice", name: "Mango Sticky Rice", description: "Sweet sticky rice, mango, coconut cream.", priceCents: 750, tags: ["vegetarian", "vegan"], allergens: [c("sesame")] },
      { slug: "sesame-pudding", name: "Black Sesame Pudding", description: "Silky pudding with toasted sesame.", priceCents: 650, tags: ["vegetarian"], allergens: [c("sesame"), c("milk"), c("egg")] },
      { slug: "pb-brownie", name: "Peanut Butter Brownie", description: "Fudgy brownie with a peanut butter swirl.", priceCents: 700, tags: ["vegetarian"], allergens: [c("peanuts"), c("wheat"), c("gluten"), c("milk"), c("egg"), m("tree_nuts")], soldOut: true },
    ],
  },
  {
    slug: "drinks",
    name: "Drinks",
    items: [
      { slug: "jasmine-tea", name: "Jasmine Tea", description: "Hot or iced.", priceCents: 300, tags: ["vegetarian", "vegan"], allergens: [] },
      { slug: "thai-milk-tea", name: "Iced Thai Milk Tea", description: "Black tea, spices and condensed milk.", priceCents: 450, tags: ["vegetarian"], allergens: [c("milk")] },
      { slug: "matcha-latte", name: "Almond Milk Matcha", description: "Matcha whisked into almond milk.", priceCents: 550, tags: ["vegetarian", "vegan"], allergens: [c("tree_nuts")], unverified: true },
      { slug: "ginger-lemonade", name: "Ginger Lemonade", description: "Fresh lemon and ginger syrup, sparkling.", priceCents: 400, tags: ["vegetarian", "vegan"], allergens: [] },
    ],
  },
];

const ITEMS = DEMO_MENU.flatMap((cat) => cat.items.map((i) => ({ ...i, id: demoId("item", i.slug), categoryId: demoId("category", cat.slug) })));
const itemBySlug = new Map(ITEMS.map((i) => [i.slug, i]));

type DemoOrder = {
  customer: "casey" | "devon" | "emery";
  /** Minutes before the load that the order was placed. */
  age: number;
  status: OrderStatus;
  pickupName: string;
  lines: [slug: string, qty: number][];
  note?: string;
  allergy?: { allergens: Allergen[]; note: string };
  cancelReason?: string;
};

export const DEMO_ORDERS: DemoOrder[] = [
  { customer: "casey", age: 3, status: "placed", pickupName: "Casey", lines: [["pad-thai", 1], ["steamed-rice", 1]], allergy: { allergens: ["peanuts"], note: "Severe peanut allergy, please use clean utensils." } },
  { customer: "devon", age: 6, status: "placed", pickupName: "Devon", lines: [["tonkotsu-ramen", 1], ["gyoza", 1]] },
  { customer: "emery", age: 14, status: "accepted", pickupName: "Emery", lines: [["veggie-fried-rice", 2]], note: "No scallion on one." },
  { customer: "casey", age: 22, status: "preparing", pickupName: "Casey", lines: [["spicy-miso-ramen", 1], ["chili-cucumbers", 1], ["jasmine-tea", 1]] },
  { customer: "devon", age: 30, status: "ready", pickupName: "Devon", lines: [["teriyaki-chicken", 1], ["ginger-lemonade", 1]] },
  { customer: "emery", age: 90, status: "picked_up", pickupName: "Emery", lines: [["katsu-curry", 1], ["mochi", 1]] },
  { customer: "casey", age: 26 * 60, status: "picked_up", pickupName: "Casey", lines: [["garlic-butter-noodles", 1]] },
  { customer: "devon", age: 120, status: "cancelled", pickupName: "Devon", lines: [["shrimp-fried-rice", 1]], cancelReason: "Sold out of shrimp." },
];

const VERSION_AFTER: Record<OrderStatus, number> = { placed: 1, accepted: 2, preparing: 3, ready: 4, picked_up: 5, cancelled: 2 };

/** One constant key serializes every demo load and reservation across processes. */
const LOCK_KEY = "demo-load";
const tryLock = (tx: Pick<ReturnType<typeof db>, "execute">) =>
  tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0)) as ok`);

/**
 * Atomic global reservation: one load per minute and `DEMO_LOADS_PER_DAY` per UTC day for the whole app. Runs in its
 * own short transaction under the load lock, so two requests can't both reserve; a refusal leaves no trace.
 */
async function reserve(actor: Actor): Promise<void> {
  await db().transaction(async (tx) => {
    const [{ ok }] = await tryLock(tx);
    if (!ok) throw new TooManyRequestsError("A demo load is already running. Try again shortly.");
    const { rateEvent } = schema;
    const any = eq(rateEvent.kind, "demo_load");
    await tx.delete(rateEvent).where(and(any, sql`${rateEvent.at} <= now() - interval '1 minute'`));
    const [{ n }] = await tx.select({ n: count() }).from(rateEvent).where(and(any, gt(rateEvent.at, sql`now() - interval '1 minute'`)));
    if (n) throw new TooManyRequestsError("The demo can be loaded once per minute. Try again shortly.");
    if (!(await reserveDaily(tx, "demo_load", DEMO_LOADS_PER_DAY))) {
      throw new TooManyRequestsError("The demo was loaded the maximum number of times today. Try again tomorrow.");
    }
    await tx.insert(rateEvent).values({ userId: actor.id, kind: "demo_load" });
  });
}

/** A load that failed after reserving gives its reservation back. */
async function release(actor: Actor): Promise<void> {
  await db().transaction(async (tx) => {
    await releaseRate(tx, actor.id, "demo_load");
    await releaseDaily(tx, "demo_load");
  });
}

export type DemoLoadResult = { users: number; categories: number; items: number; orders: number };

/**
 * Default is the safe admin-route mode. CLI mode independently rechecks all guards.
 * `now` is only for tests; no HTTP input reaches it.
 */
export async function loadDemoRestaurant(
  actor: Actor,
  options: unknown = { mode: "admin" },
  now: Date = new Date(),
  { reserve: reserveSlot = false }: { reserve?: boolean } = {},
): Promise<DemoLoadResult> {
  assertAdmin(actor);
  const parsed = optionsSchema.parse(options);
  if (reserveSlot) {
    await reserve(actor);
    log.info("admin.demo_load", { by: actor.id });
  }
  try {
    const result = await loadDemo(actor, parsed.mode, now);
    log.info("demo.loaded", { by: actor.id, mode: parsed.mode, ...result });
    return result;
  } catch (err) {
    if (reserveSlot) await release(actor).catch(() => undefined);
    throw err;
  }
}

/** Postgres unique violation, possibly wrapped by Drizzle (`cause`). */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));

const UNRELATED = "A demo email belongs to an unrelated account; no demo data was replaced.";

async function loadDemo(actor: Actor, mode: "admin" | "cli", now: Date): Promise<DemoLoadResult> {
  const password = mode === "cli" ? demoSeedConfig().password : undefined;
  // The admin button creates no admin account: a demo admin with a password nobody knows is still an admin account.
  const who = (Object.keys(PEOPLE) as Person[]).filter((p) => mode === "cli" || PEOPLE[p].role !== "admin");
  const people = new Map<Person, string>();

  // Preflight every identity before changing anything. An unrelated account at a demo address is never adopted.
  for (const p of who) {
    const [existing] = await db().select().from(schema.user).where(eq(schema.user.email, demoEmail(p)));
    if (existing && existing.image !== MARKER) throw new ConflictError(UNRELATED);
    if (existing?.id === actor.id) throw new ConflictError("Load the demo from a separate administrator account.");
  }

  for (const p of who) {
    const { role, name } = PEOPLE[p];
    const email = demoEmail(p);
    // Rotate every time, so a previous CLI password can't sign in on a live load.
    const hash = await hashPassword(password ?? randomBytes(32).toString("base64url"));
    try {
      const id = await db().transaction(async (tx) => {
        const [existing] = await tx.select().from(schema.user).where(eq(schema.user.email, email));
        if (existing) {
          if (existing.image !== MARKER) throw new ConflictError(UNRELATED);
          await tx.update(schema.user).set({ role, banned: false, updatedAt: new Date() }).where(eq(schema.user.id, existing.id));
          await tx.update(schema.account).set({ password: hash, updatedAt: new Date() }).where(and(eq(schema.account.userId, existing.id), eq(schema.account.providerId, "credential")));
          await tx.delete(schema.session).where(eq(schema.session.userId, existing.id));
          return existing.id;
        }
        // Written with Drizzle, not Better Auth: the auth hooks refuse demo emails and marker images.
        const newId = randomUUID();
        await tx.insert(schema.user).values({ id: newId, email, name, role, image: MARKER });
        await tx.insert(schema.account).values({ id: randomUUID(), accountId: newId, providerId: "credential", userId: newId, password: hash });
        return newId;
      });
      people.set(p, id);
      if (role !== "user") log.info("role.changed", { by: actor.id, userId: id, role, via: "demo-load" });
    } catch (e) {
      // A real account took the demo email since the preflight: report a conflict, not a crash.
      if (isUniqueViolation(e)) throw new ConflictError(UNRELATED);
      throw e;
    }
  }
  const ids = [...people.values()];
  const id = (p: Person) => people.get(p)!;
  const verifier = id("avery");

  const { menuCategory, menuItem, menuItemAllergen, allergenChange, order, orderLine, restaurantSetting, rateEvent } = schema;
  const MINUTE = 60_000;
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);

  await db().transaction(async (tx) => {
    // Serialize loads (the CLI and the route can overlap): wait for the lock, never nest another pool use inside.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${LOCK_KEY}, 0))`);

    // Replace only the demo customers' orders and caps. Ids come from the marker-checked accounts above.
    await tx.delete(order).where(inArray(order.customerId, ids));
    await tx.delete(rateEvent).where(and(inArray(rateEvent.userId, ids), sql`${rateEvent.kind} <> 'demo_load'`));

    await tx
      .insert(restaurantSetting)
      .values({ id: 1, acceptingOrders: true, pickupMinutes: 20 })
      .onConflictDoUpdate({ target: restaurantSetting.id, set: { acceptingOrders: true, pickupMinutes: 20, updatedAt: sql`now()` } });

    for (const [position, cat] of DEMO_MENU.entries()) {
      await tx
        .insert(menuCategory)
        .values({ id: demoId("category", cat.slug), name: cat.name, position })
        .onConflictDoUpdate({ target: menuCategory.id, set: { name: cat.name, position } });
    }
    for (const [position, item] of ITEMS.entries()) {
      const verified = item.unverified ? { allergensVerifiedAt: null, allergensVerifiedBy: null } : { allergensVerifiedAt: ago(3 * 24 * 60), allergensVerifiedBy: verifier };
      const values = {
        categoryId: item.categoryId,
        name: item.name,
        description: item.description,
        priceCents: item.priceCents,
        dietaryTags: item.tags ?? [],
        soldOut: item.soldOut ?? false,
        position,
        archivedAt: null,
        ...verified,
      };
      await tx
        .insert(menuItem)
        .values({ id: item.id, ...values })
        .onConflictDoUpdate({ target: menuItem.id, set: { ...values, version: sql`${menuItem.version} + 1`, updatedAt: sql`now()` } });

      // Declarations: log a change when they differ from what's there, or when the item has no log entry yet (the log
      // is append-only, so a reload with nothing new adds nothing).
      const after = item.allergens.map(([allergen, level]) => ({ allergen, level })).sort((a, b) => a.allergen.localeCompare(b.allergen));
      const current = (await tx.select().from(menuItemAllergen).where(eq(menuItemAllergen.itemId, item.id)))
        .map(({ allergen, level }) => ({ allergen, level }))
        .sort((a, b) => a.allergen.localeCompare(b.allergen));
      if (JSON.stringify(current) !== JSON.stringify(after) || !(await hasChange(tx, item.id))) {
        await tx.delete(menuItemAllergen).where(eq(menuItemAllergen.itemId, item.id));
        if (after.length) await tx.insert(menuItemAllergen).values(after.map((a) => ({ itemId: item.id, ...a })));
        await tx.insert(allergenChange).values({ itemId: item.id, actorId: verifier, before: current, after });
      }
    }

    for (const spec of DEMO_ORDERS) {
      const lines = spec.lines.map(([slug, qty], position) => {
        const item = itemBySlug.get(slug)!;
        return { item, qty, position, unitPriceCents: item.priceCents };
      });
      const created = ago(spec.age);
      const [row] = await tx
        .insert(order)
        .values({
          number: await allocateOrderNumber(tx),
          customerId: id(spec.customer),
          status: spec.status,
          pickupName: spec.pickupName,
          note: spec.note ?? "",
          allergyAlert: !!spec.allergy,
          allergyAllergens: spec.allergy?.allergens ?? [],
          allergyNote: spec.allergy?.note ?? "",
          allergyCustomerConfirmed: !!spec.allergy,
          subtotalCents: subtotalCents(lines),
          idempotencyKey: randomUUID(),
          cancelReason: spec.cancelReason ?? null,
          readyEstimateAt: new Date(created.getTime() + 20 * MINUTE),
          version: VERSION_AFTER[spec.status],
          createdAt: created,
          updatedAt: ago(Math.max(0, spec.age - 5)),
        })
        .returning({ id: order.id });
      await tx.insert(orderLine).values(
        lines.map((l) => ({
          orderId: row.id,
          customerId: id(spec.customer),
          menuItemId: l.item.id,
          name: l.item.name,
          unitPriceCents: l.unitPriceCents,
          qty: l.qty,
          allergens: l.item.allergens.map(([allergen, level]) => ({ allergen, level })).sort((a, b) => a.allergen.localeCompare(b.allergen)),
          position: l.position,
        })),
      );
    }
  });

  return { users: people.size, categories: DEMO_MENU.length, items: ITEMS.length, orders: DEMO_ORDERS.length };
}

async function hasChange(tx: Pick<ReturnType<typeof db>, "select">, itemId: string): Promise<boolean> {
  const rows = await tx.select({ id: schema.allergenChange.id }).from(schema.allergenChange).where(eq(schema.allergenChange.itemId, itemId)).limit(1);
  return rows.length > 0;
}
