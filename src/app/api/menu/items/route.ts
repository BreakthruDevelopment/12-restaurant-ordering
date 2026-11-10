import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createItem, listMenuForStaff } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** GET /api/menu/items (staff): everything, archived items and versions included, for the menu editor. */
export async function GET() {
  try {
    return Response.json(await listMenuForStaff(await requireRole("staff")));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/menu/items (staff): a new item with no allergen declarations and no verification stamp. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ item: await createItem(staff, await readJson(request)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
