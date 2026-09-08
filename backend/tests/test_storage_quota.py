"""The per-plan server storage allowance."""
import pytest

from packages.core.settings import get_settings


@pytest.fixture()
def settings():
    get_settings.cache_clear()
    return get_settings()


def test_every_named_plan_has_a_limit(settings):
    from packages.db.models.core_auth import PLAN_VALUES

    for plan in PLAN_VALUES:
        assert isinstance(settings.plan_storage_limit(plan), int)


def test_default_allowance_is_ten_gb(settings):
    assert settings.plan_storage_limit("free") == 10 * 1024**3


def test_enterprise_is_unlimited(settings):
    # 0 is the same "unlimited" sentinel the token limits use.
    assert settings.plan_storage_limit("enterprise") == 0


def test_an_unknown_plan_falls_back_to_free(settings):
    # A row carrying a plan this build has never heard of must not get
    # unlimited storage by accident.
    assert settings.plan_storage_limit("legendary") == settings.plan_storage_limit("free")


def test_storage_and_token_limits_are_configured_the_same_way(settings):
    # Both are plain settings fields, so both are env-tunable without a deploy.
    assert settings.plan_storage_limit("pro") == settings.plan_pro_storage_bytes
    assert settings.plan_token_limit("pro") == settings.plan_pro_monthly_tokens
