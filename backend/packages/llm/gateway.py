"""Provider-agnostic LLM gateway over LiteLLM.

THE ONLY place the project talks to a model. No vendor SDK is imported elsewhere.
Supports cloud (Claude/OpenAI/Gemini/…) and local (Ollama/vLLM/OpenAI-compatible)
via config. Tool/function calling is normalized by LiteLLM; we add a graceful
no-tools fallback for models that don't support tool calling.

Usage tracking: if a UsageCtx is set via set_usage_ctx(), each call automatically:
  1. Re-checks that the account may use paid AI at all (verified email — the
     defense in depth behind services/api/ai_gate.py; HTTP 403).
  2. Before EVERY attempt, asks the per-call guard (packages/billing/guard.py)
     whether the call still fits the paid run's ceiling and the daily circuit
     breaker; a call that does not is never sent (``RunBudgetExceeded`` /
     ``ServicePaused``). Plan limits themselves are checked once, at job start
     (packages/billing/runs.py), not here.
  3. Waits for a cross-process vendor slot (packages/billing/vendor_limits.py).
  4. Records EVERY attempt that reached the vendor — ok, failed, or failed and
     retried — to core.llm_usage_logs, awaited and durable
     (packages/billing/metering.py): each one is a request we pay for. Only a
     connection error (the request never left) is not recorded.

Billing hints a call site may pass (popped here, never sent to the provider):
``billing_video_sec`` — total seconds of every video file the request attaches
(measured on the server) — with ``billing_video_precision`` (``standard`` /
``high``, the sampling density it asks for), or ``billing_input_tokens`` when
it knows the whole input count better than a local count.

Output cap: for a request that sets no ``max_tokens`` of its own, the guard
returns the output the paid run can still afford and it is sent as
``max_tokens``; an answer cut off there (``finish_reason == "length"``) stops
the run as ``limit_stop`` (packages/billing/guard.py). An attempt cancelled
mid-flight (worker restart, job timeout) is still recorded — with the usage
streamed so far, else its input estimate — before the cancellation goes on.
"""

import asyncio
import time
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import litellm
from fastapi import HTTPException

from packages.billing import guard, vendor_limits
from packages.billing.metering import record_llm_attempt
from packages.core.logging import get_logger
from packages.core.settings import get_settings
from packages.llm import fake
from packages.llm.config import model_params
from packages.llm.usage import (
    EmailNotVerified,
    UsageCtx,
    check_ai_access,
    extract_cached_tokens,
    extract_stream_cached_from_chunks,
    extract_stream_usage_from_chunks,
    extract_usage_tokens,
    get_usage_ctx,
    merge_provider_usage,
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


#: Failures after which the request may still have been billed although the
#: vendor reported no usage.
_TIMEOUT_PHASES = frozenset({"hard_timeout", "timeout"})


def _billing_hints(extra: dict[str, Any]) -> dict[str, Any]:
    """Pop the billing-only kwargs (never sent to the provider)."""
    return {
        "input_tokens": extra.pop("billing_input_tokens", None),
        "video_sec": extra.pop("billing_video_sec", None),
        "video_precision": extra.pop("billing_video_precision", None),
    }


def _finish_reason(resp: Any) -> str | None:
    try:
        return getattr(resp.choices[0], "finish_reason", None)
    except (AttributeError, IndexError, TypeError):
        return None


def _is_retryable(exc: BaseException) -> bool:
    phase = _error_phase(exc)
    return phase in {"connection", "timeout", "hard_timeout", "upstream_5xx", "rate_limit"}


async def _record_failed_attempt(
    ctx: UsageCtx | None,
    model: str,
    exc: BaseException,
    *,
    retried: bool,
    chunks: Sequence[Any] | None = None,
) -> int:
    """Record an attempt that raised — it still reached the vendor and may be billed.

    Usage comes from whatever the vendor reported before failing (stream
    chunks already received, or a ``usage`` the exception carries); none →
    a zero row that proves the request without claiming a cost. A connection
    error never left this machine, so it is not a vendor request at all.
    """
    if ctx is None or _error_phase(exc) == "connection":
        return 0
    inp = out = cached = 0
    if chunks:
        inp, out = extract_stream_usage_from_chunks(chunks)
        cached = extract_stream_cached_from_chunks(chunks)
    else:
        usage = getattr(exc, "usage", None)
        inp, out = extract_usage_tokens(usage)
        cached = extract_cached_tokens(usage)
    return await record_llm_attempt(
        ctx, model=model, status="retry" if retried else "failed",
        input_tokens=inp, cached_tokens=cached, output_tokens=out,
    )


async def _check_access(ctx: UsageCtx | None) -> None:
    """Verified-email gate before any model call (defense in depth)."""
    if ctx is None:
        return
    try:
        await check_ai_access(ctx)
    except EmailNotVerified as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — a lookup hiccup must not fail the call
        log.warning("llm_access_check_failed", error=str(exc)[:200])


async def _admit_attempt(
    model: str,
    msgs: Sequence[Message],
    kwargs: dict[str, Any],
    hints: dict[str, Any],
    caller_sets_max: bool,
) -> guard.Admission:
    """Per-call guard + vendor slot, before an attempt is sent. Returns what
    was admitted (release it with ``guard.after_llm_call``). Applies the
    guard's output cap as ``max_tokens`` unless the call site set its own —
    and drops a cap an earlier attempt set, so it is not read as the call's."""
    if not caller_sets_max:
        kwargs.pop("max_tokens", None)
    adm = await guard.before_llm_call(model, msgs, kwargs, **hints)
    vendor_tokens = adm.input_tokens or (
        hints["input_tokens"] if hints["input_tokens"] is not None else guard.count_text_tokens(msgs)
    )
    try:
        await vendor_limits.acquire_gemini(model, vendor_tokens)
    except BaseException:
        guard.after_llm_call(adm.budget, 0)
        raise
    if adm.max_tokens is not None and not caller_sets_max:
        kwargs["max_tokens"] = adm.max_tokens
    return adm


def _settle_failed(adm: guard.Admission, exc: BaseException, charged: int) -> None:
    """Release a failed attempt's budget. A TIMED-OUT attempt the vendor gave
    no usage for still counts its input against the run's ceiling (the request
    was sent and may be billed), so N timed-out retries cannot each be
    admitted at the full budget."""
    if not charged and _error_phase(exc) in _TIMEOUT_PHASES:
        guard.after_llm_call(adm.budget, adm.input_charge)
    else:
        guard.after_llm_call(adm.budget, charged)


async def _record_cancelled(
    ctx: UsageCtx | None, model: str, adm: guard.Admission, chunks: Sequence[Any] | None = None
) -> None:
    """An attempt cancelled mid-flight (worker SIGTERM on deploy, arq's job
    timeout). The vendor bills the request and whatever it already streamed,
    so it is recorded — with the streamed usage, else the admitted input
    estimate — before the cancellation propagates. Never raises."""
    inp = out = cached = 0
    if chunks:
        inp, out = extract_stream_usage_from_chunks(chunks)
        cached = extract_stream_cached_from_chunks(chunks)
    if not inp:
        inp = adm.input_tokens
    charged = 0
    try:
        charged = await asyncio.shield(record_llm_attempt(
            ctx, model=model, status="cancelled", input_tokens=inp, cached_tokens=cached, output_tokens=out,
        ))
    except (Exception, asyncio.CancelledError) as exc:  # noqa: BLE001 — must not mask the cancel
        log.warning("llm_cancelled_record_failed", error=str(exc)[:200])
    guard.after_llm_call(adm.budget, charged or adm.input_charge)
    log.warning("llm_call_cancelled", model=model, input_tokens=inp, output_tokens=out)


async def _vendor_acompletion(kwargs: dict[str, Any], adm: guard.Admission) -> Any:
    """The one line that reaches a model vendor. Under LOADTEST_FAKE_AI a
    canned answer is returned after a simulated delay instead
    (packages/llm/fake.py) — everything before and after this call (guard,
    vendor slot, metering) runs for real either way."""
    if fake.active():
        return await fake.acompletion(kwargs, input_estimate=adm.input_tokens or None)
    return await litellm.acompletion(**kwargs)


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
    hints = _billing_hints(extra)
    # Gemini (and OpenAI-compat) only honor system via messages[role=system].
    # A top-level litellm `system=` kwarg is Anthropic-shaped and is silently
    # dropped for Gemini — observed as ~30 input_tokens on a 12k-char system
    # prompt (effects codegen wrote random React/HTML instead of Remotion).
    # Always inject as a system message so every provider sees it.
    msgs = list(messages)
    if system:
        msgs = [{"role": "system", "content": system}, *msgs]

    params = model_params()
    kwargs: dict[str, Any] = {**params, "messages": msgs, "stream": stream, **extra}
    if params.get("api_key") and not kwargs.get("api_key"):
        kwargs["api_key"] = params["api_key"]
    if tools:
        kwargs["tools"] = tools

    ctx = get_usage_ctx()
    await _check_access(ctx)
    caller_sets_max = bool(kwargs.get("max_tokens") or kwargs.get("max_completion_tokens"))

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

    adm = guard.Admission()
    for attempt in range(1, max_attempts + 1):
        adm = await _admit_attempt(str(kwargs.get("model") or ""), msgs, kwargs, hints, caller_sets_max)
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
                _vendor_acompletion(kwargs, adm),
                timeout=timeout_sec,
            )
            break
        except asyncio.CancelledError:
            await _record_cancelled(ctx, str(kwargs.get("model") or ""), adm)
            raise
        except Exception as exc:
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
            model_name = str(kwargs.get("model") or "")
            if tools and _looks_like_tool_unsupported(exc):
                log.warning("llm_tools_unsupported_fallback", model=kwargs.get("model"))
                _settle_failed(adm, exc, await _record_failed_attempt(ctx, model_name, exc, retried=True))
                kwargs.pop("tools", None)
                tools = None
                tool_fallback = True
            elif attempt < max_attempts and _is_retryable(exc):
                _settle_failed(adm, exc, await _record_failed_attempt(ctx, model_name, exc, retried=True))
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
                _settle_failed(adm, exc, await _record_failed_attempt(ctx, model_name, exc, retried=False))
                raise
        finally:
            heartbeat.cancel()
            try:
                await heartbeat
            except asyncio.CancelledError:
                pass
        if tool_fallback:
            adm = await _admit_attempt(str(kwargs.get("model") or ""), msgs, kwargs, hints, caller_sets_max)
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
                    _vendor_acompletion(kwargs, adm),
                    timeout=timeout_sec,
                )
                break
            except asyncio.CancelledError:
                await _record_cancelled(ctx, str(kwargs.get("model") or ""), adm)
                raise
            except Exception as exc:
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
                retry_next = attempt < max_attempts and _is_retryable(exc)
                _settle_failed(adm, exc, await _record_failed_attempt(
                    ctx, str(kwargs.get("model") or ""), exc, retried=retry_next
                ))
                if retry_next:
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
    input_tokens, output_tokens = extract_usage_tokens(usage)
    cached_tokens = extract_cached_tokens(usage)
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

    # Awaited, not fire-and-forget: a row that silently fails to land is
    # vendor cost nobody can attribute (metering retries, then outboxes).
    charged = await record_llm_attempt(
        ctx, model=str(kwargs.get("model") or ""), status="ok",
        input_tokens=input_tokens, cached_tokens=cached_tokens, output_tokens=output_tokens,
    )
    guard.after_llm_call(adm.budget, charged)
    if adm.max_tokens is not None and not caller_sets_max and _finish_reason(resp) == "length":
        guard.output_truncated()

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
    hints = _billing_hints(extra)
    # See acompletion(): Gemini ignores top-level `system=`; inject as message.
    msgs = list(messages)
    if system:
        msgs = [{"role": "system", "content": system}, *msgs]

    params = model_params()
    kwargs: dict[str, Any] = {**params, "messages": msgs, "stream": True, **extra}
    if params.get("api_key") and not kwargs.get("api_key"):
        kwargs["api_key"] = params["api_key"]
    stream_opts = dict(kwargs.get("stream_options") or {})
    stream_opts["include_usage"] = True
    kwargs["stream_options"] = stream_opts

    ctx = get_usage_ctx()
    await _check_access(ctx)
    caller_sets_max = bool(kwargs.get("max_tokens") or kwargs.get("max_completion_tokens"))

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
        stream_include_usage=True,
        vision_image_blocks=stats["image_blocks"] or None,
        approx_request_kb=stats["approx_request_kb"],
    )

    t0 = time.monotonic()
    attempt = 0
    resp: Any = None
    all_chunks: list[Any] = []
    adm = guard.Admission()

    for attempt in range(1, max_attempts + 1):
        adm = await _admit_attempt(str(kwargs.get("model") or ""), msgs, kwargs, hints, caller_sets_max)
        attempt_t0 = time.monotonic()
        try:
            log.info(
                "llm_call_attempt",
                model=kwargs.get("model"),
                attempt=attempt,
                max_attempts=max_attempts,
                stream_thinking=True,
            )

            all_chunks = []
            thinking_chars = 0
            thinking_buf: list[str] = []
            last_thinking_log = time.monotonic()

            stream_iter = await _vendor_acompletion(kwargs, adm)
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

        except asyncio.CancelledError:
            await _record_cancelled(ctx, str(kwargs.get("model") or ""), adm, all_chunks)
            raise
        except Exception as exc:
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
            retry_next = attempt < max_attempts and _is_retryable(exc)
            _settle_failed(adm, exc, await _record_failed_attempt(
                ctx, str(kwargs.get("model") or ""), exc, retried=retry_next, chunks=all_chunks,
            ))
            if retry_next:
                wait_s = _RETRY_BACKOFF_SEC * attempt
                log.warning("llm_call_retry", model=kwargs.get("model"), next_attempt=attempt + 1, wait_s=wait_s)
                await asyncio.sleep(wait_s)
            else:
                raise

    if resp is None:
        raise RuntimeError("acompletion_stream_thinking finished without a response")

    elapsed_ms = round((time.monotonic() - t0) * 1000)
    chunk_usage = extract_stream_usage_from_chunks(all_chunks)
    built_usage = extract_usage_tokens(getattr(resp, "usage", None))
    input_tokens, output_tokens = merge_provider_usage(chunk_usage, built_usage)
    cached_tokens = max(
        extract_stream_cached_from_chunks(all_chunks),
        extract_cached_tokens(getattr(resp, "usage", None)),
    )
    if input_tokens == 0 and output_tokens > 0:
        log.warning(
            "llm_stream_usage_missing_prompt",
            model=kwargs.get("model"),
            output_tokens=output_tokens,
            chunk_count=len(all_chunks),
            built_input=built_usage[0],
            chunk_input=chunk_usage[0],
        )
    content = ""
    try:
        content = resp.choices[0].message.content or ""
    except Exception:
        pass

    usage_obj = getattr(resp, "usage", None)
    if usage_obj is not None and (input_tokens or output_tokens):
        try:
            usage_obj.prompt_tokens = input_tokens
            usage_obj.completion_tokens = output_tokens
            usage_obj.total_tokens = input_tokens + output_tokens
        except Exception:  # noqa: BLE001
            pass

    log.info(
        "llm_acompletion_done",
        model=kwargs.get("model"),
        elapsed_ms=elapsed_ms,
        attempts_used=attempt,
        input_tokens=input_tokens or None,
        output_tokens=output_tokens or None,
        chunk_input_tokens=chunk_usage[0] or None,
        chunk_output_tokens=chunk_usage[1] or None,
        response_chars=len(content),
        stream_thinking=True,
        response_preview=content[:120].replace("\n", " "),
    )

    charged = await record_llm_attempt(
        ctx, model=str(kwargs.get("model") or ""), status="ok",
        input_tokens=input_tokens, cached_tokens=cached_tokens, output_tokens=output_tokens,
    )
    guard.after_llm_call(adm.budget, charged)
    if adm.max_tokens is not None and not caller_sets_max and _finish_reason(resp) == "length":
        guard.output_truncated()

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
