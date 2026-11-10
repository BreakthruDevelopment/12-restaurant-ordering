import { adminStats } from "@/lib/admin-stats";
import { requireRole } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";

export const dynamic = "force-dynamic";

/** GET /api/admin/stats (admin): counts only, never order contents or allergy details. */
export async function GET() {
  try {
    return Response.json(await adminStats(await requireRole("admin")));
  } catch (err) {
    return errorResponse(err);
  }
}
