import { requireUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/http";
import { openOrderStream } from "@/lib/order-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/orders/stream. Server-Sent Events carrying `{orderId, version}` only.
 * The session is checked on connect (and again when the client reconnects after the 10-minute close).
 * Customers get their own orders; staff get every order; anyone else gets the same 401/404 as the order routes.
 * A 4th stream for one user, or more than 100 streams in the process, is 429 so the client polls instead.
 */
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    return openOrderStream(user, request.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
