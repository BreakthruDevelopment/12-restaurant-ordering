import { errorResponse } from "@/lib/http";
import { getPublicMenu } from "@/lib/menu";

export const dynamic = "force-dynamic";

/**
 * GET /api/menu (public): available items with prices, structured allergen declarations and verification state.
 * No staff fields. An allergen that isn't listed for a dish is not declared free of it.
 */
export async function GET() {
  try {
    return Response.json(await getPublicMenu());
  } catch (err) {
    return errorResponse(err);
  }
}
