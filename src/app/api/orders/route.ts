import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";
import { listOrders, placeOrder } from "@/lib/orders";

export const dynamic = "force-dynamic";

/** GET /api/orders: a customer's own orders; staff get the kitchen queue (`?status=open|all|<status>`). Admins: 404. */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const status = new URL(request.url).searchParams.get("status") ?? undefined;
    return Response.json({ orders: await listOrders(user, status ? { status } : {}) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/orders (customer): `{lines: [{itemId, qty}], pickupName, note?, allergy: {has, allergens, note, confirmWithStaff}, idempotencyKey}`.
 * Prices come from the menu, never the client. 201 for a new order; 200 with the first order for a repeated key.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    const { order, created } = await placeOrder(user, await readJson(request));
    return Response.json({ order }, { status: created ? 201 : 200 });
  } catch (err) {
    return errorResponse(err);
  }
}
