import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { deleteCategory, updateCategory } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** PATCH /api/menu/categories/:id (staff): `{name?, position?}`. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ category: await updateCategory(staff, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/menu/categories/:id (staff): only when the category has no items at all. */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    await deleteCategory(staff, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
