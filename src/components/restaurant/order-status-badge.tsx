import type { OrderStatus } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/labels";

const tone: Record<OrderStatus, string> = {
  placed: "bg-idle-soft text-idle",
  accepted: "bg-accent-soft text-accent",
  preparing: "bg-building-soft text-building",
  ready: "bg-live-soft text-live",
  picked_up: "bg-idle-soft text-idle",
  cancelled: "bg-blocked-soft text-blocked",
};

/** An order's status as a text label; colour is never the only signal. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return <span className={`inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-sm font-semibold ${tone[status]}`}>{STATUS_LABELS[status]}</span>;
}
