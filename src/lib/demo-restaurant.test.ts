import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { DEMO_ORDERS } from "./demo-restaurant";
import { restaurantDay, restaurantNoon } from "./restaurant-time";

const MINUTE = 60_000;

/** Restaurant days the demo orders land on when the loader's clock is `now`. */
function orderDays(now: Date): string[] {
  return [...new Set(DEMO_ORDERS.map((order) => restaurantDay(new Date(now.getTime() - order.age * MINUTE))))].sort();
}

function dayBefore(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, dayOfMonth - 1)).toISOString().slice(0, 10);
}

function* steps(startIso: string, hours: number, stepMinutes: number): Generator<Date> {
  const start = Date.parse(startIso);
  const end = start + hours * 60 * MINUTE;
  for (let t = start; t < end; t += stepMinutes * MINUTE) yield new Date(t);
}

/**
 * The demo fixture places orders 2 hours back and one order 26 hours back. Those ages cross three Chicago
 * calendar dates whenever the clock is between 00:03 and 02:00. The loader test pins its clock to noon.
 */
describe("demo order restaurant days", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  function chicago() {
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", "postgres://x");
    vi.stubEnv("BETTER_AUTH_SECRET", "x".repeat(32));
    vi.stubEnv("RESTAURANT_TZ", "America/Chicago");
    resetEnvCache();
  }

  it("spans three days between 00:03 and 02:00 Chicago, and two days again at 02:05", () => {
    chicago();
    const threeDays = [
      "2026-11-12T06:03:00Z", // 00:03 CST
      "2026-11-12T07:00:00Z", // 01:00 CST
      "2026-11-12T07:59:00Z", // 01:59 CST
      "2026-07-12T05:03:00Z", // 00:03 CDT
      "2026-07-12T06:59:00Z", // 01:59 CDT
      "2026-03-08T06:30:00Z", // 00:30 CST, spring-forward morning
      "2026-11-01T06:30:00Z", // 01:30 CDT, before the fall back
    ];
    for (const at of threeDays) expect({ at, count: orderDays(new Date(at)).length }).toEqual({ at, count: 3 });
    // 02:05 CST is the re-run that passed: the 2-hour-old order is back on the same day as the new ones.
    expect(orderDays(new Date("2026-11-12T08:05:00Z"))).toHaveLength(2);
  });

  it("stays on noon's day and the day before it, at every clock time including that window", () => {
    chicago();
    const spans = [
      ["2026-03-07T00:00:00Z", 48], // spring forward
      ["2026-07-14T00:00:00Z", 48], // CDT
      ["2026-11-01T00:00:00Z", 48], // fall back
      ["2026-11-11T00:00:00Z", 48], // the reported CST window
    ] as const;
    for (const [start, hours] of spans) {
      for (const wall of steps(start, hours, 15)) {
        const now = restaurantNoon(wall);
        const today = restaurantDay(now);
        expect({ wall: wall.toISOString(), days: orderDays(now) }).toEqual({ wall: wall.toISOString(), days: [dayBefore(today), today].sort() });
      }
    }
  });
});
