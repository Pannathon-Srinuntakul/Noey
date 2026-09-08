"""A real deployment must not run on any of the development secrets."""
import pytest

from packages.core.settings import (
    DEV_ADMIN_PASSWORD,
    DEV_JWT_SECRET,
    InsecureConfiguration,
    assert_production_secrets,
    get_settings,
)

REAL_SECRET = "a-long-random-value-set-by-the-operator"


@pytest.fixture(autouse=True)
def _fresh():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def _other_secrets_set(monkeypatch):
    """Everything EXCEPT the value a test is about, so one failure is isolated."""
    monkeypatch.setenv("POSTGRES_PASSWORD", "a-real-database-password")
    monkeypatch.setenv("ADMIN_PASSWORD", "a-real-admin-password")


def test_local_development_still_starts(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", DEV_JWT_SECRET)
    monkeypatch.setenv("POSTGRES_HOST", "localhost")
    get_settings.cache_clear()
    assert_production_secrets()  # must not raise


def test_a_remote_database_with_the_placeholder_is_refused(monkeypatch, _other_secrets_set):
    """The exact shape of the live deployment found on 2026-09-08.

    JWT_SECRET unset (so the placeholder) while POSTGRES_HOST points at a
    managed database. Anyone who can read this repo could mint a token for any
    account, admin included.
    """
    monkeypatch.setenv("JWT_SECRET", DEV_JWT_SECRET)
    monkeypatch.setenv("POSTGRES_HOST", "containers-us-west-1.railway.app")
    get_settings.cache_clear()
    with pytest.raises(InsecureConfiguration) as exc:
        assert_production_secrets()
    assert "JWT_SECRET" in str(exc.value)


def test_a_real_secret_is_accepted_anywhere(monkeypatch, _other_secrets_set):
    monkeypatch.setenv("JWT_SECRET", REAL_SECRET)
    monkeypatch.setenv("POSTGRES_HOST", "containers-us-west-1.railway.app")
    get_settings.cache_clear()
    assert_production_secrets()


def test_the_placeholder_database_password_is_refused(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", REAL_SECRET)
    monkeypatch.setenv("ADMIN_PASSWORD", "a-real-admin-password")
    monkeypatch.setenv("POSTGRES_PASSWORD", "change_me")
    monkeypatch.setenv("POSTGRES_HOST", "containers-us-west-1.railway.app")
    get_settings.cache_clear()
    with pytest.raises(InsecureConfiguration) as exc:
        assert_production_secrets()
    assert "POSTGRES_PASSWORD" in str(exc.value)


@pytest.mark.parametrize("value", [None, DEV_ADMIN_PASSWORD])
def test_the_seed_admin_password_must_be_set(monkeypatch, value):
    """A fresh production database is seeded by scripts/migrate_to_multitenant
    with is_admin=true. Unset ADMIN_PASSWORD means that account ships with a
    login printed in the repository."""
    monkeypatch.setenv("JWT_SECRET", REAL_SECRET)
    monkeypatch.setenv("POSTGRES_PASSWORD", "a-real-database-password")
    if value is None:
        monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    else:
        monkeypatch.setenv("ADMIN_PASSWORD", value)
    monkeypatch.setenv("POSTGRES_HOST", "containers-us-west-1.railway.app")
    get_settings.cache_clear()
    with pytest.raises(InsecureConfiguration) as exc:
        assert_production_secrets()
    assert "ADMIN_PASSWORD" in str(exc.value)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "postgres", "host.docker.internal"])
def test_container_and_laptop_hosts_count_as_local(monkeypatch, host):
    monkeypatch.setenv("JWT_SECRET", DEV_JWT_SECRET)
    monkeypatch.setenv("POSTGRES_HOST", host)
    get_settings.cache_clear()
    assert_production_secrets()
