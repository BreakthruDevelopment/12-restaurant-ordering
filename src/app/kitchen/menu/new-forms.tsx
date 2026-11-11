"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { createCategoryAction, createItemAction } from "@/app/actions/menu";
import { parsePrice } from "@/lib/labels";

export function NewCategoryForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        const result = await createCategoryAction({ name });
        setPending(false);
        if (!result.ok) return setError(result.error);
        setName("");
        router.refresh();
      }}
    >
      <label className={`${labelClass} flex-1`}>
        <span>Category name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required className={inputClass} />
      </label>
      <button type="submit" disabled={pending || !name.trim()} className={buttonPrimary}>
        {pending ? "Adding…" : "Add category"}
      </button>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function NewItemForm({ categories }: { categories: { id: string; name: string }[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const priceCents = parsePrice(String(form.get("price") ?? ""));
        if (priceCents === null || priceCents > 100_000) return setError("Enter a price such as 12.50 (up to $1,000).");
        setPending(true);
        setError(null);
        const result = await createItemAction({
          categoryId: String(form.get("categoryId")),
          name: String(form.get("name") ?? ""),
          description: String(form.get("description") ?? ""),
          priceCents,
        });
        setPending(false);
        if (!result.ok) return setError(result.error);
        // New dishes start with no declarations: go straight to the allergen grid.
        router.push(`/kitchen/menu/${result.data.id}`);
      }}
    >
      <label className={labelClass}>
        <span>Category</span>
        <select name="categoryId" required className={inputClass}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelClass}>
        <span>Name</span>
        <input name="name" maxLength={80} required className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Price ($)</span>
        <input name="price" inputMode="decimal" required placeholder="12.50" className={inputClass} />
      </label>
      <label className={`${labelClass} sm:col-span-2`}>
        <span>Description</span>
        <textarea name="description" maxLength={300} rows={2} className={inputClass} />
      </label>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={`${buttonPrimary} w-full sm:w-auto`}>
          {pending ? "Adding…" : "Add dish and declare allergens"}
        </button>
        <p className="mt-1 text-sm text-muted">New dishes start with no allergen declarations until you check them.</p>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger sm:col-span-2">
          {error}
        </p>
      )}
    </form>
  );
}
