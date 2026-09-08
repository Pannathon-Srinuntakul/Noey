"""Where files live, and when object storage is considered configured.

Both defaults used to be load-bearing mistakes on a real deployment: `data_root`
pointed inside the container image, and `s3_enabled` demanded an endpoint URL
that plain AWS S3 users never set.
"""
import pathlib

from packages.core.settings import get_settings
from packages.video import s3
from packages.video.storage import data_root


def test_data_root_defaults_to_backend_data(monkeypatch):
    monkeypatch.delenv("DATA_DIR", raising=False)
    get_settings.cache_clear()
    assert data_root().name == "data"
    get_settings.cache_clear()


def test_data_dir_moves_the_whole_store(tmp_path, monkeypatch):
    """The only way a deployment can point uploads and renders at a mounted
    volume — without it, a redeploy takes every user's footage with it."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    assert data_root() == pathlib.Path(tmp_path).resolve()
    get_settings.cache_clear()


def test_s3_is_enabled_on_plain_aws_without_an_endpoint_url(monkeypatch):
    """S3_ENDPOINT_URL is required for R2 and unset on AWS. Testing for it made
    every method a silent no-op on AWS, so files simply were not there later."""
    monkeypatch.setenv("S3_BUCKET", "noey")
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "s")
    monkeypatch.delenv("S3_ENDPOINT_URL", raising=False)
    get_settings.cache_clear()
    assert s3.s3_enabled() is True
    get_settings.cache_clear()


def test_s3_stays_off_when_credentials_are_missing(monkeypatch):
    # Emptied rather than deleted: pydantic-settings still reads the developer's
    # .env behind os.environ, so unsetting the variable does not unset the value.
    monkeypatch.setenv("S3_BUCKET", "noey")
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "")
    get_settings.cache_clear()
    assert s3.s3_enabled() is False
    get_settings.cache_clear()
