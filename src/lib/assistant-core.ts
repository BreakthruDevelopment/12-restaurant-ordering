import { generate as defaultGenerate } from "@/lib/ai";
import { AiError } from "@/lib/ai/types";
import { type AssistantItem, isTimeQuestion, menuWordsOf, routeQuestion } from "@/lib/allergen-router";
import { type AssistantReply, allergenReply, reply as makeReply, renderGeneral } from "@/lib/allergen-guardrails";
import { log } from "@/lib/log";
import { MENU_QA_SYSTEM, MENU_QA_TASK, availableItems, buildMenuQaPrompt, menuQaOutput } from "@/lib/menu-qa";

/**
 * The menu assistant without the database: route the question, answer allergen questions deterministically, send
 * general ones to the model through `generate()` and put the result through the guardrails. Rate limits, the daily
 * cap and the admin counter wrap this in assistant.ts. The evals (test/ai-evals.test.ts) call it directly.
 */

export type AssistantMeta = {
  /** What happened with the model: not called, a live answer, a recorded demo answer, or a failed call. */
  model: "none" | "live" | "demo" | "failed";
};

type GenerateFn = typeof defaultGenerate;

/** Wait times and opening hours: fixed text, never dish suggestions. */
export function timeReply(pickupMinutes?: number): AssistantReply {
  const wait = pickupMinutes ? ` Pickup orders are usually ready in about ${pickupMinutes} minutes.` : "";
  return makeReply("general", `Wait times depend on how busy we are.${wait} Your order page shows an estimated pickup time once you order. For opening hours, please ask staff.`, [], false);
}

/** Whether this question will call a model: general mode, not a wait-time question, and at least one available dish. */
export function needsModel(question: string, menu: readonly AssistantItem[]): boolean {
  return routeQuestion(question, { menuWords: menuWordsOf(menu) }).mode === "general" && !isTimeQuestion(question) && availableItems(menu).length > 0;
}

export async function answerQuestion(
  question: string,
  menu: readonly AssistantItem[],
  deps: { generate?: GenerateFn; now?: Date; pickupMinutes?: number } = {},
): Promise<{ reply: AssistantReply; meta: AssistantMeta }> {
  const route = routeQuestion(question, { menuWords: menuWordsOf(menu) });
  // Allergen mode (and anything outside the general vocabulary): no model, ever.
  if (route.mode === "allergen") return { reply: allergenReply(question, menu, "allergen", deps.now), meta: { model: "none" } };
  if (isTimeQuestion(question)) return { reply: timeReply(deps.pickupMinutes), meta: { model: "none" } };

  const { prompt, refs } = buildMenuQaPrompt(question, menu);
  if (refs.size === 0) {
    return { reply: makeReply("guardrail", "There are no dishes available to talk about right now. Please ask staff.", [], false), meta: { model: "none" } };
  }

  const gen = deps.generate ?? defaultGenerate;
  try {
    const result = await gen({ task: MENU_QA_TASK, system: MENU_QA_SYSTEM, prompt, schema: menuQaOutput, maxOutputTokens: 100 });
    const reply = renderGeneral(result.data, { question, menu, refs, demo: result.demo, now: deps.now });
    return { reply, meta: { model: result.demo ? "demo" : "live" } };
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    // `generate()` has already logged the failure (task, provider, kind; never the prompt).
    log.warn("assistant.model_unavailable", { task: MENU_QA_TASK, kind: err.kind });
    return {
      reply: makeReply("guardrail", "I couldn't answer that just now. Please ask staff, or look through the menu.", [], false),
      meta: { model: "failed" },
    };
  }
}
