import type { Declared } from "@/lib/allergen-match";
import type { PublicMenu } from "@/lib/menu";

/** What the cart and checkout pages need about each dish. Display only: the server re-reads prices when ordering. */
export type MenuItemLite = { id: string; name: string; priceCents: number; soldOut: boolean; allergens: Declared[] };

export function toLite(menu: PublicMenu): MenuItemLite[] {
  return menu.categories.flatMap((c) => c.items.map((i) => ({ id: i.id, name: i.name, priceCents: i.priceCents, soldOut: i.soldOut, allergens: i.allergens })));
}
