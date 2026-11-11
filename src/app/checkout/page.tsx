import type { Metadata } from "next";
import { PageIntro } from "@/components/ui";
import { DemoBanner } from "@/components/restaurant/demo-banner";
import { toLite } from "@/components/restaurant/menu-lite";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { getPublicMenu } from "@/lib/menu";
import { CheckoutForm } from "./checkout-form";

export const metadata: Metadata = { title: "Checkout" };
export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const user = await requireRoleOrRedirect("user");
  const menu = await getPublicMenu();
  return (
    <>
      <PageIntro section="Checkout" title="Checkout" description={`Pickup only, pay when you collect. Usually ready in about ${menu.pickupMinutes} minutes.`} />
      <DemoBanner />
      <CheckoutForm userId={user.id} defaultName={user.name.slice(0, 40)} items={toLite(menu)} acceptingOrders={menu.acceptingOrders} />
    </>
  );
}
