"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/components/ui/styles";
import { authClient } from "@/lib/auth/client";

/** Grant or remove staff through Better Auth's admin endpoint (admin only, single role, logged by the role audit hook). */
export function RoleButton({ userId, name, role }: { userId: string; name: string; role: "user" | "staff" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = role === "staff" ? "user" : "staff";
  async function change() {
    setPending(true);
    setError(null);
    const result = await authClient.admin.setRole({ userId, role: next });
    setPending(false);
    if (result.error) return setError(result.error.message ?? "Couldn't change the role.");
    router.refresh();
  }
  return (
    <div>
      <button type="button" disabled={pending} onClick={change} className={`${buttonSecondary} w-full sm:w-auto`} aria-label={next === "staff" ? `Make ${name} staff` : `Make ${name} a customer`}>
        {pending ? "Saving…" : next === "staff" ? "Make staff" : "Make customer"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** POST /api/admin/demo: reloads "Demo Noodle Bar" and the demo customers' orders. Rate limited on the server. */
export function DemoButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState("");
  async function load() {
    setPending(true);
    setError(null);
    setDone("");
    try {
      const res = await fetch("/api/admin/demo", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; users?: number; categories?: number; items?: number; orders?: number };
      if (!res.ok) setError(body.error ?? "Couldn't load the demo.");
      else {
        setDone(`Loaded ${body.categories ?? 0} categories, ${body.items ?? 0} dishes, ${body.users ?? 0} demo accounts and ${body.orders ?? 0} orders.`);
        router.refresh();
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted">Replaces the demo customers&apos; orders and reloads the demo menu. Real dishes and accounts are never touched.</p>
      <button type="button" disabled={pending} onClick={load} className={`${buttonPrimary} w-full sm:w-auto`}>
        {pending ? "Loading…" : "Load demo restaurant"}
      </button>
      <p aria-live="polite" className="text-sm">
        {done}
      </p>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
