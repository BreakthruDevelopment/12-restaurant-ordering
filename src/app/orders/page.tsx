import type { Metadata } from "next";
import Link from "next/link";
import { type Column, DataList, PageIntro, Panel, buttonPrimary } from "@/components/ui";
import { OrderStatusBadge } from "@/components/restaurant/order-status-badge";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { formatDateTime, formatPrice } from "@/lib/labels";
import { type OrderView, listOrders } from "@/lib/orders";

export const metadata: Metadata = { title: "Your orders" };
export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await requireRoleOrRedirect("user");
  const orders = await listOrders(user);
  const tz = env().RESTAURANT_TZ;

  const columns: Column<OrderView>[] = [
    {
      key: "number",
      header: "Order",
      primary: true,
      cell: (o) => (
        <Link href={`/orders/${o.id}`} className="inline-flex min-h-11 items-center font-mono font-semibold text-accent underline underline-offset-2">
          {o.number}
        </Link>
      ),
    },
    { key: "status", header: "Status", cell: (o) => <OrderStatusBadge status={o.status} /> },
    { key: "items", header: "Dishes", cell: (o) => o.lines.reduce((n, l) => n + l.qty, 0) },
    { key: "total", header: "Total", className: "whitespace-nowrap", cell: (o) => <span className="font-mono">{formatPrice(o.subtotalCents)}</span> },
    { key: "placed", header: "Placed", className: "whitespace-nowrap", cell: (o) => formatDateTime(o.createdAt, tz) },
  ];

  return (
    <>
      <PageIntro section="Orders" title="Your orders" description="Open an order to follow it live." />
      <Panel title="Orders" count={orders.length}>
        <DataList
          caption="Your orders"
          rows={orders}
          rowKey={(o) => o.id}
          columns={columns}
          empty={
            <span className="flex flex-col items-center gap-3">
              You haven&apos;t ordered yet.
              <Link href="/menu" className={buttonPrimary}>
                Browse the menu
              </Link>
            </span>
          }
        />
      </Panel>
    </>
  );
}
