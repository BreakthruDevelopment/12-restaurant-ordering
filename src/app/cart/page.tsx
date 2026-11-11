import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { DemoBanner } from "@/components/restaurant/demo-banner";
import { toLite } from "@/components/restaurant/menu-lite";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { getPublicMenu } from "@/lib/menu";
import { CartView } from "./cart-view";

export const metadata: Metadata = { title: "Cart" };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  const user = await requireRoleOrRedirect("user");
  const menu = await getPublicMenu();
  return (
    <>
      <PageIntro section="Cart" title="Your cart" description="Check your dishes, then go to checkout. You pay at pickup." />
      <DemoBanner />
      <CartView userId={user.id} items={toLite(menu)} acceptingOrders={menu.acceptingOrders} />
    </>
  );
}
