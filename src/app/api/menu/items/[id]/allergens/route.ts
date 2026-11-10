import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { setAllergens } from "@/lib/menu";

export const dynamic = "force-dynamic";

/**
 * PUT /api/menu/items/:id/allergens (staff): `{version, verified: true, allergens: [{allergen, level}]}`.
 * Replaces the declarations, stamps who verified and when, and appends to the allergen change log.
 * Without `verified: true` it is refused.
 */
export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ item: await setAllergens(staff, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}
