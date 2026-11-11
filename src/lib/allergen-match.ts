import type { Allergen, AllergenLevel } from "@/lib/db/schema";

/**
 * Allergen matching, free of Node and database imports so the checkout page (a client component) runs exactly the
 * rule the server enforces in placeOrder(). order-rules.ts re-exports everything here.
 */

export type Declared = { allergen: Allergen; level: AllergenLevel };

/**
 * Allergens that are sources of one another in the ten-value list. Matching over-warns on purpose: a customer who
 * picks one of a pair is warned about dishes declaring either, in both directions. Reviewed pair by pair:
 * - wheat and gluten: wheat is a source of gluten, and a gluten declaration may stand for wheat. Linked.
 * - peanuts and tree_nuts: separate allergens (peanuts are legumes). Not linked.
 * - fish, crustacean_shellfish, milk, egg, soy, sesame: no other value in the list is a source of them. Not linked.
 * This is the only place the relations live; add a pair here and the tests in order-rules.test.ts cover it.
 */
export const RELATED_ALLERGENS: readonly (readonly [Allergen, Allergen])[] = [["wheat", "gluten"]];

/** The picked allergens plus everything related to them (see RELATED_ALLERGENS). */
export function expandAllergens(picked: readonly Allergen[]): Set<Allergen> {
  const out = new Set<Allergen>(picked);
  for (const [a, b] of RELATED_ALLERGENS) {
    if (out.has(a)) out.add(b);
    if (out.has(b)) out.add(a);
  }
  return out;
}

/** Items whose declaration contains or may contain a picked allergen, or one related to it. */
export function allergenConflicts<T extends { declared: readonly Declared[] }>(lines: readonly T[], picked: readonly Allergen[]): T[] {
  const set = expandAllergens(picked);
  return lines.filter((l) => l.declared.some((d) => set.has(d.allergen)));
}
