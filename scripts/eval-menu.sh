#!/usr/bin/env bash
# Live evals for the menu assistant: the same cases as test/ai-evals.test.ts, against the real model (not on Oracle).
# Fails (non-zero) if there is no key: a "passing" eval run that silently used stubs would prove nothing.
set -euo pipefail
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "eval:menu needs GEMINI_API_KEY (live model). CI runs the same cases against stubs via 'pnpm test'." >&2
  exit 1
fi
AI_PROVIDER=gemini AI_FALLBACK_TO_DEMO=false EVAL_LIVE=1 exec vitest run test/ai-evals.test.ts
