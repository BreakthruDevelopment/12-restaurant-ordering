import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

/** Placeholder until the customer pages and the kitchen board arrive (issue 12.4). */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  return (
    <>
      <PageIntro section="Dashboard" title={`Hi, ${user.name}`} description={`Signed in as ${user.email}. Role: ${user.role}.`} />
      <Panel title="Coming next">
        <p className="text-muted">The menu, cart, order tracker and kitchen board are built in a later issue. The API is ready.</p>
      </Panel>
    </>
  );
}
