"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { setAllergensAction } from "@/app/actions/menu";
import type { Declared } from "@/lib/allergen-match";
import type { Allergen, AllergenLevel } from "@/lib/db/schema";
import { ALLERGEN_LABELS, ALLERGEN_ORDER } from "@/lib/labels";

type Choice = AllergenLevel | "none";
const CHOICES: { value: Choice; label: string }[] = [
  { value: "none", label: "Not listed" },
  { value: "may_contain", label: "May contain" },
  { value: "contains", label: "Contains" },
];

/**
 * One row per allergen: not listed, may contain, contains. Saving needs the "I checked these against the recipe"
 * tick (the server refuses without verified: true), stamps who and when, and writes the change log.
 */
export function AllergenGrid({ itemId, version, declared }: { itemId: string; version: number; declared: Declared[] }) {
  const router = useRouter();
  const initial = Object.fromEntries(ALLERGEN_ORDER.map((a) => [a, declared.find((d) => d.allergen === a)?.level ?? "none"])) as Record<Allergen, Choice>;
  const [values, setValues] = useState(initial);
  const [verified, setVerified] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!verified) return setError("Tick “I checked these against the recipe” to save.");
    setPending(true);
    setError(null);
    setSaved("");
    const allergens = ALLERGEN_ORDER.filter((a) => values[a] !== "none").map((a) => ({ allergen: a, level: values[a] as AllergenLevel }));
    const result = await setAllergensAction(itemId, { version, verified: true, allergens });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      // Any failure clears the tick: the declarations must be checked again before a retry.
      setVerified(false);
      if (result.status === 409) router.refresh();
      return;
    }
    setVerified(false);
    setSaved("Allergens saved and stamped as checked.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="divide-y divide-border rounded-card border border-border">
        {ALLERGEN_ORDER.map((a) => (
          <fieldset key={a} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <legend className="sr-only">{ALLERGEN_LABELS[a]}</legend>
            <span aria-hidden className="font-semibold">
              {ALLERGEN_LABELS[a]}
            </span>
            <div className="grid grid-cols-3 gap-1 sm:w-96">
              {CHOICES.map((c) => (
                <label
                  key={c.value}
                  className="flex min-h-11 cursor-pointer items-center justify-center rounded-card border border-border px-2 text-center text-sm font-medium has-[:checked]:border-accent has-[:checked]:bg-accent-soft has-[:checked]:text-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent"
                >
                  <input
                    type="radio"
                    name={`allergen-${a}`}
                    value={c.value}
                    checked={values[a] === c.value}
                    onChange={() => setValues((v) => ({ ...v, [a]: c.value }))}
                    className="sr-only"
                  />
                  {c.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 font-semibold">
        <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} className="size-5" />
        I checked these against the recipe
      </label>
      <button type="submit" disabled={pending || !verified} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Saving…" : "Save allergens"}
      </button>
      <p aria-live="polite" className="text-sm text-muted">
        {saved}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
