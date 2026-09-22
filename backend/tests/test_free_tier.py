"""Free-tier abuse limits (packages/billing/free_tier.py) and the sign-up side."""

import pytest
from sqlalchemy import text

from packages.billing import free_tier
from packages.core.settings import get_settings
from packages.db.session import get_engine
from tests.admin_helpers import DOMAIN, _admin_env, client  # noqa: F401


async def test_three_free_accounts_per_ip_then_refused():
    for uid in (1, 2, 3):
        await free_tier.check_start(user_id=uid, ip="203.0.113.7", device=None)
    await free_tier.check_start(user_id=2, ip="203.0.113.7", device=None)  # a known one is fine
    with pytest.raises(free_tier.FreeTierLimited) as exc:
        await free_tier.check_start(user_id=4, ip="203.0.113.7", device=None)
    assert exc.value.reason == "ip_accounts"
    await free_tier.check_start(user_id=4, ip="198.51.100.1", device=None)  # another network


async def test_the_device_id_is_limited_the_same_way():
    for uid in (1, 2, 3):
        await free_tier.check_start(user_id=uid, ip=None, device="dev-abc")
    with pytest.raises(free_tier.FreeTierLimited) as exc:
        await free_tier.check_start(user_id=9, ip=f"10.0.0.{9}", device="dev-abc")
    assert exc.value.reason == "device_accounts"


async def test_free_runs_per_ip_per_day(monkeypatch):
    monkeypatch.setenv("FREE_RUNS_PER_IP_DAY", "2")
    get_settings.cache_clear()
    for _ in range(2):
        await free_tier.check_start(user_id=1, ip="192.0.2.1", device=None)
        await free_tier.count_run(ip="192.0.2.1", device=None)
    with pytest.raises(free_tier.FreeTierLimited) as exc:
        await free_tier.check_start(user_id=1, ip="192.0.2.1", device=None)
    assert exc.value.reason == "ip_runs"


async def test_checking_does_not_count_a_run(monkeypatch):
    """Only a start that got its reservation counts (billing_start calls
    count_run after runs.reserve) — a refused start leaves the allowance."""
    monkeypatch.setenv("FREE_RUNS_PER_IP_DAY", "1")
    get_settings.cache_clear()
    for _ in range(5):
        await free_tier.check_start(user_id=1, ip="192.0.2.9", device="dev-9")
    await free_tier.count_run(ip="192.0.2.9", device="dev-9")
    with pytest.raises(free_tier.FreeTierLimited):
        await free_tier.check_start(user_id=1, ip="192.0.2.9", device=None)
    with pytest.raises(free_tier.FreeTierLimited):
        await free_tier.check_start(user_id=1, ip=None, device="dev-9")


async def test_a_dead_store_fails_open(monkeypatch):
    class Dead:
        async def admit_member(self, *a):
            return None

        async def incr(self, *a):
            return None

        async def get_count(self, *a):
            return None

    monkeypatch.setattr(free_tier, "_store", Dead())
    for uid in range(20):
        await free_tier.check_start(user_id=uid, ip="203.0.113.99", device="d")
        await free_tier.count_run(ip="203.0.113.99", device="d")


def test_identities_are_salted_hashes_never_raw():
    h = free_tier.identity_hash("203.0.113.7")
    assert h and len(h) == 64 and "203" not in h
    assert free_tier.identity_hash("203.0.113.7") == h
    assert free_tier.identity_hash("") is None and free_tier.identity_hash(None) is None


async def test_signup_is_limited_per_ip_per_day_and_stores_only_hashes(monkeypatch):
    monkeypatch.setenv("ALLOW_REGISTRATION", "true")
    monkeypatch.setenv("TURNSTILE_SECRET_KEY", "")
    get_settings.cache_clear()
    codes = []
    async with client() as c:
        for i in range(6):
            r = await c.post(
                "/auth/register",
                json={"email": f"daily{i}-{id(codes)}@{DOMAIN}", "password": "correct horse battery 9"},
                headers={"X-Noey-Device": "device-123"},
            )
            codes.append(r.status_code)
    assert codes == [201] * 5 + [429]
    async with get_engine().begin() as conn:
        rows = (
            await conn.execute(
                text("SELECT signup_ip_hash, signup_device_hash FROM core.users WHERE email LIKE :p"),
                {"p": f"daily%-{id(codes)}@{DOMAIN}"},
            )
        ).all()
    assert len(rows) == 5
    assert {r[0] for r in rows} == {free_tier.identity_hash("127.0.0.1")}
    assert {r[1] for r in rows} == {free_tier.identity_hash("device-123")}
