import { generate as defaultGenerate } from "@/lib/ai";
import { AiError } from "@/lib/ai/types";
import { ASSISTANT_FOOTER, type AssistantItem, routeQuestion } from "@/lib/allergen-router";
import { type AssistantReply, allergenReply, guardModelOutput } from "@/lib/allergen-guardrails";
import { log } from "@/lib/log";
import { MENU_QA_SYSTEM, MENU_QA_TASK, buildMenuQaPrompt, demoCanAnswer, menuQaOutput } from "@/lib/menu-qa";

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

export async function answerQuestion(
  question: string,
  menu: readonly AssistantItem[],
  deps: { generate?: GenerateFn; now?: Date } = {},
): Promise<{ reply: AssistantReply; meta: AssistantMeta }> {
  const route = routeQuestion(question);
  // Allergen mode: no model, ever.
  if (route.mode === "allergen") return { reply: allergenReply(question, menu, "allergen", deps.now), meta: { model: "none" } };

  const { prompt, refs } = buildMenuQaPrompt(question, menu);
  if (refs.size === 0) {
    return { reply: { mode: "guardrail", answer: "There are no dishes available to talk about right now. Please ask staff.", items: [], footer: ASSISTANT_FOOTER, demo: false }, meta: { model: "none" } };
  }

  const gen = deps.generate ?? defaultGenerate;
  try {
    const result = await gen({ task: MENU_QA_TASK, system: MENU_QA_SYSTEM, prompt, schema: menuQaOutput, maxOutputTokens: 400 });
    // A recorded answer can't read the question: serve it only for plainly general topics, else flag it so it becomes "ask staff".
    const data = result.demo && !demoCanAnswer(question) ? { ...result.data, mentionsAllergyOrDiet: true } : result.data;
    const reply = guardModelOutput(data, { question, menu, refs, demo: result.demo, now: deps.now });
    return { reply, meta: { model: result.demo ? "demo" : "live" } };
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    // `generate()` has already logged the failure (task, provider, kind; never the prompt).
    log.warn("assistant.model_unavailable", { task: MENU_QA_TASK, kind: err.kind });
    return {
      reply: { mode: "guardrail", answer: "I couldn't answer that just now. Please ask staff, or look through the menu.", items: [], footer: ASSISTANT_FOOTER, demo: false },
      meta: { model: "failed" },
    };
  }
}
