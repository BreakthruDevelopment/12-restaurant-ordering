import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { archiveItem, getMenuItemForStaff, updateItem } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** GET /api/menu/items/:id (staff): the item with its allergen change log. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const staff = await requireRole("staff");
    return Response.json({ item: await getMenuItemForStaff(staff, (await ctx.params).id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/menu/items/:id (staff): body needs the `version` you saw. Allergens have their own endpoint. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ item: await updateItem(staff, (await ctx.params).id, await readJson(request)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/menu/items/:id (staff): archives the item (it stays for past orders and the allergen log). */
export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    await archiveItem(staff, (await ctx.params).id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
