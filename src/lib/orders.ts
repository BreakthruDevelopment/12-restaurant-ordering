import "server-only";
import { type SQL, and, asc, count, desc, eq, inArray, isNotNull, isNull, not, or, sql } from "drizzle-orm";
import { z } from "zod";
import { type OrderAccess, assertCustomer, orderAccess, orderScope } from "@/lib/access";
import { ForbiddenError, type Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ALLERGENS, ORDER_STATUSES, type Allergen, type OrderStatus } from "@/lib/db/schema";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { log } from "@/lib/log";
import { getSettings } from "@/lib/menu";
import { OPEN_STATUSES, type Declared, allergenConflicts, checkTransition, formatOrderNumber, requestHash, subtotalCents } from "@/lib/order-rules";
import { enqueueOrderEvent, transactionWithOrderEvents } from "@/lib/order-tx";
import { restaurantDayExpr } from "@/lib/restaurant-time";
import { type Tx, advisoryLock, consumeRate } from "@/lib/usage";

/**
 * Orders, the allergy flow and the status machine.
 *
 * Rules enforced here (and, for the allergy data, again by database triggers):
 * - Prices, names and allergen declarations are read from the database at order time and snapshotted on the lines.
 *   The client sends item ids and quantities only; any price it sends is dropped by the schema.
 * - The allergy question is required. Allergy data is fixed at placement. If a dish declares an allergen the customer
 *   picked, the order is refused until they confirm they will check with staff.
 * - An order with an allergy alert can't be accepted until staff acknowledge it; staff can always cancel it.
 * - Every transition carries the `version` the caller saw; the UPDATE matches on it, so two racing writers can't both win.
 * - Customers reach their own orders only; staff reach all; admins get 404 (access.ts).
 * - Logs carry ids and statuses, never allergy details, names or notes.
 * - A change is queued inside the transaction and published on the order bus only after commit,
 *   as `{orderId, version, customerId}`. A rollback publishes nothing. The stream decides who hears it.
 */

export const ORDERS_PER_HOUR = 10;
export const MAX_OPEN_ORDERS = 3;
const ORDER_LIMIT_MESSAGE = "You've placed too many orders this hour. Try again later.";

export const placeOrderInput = z.object({
  lines: z
    .array(z.object({ itemId: z.uuid(), qty: z.number().int().min(1).max(20) }))
    .min(1)
    .max(20)
    .refine((l) => new Set(l.map((x) => x.itemId)).size === l.length, "Each item can appear on one line only"),
  pickupName: z.string().trim().min(1).max(40),
  note: z.string().trim().max(200).default(""),
  // Required: the allergy question is always answered. Unknown keys (a price, a status) are dropped by zod.
  allergy: z
    .object({
      has: z.boolean(),
      allergens: z
        .array(z.enum(ALLERGENS))
        .max(ALLERGENS.length)
        .refine((a) => new Set(a).size === a.length, "Duplicate allergen")
        .default([]),
      note: z.string().trim().max(200).default(""),
      /** "I'll confirm with staff before eating". Required when a dish matches a picked allergen. */
      confirmWithStaff: z.boolean().default(false),
    })
    .superRefine((a, ctx) => {
      // Allergy details are never dropped: sending them with has: false is an error, not a silent discard.
      if (!a.has && (a.allergens.length > 0 || a.note !== "")) {
        ctx.addIssue({ code: "custom", message: "Allergy details were given but 'has' is false", path: ["has"] });
      }
      if (a.has && a.allergens.length === 0 && a.note === "") {
        ctx.addIssue({ code: "custom", message: "Pick the allergens or describe the allergy", path: ["allergens"] });
      }
    }),
  idempotencyKey: z.uuid(),
});

export const transitionInput = z
  .object({
    to: z.enum(ORDER_STATUSES.filter((s) => s !== "placed") as [Exclude<OrderStatus, "placed">, ...Exclude<OrderStatus, "placed">[]]),
    version: z.number().int().min(1).max(1_000_000),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export const listOrdersInput = z.object({ status: z.enum(["open", "all", ...ORDER_STATUSES]).optional() }).strict();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type OrderLineView = { id: string; menuItemId: string; name: string; unitPriceCents: number; qty: number; lineTotalCents: number; allergens: Declared[] };
export type OrderView = {
  id: string;
  number: string;
  status: OrderStatus;
  pickupName: string;
  note: string;
  subtotalCents: number;
  version: number;
  cancelReason: string | null;
  readyEstimateAt: string;
  createdAt: string;
  updatedAt: string;
  allergy: {
    alert: boolean;
    allergens: Allergen[];
    note: string;
    customerConfirmed: boolean;
    acknowledged: boolean;
    acknowledgedAt: string | null;
    /** Staff only: who reviewed the alert. */
    acknowledgedBy?: { id: string; name: string } | null;
  };
  lines: OrderLineView[];
};

type OrderRow = typeof schema.order.$inferSelect;
type LineRow = typeof schema.orderLine.$inferSelect;

function toView(row: OrderRow, lines: LineRow[], access: OrderAccess, ackBy?: { id: string; name: string } | null): OrderView {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    pickupName: row.pickupName,
    note: row.note,
    subtotalCents: row.subtotalCents,
    version: row.version,
    cancelReason: row.cancelReason,
    readyEstimateAt: row.readyEstimateAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    allergy: {
      alert: row.allergyAlert,
      allergens: row.allergyAllergens as Allergen[],
      note: row.allergyNote,
      customerConfirmed: row.allergyCustomerConfirmed,
      acknowledged: row.allergyAckAt !== null,
      acknowledgedAt: row.allergyAckAt?.toISOString() ?? null,
      ...(access.kind === "staff" ? { acknowledgedBy: row.allergyAckBy ? (ackBy ?? { id: row.allergyAckBy, name: "" }) : null } : {}),
    },
    lines: lines
      .filter((l) => l.orderId === row.id)
      .sort((a, b) => a.position - b.position)
      .map((l) => ({ id: l.id, menuItemId: l.menuItemId, name: l.name, unitPriceCents: l.unitPriceCents, qty: l.qty, lineTotalCents: l.unitPriceCents * l.qty, allergens: l.allergens })),
  };
}

async function loadViews(rows: OrderRow[], access: OrderAccess, executor: Pick<Tx, "select"> = db()): Promise<OrderView[]> {
  if (rows.length === 0) return [];
  const { orderLine, user } = schema;
  const lines = await executor
    .select()
    .from(orderLine)
    .where(and(inArray(orderLine.orderId, rows.map((r) => r.id)), access.kind === "customer" ? eq(orderLine.customerId, access.customerId) : undefined));
  const names = new Map<string, string>();
  if (access.kind === "staff") {
    const ids = [...new Set(rows.map((r) => r.allergyAckBy).filter((x): x is string => !!x))];
    if (ids.length) for (const u of await executor.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))) names.set(u.id, u.name);
  }
  return rows.map((r) => toView(r, lines, access, r.allergyAckBy ? { id: r.allergyAckBy, name: names.get(r.allergyAckBy) ?? "" } : null));
}

const idParam = z.uuid();
const parseId = (value: string) => {
  const parsed = idParam.safeParse(value);
  if (!parsed.success) throw new NotFoundError();
  return parsed.data;
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && ((e as { code?: unknown }).code === "23505" || isUniqueViolation((e as { cause?: unknown }).cause));

/**
 * Next daily number for `day` (default: today in RESTAURANT_TZ). The upsert takes that day's row lock, so concurrent
 * orders get distinct, gapless numbers. Returns the day too, so the order row can store the same one.
 */
export async function allocateOrderNumber(tx: Tx, day?: string): Promise<{ number: string; day: string }> {
  const dayExpr = day ? sql`${day}::date` : restaurantDayExpr();
  const rows = await tx.execute<{ last: number; day: string }>(sql`
    insert into daily_counter (day, last) values (${dayExpr}, 1)
    on conflict (day) do update set last = daily_counter.last + 1
    returning last, day::text as day
  `);
  return { number: formatOrderNumber(Number(rows[0].last)), day: rows[0].day };
}

/**
 * Place an order. Returns `created: false` with the first order when the same `idempotencyKey` was already used by
 * this customer with the same request (a double tap or a retry), without spending rate limit or caps. The same key
 * with a different request is 409 `idempotency_key_reused`: the first order is never returned for a request that
 * differs from it (an added allergy must never be dropped).
 */
export async function placeOrder(actor: Actor, input: unknown): Promise<{ order: OrderView; created: boolean }> {
  const access = orderAccess(actor); // admins: 404
  assertCustomer(actor); // staff: 403
  const data = placeOrderInput.parse(input);
  const { order, orderLine, menuItem } = schema;
  const hash = requestHash(data);
  /** The first order for this key, or a refusal when the retry isn't the same request. */
  const replay = async (existing: OrderRow, executor: Pick<Tx, "select">) => {
    if (existing.requestHash !== hash) {
      throw new ConflictError("This idempotency key was already used for a different order (idempotency_key_reused). Start a new order.", { code: "idempotency_key_reused" });
    }
    return { order: (await loadViews([existing], access, executor))[0], created: false };
  };
  const find = (executor: Pick<Tx, "select">) =>
    executor.select().from(order).where(and(eq(order.customerId, actor.id), eq(order.idempotencyKey, data.idempotencyKey)));

  try {
    const result = await transactionWithOrderEvents(async (tx) => {
      // One order attempt per customer at a time: retries and double taps queue here, so the second sees the first.
      await advisoryLock(tx, `order:${actor.id}`);
      const [existing] = await find(tx);
      if (existing) return replay(existing, tx);

      await consumeRate(tx, actor.id, "order", ORDERS_PER_HOUR, ORDER_LIMIT_MESSAGE);
      const [{ open }] = await tx
        .select({ open: count() })
        .from(order)
        .where(and(eq(order.customerId, actor.id), inArray(order.status, [...OPEN_STATUSES])));
      if (open >= MAX_OPEN_ORDERS) throw new ConflictError(`You already have ${MAX_OPEN_ORDERS} open orders. Wait for one to finish or cancel one.`);

      const settings = await getSettings(tx);
      if (!settings.acceptingOrders) throw new ConflictError("The restaurant isn't taking orders right now.");

      // Current prices and availability, locked against edits until this transaction ends.
      const ids = data.lines.map((l) => l.itemId);
      const items = await tx.select().from(menuItem).where(inArray(menuItem.id, ids)).for("share");
      const byId = new Map(items.map((i) => [i.id, i]));
      type Unavailable = { itemId: string; name: string | null; reason: "unknown" | "sold_out" };
      const unavailable = data.lines.flatMap((l): Unavailable[] => {
        const item = byId.get(l.itemId);
        if (!item || item.archivedAt) return [{ itemId: l.itemId, name: null, reason: "unknown" }];
        return item.soldOut ? [{ itemId: item.id, name: item.name, reason: "sold_out" }] : [];
      });
      if (unavailable.length) {
        const label = unavailable.map((u) => u.name ?? "an item that is no longer on the menu").join(", ");
        throw new ConflictError(`Some items can't be ordered: ${label}.`, { unavailable });
      }
      const declarations = await tx.select().from(schema.menuItemAllergen).where(inArray(schema.menuItemAllergen.itemId, ids));
      const lines = data.lines.map((l, position) => {
        const item = byId.get(l.itemId)!;
        const declared = declarations
          .filter((d) => d.itemId === item.id)
          .map((d) => ({ allergen: d.allergen, level: d.level }))
          .sort((a, b) => a.allergen.localeCompare(b.allergen));
        return { itemId: item.id, name: item.name, unitPriceCents: item.priceCents, qty: l.qty, declared, position };
      });

      const { allergy } = data;
      const conflicts = allergy.has ? allergenConflicts(lines, allergy.allergens) : [];
      if (conflicts.length > 0 && !allergy.confirmWithStaff) {
        throw new ConflictError(
          `Some dishes in your order declare an allergen you picked (${conflicts.map((c) => c.name).join(", ")}). Confirm that you will check with staff before eating to continue.`,
          { code: "allergy_confirmation_required", items: conflicts.map((c) => ({ itemId: c.itemId, name: c.name })) },
        );
      }

      const { number, day } = await allocateOrderNumber(tx);
      const [row] = await tx
        .insert(order)
        .values({
          number,
          day,
          customerId: actor.id,
          requestHash: hash,
          pickupName: data.pickupName,
          note: data.note,
          allergyAlert: allergy.has,
          allergyAllergens: allergy.has ? allergy.allergens : [],
          allergyNote: allergy.has ? allergy.note : "",
          allergyCustomerConfirmed: conflicts.length > 0 && allergy.confirmWithStaff,
          subtotalCents: subtotalCents(lines),
          idempotencyKey: data.idempotencyKey,
          readyEstimateAt: new Date(Date.now() + settings.pickupMinutes * 60_000),
        })
        .returning();
      await tx.insert(orderLine).values(
        lines.map((l) => ({
          orderId: row.id,
          customerId: actor.id,
          menuItemId: l.itemId,
          name: l.name,
          unitPriceCents: l.unitPriceCents,
          qty: l.qty,
          allergens: l.declared,
          position: l.position,
        })),
      );
      const view = (await loadViews([row], access, tx))[0];
      // After the insert, still inside the transaction: a later throw rolls this back with the order.
      enqueueOrderEvent(tx, { orderId: row.id, version: row.version, customerId: row.customerId });
      return { order: view, created: true };
    });
    // After the commit, so a rolled-back order is never reported. Ids and counts only: never names, notes or allergy details.
    if (result.created) log.info("order.placed", { orderId: result.order.id, lineCount: result.order.lines.length });
    return result;
  } catch (err) {
    // Defensive: the per-customer lock above already serializes retries, but the unique index is the real guarantee.
    if (isUniqueViolation(err)) {
      const [existing] = await find(db());
      if (existing) return replay(existing, db());
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Customers: their own orders, newest first. Staff: the kitchen queue (open orders, oldest first) unless `status` says otherwise. */
export async function listOrders(actor: Actor, input: unknown = {}): Promise<OrderView[]> {
  const access = orderAccess(actor);
  const { status } = listOrdersInput.parse(input);
  const { order } = schema;
  const which = status ?? (access.kind === "staff" ? "open" : "all");
  const filter: SQL | undefined = which === "all" ? undefined : which === "open" ? inArray(order.status, [...OPEN_STATUSES]) : eq(order.status, which);
  const queue = access.kind === "staff" && which === "open";
  const rows = await db()
    .select()
    .from(order)
    .where(and(orderScope(access), filter))
    .orderBy(queue ? asc(order.createdAt) : desc(order.createdAt))
    .limit(queue ? 200 : access.kind === "staff" ? 100 : 50);
  return loadViews(rows, access);
}

export async function getOrder(actor: Actor, orderId: string): Promise<OrderView> {
  const access = orderAccess(actor);
  const id = parseId(orderId);
  const [row] = await db().select().from(schema.order).where(and(eq(schema.order.id, id), orderScope(access)));
  if (!row) throw new NotFoundError(); // someone else's order looks exactly like a missing one
  return (await loadViews([row], access))[0];
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Move an order. 404 if it isn't yours; 403 if your role can't make that move; 409 if the version is stale, the move
 * isn't allowed from the current state, or an allergy alert is unacknowledged. The UPDATE re-checks version and status,
 * so of any number of racing callers exactly one wins.
 */
export async function transitionOrder(actor: Actor, orderId: string, input: unknown): Promise<OrderView> {
  const access = orderAccess(actor);
  const id = parseId(orderId);
  const data = transitionInput.parse(input);
  const { order } = schema;
  const [row] = await db().select().from(order).where(and(eq(order.id, id), orderScope(access)));
  if (!row) throw new NotFoundError();

  // A customer can only ever cancel. Say so before anything that depends on the order's state.
  if (access.kind === "customer" && data.to !== "cancelled") throw new ForbiddenError("Only restaurant staff can move an order along.");
  if (row.version !== data.version) throw new ConflictError("This order changed. Reload and try again.");
  const verdict = checkTransition(access.kind, row.status, data.to, data.reason);
  if (!verdict.ok) {
    if (verdict.reason === "reason_required") throw new BadRequestError("Say why the order is being cancelled.");
    if (verdict.reason === "final") throw new ConflictError("This order is already finished.");
    throw new ConflictError(access.kind === "customer" ? "An order can only be cancelled while it is waiting for the kitchen." : `An order can't go from ${row.status} to ${data.to}.`);
  }
  const needsAck = data.to !== "cancelled" && row.allergyAlert && row.allergyAckAt === null;
  if (needsAck) throw new ConflictError("Review the allergy alert with the kitchen before accepting this order.");

  const updated = await transactionWithOrderEvents(async (tx) => {
    const [next] = await tx
      .update(order)
      .set({
        status: data.to,
        version: sql`${order.version} + 1`,
        updatedAt: sql`now()`,
        ...(data.to === "cancelled" ? { cancelReason: data.reason || null } : {}),
      })
      .where(
        and(
          eq(order.id, id),
          eq(order.version, data.version),
          eq(order.status, row.status),
          // Re-checked in the statement itself, not just above.
          or(not(order.allergyAlert), isNotNull(order.allergyAckAt), eq(sql`${data.to}`, "cancelled")),
        ),
      )
      .returning();
    if (!next) return null;
    enqueueOrderEvent(tx, { orderId: next.id, version: next.version, customerId: next.customerId });
    return next;
  });
  if (!updated) throw new ConflictError("This order changed. Reload and try again.");
  log.info("order.transition", { orderId: id, from: row.status, to: data.to, by: actor.id });
  return (await loadViews([updated], access))[0];
}

/**
 * Staff press "Allergy reviewed with kitchen": records who and when, once. Only a `placed` order with an unacknowledged
 * alert changes; pressing it again (or two staff at once) returns the existing acknowledgment untouched.
 */
export async function acknowledgeAllergy(actor: Actor, orderId: string): Promise<OrderView> {
  const access = orderAccess(actor);
  if (access.kind !== "staff") throw new ForbiddenError("Only restaurant staff can do that.");
  const id = parseId(orderId);
  const { order } = schema;
  const updated = await transactionWithOrderEvents(async (tx) => {
    const [next] = await tx
      .update(order)
      .set({ allergyAckBy: actor.id, allergyAckAt: sql`now()`, version: sql`${order.version} + 1`, updatedAt: sql`now()` })
      .where(and(eq(order.id, id), eq(order.status, "placed"), eq(order.allergyAlert, true), isNull(order.allergyAckAt)))
      .returning();
    if (!next) return null;
    enqueueOrderEvent(tx, { orderId: next.id, version: next.version, customerId: next.customerId });
    return next;
  });
  if (updated) return (await loadViews([updated], access))[0];

  const [row] = await db().select().from(order).where(eq(order.id, id));
  if (!row) throw new NotFoundError();
  if (!row.allergyAlert) throw new ConflictError("This order has no allergy alert.");
  if (row.allergyAckAt) return (await loadViews([row], access))[0]; // already reviewed: keep who and when
  throw new ConflictError("Only a new order's allergy alert can be reviewed.");
}
