import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, Panel } from "@/components/ui";
import { AllergenChips } from "@/components/restaurant/allergen-chips";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { formatPrice } from "@/lib/labels";
import { listMenuForStaff } from "@/lib/menu";
import { NewCategoryForm, NewItemForm } from "./new-forms";
import { SoldOutToggle } from "./sold-out-toggle";
import { VerificationBadge } from "./verification-badge";

export const metadata: Metadata = { title: "Menu editor" };
export const dynamic = "force-dynamic";

export default async function MenuEditorPage() {
  const staff = await requireRoleOrRedirect("staff");
  const { categories, items } = await listMenuForStaff(staff);
  const live = items.filter((i) => !i.archivedAt);
  const archived = items.filter((i) => i.archivedAt);
  const needsCheck = live.filter((i) => i.allergensCheck !== "current").length;

  return (
    <>
      <PageIntro section="Kitchen" title="Menu editor" description="Dishes, prices, sold-out and allergen declarations. Allergens are only saved with your check against the recipe." />
      {needsCheck > 0 && (
        <p className="mb-6 rounded-card border border-building bg-building-soft px-4 py-3 text-sm font-semibold text-building">
          {needsCheck} {needsCheck === 1 ? "dish needs" : "dishes need"} an allergen check (never checked, or more than 90 days ago).
        </p>
      )}
      {categories.length === 0 && (
        <Panel title="Menu">
          <p className="text-muted">No categories yet. Add one below, then add dishes to it.</p>
        </Panel>
      )}
      {categories.map((c) => {
        const list = live.filter((i) => i.categoryId === c.id);
        return (
          <Panel key={c.id} title={c.name} count={list.length}>
            {list.length === 0 ? (
              <p className="text-sm text-muted">No dishes in this category.</p>
            ) : (
              <ul className="divide-y divide-border">
                {list.map((i) => (
                  <li key={i.id} className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between">
                    <div className="min-w-0 space-y-1">
                      <Link href={`/kitchen/menu/${i.id}`} className="inline-flex min-h-11 items-center font-semibold break-words text-accent underline underline-offset-2">
                        {i.name}
                      </Link>
                      <p className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono">{formatPrice(i.priceCents)}</span>
                        <VerificationBadge check={i.allergensCheck} />
                      </p>
                      <AllergenChips allergens={i.allergens} emptyText="No allergens declared." />
                    </div>
                    <SoldOutToggle itemId={i.id} soldOut={i.soldOut} name={i.name} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        );
      })}
      {categories.length > 0 && (
        <Panel title="Add a dish">
          <NewItemForm categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
        </Panel>
      )}
      <Panel title="Add a category">
        <NewCategoryForm />
      </Panel>
      {archived.length > 0 && (
        <Panel title="Archived dishes" count={archived.length} collapsible defaultOpen={false}>
          <ul className="space-y-1 text-sm">
            {archived.map((i) => (
              <li key={i.id}>
                <Link href={`/kitchen/menu/${i.id}`} className="inline-flex min-h-11 items-center break-words text-accent underline underline-offset-2">
                  {i.name}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
