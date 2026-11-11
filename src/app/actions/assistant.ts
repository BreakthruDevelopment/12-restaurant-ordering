"use server";

import { type ActionResult, runAction } from "@/lib/action-result";
import type { AssistantReply } from "@/lib/allergen-guardrails";
import { askMenuAssistant } from "@/lib/assistant";
import { requireUser } from "@/lib/auth/session";

/** The menu box's "Ask" button. Any signed-in account; the data function validates, rate limits and stores nothing. */
export async function askAssistantAction(question: string): Promise<ActionResult<AssistantReply>> {
  return runAction(async () => askMenuAssistant(await requireUser(), { question }));
}
