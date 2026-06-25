"""Provider-agnostic LLM gateway over LiteLLM.

THE ONLY place the project talks to a model. No vendor SDK is imported elsewhere.
Supports cloud (Claude/OpenAI/Gemini/…) and local (Ollama/vLLM/OpenAI-compatible)
via config. Tool/function calling is normalized by LiteLLM; we add a graceful
no-tools fallback for models that don't support tool calling.
"""

from collections.abc import Sequence
from typing import Any
import time

import litellm

from packages.core.logging import get_logger
from packages.llm.config import model_params

log = get_logger(__name__)

Message = dict[str, Any]


async def acompletion(
    messages: Sequence[Message],
    tools: list[dict] | None = None,
    stream: bool = False,
    **extra: Any,
) -> Any:
    """One model call. Returns the raw LiteLLM response (or async stream if `stream`).

    If `tools` are supplied but the configured model can't do tool calling, retries once
    without tools and logs — so a small local model degrades instead of crashing.
    """
    extra = dict(extra)
    system = extra.pop("system", None)
    msgs = list(messages)

    params = model_params()
    kwargs: dict[str, Any] = {**params, "messages": msgs, "stream": stream, **extra}
    # Anthropic native API uses top-level `system` (not role=system in messages).
    # LiteLLM forwards this correctly for anthropic/* models.
    if system:
        kwargs["system"] = system
    # Never let empty overrides wipe the configured key.
    if params.get("api_key") and not kwargs.get("api_key"):
        kwargs["api_key"] = params["api_key"]
    if tools:
        kwargs["tools"] = tools

    # Estimate prompt size for logging (chars, not tokens — fast approximation)
    prompt_chars = sum(len(str(m.get("content") or "")) for m in msgs)
    if system:
        prompt_chars += len(system)
    log.info(
        "llm_acompletion",
        model=kwargs.get("model"),
        api_key_set=bool(kwargs.get("api_key")),
        message_count=len(msgs),
        prompt_chars=prompt_chars,
        reasoning_effort=kwargs.get("reasoning_effort"),
    )
    t0 = time.monotonic()
    try:
        resp = await litellm.acompletion(**kwargs)
    except Exception as exc:  # noqa: BLE001
        elapsed_ms = round((time.monotonic() - t0) * 1000)
        log.warning("llm_acompletion_error", model=params.get("model"), elapsed_ms=elapsed_ms, error=str(exc)[:200])
        if tools and _looks_like_tool_unsupported(exc):
            log.warning("llm_tools_unsupported_fallback", model=params.get("model"), error=str(exc))
            kwargs.pop("tools", None)
            resp = await litellm.acompletion(**kwargs)
        else:
            raise

    elapsed_ms = round((time.monotonic() - t0) * 1000)
    usage = getattr(resp, "usage", None)
    content = ""
    try:
        content = resp.choices[0].message.content or ""
    except Exception:
        pass
    log.info(
        "llm_acompletion_done",
        model=kwargs.get("model"),
        elapsed_ms=elapsed_ms,
        input_tokens=getattr(usage, "prompt_tokens", None),
        output_tokens=getattr(usage, "completion_tokens", None),
        response_chars=len(content),
        response_preview=content[:120].replace("\n", " "),
    )
    return resp


async def complete(prompt: str, system: str | None = None, **extra: Any) -> str:
    """Convenience: single-prompt completion returning the text."""
    messages: list[Message] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    resp = await acompletion(messages, **extra)
    return resp.choices[0].message.content or ""


async def chat_once(
    messages: Sequence[Message], tools: list[dict] | None = None, **extra: Any
) -> Any:
    """One chat turn (no internal tool loop). Returns the LiteLLM message object so the
    caller can inspect `tool_calls` and run its own tool loop."""
    resp = await acompletion(messages, tools=tools, **extra)
    return resp.choices[0].message


def _looks_like_tool_unsupported(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(k in text for k in ("tool", "function call", "not supported", "unsupported"))
