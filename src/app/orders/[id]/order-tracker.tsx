"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "@/components/ui";
import { buttonDanger } from "@/components/ui/styles";
import { transitionOrderAction } from "@/app/actions/orders";
import { AllergenChips } from "@/components/restaurant/allergen-chips";
import { OrderStatusBadge } from "@/components/restaurant/order-status-badge";
import { ALLERGEN_LABELS, FINAL, STATUS_LABELS, TRACKER_STEPS, formatPrice, formatTime } from "@/lib/labels";
import type { OrderView } from "@/lib/orders";
import { useOrderEvents } from "@/lib/use-order-events";

/**
 * The customer's live tracker. The stream only says "order X is now at version N"; the tracker then refetches
 * GET /api/orders/[id], which applies the access rules. After two stream errors it polls every 5 s.
 */
export function OrderTracker({ initial, timeZone }: { initial: OrderView; timeZone: string }) {
  const [order, setOrder] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inflight = useRef(false);
  // A signal that arrives while a refetch is running must not be lost: run once more after it.
  const again = useRef(false);
  const final = FINAL.has(order.status);

  const refetch = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      const res = await fetch(`/api/orders/${order.id}`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { order: OrderView };
        setOrder((cur) => (body.order.version >= cur.version ? body.order : cur));
      }
    } catch {
      // Offline for a moment: the next event or poll tries again.
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void refetchRef.current();
      }
    }
  }, [order.id]);

  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const { mode } = useOrderEvents({
    enabled: !final,
    onEvent: (e) => {
      if (e.orderId === order.id && e.version > order.version) void refetch();
    },
    onPoll: () => void refetch(),
  });

  async function cancel() {
    setPending(true);
    setError(null);
    const result = await transitionOrderAction(order.id, { to: "cancelled", version: order.version });
    setPending(false);
    if (result.ok) setOrder(result.data);
    else {
      setError(result.error);
      void refetch();
    }
  }

  const stepIndex = TRACKER_STEPS.indexOf(order.status as (typeof TRACKER_STEPS)[number]);
  const waitingForAllergyReview = order.allergy.alert && !order.allergy.acknowledged && order.status === "placed";

  return (
    <>
      <Panel title="Status" action={<OrderStatusBadge status={order.status} />}>
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {final ? "This order is finished." : mode === "live" ? "Live: this page updates by itself." : "Checking for updates every few seconds."}
        </p>
        {order.status === "cancelled" ? (
          <div role="status" className="rounded-card border border-blocked bg-blocked-soft p-4 text-blocked">
            <p className="font-semibold">This order was cancelled.</p>
            {order.cancelReason && <p className="mt-1 break-words">Reason: {order.cancelReason}</p>}
          </div>
        ) : (
          <ol className="grid gap-2 sm:grid-cols-5" aria-label="Order progress">
            {TRACKER_STEPS.map((s, i) => {
              const done = i < stepIndex;
              const current = i === stepIndex;
              return (
                <li
                  key={s}
                  aria-current={current ? "step" : undefined}
                  className={`flex min-h-11 items-center gap-3 rounded-card border px-3 py-2 text-sm ${
                    current ? "border-accent bg-accent-soft font-semibold text-accent" : done ? "border-border bg-surface text-foreground" : "border-border bg-background text-muted"
                  }`}
                >
                  <span aria-hidden className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${current || done ? "bg-accent text-accent-foreground" : "bg-idle-soft text-idle"}`}>
                    {i + 1}
                  </span>
                  <span>
                    {STATUS_LABELS[s]}
                    <span className="sr-only">{done ? " (done)" : current ? " (current)" : ""}</span>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {!final && (
          <p className="mt-4 font-semibold">
            {order.status === "ready" ? "Your order is ready. Come and collect it." : `Estimated ready around ${formatTime(order.readyEstimateAt, timeZone)}.`}
          </p>
        )}
        {order.status === "placed" && (
          <div className="mt-4">
            <button type="button" onClick={cancel} disabled={pending} className={`${buttonDanger} w-full sm:w-auto`}>
              {pending ? "Cancelling…" : "Cancel order"}
            </button>
            <p className="mt-1 text-sm text-muted">You can cancel until the kitchen accepts it.</p>
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </Panel>

      {order.allergy.alert && (
        <Panel title="Your allergy">
          <p className="mb-2 font-semibold">
            {waitingForAllergyReview
              ? "Staff will confirm your allergy before we start."
              : order.allergy.acknowledged
                ? "Staff reviewed your allergy with the kitchen."
                : "You told us about an allergy."}
          </p>
          {order.allergy.allergens.length > 0 && <p className="text-sm break-words">{order.allergy.allergens.map((a) => ALLERGEN_LABELS[a]).join(", ")}</p>}
          {order.allergy.note && <p className="mt-1 text-sm break-words text-muted">{order.allergy.note}</p>}
          <p className="mt-2 text-sm">Please speak with staff before eating.</p>
        </Panel>
      )}

      <Panel title="Dishes" count={order.lines.length}>
        <ul className="divide-y divide-border">
          {order.lines.map((l) => (
            <li key={l.id} className="space-y-1 py-2">
              <p className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words">
                  {l.qty} × {l.name}
                </span>
                <span className="shrink-0 font-mono text-sm">{formatPrice(l.lineTotalCents)}</span>
              </p>
              <AllergenChips allergens={l.allergens} emptyText="No allergens listed when you ordered. That isn't a guarantee." />
            </li>
          ))}
        </ul>
        <p className="mt-2 flex justify-between border-t border-border pt-2 font-semibold">
          <span>Total (pay at pickup)</span>
          <span className="font-mono">{formatPrice(order.subtotalCents)}</span>
        </p>
        {order.note && <p className="mt-2 text-sm break-words text-muted">Your note: {order.note}</p>}
      </Panel>
    </>
  );
}
