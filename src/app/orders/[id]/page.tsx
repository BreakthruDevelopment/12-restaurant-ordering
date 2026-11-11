import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageIntro } from "@/components/ui";
import { DemoBanner } from "@/components/restaurant/demo-banner";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import { getOrder } from "@/lib/orders";
import { OrderTracker } from "./order-tracker";

export const metadata: Metadata = { title: "Order" };
export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: PageProps<"/orders/[id]">) {
  const user = await requireRoleOrRedirect("user");
  const { id } = await params;
  // Someone else's order is the same 404 as a missing one (getOrder scopes the query to this customer).
  const order = await getOrder(user, id).catch((err) => {
    if (err instanceof NotFoundError) notFound();
    throw err;
  });
  return (
    <>
      <PageIntro section="Orders" title={`Order ${order.number}`} description={`For pickup by ${order.pickupName}. Pay at pickup.`} />
      <DemoBanner />
      <OrderTracker initial={order} timeZone={env().RESTAURANT_TZ} />
    </>
  );
}
