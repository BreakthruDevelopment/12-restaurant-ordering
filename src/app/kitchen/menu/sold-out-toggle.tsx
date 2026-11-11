"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonDanger, buttonSecondary } from "@/components/ui/styles";
import { setSoldOutAction } from "@/app/actions/menu";

/** Sets sold-out to an explicit value (not a toggle on the server), so two staff can't undo each other. */
export function SoldOutToggle({ itemId, soldOut, name }: { itemId: string; soldOut: boolean; name: string }) {
  const router = useRouter();
  const [value, setValue] = useState(soldOut);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function set(next: boolean) {
    setPending(true);
    setError(null);
    const result = await setSoldOutAction(itemId, next);
    setPending(false);
    if (!result.ok) return setError(result.error);
    setValue(result.data.soldOut);
    router.refresh();
  }
  return (
    <div className="flex shrink-0 flex-col items-start gap-1 md:items-end">
      <div className="flex items-center gap-3">
        <span className={`text-sm font-semibold ${value ? "text-blocked" : "text-muted"}`}>{value ? "Sold out" : "Available"}</span>
        <button type="button" disabled={pending} onClick={() => set(!value)} className={`${value ? buttonSecondary : buttonDanger} min-h-14`} aria-label={value ? `Mark ${name} available` : `Mark ${name} sold out`}>
          {value ? "Mark available" : "Mark sold out"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
