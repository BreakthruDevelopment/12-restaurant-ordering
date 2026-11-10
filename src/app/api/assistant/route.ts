import { askMenuAssistant } from "@/lib/assistant";
import { requireUser } from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/csrf";
import { errorResponse, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";
// Room for one live model call (AI_TIMEOUT_MS is at most 22 s) where the platform honours it.
export const maxDuration = 25;

/**
 * POST /api/assistant (any signed-in account): `{question}` (1 to 300 characters).
 *
 * 200 `{mode, answer, items, footer, demo}`
 *   - `mode`: "allergen" (deterministic, no model), "general" (live model, checked), "demo" (recorded answer, checked),
 *     "guardrail" (a model answer was replaced, or the model was unavailable).
 *   - `answer`: plain text. Render it as text, never as HTML or markdown.
 *   - `items`: dishes the answer is about `[{id, name, priceCents}]`, names and prices from the database.
 *   - `footer`: always "Allergies? Ask staff before ordering."; show it under every answer.
 * 400 invalid body; 401 not signed in; 403 cross-origin; 429 hourly limit (20) or the daily model cap.
 * Questions are not stored or logged.
 */
export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser();
    return Response.json(await askMenuAssistant(user, await readJson(request)));
  } catch (err) {
    return errorResponse(err);
  }
}
