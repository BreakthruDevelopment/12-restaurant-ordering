import { afterEach, describe, expect, it, vi } from "vitest";
import { env, resetEnvCache } from "@/lib/env";
import { restaurantDay } from "./restaurant-time";

const base = { DATABASE_URL: "postgres://x", BETTER_AUTH_SECRET: "x".repeat(32) };

function withEnv(extra: Record<string, string>) {
  vi.unstubAllEnvs();
  vi.stubEnv("RESTAURANT_TZ", "");
  for (const [k, v] of Object.entries({ ...base, ...extra })) vi.stubEnv(k, v);
  resetEnvCache();
}
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("restaurantDay", () => {
  // 03:30 UTC on 11 Nov is 21:30 on 10 Nov in Chicago (CST): dinner time, still the 10th.
  const lateEvening = new Date("2026-11-11T03:30:00Z");

  it("defaults to America/Chicago, so the numbering doesn't reset mid-dinner", () => {
    withEnv({});
    expect(env().RESTAURANT_TZ).toBe("America/Chicago");
    expect(restaurantDay(lateEvening)).toBe("2026-11-10");
    expect(restaurantDay(new Date("2026-11-11T06:00:00Z"))).toBe("2026-11-11"); // midnight Chicago
    expect(restaurantDay(new Date("2026-11-11T05:59:59Z"))).toBe("2026-11-10");
  });

  it("follows RESTAURANT_TZ, daylight saving included", () => {
    withEnv({ RESTAURANT_TZ: "UTC" });
    expect(restaurantDay(lateEvening)).toBe("2026-11-11");
    withEnv({ RESTAURANT_TZ: "Asia/Tokyo" });
    expect(restaurantDay(new Date("2026-11-10T15:30:00Z"))).toBe("2026-11-11");
    withEnv({});
    expect(restaurantDay(new Date("2026-07-01T04:30:00Z"))).toBe("2026-06-30"); // CDT is UTC-5
  });

  it("refuses a time zone that doesn't exist", () => {
    withEnv({ RESTAURANT_TZ: "Mars/Olympus" });
    expect(() => env()).toThrow(/RESTAURANT_TZ/);
  });
});
