"""Provider-agnostic LLM gateway over LiteLLM.

THE ONLY place the project talks to a model. No vendor SDK is imported elsewhere.
Supports cloud (Claude/OpenAI/Gemini/…) and local (Ollama/vLLM/OpenAI-compatible)
via config. Tool/function calling is normalized by LiteLLM; we add a graceful
no-tools fallback for models that don't support tool calling.

Usage tracking: if a UsageCtx is set via set_usage_ctx(), each call automatically:
  1. Checks the user's plan token limit before calling the model (raises HTTP 429).
  2. Records input/output tokens to core.llm_usage_logs after a successful call.
"""

from collections.abc import Awaitable, Callable, Sequence
from typing import Any
import asyncio
import time

import litellm
from fastapi import HTTPException

from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.llm.config import model_params
from packages.llm.usage import (
    UsageLimitExceeded,
    check_limit,
    get_usage_ctx,
    record_usage,
)

log = get_logger(__name__)

Message = dict[str, Any]

_RETRY_BACKOFF_SEC = 30.0


def _payload_stats(messages: Sequence[Message], system: str | None) -> dict[str, int]:
    """Split user-visible text vs base64 image payload for logging."""
    text_chars = 0
    image_blocks = 0
    image_base64_chars = 0
    for m in messages:
        content = m.get("content")
        if isinstance(content, str):
            text_chars += len(content)
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text_chars += len(str(block.get("text") or ""))
            elif block.get("type") == "image_url":
                image_blocks += 1
                url = ""
                image_url = block.get("image_url")
                if isinstance(image_url, dict):
                    url = str(image_url.get("url") or "")
                image_base64_chars += len(url)
            elif block.get("type") == "file":
                image_blocks += 1
                file_sub = block.get("file")
                if isinstance(file_sub, dict):
                    image_base64_chars += len(str(file_sub.get("file_id") or ""))
    system_chars = len(system) if system else 0
    total_chars = text_chars + system_chars + image_base64_chars
    return {
        "text_chars": text_chars,
        "system_chars": system_chars,
        "image_blocks": image_blocks,
        "image_base64_chars": image_base64_chars,
        "approx_request_kb": round(total_chars / 1024),
    }


def _resolve_timeout_sec(kwargs: dict[str, Any], image_blocks: int) -> int:
    if kwargs.get("timeout") is not None:
        return int(kwargs["timeout"])
    s = get_settings()
    if image_blocks > 0:
        return int(s.llm_vision_timeout_sec)
    return int(s.llm_timeout_sec)


def _error_phase(exc: BaseException) -> str:
    if isinstance(exc, asyncio.TimeoutError):
        return "hard_timeout"
    text = str(exc).lower()
    name = type(exc).__name__.lower()
    if "getaddrinfo" in text or "connecterror" in name or "connection" in name:
        return "connection"
    if "timeout" in text or "timed out" in text:
        return "timeout"
    if any(code in text for code in ("error 520", "error 502", "error 503", "error 529")):
        return "upstream_5xx"
    if "rate limit" in text or "overloaded" in text:
        return "rate_limit"
    return "api_error"


def _is_retryable(exc: BaseException) -> bool:
    phase = _error_phase(exc)
    return phase in {"connection", "timeout", "hard_timeout", "upstream_5xx", "rate_limit"}


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
    if system:
        kwargs["system"] = system
    if params.get("api_key") and not kwargs.get("api_key"):
        kwargs["api_key"] = params["api_key"]
    if tools:
        kwargs["tools"] = tools

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
            log.warning("llm_usage_check_failed", error=str(exc)[:200])

    stats = _payload_stats(msgs, system)
    timeout_sec = _resolve_timeout_sec(kwargs, stats["image_blocks"])
    kwargs["timeout"] = timeout_sec
    max_retries = int(get_settings().llm_max_retries)
    max_attempts = max_retries + 1

    log.info(
        "llm_acompletion",
        model=kwargs.get("model"),
        api_key_set=bool(kwargs.get("api_key")),
        message_count=len(msgs),
        reasoning_effort=kwargs.get("reasoning_effort"),
        timeout_sec=timeout_sec,
        max_attempts=max_attempts,
        vision_image_blocks=stats["image_blocks"] or None,
        text_chars=stats["text_chars"],
        system_chars=stats["system_chars"] or None,
        image_base64_kb=round(stats["image_base64_chars"] / 1024) if stats["image_blocks"] else None,
        approx_request_kb=stats["approx_request_kb"],
        note=(
            "upload+inference opaque inside litellm; "
            "long llm_acompletion_waiting = hung or slow API, not local ffmpeg"
        ),
    )

    t0 = time.monotonic()
    heartbeat_sec = 30.0
    attempt = 0
    resp: Any = None

    async def _wait_heartbeat() -> None:
        while True:
            await asyncio.sleep(heartbeat_sec)
            elapsed_s = round(time.monotonic() - t0)
            log.info(
                "llm_acompletion_waiting",
                model=kwargs.get("model"),
                elapsed_s=elapsed_s,
                timeout_sec=timeout_sec,
                remaining_s=max(0, timeout_sec - elapsed_s),
                attempt=attempt,
                approx_request_kb=stats["approx_request_kb"],
                image_blocks=stats["image_blocks"] or None,
            )

    for attempt in range(1, max_attempts + 1):
        heartbeat = asyncio.create_task(_wait_heartbeat())
        attempt_t0 = time.monotonic()
        tool_fallback = False
        try:
            log.info(
                "llm_call_attempt",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                timeout_sec=timeout_sec,
                approx_request_kb=stats["approx_request_kb"],
                image_blocks=stats["image_blocks"] or None,
            )
            resp = await asyncio.wait_for(
                litellm.acompletion(**kwargs),
                timeout=timeout_sec,
            )
            break
        except Exception as exc:  # noqa: BLE001
            elapsed_ms = round((time.monotonic() - attempt_t0) * 1000)
            total_ms = round((time.monotonic() - t0) * 1000)
            phase = _error_phase(exc)
            log.warning(
                "llm_acompletion_error",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                attempt_elapsed_ms=elapsed_ms,
                total_elapsed_ms=total_ms,
                timeout_sec=timeout_sec,
                error_phase=phase,
                error_type=type(exc).__name__,
                approx_request_kb=stats["approx_request_kb"],
                image_blocks=stats["image_blocks"] or None,
                error=str(exc)[:400],
            )
            if tools and _looks_like_tool_unsupported(exc):
                log.warning("llm_tools_unsupported_fallback", model=kwargs.get("model"))
                kwargs.pop("tools", None)
                tools = None
                tool_fallback = True
            elif attempt < max_attempts and _is_retryable(exc):
                wait_s = _RETRY_BACKOFF_SEC * attempt
                log.warning(
                    "llm_call_retry",
                    model=kwargs.get("model"),
                    next_attempt=attempt + 1,
                    wait_s=wait_s,
                    error_phase=phase,
                )
                await asyncio.sleep(wait_s)
            else:
                raise
        finally:
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass
        if tool_fallback:
            log.info(
                "llm_call_attempt",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                timeout_sec=timeout_sec,
                approx_request_kb=stats["approx_request_kb"],
                image_blocks=stats["image_blocks"] or None,
                tool_fallback=True,
            )
            heartbeat = asyncio.create_task(_wait_heartbeat())
            attempt_t0 = time.monotonic()
            try:
                resp = await asyncio.wait_for(
                    litellm.acompletion(**kwargs),
                    timeout=timeout_sec,
                )
                break
            except Exception as exc:  # noqa: BLE001
                elapsed_ms = round((time.monotonic() - attempt_t0) * 1000)
                total_ms = round((time.monotonic() - t0) * 1000)
                phase = _error_phase(exc)
                log.warning(
                    "llm_acompletion_error",
                    model=kwargs.get("model"),
                    attempt=attempt,
                    max_attempts=max_attempts,
                    attempt_elapsed_ms=elapsed_ms,
                    total_elapsed_ms=total_ms,
                    timeout_sec=timeout_sec,
                    error_phase=phase,
                    error_type=type(exc).__name__,
                    approx_request_kb=stats["approx_request_kb"],
                    image_blocks=stats["image_blocks"] or None,
                    error=str(exc)[:400],
                    tool_fallback=True,
                )
                if attempt < max_attempts and _is_retryable(exc):
                    wait_s = _RETRY_BACKOFF_SEC * attempt
                    log.warning(
                        "llm_call_retry",
                        model=kwargs.get("model"),
                        next_attempt=attempt + 1,
                        wait_s=wait_s,
                        error_phase=phase,
                    )
                    await asyncio.sleep(wait_s)
                else:
                    raise
            finally:
                heartbeat.cancel()
                try:
                    await heartbeat
                except asyncio.CancelledError:
                    pass

    if resp is None:
        raise RuntimeError("llm_acompletion finished without a response")

    elapsed_ms = round((time.monotonic() - t0) * 1000)
    usage = getattr(resp, "usage", None)
    input_tokens: int = int(getattr(usage, "prompt_tokens", 0) or 0)
    output_tokens: int = int(getattr(usage, "completion_tokens", 0) or 0)
    content = ""
    try:
        content = resp.choices[0].message.content or ""
    except Exception:
        pass
    visible_chars = len(content)
    log.info(
        "llm_acompletion_done",
        model=kwargs.get("model"),
        elapsed_ms=elapsed_ms,
        attempts_used=attempt,
        input_tokens=input_tokens or None,
        output_tokens=output_tokens or None,
        response_chars=visible_chars,
        approx_request_kb=stats["approx_request_kb"],
        image_blocks=stats["image_blocks"] or None,
        response_preview=content[:120].replace("\n", " "),
    )

    if ctx is not None and (input_tokens or output_tokens):
        model_name = str(kwargs.get("model") or "")
        asyncio.ensure_future(
            record_usage(ctx, model_name, input_tokens, output_tokens)
        )

    return resp


async def acompletion_stream_thinking(
    messages: Sequence[Message],
    *,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
    **extra: Any,
) -> Any:
    """Stream completion, logging thinking blocks every 5s in real-time.

    Identical to acompletion() but uses stream=True internally so callers can see
    Claude's reasoning progress via 'scene_match_thinking' log events.
    Returns an assembled response with the same shape as acompletion().
    """
    extra = dict(extra)
    system = extra.pop("system", None)
    msgs = list(messages)

    params = model_params()
    kwargs: dict[str, Any] = {**params, "messages": msgs, "stream": True, **extra}
    if system:
        kwargs["system"] = system
    if params.get("api_key") and not kwargs.get("api_key"):
        kwargs["api_key"] = params["api_key"]

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
            log.warning("llm_usage_check_failed", error=str(exc)[:200])

    stats = _payload_stats(msgs, system)
    timeout_sec = _resolve_timeout_sec(kwargs, stats["image_blocks"])
    kwargs["timeout"] = timeout_sec
    max_retries = int(get_settings().llm_max_retries)
    max_attempts = max_retries + 1

    log.info(
        "llm_acompletion",
        model=kwargs.get("model"),
        api_key_set=bool(kwargs.get("api_key")),
        message_count=len(msgs),
        reasoning_effort=kwargs.get("reasoning_effort"),
        timeout_sec=timeout_sec,
        max_attempts=max_attempts,
        stream_thinking=True,
        vision_image_blocks=stats["image_blocks"] or None,
        approx_request_kb=stats["approx_request_kb"],
    )

    t0 = time.monotonic()
    attempt = 0
    resp: Any = None

    for attempt in range(1, max_attempts + 1):
        attempt_t0 = time.monotonic()
        try:
            log.info(
                "llm_call_attempt",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                stream_thinking=True,
            )

            all_chunks: list[Any] = []
            thinking_chars = 0
            thinking_buf: list[str] = []
            last_thinking_log = time.monotonic()

            stream_iter = await litellm.acompletion(**kwargs)
            async for chunk in stream_iter:
                all_chunks.append(chunk)
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta is None:
                    continue

                # Anthropic streams thinking via delta.reasoning_content (plain str)
                # or delta.thinking_blocks (list of {type, thinking, signature} dicts).
                thinking_text: str = getattr(delta, "reasoning_content", None) or ""
                if not thinking_text:
                    blocks = getattr(delta, "thinking_blocks", None) or []
                    thinking_text = "".join(
                        b.get("thinking", "") for b in blocks if isinstance(b, dict)
                    )
                if thinking_text:
                    thinking_buf.append(thinking_text)
                    thinking_chars += len(thinking_text)
                    now = time.monotonic()
                    if now - last_thinking_log >= 1.0:
                        full_text = "".join(thinking_buf)
                        excerpt = full_text[-300:].replace("\n", " ")
                        log.info(
                            "scene_match_thinking",
                            project_uid=project_uid,
                            elapsed_s=round(now - t0),
                            thinking_chars=thinking_chars,
                            excerpt=excerpt,
                        )
                        if on_thinking is not None:
                            await on_thinking(full_text)
                        last_thinking_log = now

            if thinking_buf:
                full_text = "".join(thinking_buf)
                excerpt = full_text[-300:].replace("\n", " ")
                log.info(
                    "scene_match_thinking",
                    project_uid=project_uid,
                    elapsed_s=round(time.monotonic() - t0),
                    thinking_chars=thinking_chars,
                    excerpt=excerpt,
                )
                if on_thinking is not None:
                    await on_thinking(full_text)

            resp = litellm.stream_chunk_builder(all_chunks, messages=msgs)
            break

        except Exception as exc:  # noqa: BLE001
            elapsed_ms = round((time.monotonic() - attempt_t0) * 1000)
            total_ms = round((time.monotonic() - t0) * 1000)
            phase = _error_phase(exc)
            log.warning(
                "llm_acompletion_error",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                attempt_elapsed_ms=elapsed_ms,
                total_elapsed_ms=total_ms,
                error_phase=phase,
                error_type=type(exc).__name__,
                error=str(exc)[:400],
                stream_thinking=True,
            )
            if attempt < max_attempts and _is_retryable(exc):
                wait_s = _RETRY_BACKOFF_SEC * attempt
                log.warning("llm_call_retry", model=kwargs.get("model"), next_attempt=attempt + 1, wait_s=wait_s)
                await asyncio.sleep(wait_s)
            else:
                raise

    if resp is None:
        raise RuntimeError("acompletion_stream_thinking finished without a response")

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
        attempts_used=attempt,
        input_tokens=input_tokens or None,
        output_tokens=output_tokens or None,
        response_chars=len(content),
        stream_thinking=True,
        response_preview=content[:120].replace("\n", " "),
    )

    if ctx is not None and (input_tokens or output_tokens):
        model_name = str(kwargs.get("model") or "")
        asyncio.ensure_future(record_usage(ctx, model_name, input_tokens, output_tokens))

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
