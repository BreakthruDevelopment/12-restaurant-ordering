"use client";

import { useState } from "react";
import { DemoBadge } from "@/components/ui";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { askAssistantAction } from "@/app/actions/assistant";
import type { AssistantReply } from "@/lib/allergen-guardrails";
import { formatPrice } from "@/lib/labels";

const MAX = 300;

/**
 * The menu assistant. The answer is plain text from the server (never HTML or markdown). In allergen mode the listed
 * dishes are the risks (contains / may contain), so they are shown as a plain list, never as suggestions.
 */
export function AssistantBox() {
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<AssistantReply | null>(null);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setPending(true);
    setError(null);
    const result = await askAssistantAction(question.trim());
    setPending(false);
    if (result.ok) setReply(result.data);
    else setError(result.error);
  }

  const risk = reply && (reply.mode === "allergen" || reply.mode === "guardrail");
  return (
    <div className="space-y-4">
      <form onSubmit={ask} className="space-y-3">
        <label className={labelClass}>
          <span>Your question</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX}
            rows={2}
            required
            placeholder="What's spicy? What comes with the noodles?"
            className={inputClass}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm text-muted">
            {question.length}/{MAX}
          </span>
          <button type="submit" disabled={pending || !question.trim()} className={`${buttonPrimary} w-full sm:w-auto`}>
            {pending ? "Checking the menu…" : "Ask"}
          </button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      )}
      {pending && !reply && <p className="text-sm text-muted">Checking the menu…</p>}
      {reply ? (
        <div aria-live="polite" className="space-y-3 rounded-card border border-border bg-background p-4">
          {reply.demo && <DemoBadge label="Recorded demo answer" />}
          <p className="whitespace-pre-line break-words">{reply.answer}</p>
          {reply.items.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">{risk ? "Dishes this answer is about" : "Dishes mentioned"}</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                {reply.items.map((i) => (
                  <li key={i.id} className="break-words">
                    {i.name}
                    {risk ? "" : ` · ${formatPrice(i.priceCents)}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-sm font-semibold">{reply.footer}</p>
        </div>
      ) : (
        !pending && <p className="text-sm text-muted">Ask about dishes, ingredients or prices. For allergies, the assistant only lists risks: always ask staff.</p>
      )}
    </div>
  );
}
