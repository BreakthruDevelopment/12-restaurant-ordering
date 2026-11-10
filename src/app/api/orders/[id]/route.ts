import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { getOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** GET /api/orders/:id: the customer's own order or any order for staff. Anyone else gets 404. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    return Response.json({ order: await getOrder(user, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}
