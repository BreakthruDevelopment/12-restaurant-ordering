import type { Declared } from "@/lib/allergen-match";
import { declarationLabel } from "@/lib/labels";

/**
 * Declared allergens as neutral chips with text labels. Never green, never a check mark, and an empty list is never
 * shown as "free of" anything: it says nothing is listed and that this isn't a guarantee.
 */
export function AllergenChips({ allergens, emptyText = "No allergens listed. That isn't a guarantee: ask staff." }: { allergens: readonly Declared[]; emptyText?: string }) {
  if (allergens.length === 0) return <p className="text-sm text-muted">{emptyText}</p>;
  return (
    <ul aria-label="Declared allergens" className="flex flex-wrap gap-1.5">
      {allergens.map((d) => (
        <li
          key={d.allergen}
          className={`rounded-md border px-2 py-0.5 text-sm ${d.level === "contains" ? "border-border-strong bg-idle-soft font-semibold text-foreground" : "border-border bg-surface text-foreground"}`}
        >
          {declarationLabel(d)}
        </li>
      ))}
    </ul>
  );
}

/** Verification state of a dish's allergen information, as text (staff stamp older than 90 days or missing). */
export function AllergenCheckNote({ check }: { check: "current" | "stale" | "never" }) {
  if (check === "current") return null;
  return <p className="text-sm font-medium text-building">Allergen information for this dish hasn&apos;t been checked recently: ask staff.</p>;
}
