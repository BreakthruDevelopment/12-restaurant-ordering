import { sql } from "drizzle-orm";
import { boolean, check, date, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Auth tables (shape required by Better Auth with the admin plugin).
// ---------------------------------------------------------------------------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Restaurant domain (spec 12). One restaurant per deployment.
// ---------------------------------------------------------------------------

/** US nine majors plus gluten (spec: no EU-14 list). Declarations are structured, never free text. */
export const ALLERGENS = ["milk", "egg", "fish", "crustacean_shellfish", "tree_nuts", "peanuts", "wheat", "soy", "sesame", "gluten"] as const;
export type Allergen = (typeof ALLERGENS)[number];
export const ALLERGEN_LEVELS = ["contains", "may_contain"] as const;
export type AllergenLevel = (typeof ALLERGEN_LEVELS)[number];
export const DIETARY_TAGS = ["vegetarian", "vegan", "spicy"] as const;
export type DietaryTag = (typeof DIETARY_TAGS)[number];
export const ORDER_STATUSES = ["placed", "accepted", "preparing", "ready", "picked_up", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const list = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));

export const menuCategory = pgTable(
  "menu_category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("menu_category_name_chk", sql`char_length(${t.name}) between 1 and 60`)],
);

export const menuItem = pgTable(
  "menu_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Items are archived, never deleted: allergen_change (append-only) and order lines point at them.
    categoryId: uuid("category_id")
      .notNull()
      .references(() => menuCategory.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull(),
    dietaryTags: text("dietary_tags").array().notNull().default(sql`'{}'::text[]`),
    soldOut: boolean("sold_out").notNull().default(false),
    position: integer("position").notNull().default(0),
    /** The "I checked these against the recipe" stamp. Null means never verified. */
    allergensVerifiedAt: timestamp("allergens_verified_at", { withTimezone: true }),
    allergensVerifiedBy: text("allergens_verified_by").references(() => user.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("menu_item_category_idx").on(t.categoryId),
    check("menu_item_name_chk", sql`char_length(${t.name}) between 1 and 80`),
    check("menu_item_description_chk", sql`char_length(${t.description}) <= 300`),
    check("menu_item_price_chk", sql`${t.priceCents} between 0 and 100000`),
    check("menu_item_tags_chk", sql`${t.dietaryTags} <@ array[${list(DIETARY_TAGS)}]::text[]`),
  ],
);

/** No row means "not declared", which the app never shows as "free of". */
export const menuItemAllergen = pgTable(
  "menu_item_allergen",
  {
    itemId: uuid("item_id")
      .notNull()
      .references(() => menuItem.id, { onDelete: "cascade" }),
    allergen: text("allergen", { enum: ALLERGENS }).notNull(),
    level: text("level", { enum: ALLERGEN_LEVELS }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.allergen] }),
    check("menu_item_allergen_allergen_chk", sql`${t.allergen} in (${list(ALLERGENS)})`),
    check("menu_item_allergen_level_chk", sql`${t.level} in (${list(ALLERGEN_LEVELS)})`),
  ],
);

/**
 * Append-only log of every allergen declaration change (a database trigger refuses UPDATE, DELETE and TRUNCATE).
 * `actor_id` has no foreign key on purpose: the record must outlive the account.
 */
export const allergenChange = pgTable(
  "allergen_change",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    itemId: uuid("item_id")
      .notNull()
      .references(() => menuItem.id, { onDelete: "restrict" }),
    actorId: text("actor_id").notNull(),
    before: jsonb("before").$type<{ allergen: Allergen; level: AllergenLevel }[]>().notNull(),
    after: jsonb("after").$type<{ allergen: Allergen; level: AllergenLevel }[]>().notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("allergen_change_item_at_idx").on(t.itemId, t.at)],
);

/** Singleton row (id is always 1). */
export const restaurantSetting = pgTable(
  "restaurant_setting",
  {
    id: integer("id").primaryKey().default(1),
    acceptingOrders: boolean("accepting_orders").notNull().default(true),
    pickupMinutes: integer("pickup_minutes").notNull().default(20),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("restaurant_setting_singleton_chk", sql`${t.id} = 1`), check("restaurant_setting_pickup_chk", sql`${t.pickupMinutes} between 5 and 90`)],
);

/** One row per UTC day; the row lock taken by the upsert serializes daily order numbers. */
export const dailyCounter = pgTable("daily_counter", {
  day: date("day", { mode: "string" }).primaryKey(),
  last: integer("last").notNull().default(0),
});

export const order = pgTable(
  "order",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** "A-042": per UTC day, from daily_counter. */
    number: text("number").notNull(),
    day: date("day", { mode: "string" })
      .notNull()
      .default(sql`(now() at time zone 'utc')::date`),
    customerId: text("customer_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    status: text("status", { enum: ORDER_STATUSES }).notNull().default("placed"),
    pickupName: text("pickup_name").notNull(),
    note: text("note").notNull().default(""),
    // The allergy question. Health data: immutable after placement (trigger), customer and staff only.
    allergyAlert: boolean("allergy_alert").notNull().default(false),
    allergyAllergens: text("allergy_allergens").array().notNull().default(sql`'{}'::text[]`),
    allergyNote: text("allergy_note").notNull().default(""),
    /** The customer ticked "I'll confirm with staff before eating" (required when a dish matches a picked allergen). */
    allergyCustomerConfirmed: boolean("allergy_customer_confirmed").notNull().default(false),
    allergyAckBy: text("allergy_ack_by").references(() => user.id, { onDelete: "set null" }),
    allergyAckAt: timestamp("allergy_ack_at", { withTimezone: true }),
    /** Computed on the server from the menu prices at order time. Integer cents. */
    subtotalCents: integer("subtotal_cents").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    cancelReason: text("cancel_reason"),
    /** Estimated pickup time, fixed at placement from restaurant_setting.pickup_minutes. */
    readyEstimateAt: timestamp("ready_estimate_at", { withTimezone: true }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("order_id_customer_uq").on(t.id, t.customerId),
    uniqueIndex("order_customer_idempotency_uidx").on(t.customerId, t.idempotencyKey),
    uniqueIndex("order_day_number_uidx").on(t.day, t.number),
    index("order_status_created_idx").on(t.status, t.createdAt),
    index("order_customer_created_idx").on(t.customerId, t.createdAt),
    check("order_status_chk", sql`${t.status} in (${list(ORDER_STATUSES)})`),
    check("order_pickup_name_chk", sql`char_length(${t.pickupName}) between 1 and 40`),
    check("order_note_chk", sql`char_length(${t.note}) <= 200 and char_length(${t.allergyNote}) <= 200`),
    check("order_subtotal_chk", sql`${t.subtotalCents} >= 0`),
    check("order_allergens_chk", sql`${t.allergyAllergens} <@ array[${list(ALLERGENS)}]::text[]`),
    // No alert, no allergy data; an alert always carries at least an allergen or a note.
    check(
      "order_allergy_shape_chk",
      sql`(${t.allergyAlert} and (cardinality(${t.allergyAllergens}) > 0 or char_length(${t.allergyNote}) > 0)) or (not ${t.allergyAlert} and cardinality(${t.allergyAllergens}) = 0 and ${t.allergyNote} = '')`,
    ),
    check("order_ack_shape_chk", sql`(${t.allergyAckAt} is null or ${t.allergyAlert})`),
    check("order_confirmed_shape_chk", sql`(not ${t.allergyCustomerConfirmed} or ${t.allergyAlert})`),
    check("order_cancel_reason_chk", sql`${t.cancelReason} is null or char_length(${t.cancelReason}) <= 200`),
  ],
);

export const orderLine = pgTable(
  "order_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    customerId: text("customer_id").notNull(),
    menuItemId: uuid("menu_item_id")
      .notNull()
      .references(() => menuItem.id, { onDelete: "restrict" }),
    // Snapshots: what the customer saw and what the kitchen must cook, whatever the menu says later.
    name: text("name").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    qty: integer("qty").notNull(),
    allergens: jsonb("allergens").$type<{ allergen: Allergen; level: AllergenLevel }[]>().notNull(),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    foreignKey({ columns: [t.orderId, t.customerId], foreignColumns: [order.id, order.customerId], name: "order_line_order_customer_fk" }).onDelete("cascade"),
    index("order_line_order_idx").on(t.orderId),
    check("order_line_qty_chk", sql`${t.qty} between 1 and 20`),
    check("order_line_price_chk", sql`${t.unitPriceCents} between 0 and 100000`),
  ],
);

// ---------------------------------------------------------------------------
// Usage limits (src/lib/usage.ts). Each app lists its own kinds here; changing a list
// needs a migration, because the CHECK constraints below are part of the schema.
// ---------------------------------------------------------------------------

export const RATE_KINDS = ["order", "qa", "menu_write", "ai", "demo_load"] as const;
export const DAILY_USAGE_KINDS = ["ai", "demo_load"] as const;

/** App-wide daily counters (one row per UTC day and kind) for free-tier caps. */
export const dailyUsage = pgTable(
  "daily_usage",
  {
    day: date("day", { mode: "string" }).notNull(),
    kind: text("kind", { enum: DAILY_USAGE_KINDS }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind] }),
    check("daily_usage_kind_chk", sql`${t.kind} in (${list(DAILY_USAGE_KINDS)})`),
    check("daily_usage_count_chk", sql`${t.count} >= 0`),
  ],
);

/** Per-user rate-limit ledger: one row per attempt, counted over a sliding window. */
export const rateEvent = pgTable(
  "rate_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RATE_KINDS }).notNull(),
    at: timestamp("at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index("rate_event_user_kind_at_idx").on(t.userId, t.kind, t.at),
    check("rate_event_kind_chk", sql`${t.kind} in (${list(RATE_KINDS)})`),
  ],
);

export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;

/**
 * Background job queue (see src/lib/jobs). `key` makes enqueue idempotent: only one queued or running job per
 * (kind, key). `payload` holds ids and small parameters, never personal data or secrets. `last_error` is a short
 * code, never a message.
 */
export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    key: text("key"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    /** Times a handler asked to try again later without using an attempt; capped so a job can't defer forever. */
    deferrals: integer("deferrals").notNull().default(0),
    /** A floor, not a deadline: the job runs at the first claim after this time. */
    runAfter: timestamp("run_after", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    /** While running: the lease. After it passes, any worker may reclaim the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true, precision: 3 }),
    /** Fencing token of the current claim: a worker whose lease was reclaimed can no longer complete or fail the job. */
    lockToken: uuid("lock_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    uniqueIndex("job_active_key_uidx").on(t.kind, t.key).where(sql`${t.status} in ('queued', 'running') and ${t.key} is not null`),
    index("job_due_idx").on(t.runAfter).where(sql`${t.status} = 'queued'`),
    index("job_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("job_kind_key_idx").on(t.kind, t.key, t.createdAt),
    index("job_owner_idx").on(t.ownerId),
    check("job_status_chk", sql`${t.status} in (${list(JOB_STATUSES)})`),
    check("job_attempts_chk", sql`${t.attempts} >= 0 and ${t.maxAttempts} >= 1 and ${t.deferrals} >= 0`),
  ],
);

export type User = typeof user.$inferSelect;
export type MenuItem = typeof menuItem.$inferSelect;
export type Order = typeof order.$inferSelect;
export type Job = typeof job.$inferSelect;
