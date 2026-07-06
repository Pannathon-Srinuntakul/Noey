"""Build LiteLLM call params from Settings. Provider/model + optional local base URL."""

from __future__ import annotations

import os
from typing import Literal

from packages.core.settings import get_settings

EffortLevel = Literal["low", "medium", "high", "max"]

# Default per-request HTTP timeout (overridden by Settings.llm_*_timeout_sec).
LLM_REQUEST_TIMEOUT_SEC = 300


def _normalize_key(val: str | None) -> str | None:
    if not val:
        return None
    stripped = val.strip()
    return stripped or None


def _key(settings: object, field: str, env_var: str) -> str | None:
    """Read API key from Settings field, with os.environ fallback."""
    val = _normalize_key(getattr(settings, field, None))
    if val:
        return val
    return _normalize_key(os.environ.get(env_var))


def sync_llm_env() -> None:
    """Push Settings API keys into os.environ for LiteLLM secret resolution."""
    import litellm

    s = get_settings()
    pairs = (
        ("anthropic_api_key", "ANTHROPIC_API_KEY"),
        ("openai_api_key", "OPENAI_API_KEY"),
        ("gemini_api_key", "GEMINI_API_KEY"),
    )
    for field, env_var in pairs:
        key = _normalize_key(getattr(s, field, None))
        if key:
            os.environ[env_var] = key
    # Must differ from LiteLLM DEFAULT_REQUEST_TIMEOUT_SECONDS (6000) or chat calls
    # fall back to COMPLETION_HTTP_FALLBACK_SECONDS (600).
    litellm.request_timeout = max(int(s.llm_timeout_sec), int(s.llm_vision_timeout_sec))


def model_supports_effort(model: str) -> bool:
    """True when LiteLLM maps reasoning_effort → output_config for this model."""
    m = model.lower()
    return any(tag in m for tag in (
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-fable-5",
        "claude-mythos-5",
    ))


def _api_key_for_model(model: str, settings: object) -> str | None:
    m = model.lower()
    if "anthropic" in m:
        return _key(settings, "anthropic_api_key", "ANTHROPIC_API_KEY")
    if "openai" in m or "gpt" in m:
        return _key(settings, "openai_api_key", "OPENAI_API_KEY")
    if "gemini" in m:
        return _key(settings, "gemini_api_key", "GEMINI_API_KEY")
    return None


def _with_effort(params: dict, model: str, effort: str | None) -> dict:
    """Attach reasoning_effort when the model supports Claude 4.6 adaptive thinking."""
    if effort and model_supports_effort(model):
        params["reasoning_effort"] = effort
    return params


def model_params() -> dict:
    """Return base kwargs for litellm calls (default model + effort)."""
    sync_llm_env()
    s = get_settings()
    model = s.llm_model
    params: dict = {"model": model}
    if s.llm_base_url:
        params["api_base"] = s.llm_base_url
    key = _api_key_for_model(model, s)
    if key:
        params["api_key"] = key
    params["timeout"] = int(s.llm_timeout_sec)
    return _with_effort(params, model, s.llm_effort)


def call_kwargs(
    *,
    model: str | None = None,
    effort: str | None = None,
) -> dict:
    """Extra kwargs for litellm.acompletion — model override + effort."""
    s = get_settings()
    resolved = model or s.llm_model
    resolved_effort = effort if effort is not None else s.llm_effort
    extra: dict = {}
    if model:
        extra["model"] = model
        key = _api_key_for_model(model, s)
        if key:
            extra["api_key"] = key
    return _with_effort(extra, resolved, resolved_effort)


def vision_call_kwargs() -> dict:
    """Vision-heavy tasks (video scene matching, cut planning)."""
    s = get_settings()
    model = s.llm_vision_model or s.llm_model
    effort = s.llm_vision_effort or "medium"
    extra = call_kwargs(model=model, effort=effort)
    extra["timeout"] = int(s.llm_vision_timeout_sec)
    return extra


def anthropic_file_kwargs() -> dict:
    """Kwargs for litellm.acreate_file / afile_delete on Anthropic Files API."""
    sync_llm_env()
    s = get_settings()
    extra: dict = {"custom_llm_provider": "anthropic"}
    key = _api_key_for_model("anthropic/claude-sonnet-4-6", s)
    if key:
        extra["api_key"] = key
    return extra


def llm_call_extra(
    model: str,
    base_url: str | None = None,
    *,
    web_search_enabled: bool = True,
) -> dict:
    """Extra kwargs for a chat completion (model, optional api_base, web search)."""
    extra: dict = {"model": model}
    if base_url:
        extra["api_base"] = base_url
    if web_search_enabled and model.startswith("anthropic/"):
        # LiteLLM maps this to Anthropic's hosted web_search tool (server-side).
        extra["web_search_options"] = {"search_context_size": "medium"}
    return extra
