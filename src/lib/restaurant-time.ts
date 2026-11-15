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

/** Milliseconds to add to a UTC instant to read the clock in `timeZone` (local = utc + offset). */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")) - at.getTime();
}

/**
 * 12:00 in RESTAURANT_TZ on the restaurant day of `at`. Noon is never in a DST gap or the repeated hour.
 * The demo loader's test clock: orders up to two hours old stay on this day, including when the wall clock is
 * between midnight and 02:00.
 */
export function restaurantNoon(at: Date): Date {
  const [year, month, day] = restaurantDay(at).split("-").map(Number);
  const timeZone = env().RESTAURANT_TZ;
  // Treat civil noon as UTC, then shift by the zone offset. The second pass covers a DST change between the guess and noon.
  const civil = Date.UTC(year, month - 1, day, 12, 0, 0);
  const corrected = civil - zoneOffsetMs(new Date(civil), timeZone);
  return new Date(civil - zoneOffsetMs(new Date(corrected), timeZone));
}
