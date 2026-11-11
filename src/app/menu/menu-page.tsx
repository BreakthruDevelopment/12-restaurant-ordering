import Link from "next/link";
import { PageIntro, Panel, buttonOutlineAccent } from "@/components/ui";
import { AllergenCheckNote, AllergenChips } from "@/components/restaurant/allergen-chips";
import { DemoBanner } from "@/components/restaurant/demo-banner";
import { getCurrentUser } from "@/lib/auth/session";
import { DIETARY_LABELS, formatPrice } from "@/lib/labels";
import { getPublicMenu } from "@/lib/menu";
import type { DietaryTag } from "@/lib/db/schema";
import { AddToCart, CartLink } from "./add-to-cart";
import { AssistantBox } from "./assistant-box";

/**
 * The public menu (`/` and `/menu`): categories, prices, declared allergens, sold-out state, the open/closed banner and
 * the menu assistant. Anyone can read it; only signed-in customers get add-to-cart, and only signed-in accounts can ask.
 */
export async function MenuPage() {
  const user = await getCurrentUser();
  const menu = await getPublicMenu();
  const isCustomer = user?.role === "user";
  const itemCount = menu.categories.reduce((n, c) => n + c.items.length, 0);

  return (
    <>
      <PageIntro
        section="Menu"
        title="Order ahead for pickup"
        description={`Browse the menu, order on your phone and pay at pickup. Orders are usually ready in about ${menu.pickupMinutes} minutes.`}
        actions={isCustomer ? <CartLink userId={user.id} /> : !user ? <Link href="/sign-in" className={buttonOutlineAccent}>Sign in to order</Link> : undefined}
      />
      <DemoBanner />
      {menu.acceptingOrders ? (
        <p className="mb-6 rounded-card border border-border bg-surface px-4 py-3 text-sm font-semibold">We&apos;re taking pickup orders now.</p>
      ) : (
        <p role="status" className="mb-6 rounded-card border border-blocked bg-blocked-soft px-4 py-3 text-sm font-semibold text-blocked">
          We&apos;re not taking orders right now. You can still browse the menu.
        </p>
      )}

      <Panel title="Ask about the menu">
        {user ? (
          <AssistantBox />
        ) : (
          <p className="text-muted">
            <Link href="/sign-in" className="inline-flex min-h-11 items-center font-semibold text-accent underline underline-offset-2">
              Sign in
            </Link>{" "}
            to ask the menu assistant. Allergies? Ask staff before ordering.
          </p>
        )}
      </Panel>

      {itemCount === 0 ? (
        <Panel title="Menu">
          <p className="text-muted">The menu is empty right now. Check back soon.</p>
        </Panel>
      ) : (
        <>
          {menu.categories.length > 1 && (
            <nav aria-label="Menu categories" className="mb-6 flex flex-wrap gap-2">
              {menu.categories
                .filter((c) => c.items.length > 0)
                .map((c) => (
                  <a key={c.id} href={`#cat-${c.id}`} className="inline-flex min-h-11 items-center rounded-card border border-border bg-surface px-3 text-sm font-semibold hover:bg-accent-soft">
                    {c.name}
                  </a>
                ))}
            </nav>
          )}
          {menu.categories
            .filter((c) => c.items.length > 0)
            .map((c) => (
              <Panel key={c.id} id={`cat-${c.id}`} title={c.name} count={c.items.length}>
                <ul className="grid gap-3 md:grid-cols-2">
                  {c.items.map((item) => (
                    <li key={item.id} className="flex min-w-0 flex-col gap-2 rounded-card border border-border p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="min-w-0 font-semibold break-words">{item.name}</h3>
                        <span className="shrink-0 font-mono text-sm font-medium">{formatPrice(item.priceCents)}</span>
                      </div>
                      {item.description && <p className="text-sm break-words text-muted">{item.description}</p>}
                      {item.dietaryTags.length > 0 && (
                        <p className="text-sm text-muted">{item.dietaryTags.map((t) => DIETARY_LABELS[t as DietaryTag] ?? t).join(" · ")}</p>
                      )}
                      <AllergenChips allergens={item.allergens} />
                      <AllergenCheckNote check={item.allergensCheck} />
                      {item.soldOut && <p className="text-sm font-semibold text-blocked">Sold out</p>}
                      {isCustomer && <AddToCart userId={user.id} itemId={item.id} itemName={item.name} disabled={item.soldOut || !menu.acceptingOrders} />}
                    </li>
                  ))}
                </ul>
              </Panel>
            ))}
        </>
      )}
    </>
  );
}
