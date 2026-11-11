/** Text label for an item's allergen verification stamp. No check marks, no green. */
export function VerificationBadge({ check }: { check: "current" | "stale" | "never" }) {
  const label = check === "current" ? "Allergens checked" : check === "stale" ? "Allergen check over 90 days old" : "Allergens never checked";
  const tone = check === "current" ? "bg-idle-soft text-idle" : check === "stale" ? "bg-building-soft text-building" : "bg-blocked-soft text-blocked";
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-sm font-medium ${tone}`}>{label}</span>;
}
