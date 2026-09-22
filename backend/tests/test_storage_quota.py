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


def test_allowances_follow_the_website(settings):
    # Owner, 2026-09-22: Free 1 GB, Lite 3, Starter 5, Pro 10, Studio 30,
    # Agency 60, Max 100 — packages/billing/limits.py is the one table.
    gb = {"free": 1, "lite": 3, "starter": 5, "pro": 10, "studio": 30, "agency": 60, "max": 100}
    for plan, size in gb.items():
        assert settings.plan_storage_limit(plan) == size * 1024**3, plan


def test_enterprise_is_unlimited(settings):
    # 0 is the same "unlimited" sentinel the token limits use.
    assert settings.plan_storage_limit("enterprise") == 0


def test_an_unknown_plan_falls_back_to_free(settings):
    # A row carrying a plan this build has never heard of must not get
    # unlimited storage by accident.
    assert settings.plan_storage_limit("legendary") == settings.plan_storage_limit("free")


def test_an_env_override_still_wins_for_one_tier(monkeypatch):
    # The operational escape hatch: PLAN_<TIER>_STORAGE_BYTES overrides one tier.
    monkeypatch.setenv("PLAN_PRO_STORAGE_BYTES", str(7 * 1024**3))
    get_settings.cache_clear()
    try:
        s = get_settings()
        assert s.plan_storage_limit("pro") == 7 * 1024**3
        assert s.plan_storage_limit("studio") == 30 * 1024**3
    finally:
        get_settings.cache_clear()


def test_the_daily_token_settings_are_gone(settings):
    # AI limits are rolling windows in packages/billing/limits.py now.
    assert not hasattr(settings, "plan_token_limit")
    assert not hasattr(settings, "plan_free_monthly_tokens")


async def test_admins_have_unlimited_storage_and_a_full_account_is_refused():
    import uuid

    from fastapi import HTTPException

    from packages.db.session import get_sessionmaker
    from services.api.routers import videos_local
    from tests.admin_helpers import email, make_user, purge

    admin_id = await make_user(email("store"), admin=True, plan="free")
    user_id = await make_user(email("store"), plan="free")
    try:
        async with get_sessionmaker()() as session:
            from packages.db.session import bind_tenant_search_path

            await bind_tenant_search_path(session, "default")
            assert (await videos_local._quota_for(session, admin_id))[0] == 0
            assert (await videos_local._quota_for(session, user_id))[0] == 1024**3
            await videos_local.enforce_storage_quota(session, user_id, 10)  # fits
            try:
                await videos_local.enforce_storage_quota(session, user_id, 2 * 1024**3)
            except HTTPException as exc:
                assert exc.status_code == 507
            else:  # pragma: no cover
                raise AssertionError("an upload over the plan's storage must be refused")
            await videos_local.enforce_storage_quota(session, admin_id, 10**15)  # unlimited
            _ = uuid
    finally:
        await purge()
