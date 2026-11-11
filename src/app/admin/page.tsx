import type { Metadata } from "next";
import { headers } from "next/headers";
import { type Column, DataList, PageIntro, Panel, StatGrid, StatTile } from "@/components/ui";
import { type AdminStats, adminStats } from "@/lib/admin-stats";
import { auth } from "@/lib/auth";
import { toRole } from "@/lib/auth/rbac";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { ORDER_STATUSES } from "@/lib/db/schema";
import { STATUS_LABELS } from "@/lib/labels";
import { DemoButton, RoleButton } from "./admin-controls";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const MODE_LABELS = { allergen: "Allergen", general: "General", guardrail: "Guardrail", demo: "Demo" } as const;

/**
 * Counts only: orders by status per day, sold-out dishes, assistant answers by mode, accounts by role. No order contents
 * or allergy details (admins get 404 from every order function). User management (granting staff) goes through Better
 * Auth's admin endpoints, which log every role change.
 */
export default async function AdminPage() {
  const admin = await requireRoleOrRedirect("admin");
  const [stats, list] = await Promise.all([
    adminStats(admin),
    auth().api.listUsers({ query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" }, headers: await headers() }),
  ]);
  const users = list.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: toRole((u as { role?: string | null }).role), createdAt: new Date(u.createdAt) }));
  const orders14 = stats.ordersByDay.reduce((n, d) => n + d.total, 0);

  type Day = AdminStats["ordersByDay"][number];
  const dayColumns: Column<Day>[] = [
    { key: "day", header: "Day", primary: true, className: "whitespace-nowrap", cell: (d) => <span className="font-mono">{d.day}</span> },
    ...ORDER_STATUSES.map((s) => ({ key: s, header: STATUS_LABELS[s], cell: (d: Day) => d[s] })),
    { key: "total", header: "Total", cell: (d) => <span className="font-semibold">{d.total}</span> },
  ];
  type ModeDay = AdminStats["assistantByDay"][number];
  const modeColumns: Column<ModeDay>[] = [
    { key: "day", header: "Day", primary: true, className: "whitespace-nowrap", cell: (d) => <span className="font-mono">{d.day}</span> },
    ...(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]).map((m) => ({ key: m, header: MODE_LABELS[m], cell: (d: ModeDay) => d[m] })),
  ];
  type Row = (typeof users)[number];
  const userColumns: Column<Row>[] = [
    { key: "name", header: "Name", primary: true, cell: (u) => <span className="break-words">{u.name}</span> },
    { key: "email", header: "Email", className: "break-all", cell: (u) => <span className="break-all">{u.email}</span> },
    { key: "role", header: "Role", cell: (u) => (u.role === "admin" ? "Admin" : u.role === "staff" ? "Staff" : "Customer") },
    { key: "joined", header: "Joined", className: "whitespace-nowrap", cell: (u) => u.createdAt.toISOString().slice(0, 10) },
    {
      key: "actions",
      header: "Change role",
      srOnlyHeader: true,
      hideLabel: true,
      cell: (u) => (u.role === "admin" || u.id === admin.id ? <span className="text-sm text-muted">—</span> : <RoleButton userId={u.id} name={u.name} role={u.role} />),
    },
  ];

  return (
    <>
      <PageIntro section="Admin" title="Restaurant counts" description="Numbers only: no order contents or allergy details. Grant staff access and load the demo restaurant here." />
      <StatGrid>
        <StatTile value={orders14} label="Orders, last 14 days" tone="accent" />
        <StatTile value={stats.soldOutItems} label="Sold-out dishes" tone={stats.soldOutItems > 0 ? "building" : "default"} />
        <StatTile value={stats.users.customers} label="Customers" />
        <StatTile value={stats.users.staff} label="Staff" />
      </StatGrid>
      <Panel title="Orders by status, last 14 days" count={stats.ordersByDay.length}>
        <DataList caption="Orders by status per day" rows={stats.ordersByDay} rowKey={(d) => d.day} columns={dayColumns} empty="No orders in the last 14 days." />
      </Panel>
      <Panel title="Menu assistant answers by mode" count={stats.assistantByDay.length}>
        <DataList caption="Assistant answers by mode per day" rows={stats.assistantByDay} rowKey={(d) => d.day} columns={modeColumns} empty="No questions in the last 14 days." />
      </Panel>
      <Panel title="Users" count={users.length}>
        <p className="mb-3 text-sm text-muted">Only admins can grant staff. Every role change is logged.</p>
        <DataList caption="Users" rows={users} rowKey={(u) => u.id} columns={userColumns} empty="No users yet." />
      </Panel>
      <Panel title="Demo restaurant">
        <DemoButton />
      </Panel>
    </>
  );
}
