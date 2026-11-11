"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import { updateSettingsAction } from "@/app/actions/menu";

/** Open or close ordering and set the pickup estimate (5 to 90 minutes). Staff only, enforced in the action. */
export function SettingsBar({ acceptingOrders, pickupMinutes }: { acceptingOrders: boolean; pickupMinutes: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(acceptingOrders);
  const [minutes, setMinutes] = useState(String(pickupMinutes));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState("");

  async function save(input: { acceptingOrders?: boolean; pickupMinutes?: number }) {
    setPending(true);
    setError(null);
    setSaved("");
    const result = await updateSettingsAction(input);
    setPending(false);
    if (!result.ok) return setError(result.error);
    setOpen(result.data.acceptingOrders);
    setMinutes(String(result.data.pickupMinutes));
    setSaved("Saved.");
    router.refresh();
  }

  return (
    <section aria-label="Ordering settings" className="mb-6 flex flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:flex-row sm:flex-wrap sm:items-end">
      <div className="flex flex-1 flex-wrap items-center gap-3">
        <p className={`font-semibold ${open ? "" : "text-blocked"}`}>{open ? "Taking orders" : "Ordering is closed"}</p>
        <button type="button" disabled={pending} onClick={() => save({ acceptingOrders: !open })} className={`${open ? buttonSecondary : buttonPrimary} min-h-14`}>
          {open ? "Close ordering" : "Open ordering"}
        </button>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(minutes);
          if (!Number.isInteger(n) || n < 5 || n > 90) return setError("Pickup time must be 5 to 90 minutes.");
          void save({ pickupMinutes: n });
        }}
      >
        <label className="block space-y-1 text-sm font-medium">
          <span>Pickup estimate (minutes)</span>
          <input type="number" min={5} max={90} inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} className={`${inputClass} min-h-14 w-32`} />
        </label>
        <button type="submit" disabled={pending} className={`${buttonSecondary} min-h-14`}>
          Save
        </button>
      </form>
      <p aria-live="polite" className="text-sm text-muted sm:basis-full">
        {saved}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger sm:basis-full">
          {error}
        </p>
      )}
    </section>
  );
}
