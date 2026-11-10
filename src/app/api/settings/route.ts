import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { updateSettings } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** PATCH /api/settings (staff): `{acceptingOrders?, pickupMinutes?}` (5 to 90). */
export async function PATCH(request: Request) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ settings: await updateSettings(staff, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
