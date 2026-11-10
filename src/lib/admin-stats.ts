import "server-only";
import { count, isNull, and, eq, sql } from "drizzle-orm";
import { assertAdmin } from "@/lib/access";
import type { Actor } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { restaurantDayExpr } from "@/lib/restaurant-time";
import { ASSISTANT_MODES, type AssistantMode, ORDER_STATUSES, type OrderStatus } from "@/lib/db/schema";

export const STATS_DAYS = 14;

export type AdminStats = {
  /** One entry per restaurant day (RESTAURANT_TZ) with orders in the last 14 days, newest first. */
  ordersByDay: ({ day: string; total: number } & Record<OrderStatus, number>)[];
  /** Menu assistant answers by mode (allergen, general, guardrail, demo) per restaurant day, last 14 days, newest first. Numbers only. */
  assistantByDay: ({ day: string } & Record<AssistantMode, number>)[];
  soldOutItems: number;
  users: { customers: number; staff: number; admins: number };
};

/**
 * Counts only: orders by status per day, sold-out items, accounts by role. Never an order, a name, an allergy or an
 * id. Admins get nothing else about orders (access.ts). Assistant answers by mode are counters (assistant_stat), never questions.
 */
export async function adminStats(actor: Actor): Promise<AdminStats> {
  assertAdmin(actor);
  const { order, menuItem, user, assistantStat } = schema;
  const byDay = await db()
    .select({ day: sql<string>`${order.day}::text`, status: order.status, n: count() })
    .from(order)
    .where(sql`${order.day} > ${restaurantDayExpr()} - ${STATS_DAYS}::int`)
    .groupBy(order.day, order.status);
  const days = new Map<string, AdminStats["ordersByDay"][number]>();
  for (const r of byDay) {
    const entry = days.get(r.day) ?? { day: r.day, total: 0, ...(Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>) };
    entry[r.status] = r.n;
    entry.total += r.n;
    days.set(r.day, entry);
  }
  const modeRows = await db()
    .select({ day: sql<string>`${assistantStat.day}::text`, mode: assistantStat.mode, n: assistantStat.count })
    .from(assistantStat)
    .where(sql`${assistantStat.day} > ${restaurantDayExpr()} - ${STATS_DAYS}::int`);
  const assistantDays = new Map<string, AdminStats["assistantByDay"][number]>();
  for (const r of modeRows) {
    const entry = assistantDays.get(r.day) ?? { day: r.day, ...(Object.fromEntries(ASSISTANT_MODES.map((m) => [m, 0])) as Record<AssistantMode, number>) };
    entry[r.mode] = r.n;
    assistantDays.set(r.day, entry);
  }
  const [{ soldOut }] = await db()
    .select({ soldOut: count() })
    .from(menuItem)
    .where(and(eq(menuItem.soldOut, true), isNull(menuItem.archivedAt)));
  const roles = await db().select({ role: user.role, n: count() }).from(user).groupBy(user.role);
  const users = { customers: 0, staff: 0, admins: 0 };
  for (const r of roles) {
    if (r.role === "admin") users.admins += r.n;
    else if (r.role === "staff") users.staff += r.n;
    else users.customers += r.n;
  }
  return { ordersByDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)), assistantByDay: [...assistantDays.values()].sort((a, b) => b.day.localeCompare(a.day)), soldOutItems: soldOut, users };
}
