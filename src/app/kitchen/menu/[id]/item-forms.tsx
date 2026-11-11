"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonDanger, buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { archiveItemAction, updateItemAction } from "@/app/actions/menu";
import type { DietaryTag } from "@/lib/db/schema";
import { DIETARY_LABELS, DIETARY_ORDER, parsePrice, priceInput } from "@/lib/labels";

type Initial = { name: string; description: string; priceCents: number; categoryId: string; dietaryTags: DietaryTag[] };

/** Name, description, price, category and dietary tags. A new name or description clears the allergen check on the server. */
export function ItemDetailsForm({ itemId, version, categories, initial }: { itemId: string; version: number; categories: { id: string; name: string }[]; initial: Initial }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState("");

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const priceCents = parsePrice(String(form.get("price") ?? ""));
    if (priceCents === null || priceCents > 100_000) return setError("Enter a price such as 12.50 (up to $1,000).");
    const patch: Record<string, unknown> = {};
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "").trim();
    const categoryId = String(form.get("categoryId") ?? "");
    const dietaryTags = DIETARY_ORDER.filter((t) => form.get(`tag-${t}`) === "on");
    if (name !== initial.name) patch.name = name;
    if (description !== initial.description) patch.description = description;
    if (priceCents !== initial.priceCents) patch.priceCents = priceCents;
    if (categoryId !== initial.categoryId) patch.categoryId = categoryId;
    if (dietaryTags.join() !== DIETARY_ORDER.filter((t) => initial.dietaryTags.includes(t)).join()) patch.dietaryTags = dietaryTags;
    if (Object.keys(patch).length === 0) return setSaved("Nothing to change.");
    setPending(true);
    setError(null);
    setSaved("");
    const result = await updateItemAction(itemId, { version, ...patch });
    setPending(false);
    if (!result.ok) {
      setError(result.error);
      if (result.status === 409) router.refresh();
      return;
    }
    setSaved("name" in patch || "description" in patch ? "Saved. The name or description changed, so check the allergens again." : "Saved.");
    router.refresh();
  }

  return (
    <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
      <label className={labelClass}>
        <span>Name</span>
        <input name="name" defaultValue={initial.name} maxLength={80} required className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Price ($)</span>
        <input name="price" defaultValue={priceInput(initial.priceCents)} inputMode="decimal" required className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        <span>Description</span>
        <textarea name="description" defaultValue={initial.description} maxLength={300} rows={3} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Category</span>
        <select name="categoryId" defaultValue={initial.categoryId} className={inputClass}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className="mb-1 text-sm font-medium">Dietary tags</legend>
        <div className="flex flex-wrap gap-2">
          {DIETARY_ORDER.map((t) => (
            <label key={t} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-card border border-border px-3 text-sm has-[:checked]:border-accent has-[:checked]:bg-accent-soft">
              <input type="checkbox" name={`tag-${t}`} defaultChecked={initial.dietaryTags.includes(t)} className="size-5" />
              {DIETARY_LABELS[t]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
          {pending ? "Saving…" : "Save details"}
        </button>
        <p className="mt-1 text-sm text-muted">Changing the name or description clears the allergen check until you redo it.</p>
        <p aria-live="polite" className="text-sm text-muted">
          {saved}
        </p>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/** Archiving takes the dish off the menu; it stays for past orders and the allergen log. */
export function ArchiveButton({ itemId, name }: { itemId: string; name: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function archive() {
    setPending(true);
    setError(null);
    const result = await archiveItemAction(itemId);
    setPending(false);
    if (!result.ok) return setError(result.error);
    router.push("/kitchen/menu");
    router.refresh();
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">Archiving takes {name} off the menu. Past orders and the allergen log keep it.</p>
      {confirming ? (
        <div className="flex flex-wrap gap-3">
          <button type="button" disabled={pending} onClick={archive} className={buttonDanger}>
            {pending ? "Archiving…" : "Yes, archive it"}
          </button>
          <button type="button" disabled={pending} onClick={() => setConfirming(false)} className={buttonPrimary}>
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={buttonDanger}>
          Archive dish
        </button>
      )}
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
