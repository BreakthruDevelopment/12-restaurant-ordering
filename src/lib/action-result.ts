import "server-only";
import { errorInfo } from "@/lib/http";

/**
 * What a server action returns to a client component. Errors are mapped exactly like route handlers map them
 * (errorInfo: status, a client-safe message and optional details such as which items are sold out), never thrown,
 * so the page can show the message with role="alert" and no stack trace reaches the browser.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; details?: unknown };

export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const { status, body } = errorInfo(err);
    // Zod issues are summarised into the message rather than shown raw.
    const issues = Array.isArray(body.issues) ? (body.issues as { message?: string }[]).map((i) => i.message).filter(Boolean) : [];
    const error = issues.length ? `${body.error}: ${issues.slice(0, 3).join("; ")}` : body.error;
    return { ok: false, status, error, ...(body.details === undefined ? {} : { details: body.details }) };
  }
}
