"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { acknowledgeAllergyAction, transitionOrderAction } from "@/app/actions/orders";
import { OrderStatusBadge } from "@/components/restaurant/order-status-badge";
import { inputClass } from "@/components/ui/styles";
import { ALLERGEN_LABELS, BOARD_COLUMNS, NEXT_STEP, STATUS_LABELS, declarationLabel, formatTime } from "@/lib/labels";
import type { OrderView } from "@/lib/orders";
import { useOrderEvents } from "@/lib/use-order-events";

/** Gloved-hands targets: 56 px. */
const big = "inline-flex min-h-14 items-center justify-center gap-2 rounded-card px-4 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60";
const bigPrimary = `${big} bg-accent text-accent-foreground hover:opacity-90`;
const bigSecondary = `${big} border border-border bg-surface text-foreground hover:bg-accent-soft`;
const bigDanger = `${big} border border-border bg-surface text-danger hover:bg-blocked-soft`;

type Column = (typeof BOARD_COLUMNS)[number];

/**
 * The live kitchen board: Placed / Accepted / Preparing / Ready. Stream events (ids and versions only) trigger a refetch
 * of GET /api/orders; it also refetches every 15 s as a backstop, and every 5 s if the stream fails. Below 640 px it
 * is one column with status tabs.
 */
export function KitchenBoard({ initial, timeZone }: { initial: OrderView[]; timeZone: string }) {
  const [orders, setOrders] = useState(initial);
  const [tab, setTab] = useState<Column>("placed");
  const [loadError, setLoadError] = useState(false);
  const inflight = useRef(false);
  // A signal that arrives while a refetch is running must not be lost: run once more after it.
  const again = useRef(false);

  const refetch = useCallback(async () => {
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    try {
      const res = await fetch("/api/orders", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setOrders(((await res.json()) as { orders: OrderView[] }).orders);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      inflight.current = false;
      if (again.current) {
        again.current = false;
        void refetchRef.current();
      }
    }
  }, []);

  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  const { mode } = useOrderEvents({ onEvent: () => void refetch(), onPoll: () => void refetch(), backstop: true });

  /** Apply one order's new state locally (dropping it when it leaves the board), then refetch to stay in sync. */
  const applied = useCallback(
    (next: OrderView) => {
      setOrders((cur) => (BOARD_COLUMNS.includes(next.status as Column) ? cur.map((o) => (o.id === next.id ? next : o)) : cur.filter((o) => o.id !== next.id)));
      void refetch();
    },
    [refetch],
  );

  const byColumn = (c: Column) => orders.filter((o) => o.status === c);

  return (
    <div>
      <p className="mb-3 text-sm text-muted" aria-live="polite">
        {mode === "live" ? "Live: new orders appear by themselves." : "Live updates unavailable: refreshing every few seconds."}
      </p>
      {loadError && (
        <p role="alert" className="mb-3 text-sm font-medium text-danger">
          Couldn&apos;t refresh the board. Retrying.
        </p>
      )}
      <div role="tablist" aria-label="Order status" className="mb-4 grid grid-cols-2 gap-2 sm:hidden">
        {BOARD_COLUMNS.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            id={`tab-${c}`}
            aria-selected={tab === c}
            aria-controls={`col-${c}`}
            onClick={() => setTab(c)}
            className={`${big} border ${tab === c ? "border-accent bg-accent text-accent-foreground" : "border-border bg-surface text-foreground"}`}
          >
            {STATUS_LABELS[c]} ({byColumn(c).length})
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {BOARD_COLUMNS.map((c) => {
          const list = byColumn(c);
          return (
            <section key={c} id={`col-${c}`} aria-labelledby={`heading-${c}`} className={`${tab === c ? "block" : "hidden"} min-w-0 sm:block`}>
              <h2 id={`heading-${c}`} className="mb-2 flex items-center gap-2 font-display text-2xl font-semibold">
                {STATUS_LABELS[c]}
                <span className="rounded-md bg-idle-soft px-2 py-0.5 font-sans text-sm font-medium text-idle">{list.length}</span>
              </h2>
              {list.length === 0 ? (
                <p className="rounded-card border border-border bg-surface px-4 py-6 text-center text-sm text-muted">No orders.</p>
              ) : (
                <ul className="space-y-3">
                  {list.map((o) => (
                    <li key={o.id}>
                      <Ticket order={o} timeZone={timeZone} onChange={applied} onStale={() => void refetch()} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Ticket({ order, timeZone, onChange, onStale }: { order: OrderView; timeZone: string; onChange: (o: OrderView) => void; onStale: () => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState(order.allergy.alert ? "Can't safely prepare" : "");
  const alertOpen = order.allergy.alert && !order.allergy.acknowledged;
  const next = NEXT_STEP[order.status];
  const blocked = order.status === "placed" && alertOpen;

  async function run(fn: () => ReturnType<typeof transitionOrderAction>) {
    setPending(true);
    setError(null);
    const result = await fn();
    setPending(false);
    if (result.ok) {
      setCancelling(false);
      onChange(result.data);
    } else {
      setError(result.error);
      if (result.status === 409 || result.status === 404) onStale();
    }
  }

  return (
    <article aria-label={`Order ${order.number}`} className={`overflow-hidden rounded-card border bg-surface ${order.allergy.alert ? "border-2 border-blocked" : "border-border"}`}>
      {order.allergy.alert && (
        <div className="space-y-2 bg-blocked p-3 text-surface">
          <p className="text-lg font-bold uppercase tracking-wide">Allergy alert</p>
          {order.allergy.allergens.length > 0 && <p className="font-semibold break-words">{order.allergy.allergens.map((a) => ALLERGEN_LABELS[a]).join(", ")}</p>}
          {order.allergy.note && <p className="break-words">{order.allergy.note}</p>}
          {order.allergy.customerConfirmed && <p className="text-sm">The customer saw the matching dishes and will confirm with staff.</p>}
          {alertOpen ? (
            <button type="button" disabled={pending} onClick={() => run(() => acknowledgeAllergyAction(order.id))} className={`${big} w-full border-2 border-surface bg-surface text-blocked`}>
              Allergy reviewed with kitchen
            </button>
          ) : (
            <p className="text-sm font-semibold">
              Reviewed{order.allergy.acknowledgedBy?.name ? ` by ${order.allergy.acknowledgedBy.name}` : ""}
              {order.allergy.acknowledgedAt ? ` at ${formatTime(order.allergy.acknowledgedAt, timeZone)}` : ""}
            </p>
          )}
        </div>
      )}
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xl font-semibold">{order.number}</p>
          <OrderStatusBadge status={order.status} />
        </div>
        <p className="text-sm break-words">
          <span className="font-semibold">{order.pickupName}</span> · placed {formatTime(order.createdAt, timeZone)} · due {formatTime(order.readyEstimateAt, timeZone)}
        </p>
        <ul className="space-y-1">
          {order.lines.map((l) => (
            <li key={l.id} className="break-words">
              <span className="font-semibold">{l.qty} ×</span> {l.name}
              {order.allergy.alert && l.allergens.length > 0 && <span className="block text-sm text-muted">{l.allergens.map(declarationLabel).join(", ")}</span>}
            </li>
          ))}
        </ul>
        {order.note && <p className="rounded-card bg-background p-2 text-sm break-words">Note: {order.note}</p>}

        <div className="flex flex-col gap-2">
          {next && (
            <button type="button" disabled={pending || blocked} onClick={() => run(() => transitionOrderAction(order.id, { to: next.to, version: order.version }))} className={`${bigPrimary} w-full`}>
              {next.label}
            </button>
          )}
          {blocked && <p className="text-sm font-medium text-blocked">Review the allergy alert before accepting.</p>}
          {!cancelling ? (
            <button type="button" disabled={pending} onClick={() => setCancelling(true)} className={`${bigDanger} w-full`}>
              Cancel order
            </button>
          ) : (
            <form
              className="space-y-2 rounded-card border border-border p-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reason.trim()) return setError("Give a reason for cancelling.");
                void run(() => transitionOrderAction(order.id, { to: "cancelled", version: order.version, reason: reason.trim() }));
              }}
            >
              <label className="block space-y-1 text-sm font-medium">
                <span>Reason (the customer sees this)</span>
                <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} required className={`${inputClass} min-h-14`} />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button type="submit" disabled={pending} className={`${bigDanger} w-full`}>
                  Confirm cancel
                </button>
                <button type="button" disabled={pending} onClick={() => setCancelling(false)} className={`${bigSecondary} w-full`}>
                  Keep order
                </button>
              </div>
            </form>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
