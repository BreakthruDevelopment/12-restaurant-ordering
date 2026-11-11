import type { Allergen, AllergenLevel, DietaryTag, OrderStatus } from "@/lib/db/schema";

/**
 * Display labels and formatting shared by server and client components. Type-only imports, so nothing here pulls the
 * database layer into the browser bundle. The Record types make each list exhaustive: a new enum value fails typecheck.
 */

export const ALLERGEN_LABELS: Record<Allergen, string> = {
  milk: "Milk",
  egg: "Egg",
  fish: "Fish",
  crustacean_shellfish: "Crustacean shellfish",
  tree_nuts: "Tree nuts",
  peanuts: "Peanuts",
  wheat: "Wheat",
  soy: "Soy",
  sesame: "Sesame",
  gluten: "Gluten",
};

/** In the order the spec lists them (US nine majors, then gluten). */
export const ALLERGEN_ORDER = Object.keys(ALLERGEN_LABELS) as Allergen[];

export const LEVEL_LABELS: Record<AllergenLevel, string> = { contains: "Contains", may_contain: "May contain" };

export const DIETARY_LABELS: Record<DietaryTag, string> = { vegetarian: "Vegetarian", vegan: "Vegan", spicy: "Spicy" };
export const DIETARY_ORDER = Object.keys(DIETARY_LABELS) as DietaryTag[];

export const STATUS_LABELS: Record<OrderStatus, string> = {
  placed: "Placed",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready for pickup",
  picked_up: "Picked up",
  cancelled: "Cancelled",
};

/** The customer's tracker steps, in order. `cancelled` is shown as a banner instead. */
export const TRACKER_STEPS = ["placed", "accepted", "preparing", "ready", "picked_up"] as const satisfies readonly OrderStatus[];

/** The kitchen board's columns. */
export const BOARD_COLUMNS = ["placed", "accepted", "preparing", "ready"] as const satisfies readonly OrderStatus[];

/** The one forward step staff can take from each open status, with its button label. */
export const NEXT_STEP: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  placed: { to: "accepted", label: "Accept" },
  accepted: { to: "preparing", label: "Start preparing" },
  preparing: { to: "ready", label: "Mark ready" },
  ready: { to: "picked_up", label: "Picked up" },
};

export const FINAL = new Set<OrderStatus>(["picked_up", "cancelled"]);

/** Integer cents to "$12.50". */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** "Contains peanuts" / "May contain sesame". */
export function declarationLabel(d: { allergen: Allergen; level: AllergenLevel }): string {
  return `${LEVEL_LABELS[d.level]} ${ALLERGEN_LABELS[d.allergen].toLowerCase()}`;
}

/** "12:45 PM" in the restaurant's time zone, so server and client render the same text. */
export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** "Nov 11, 12:45 PM" in the restaurant's time zone. */
export function formatDateTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
}

/** A price typed by staff ("12.50", "$12", "12.5") to integer cents; null when it isn't a price. */
export function parsePrice(value: string): number | null {
  const m = /^\s*\$?(\d{1,4})(?:\.(\d{1,2}))?\s*$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** Cents to the editor's input value ("12.50"). */
export function priceInput(cents: number): string {
  return (cents / 100).toFixed(2);
}
