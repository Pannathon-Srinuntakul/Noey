"""Direct-to-bucket uploads: `POST /videos/{uid}/uploads` signs a PUT, the
browser writes the object, `POST /videos/{uid}/uploads/complete` checks what
landed. The bucket itself is faked at the `s3` module boundary — these tests
are about the contract (path safety, quota, fallback), not about boto3.
"""

from __future__ import annotations

import shutil

import pytest

from packages.video import s3
from packages.video.storage import data_root
from services.api.routers import videos_local
from tests.admin_helpers import (  # noqa: F401
    _admin_env,
    bearer,
    client,
    email,
    make_user,
    purge,
    user_token,
)


class FakeBucket:
    """What the route sees of the bucket: the objects and the URLs it signs."""

    def __init__(self) -> None:
        self.objects: dict[str, int] = {}
        self.signed: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def upload_url(uid: str, rel: str, content_type: str, expires: int = 900) -> str:
            self.signed.append((rel, content_type))
            return f"https://bucket.test/videos/{uid}/outputs/{rel}?sig=1&ttl={expires}"

        async def object_size(uid: str, rel: str) -> int | None:
            return self.objects.get(rel)

        async def delete_output_file(uid: str, rel: str) -> None:
            self.deleted.append(rel)
            self.objects.pop(rel, None)

        async def list_output_files(uid: str) -> list[tuple[str, int]]:
            return list(self.objects.items())

        monkeypatch.setattr(videos_local, "output_upload_url", upload_url)
        monkeypatch.setattr(videos_local, "output_object_size", object_size)
        monkeypatch.setattr(videos_local, "delete_output_file", delete_output_file)
        monkeypatch.setattr(videos_local, "list_output_files", list_output_files)


@pytest.fixture
def bucket(monkeypatch):
    b = FakeBucket()
    b.install(monkeypatch)
    # The quota walk caches per user for a while; every test wants a fresh count.
    monkeypatch.setattr(videos_local, "_USED_LAST", {})
    monkeypatch.setattr(videos_local, "_USED_CACHE", {})
    return b


async def _project(c, token: str) -> str:
    r = await c.post(
        "/videos/local",
        json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
        headers=bearer(token),
    )
    assert r.status_code == 201, r.text
    return r.json()["uid"]


def _cleanup(uid: str) -> None:
    shutil.rmtree(data_root() / "video_outputs" / uid, ignore_errors=True)


async def test_signs_a_put_for_an_allowed_path_and_confirms_what_landed(bucket):
    user = await make_user(email("direct"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "normalized/norm_000.mp4", "bytes": 527_000_000, "content_type": "video/mp4"},
                headers=bearer(token),
            )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["method"] == "PUT"
            assert body["url"].startswith("https://bucket.test/")
            assert body["headers"] == {"Content-Type": "video/mp4"}
            assert body["expires_in"] == videos_local._UPLOAD_URL_TTL_SEC
            assert bucket.signed == [("normalized/norm_000.mp4", "video/mp4")]

            # The browser wrote the object; complete reports its real size.
            bucket.objects["normalized/norm_000.mp4"] = 527_000_000
            r = await c.post(
                f"/videos/{uid}/uploads/complete",
                json={"path": "normalized/norm_000.mp4"},
                headers=bearer(token),
            )
            assert r.status_code == 200, r.text
            assert r.json() == {"path": "normalized/norm_000.mp4", "bytes": 527_000_000}
            # ...and the manifest a fresh browser reads now lists it.
            r = await c.get(f"/videos/{uid}/files", headers=bearer(token))
            assert {"path": "normalized/norm_000.mp4", "bytes": 527_000_000} in r.json()
        finally:
            _cleanup(uid)
            await purge()


async def test_refuses_paths_the_file_store_refuses(bucket):
    user = await make_user(email("direct"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            for bad in ("../../etc/passwd", "secrets.env", "normalized/.part"):
                r = await c.post(
                    f"/videos/{uid}/uploads",
                    json={"path": bad, "bytes": 10},
                    headers=bearer(token),
                )
                assert r.status_code == 400, bad
            assert bucket.signed == []
        finally:
            _cleanup(uid)
            await purge()


async def test_someone_elses_project_is_a_404(bucket):
    owner = await make_user(email("direct"), plan="pro")
    other = await make_user(email("direct"), plan="pro")
    async with client() as c:
        uid = await _project(c, await user_token(owner))
        try:
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "final_silent.mp4", "bytes": 10},
                headers=bearer(await user_token(other)),
            )
            assert r.status_code == 404
        finally:
            _cleanup(uid)
            await purge()


async def test_no_bucket_means_the_client_falls_back(bucket, monkeypatch):
    async def no_url(uid: str, rel: str, content_type: str, expires: int = 900) -> None:
        return None

    monkeypatch.setattr(videos_local, "output_upload_url", no_url)
    user = await make_user(email("direct"), plan="pro")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "final_silent.mp4", "bytes": 10},
                headers=bearer(token),
            )
            assert r.status_code == 409
            assert r.json()["detail"]["code"] == "direct_upload_unavailable"
        finally:
            _cleanup(uid)
            await purge()


async def test_the_plan_is_checked_before_and_after(bucket):
    """Free = 1 GB. A declared 2 GB is refused before a byte moves; an object
    that turns out over the line after the fact is deleted again."""
    user = await make_user(email("direct"), plan="free")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "normalized/norm_000.mp4", "bytes": 2 * 1024**3},
                headers=bearer(token),
            )
            assert r.status_code == 507
            assert bucket.signed == []

            # Declared small, landed huge: the browser lied (or appended).
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "normalized/norm_000.mp4", "bytes": 10},
                headers=bearer(token),
            )
            assert r.status_code == 200
            bucket.objects["normalized/norm_000.mp4"] = 2 * 1024**3
            r = await c.post(
                f"/videos/{uid}/uploads/complete",
                json={"path": "normalized/norm_000.mp4"},
                headers=bearer(token),
            )
            assert r.status_code == 507
            assert bucket.deleted == ["normalized/norm_000.mp4"]
            assert "normalized/norm_000.mp4" not in bucket.objects
        finally:
            _cleanup(uid)
            await purge()


async def test_complete_without_an_object_is_a_404_and_drops_a_stale_disk_copy(bucket):
    user = await make_user(email("direct"), plan="free")
    token = await user_token(user)
    async with client() as c:
        uid = await _project(c, token)
        try:
            r = await c.post(
                f"/videos/{uid}/uploads/complete",
                json={"path": "final_silent.mp4"},
                headers=bearer(token),
            )
            assert r.status_code == 404

            # An older PUT left a disk copy; after a direct upload it would
            # shadow the new object on GET, so complete removes it.
            stale = videos_local._web_file_path(uid, "final_silent.mp4")
            stale.parent.mkdir(parents=True, exist_ok=True)
            stale.write_bytes(b"old" * 100)
            bucket.objects["final_silent.mp4"] = 4_000
            r = await c.post(
                f"/videos/{uid}/uploads/complete",
                json={"path": "final_silent.mp4"},
                headers=bearer(token),
            )
            assert r.status_code == 200
            assert r.json()["bytes"] == 4_000
            assert not stale.exists()

            # Within the cache window the next check already counts this file:
            # free plan = 1 GB, so 1 GB more on top of the 4 KB is refused.
            r = await c.post(
                f"/videos/{uid}/uploads",
                json={"path": "normalized/norm_000.mp4", "bytes": 1024**3},
                headers=bearer(token),
            )
            assert r.status_code == 507
        finally:
            _cleanup(uid)
            await purge()


def test_upload_origin_is_the_virtual_hosted_bucket(monkeypatch):
    from packages.core.settings import get_settings

    monkeypatch.setenv("S3_BUCKET", "noey-media")
    monkeypatch.setenv("S3_ENDPOINT_URL", "https://t3.storageapi.dev")
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "k")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "s")
    get_settings.cache_clear()
    try:
        assert s3.upload_origin() == "https://noey-media.t3.storageapi.dev"
        # Empty, not unset: the repo's .env would fill an unset one back in.
        monkeypatch.setenv("S3_ENDPOINT_URL", "")
        monkeypatch.setenv("S3_REGION", "ap-southeast-1")
        get_settings.cache_clear()
        assert s3.upload_origin() == "https://noey-media.s3.ap-southeast-1.amazonaws.com"
    finally:
        get_settings.cache_clear()
