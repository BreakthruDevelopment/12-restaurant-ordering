import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { transitionOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";

/**
 * POST /api/orders/:id/transition: `{to, version, reason?}`. Customers may only cancel while `placed`; staff move the
 * order along or cancel it with a reason. A stale version is 409; accepting an unacknowledged allergy alert is 409.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json({ order: await transitionOrder(user, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
