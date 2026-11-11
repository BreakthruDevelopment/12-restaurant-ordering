import { redirect } from "next/navigation";
import { homeFor, requireUserOrRedirect } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/** Kept so old links and the sign-in form land somewhere: each role goes to its own home (menu, kitchen, admin). */
export default async function DashboardPage() {
  const user = await requireUserOrRedirect();
  redirect(homeFor(user.role));
}
