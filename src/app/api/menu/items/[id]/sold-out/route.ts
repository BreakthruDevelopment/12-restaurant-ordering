import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { setSoldOut } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** PATCH /api/menu/items/:id/sold-out (staff): `{soldOut: boolean}`. Sets the value; it isn't a toggle. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ item: await setSoldOut(staff, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
