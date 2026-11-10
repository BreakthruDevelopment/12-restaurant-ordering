import "server-only";
import { type SQL, sql } from "drizzle-orm";
import { env } from "@/lib/env";

/**
 * The restaurant's day: the calendar date in RESTAURANT_TZ (default America/Chicago), not UTC, so daily order numbers
 * and counts don't reset in the middle of dinner. `order.day`, `daily_counter.day` and the admin counts all use it.
 */
export const restaurantDayExpr = (): SQL => sql`(now() at time zone ${env().RESTAURANT_TZ})::date`;

/** The restaurant's calendar date (YYYY-MM-DD) for an instant. Used by the demo loader for orders placed in the past. */
export function restaurantDay(at: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: env().RESTAURANT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
