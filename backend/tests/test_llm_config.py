"""LLM config helpers."""

from packages.llm.config import (
    call_kwargs,
    model_supports_effort,
    vision_call_kwargs,
    llm_call_extra,
)


def test_model_supports_effort_claude_46():
    assert model_supports_effort("anthropic/claude-sonnet-4-6")
    assert model_supports_effort("anthropic/claude-opus-4-6")
    assert not model_supports_effort("anthropic/claude-haiku-4-5")


def test_llm_call_extra_anthropic_web_search():
    extra = llm_call_extra("anthropic/claude-sonnet-4-6", web_search_enabled=True)
    assert extra["model"] == "anthropic/claude-sonnet-4-6"
    assert extra["web_search_options"] == {"search_context_size": "medium"}


def test_llm_call_extra_non_anthropic_no_web_search():
    extra = llm_call_extra("ollama/llama3", web_search_enabled=True)
    assert "web_search_options" not in extra


def test_llm_call_extra_web_search_disabled():
    extra = llm_call_extra("anthropic/claude-haiku-4-5", web_search_enabled=False)
    assert "web_search_options" not in extra


def test_call_kwargs_haiku_no_effort(monkeypatch):
    from packages.core.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-haiku-4-5-20251001")
    get_settings.cache_clear()

    extra = call_kwargs()
    assert "reasoning_effort" not in extra


def test_vision_call_kwargs(monkeypatch):
    from packages.core.settings import get_settings

    get_settings.cache_clear()
    monkeypatch.setenv("LLM_MODEL", "anthropic/claude-haiku-4-5-20251001")
    monkeypatch.setenv("LLM_VISION_MODEL", "anthropic/claude-sonnet-4-6")
    monkeypatch.setenv("LLM_VISION_EFFORT", "medium")
    get_settings.cache_clear()

    extra = vision_call_kwargs()
    assert extra["model"] == "anthropic/claude-sonnet-4-6"
    assert extra["reasoning_effort"] == "medium"
    assert extra["timeout"] == 900
