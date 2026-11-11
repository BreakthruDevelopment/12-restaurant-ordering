import type { Metadata } from "next";
import Link from "next/link";
import { PageIntro, buttonSecondary } from "@/components/ui";
import { requireRoleOrRedirect } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { getSettings } from "@/lib/menu";
import { listOrders } from "@/lib/orders";
import { KitchenBoard } from "./kitchen-board";
import { SettingsBar } from "./settings-bar";

export const metadata: Metadata = { title: "Kitchen" };
export const dynamic = "force-dynamic";

export default async function KitchenPage() {
  const staff = await requireRoleOrRedirect("staff");
  const [orders, settings] = await Promise.all([listOrders(staff), getSettings()]);
  return (
    <>
      <PageIntro
        section="Kitchen"
        title="Kitchen board"
        description="Open orders, oldest first. Review every allergy alert with the kitchen before accepting."
        actions={
          <Link href="/kitchen/menu" className={buttonSecondary}>
            Menu editor
          </Link>
        }
      />
      <SettingsBar acceptingOrders={settings.acceptingOrders} pickupMinutes={settings.pickupMinutes} />
      <KitchenBoard initial={orders} timeZone={env().RESTAURANT_TZ} />
    </>
  );
}
