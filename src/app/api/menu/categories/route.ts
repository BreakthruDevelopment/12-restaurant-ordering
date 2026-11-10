import { requireRole } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { createCategory } from "@/lib/menu";

export const dynamic = "force-dynamic";

/** POST /api/menu/categories (staff): `{name, position?}`. At most 20 categories. */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const staff = await requireRole("staff");
    return Response.json({ category: await createCategory(staff, await readJson(request)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
