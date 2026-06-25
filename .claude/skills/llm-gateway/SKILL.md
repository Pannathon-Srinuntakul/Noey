---
name: llm-gateway
description: Provider-agnostic AI usage via packages/llm (LiteLLM) — cloud (Claude/OpenAI/Gemini) and local (Ollama/vLLM). Load before writing any AI/LLM/chatbot/prompt-cron code, or adding a provider.
---

# LLM Gateway Skill — provider-agnostic, cloud + local

Scope: `backend/packages/llm`. **Every model call in the whole project goes through here.** No
vendor SDK (`anthropic`, `openai`, `google-genai`, …) is imported anywhere else.

## Why

The owner wants to switch providers freely — cloud and local — by config, not code. A
single gateway over **LiteLLM** gives one interface across Claude, OpenAI, Gemini, and
local OpenAI-compatible servers (Ollama, vLLM, LM Studio).

## Interface

```
backend/packages/llm/
  gateway.py    # chat(messages, tools=None, stream=False) / complete(prompt)
  tools.py      # tool/function-call schema helpers, provider-normalized
  config.py     # reads model + base_url + keys from env
```

- `chat()` — messages in, supports **tool/function calling** and **streaming**; LiteLLM
  normalizes the request/response shape across providers.
- The rest of the code depends only on this thin wrapper, so LiteLLM itself can be
  swapped later.

## Config (env)

- `LLM_MODEL` — e.g. `anthropic/claude-opus-4-8` (default), `openai/gpt-...`,
  `gemini/...`, or `ollama/llama3` (local).
- `LLM_BASE_URL` — optional, point at a local OpenAI-compatible endpoint.
- Per-provider keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, … (none for
  local). Keys come from env only — never hard-coded, never committed.

## Rules

- **Default model `claude-opus-4-8`** unless the user sets `LLM_MODEL` otherwise.
- **Tool-calling is the primary pattern** for the chatbot (model queries the DB via tools
  rather than ingesting all rows) — bounds token cost and keeps answers grounded.
- **Graceful degrade:** provider tool-calling/streaming support varies. If the configured
  model lacks reliable tool support (common with small local models), fall back to a
  no-tools prompting path and log a warning — don't crash.
- **Caveat to surface:** small local models do tool-calling poorly; chatbot/analysis
  accuracy depends on model capability.
- Keep prompts/system text in code, not in the DB, unless it's a user's prompt-cron text.
