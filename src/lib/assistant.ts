import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { assertCanAskAssistant } from "@/lib/access";
import { type AssistantReply } from "@/lib/allergen-guardrails";
import { answerQuestion, needsModel } from "@/lib/assistant-core";
import type { Actor } from "@/lib/auth/rbac";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { TooManyRequestsError } from "@/lib/errors";
import { log } from "@/lib/log";
import { getPublicMenu } from "@/lib/menu";
import { MAX_QUESTION_CHARS, MENU_QA_TASK } from "@/lib/menu-qa";
import { restaurantDayExpr } from "@/lib/restaurant-time";
import { consumeRate, releaseDaily, releaseRate, reserveDaily } from "@/lib/usage";

/**
 * POST /api/assistant, as a data function. Order of events:
 *   1. any signed-in account may ask; the body is validated (question 1 to 300 characters);
 *   2. the question is routed with the deterministic lexicon (no database, no model);
 *   3. one small transaction spends the user's hourly question (20) and, only for a general question with a live
 *      model configured, one of the day's model calls (`QA_DAILY_CAP`, default 500) via `reserveDaily`;
 *   4. the answer is built (allergen mode never calls a model); a reservation that bought no live model call is given back;
 *   5. the answer's mode is counted for the admin stats (numbers only).
 * The question is never stored and never logged. Logs carry task, mode, ref count and latency only.
 */

export const QA_PER_HOUR = 20;
const RATE_MESSAGE = "You've asked a lot of questions this hour. Please try again later, or ask staff.";
const CAP_MESSAGE = "The menu assistant is busy right now. Please try again later, or ask staff.";

export const askInput = z.object({ question: z.string().trim().min(1, "Ask a question.").max(MAX_QUESTION_CHARS) }).strict();

/** True when a real model will answer: a non-demo provider with its key. Demo answers cost nothing, so they are not capped. */
export function liveModelConfigured(): boolean {
  const e = env();
  return (e.AI_PROVIDER === "gemini" && !!e.GEMINI_API_KEY) || (e.AI_PROVIDER === "anthropic" && !!e.ANTHROPIC_API_KEY);
}

async function countAnswer(mode: AssistantReply["mode"]): Promise<void> {
  try {
    await db().execute(sql`
      insert into assistant_stat (day, mode, count) values (${restaurantDayExpr()}, ${mode}, 1)
      on conflict (day, mode) do update set count = assistant_stat.count + 1
    `);
  } catch {
    // A counter failure must not fail an answer, and database errors can echo parameters: log nothing from them.
    log.warn("assistant.count_failed", { task: MENU_QA_TASK, mode });
  }
}

export async function askMenuAssistant(actor: Actor, input: unknown): Promise<AssistantReply> {
  assertCanAskAssistant(actor);
  const { question } = askInput.parse(input);
  const started = Date.now();
  const publicMenu = await getPublicMenu();
  const dishes = publicMenu.categories.flatMap((c) => c.items);
  const reserve = needsModel(question, dishes) && liveModelConfigured();

  await db().transaction(async (tx) => {
    await consumeRate(tx, actor.id, "qa", QA_PER_HOUR, RATE_MESSAGE);
    // If the cap is reached this throws, which rolls the user's question back too.
    if (reserve && !(await reserveDaily(tx, "ai", env().QA_DAILY_CAP))) throw new TooManyRequestsError(CAP_MESSAGE);
  });

  let outcome: Awaited<ReturnType<typeof answerQuestion>>;
  try {
    outcome = await answerQuestion(question, dishes, { pickupMinutes: publicMenu.pickupMinutes });
  } catch (err) {
    // The work never happened: give back what it cost.
    await db().transaction(async (tx) => {
      await releaseRate(tx, actor.id, "qa");
      if (reserve) await releaseDaily(tx, "ai");
    });
    throw err;
  }
  // A reservation that did not end in a live model call (demo fallback, provider error) is not a model call.
  if (reserve && outcome.meta.model !== "live") await releaseDaily(db(), "ai");

  await countAnswer(outcome.reply.mode);
  log.info("assistant.answer", { task: MENU_QA_TASK, mode: outcome.reply.mode, refs: outcome.reply.items.length, model: outcome.meta.model, latencyMs: Date.now() - started });
  return outcome.reply;
}
