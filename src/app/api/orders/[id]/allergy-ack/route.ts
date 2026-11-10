import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, parseJsonBody, readBodyCapped } from "@/lib/http";
import { acknowledgeAllergy } from "@/lib/orders";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** POST /api/orders/:id/allergy-ack (staff): "Allergy reviewed with kitchen". Records who and when, once. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    // No input of its own; an empty body is fine, anything else must be an empty object.
    const body = await readBodyCapped(request, 1024);
    if (body.length > 0) z.object({}).strict().parse(parseJsonBody(body));
    return Response.json({ order: await acknowledgeAllergy(staff, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}
