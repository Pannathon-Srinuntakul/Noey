"""Provider-agnostic LLM gateway over LiteLLM.

THE ONLY place the project talks to a model. No vendor SDK is imported elsewhere.
Supports cloud (Claude/OpenAI/Gemini/…) and local (Ollama/vLLM/OpenAI-compatible)
via config. Tool/function calling is normalized by LiteLLM; we add a graceful
no-tools fallback for models that don't support tool calling.

Usage tracking: if a UsageCtx is set via set_usage_ctx(), each call automatically:
  1. Checks the user's plan token limit before calling the model (raises HTTP 429).
  2. Records input/output tokens to core.llm_usage_logs after a successful call.
"""

from collections.abc import Sequence
from typing import Any
import asyncio
import time

import litellm
from fastapi import HTTPException

from packages.core.logging import get_logger
from packages.llm.config import model_params
from packages.llm.usage import (
    UsageLimitExceeded,
    check_limit,
    get_usage_ctx,
    record_usage,
)

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

    # ── Usage: check limit before calling ────────────────────────────────────
    ctx = get_usage_ctx()
    if ctx is not None:
        try:
            await check_limit(ctx)
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, UsageLimitExceeded):
                raise HTTPException(
                    status_code=429,
                    detail={
                        "error": "token_limit_exceeded",
                        "used": exc.used,
                        "limit": exc.limit,
                        "plan": exc.plan,
                        "message": f"คุณใช้ token ครบโควตาแล้ว ({exc.used:,}/{exc.limit:,} tokens) กรุณาติดต่อแอดมินเพื่ออัปเกรดแพลน",
                    },
                )
            # Unexpected error checking limit — log and allow through
            log.warning("llm_usage_check_failed", error=str(exc)[:200])

    # Estimate prompt size for logging (chars, not tokens — fast approximation)
    prompt_chars = sum(len(str(m.get("content") or "")) for m in msgs)
    if system:
        prompt_chars += len(system)
    vision_image_blocks = 0
    for m in msgs:
        content = m.get("content")
        if isinstance(content, list):
            vision_image_blocks += sum(
                1 for block in content
                if isinstance(block, dict) and block.get("type") == "image_url"
            )
    log.info(
        "llm_acompletion",
        model=kwargs.get("model"),
        api_key_set=bool(kwargs.get("api_key")),
        message_count=len(msgs),
        prompt_chars=prompt_chars,
        vision_image_blocks=vision_image_blocks or None,
        reasoning_effort=kwargs.get("reasoning_effort"),
    )
    t0 = time.monotonic()
    heartbeat_sec = 30.0

    async def _wait_heartbeat() -> None:
        while True:
            await asyncio.sleep(heartbeat_sec)
            elapsed_s = round(time.monotonic() - t0)
            log.info(
                "llm_acompletion_waiting",
                model=kwargs.get("model"),
                elapsed_s=elapsed_s,
            )

    heartbeat = asyncio.create_task(_wait_heartbeat())
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
    finally:
        heartbeat.cancel()
        try:
            await heartbeat
        except asyncio.CancelledError:
            pass

    elapsed_ms = round((time.monotonic() - t0) * 1000)
    usage = getattr(resp, "usage", None)
    input_tokens: int = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens: int = int(getattr(usage, "completion_tokens", 0) or 0)
    content = ""
    try:
        content = resp.choices[0].message.content or ""
    except Exception:
        pass
    log.info(
        "llm_acompletion_done",
        model=kwargs.get("model"),
        elapsed_ms=elapsed_ms,
        input_tokens=input_tokens or None,
        output_tokens=output_tokens or None,
        response_chars=len(content),
        response_preview=content[:120].replace("\n", " "),
    )

    # ── Usage: record tokens after successful call (fire-and-forget) ──────────
    if ctx is not None and (input_tokens or output_tokens):
        model_name = str(kwargs.get("model") or "")
        asyncio.ensure_future(
            record_usage(ctx, model_name, input_tokens, output_tokens)
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
