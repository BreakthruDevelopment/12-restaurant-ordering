import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PageIntro, Panel, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import type { DietaryTag } from "@/lib/db/schema";
import { NotFoundError } from "@/lib/errors";
import { formatDateTime, declarationLabel } from "@/lib/labels";
import { getMenuItemForStaff, listMenuForStaff } from "@/lib/menu";
import { SoldOutToggle } from "../sold-out-toggle";
import { VerificationBadge } from "../verification-badge";
import { AllergenGrid } from "./allergen-grid";
import { ArchiveButton, ItemDetailsForm } from "./item-forms";

export const metadata: Metadata = { title: "Edit dish" };
export const dynamic = "force-dynamic";

export default async function MenuItemPage({ params }: PageProps<"/kitchen/menu/[id]">) {
  const staff = await requireRoleOrRedirect("staff");
  const { id } = await params;
  const item = await getMenuItemForStaff(staff, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  const { categories } = await listMenuForStaff(staff);
  const tz = env().RESTAURANT_TZ;
  const archived = item.archivedAt !== null;

  return (
    <>
      <PageIntro
        section="Menu editor"
        title={item.name}
        description={archived ? "This dish is archived: it is off the menu and kept for past orders and the allergen log." : "Edit the dish, its allergen declarations and availability."}
        actions={
          <Link href="/kitchen/menu" className={buttonSecondary}>
            Back to the menu
          </Link>
        }
      />
      <Panel title="Allergens" action={<VerificationBadge check={item.allergensCheck} />}>
        <p className="mb-4 text-sm text-muted">
          {item.allergensVerifiedAt ? `Last checked against the recipe ${formatDateTime(item.allergensVerifiedAt.toISOString(), tz)}.` : "Never checked against the recipe."} No row means
          &ldquo;not declared&rdquo;; customers are never told a dish is free of anything.
        </p>
        {archived ? (
          <p className="text-sm text-muted">Archived dishes can&apos;t be changed.</p>
        ) : (
          // key: a newer version (another staff member's save, picked up by router.refresh() after a 409) remounts the
          // grid with the fresh declarations, so a retry can never write the stale ones back.
          <AllergenGrid key={item.version} itemId={item.id} version={item.version} declared={item.allergens} />
        )}
      </Panel>
      {!archived && (
        <>
          <Panel title="Availability">
            <SoldOutToggle itemId={item.id} soldOut={item.soldOut} name={item.name} />
          </Panel>
          <Panel title="Details">
            <ItemDetailsForm
              itemId={item.id}
              version={item.version}
              categories={categories.map((c) => ({ id: c.id, name: c.name }))}
              initial={{ name: item.name, description: item.description, priceCents: item.priceCents, categoryId: item.categoryId, dietaryTags: item.dietaryTags as DietaryTag[] }}
            />
          </Panel>
        </>
      )}
      <Panel title="Allergen change log" count={item.changes.length}>
        {item.changes.length === 0 ? (
          <p className="text-sm text-muted">No changes recorded yet.</p>
        ) : (
          <ol className="divide-y divide-border text-sm">
            {item.changes.map((c) => (
              <li key={c.id} className="space-y-1 py-2">
                <p className="font-semibold">{formatDateTime(c.at.toISOString(), tz)}</p>
                <p className="break-words">
                  <span className="text-muted">Before: </span>
                  {c.before.length ? c.before.map(declarationLabel).join(", ") : "none declared"}
                </p>
                <p className="break-words">
                  <span className="text-muted">After: </span>
                  {c.after.length ? c.after.map(declarationLabel).join(", ") : "none declared"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      {!archived && (
        <Panel title="Archive">
          <ArchiveButton itemId={item.id} name={item.name} />
        </Panel>
      )}
    </>
  );
}
