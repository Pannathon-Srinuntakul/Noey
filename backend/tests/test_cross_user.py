"""No route under ``/videos/{uid}`` or ``/effect-styles/{uid}`` tells user B
anything about user A's project or style.

The route list comes from the app itself (the same walk
tests/test_admin_security.py does for ``/admin``), so a new uid route is
covered the moment it is registered. Each one is called by B, with a body
that passes the framework's validation, against a uid that is A's — and must
answer 404 (or a plan 403), never 200 and never a 422 that only a real
resource could have produced. B is put in A's tenant first (seeded and
legacy accounts share tenant ``default``), so "same tenant" is no protection
in the test either; ownership is the only line.
"""

from __future__ import annotations

import json
import shutil

import pytest
from fastapi import params

from packages.core.settings import get_settings
from packages.db.session import bind_tenant_search_path, get_sessionmaker
from packages.video.storage import data_root
from services.api.main import app
from services.api.routers import videos_local
from tests.admin_helpers import (  # noqa: F401  (fixtures)
    _admin_env,
    bearer,
    client,
    db,
    email,
    make_user,
    user_token,
)
from tests.media_helpers import video_bytes


def _all_routes() -> list[tuple[str, str, object]]:
    out: list[tuple[str, str, object]] = []

    def walk(routes) -> None:  # type: ignore[no-untyped-def]
        for r in routes:
            inner = getattr(r, "original_router", None) or getattr(r, "routes", None)
            if inner is not None:
                walk(getattr(inner, "routes", inner))
                continue
            path, methods = getattr(r, "path", None), getattr(r, "methods", None)
            if isinstance(path, str) and methods:
                out.extend((m, path, r) for m in sorted(methods) if m != "HEAD")

    walk(app.routes)
    return out


UID_ROUTES = sorted(
    (m, p, r) for m, p, r in _all_routes()
    if "{uid}" in p and p.startswith(("/videos/", "/effect-styles/"))
)

#: JSON bodies that pass validation for the routes that take one. Anything
#: not listed gets ``{}``. The point is to get PAST the framework's 422 so the
#: answer is the route's own.
JSON_BODIES: dict[tuple[str, str], dict] = {
    ("PATCH", "/videos/{uid}/local-status"): {"status": "done"},
    ("POST", "/videos/{uid}/plan-dub"): {"voDurationSec": 1, "clipDurations": [1]},
    ("POST", "/videos/{uid}/uploads"): {"path": "project.json", "bytes": 1},
    ("POST", "/videos/{uid}/uploads/complete"): {"path": "project.json"},
    ("PUT", "/videos/{uid}/edit-timeline"): {"cuts": []},
}


def test_the_walk_found_the_routes_it_is_meant_to_guard():
    paths = {(m, p) for m, p, _r in UID_ROUTES}
    assert len(paths) >= 35, sorted(paths)
    for must in (
        ("GET", "/videos/{uid}"), ("DELETE", "/videos/{uid}"),
        ("POST", "/videos/{uid}/analyze-video"), ("POST", "/videos/{uid}/plan-effects"),
        ("GET", "/videos/{uid}/files/{rel:path}"), ("PUT", "/videos/{uid}/files/{rel:path}"),
        ("GET", "/effect-styles/{uid}"), ("POST", "/effect-styles/{uid}/regenerate"),
    ):
        assert must in paths, must


def _concrete(path: str, uid: str) -> str:
    out = path.replace("{uid}", uid).replace("{rel:path}", "project.json")
    if path.endswith(("source-url", "source-file")):
        out += "?source=clip0"
    return out


def _multipart(route) -> tuple[dict, list]:  # type: ignore[no-untyped-def]
    """A form + files set that satisfies every REQUIRED multipart field."""
    data: dict[str, str] = {}
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for f in route.dependant.body_params:
        if not f.field_info.is_required():
            continue
        if isinstance(f.field_info, params.File):
            files.append((f.name, ("p.mp4", video_bytes(1), "video/mp4")))
        elif isinstance(f.field_info, params.Form):
            data[f.name] = "[]" if f.name.endswith("manifest") else "x"
    return data, files


async def _send(c, method: str, path: str, route, headers: dict[str, str]):  # type: ignore[no-untyped-def]
    body_params = list(route.dependant.body_params)
    is_multipart = any(isinstance(f.field_info, (params.File, params.Form)) for f in body_params)
    if is_multipart:
        data, files = _multipart(route)
        return await c.request(method, path, headers=headers, data=data, files=files)
    if body_params:
        key = (method, route.path)
        return await c.request(method, path, headers=headers, json=JSON_BODIES.get(key, {}))
    return await c.request(method, path, headers=headers)


async def _make_style(user_id: int, uid: str) -> None:
    from packages.db.models.effect_style import EffectStyle

    async with get_sessionmaker()() as session:
        await bind_tenant_search_path(session, "default")
        session.add(EffectStyle(
            uid=uid, user_id=user_id, tenant_slug="default", kind="effects",
            name="A's", description="fast", status="ready", system_prompt="zoom",
        ))
        await session.commit()


async def _same_tenant_token(user_id: int, owner_id: int) -> str:
    """A token for ``user_id`` INSIDE ``owner_id``'s tenant.

    Self-service accounts each get a tenant of their own, so in a test made
    of two fresh accounts the tenant check alone would already separate them
    and prove nothing. Seeded and legacy accounts share tenant ``default``;
    this puts B in A's tenant the way those are, so the only thing between
    B and A's rows is the ownership check.
    """
    from packages.auth.tokens import encode_access

    row = await db(
        "SELECT t.id, t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id "
        "WHERE m.user_id = :u", u=owner_id,
    )
    tenant_id, slug = int(row[0][0]), str(row[0][1])
    await db(
        "INSERT INTO core.memberships (user_id, tenant_id, role) VALUES (:u, :t, 'member') "
        "ON CONFLICT DO NOTHING", u=user_id, t=tenant_id,
    )
    tv = await db("SELECT token_version FROM core.users WHERE id = :u", u=user_id)
    return encode_access(user_id, tenant_id, slug, int(tv[0][0]))


@pytest.fixture
def two_users(monkeypatch):
    """A owns a local project and a style; B is another ordinary account on
    the same plan (so a 403 can only ever be the plan, never the owner) and
    in the same tenant (so the tenant is no protection either)."""
    monkeypatch.setenv("REQUIRE_VERIFIED_EMAIL_FOR_AI", "false")
    get_settings.cache_clear()

    async def fake_enqueue(job_id, fn, **kwargs):
        pass

    monkeypatch.setattr(videos_local, "_enqueue", fake_enqueue)
    yield


async def test_every_uid_route_answers_another_user_with_not_found(two_users):
    a = await make_user(email("owner"), plan="pro")
    b = await make_user(email("other"), plan="pro")
    a_token, b_token = await user_token(a), await _same_tenant_token(b, a)
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
            headers=bearer(a_token),
        )
        assert r.status_code == 201, r.text
        project = r.json()["uid"]
        style = f"style-{project[:8]}"
        await _make_style(a, style)
        try:
            # A can see both — proving the denials below are about ownership.
            assert (await c.get(f"/videos/{project}", headers=bearer(a_token))).status_code == 200
            assert (await c.get(f"/effect-styles/{style}", headers=bearer(a_token))).status_code == 200

            leaks: list[tuple[str, str, int, str]] = []
            for method, path, route in UID_ROUTES:
                uid = style if path.startswith("/effect-styles") else project
                # DELETE last: the walk is sorted, so the deletes come first —
                # and B deleting A's project must be a 404 like everything else.
                resp = await _send(c, method, _concrete(path, uid), route, bearer(b_token))
                if resp.status_code not in (403, 404):
                    leaks.append((method, path, resp.status_code, resp.text[:120]))
                elif resp.status_code == 403:
                    # Only the plan gate may say 403, and B is on Pro: a 403
                    # from anything else would be an ownership answer that
                    # confirms the resource exists.
                    detail = resp.json().get("detail")
                    assert isinstance(detail, dict) and detail.get("code") == "plan_feature", (method, path, resp.text)
            # …and A still has both (nothing B did got through).
            assert (await c.get(f"/videos/{project}", headers=bearer(a_token))).status_code == 200
            assert (await c.get(f"/effect-styles/{style}", headers=bearer(a_token))).status_code == 200
        finally:
            shutil.rmtree(data_root() / "video_outputs" / project, ignore_errors=True)
    assert leaks == [], leaks


async def test_a_job_is_only_readable_by_the_user_it_belongs_to(two_users):
    """``core.jobs.user_id``: every account shares tenant ``default``, so the
    tenant check on ``GET /jobs/{id}`` was no check between users."""
    a = await make_user(email("owner"), plan="pro")
    b = await make_user(email("other"), plan="pro")
    a_token, b_token = await user_token(a), await _same_tenant_token(b, a)
    async with client() as c:
        r = await c.post(
            "/videos/local",
            json={"mode": "dub_first", "clips": [{"id": "c1", "durationSec": 30}], "engine": "lite"},
            headers=bearer(a_token),
        )
        project = r.json()["uid"]
        try:
            manifest = json.dumps([{"clip_id": "c1", "file": "p.mp4", "durationSec": 5}])
            started = await c.post(
                f"/videos/{project}/analyze-video",
                data={"manifest": manifest},
                files=[("files", ("p.mp4", video_bytes(5), "video/mp4"))],
                headers=bearer(a_token),
            )
            assert started.status_code == 202, started.text
            job_id = started.json()["job_id"]
            mine = await c.get(f"/jobs/{job_id}", headers=bearer(a_token))
            theirs = await c.get(f"/jobs/{job_id}", headers=bearer(b_token))
            owner = await db("SELECT user_id FROM core.jobs WHERE id = :j", j=job_id)
            # A row from before the column (no owner) stays tenant-scoped.
            await db("UPDATE core.jobs SET user_id = NULL WHERE id = :j", j=job_id)
            legacy = await c.get(f"/jobs/{job_id}", headers=bearer(b_token))
        finally:
            shutil.rmtree(data_root() / "video_outputs" / project, ignore_errors=True)
    assert owner[0][0] == a
    assert mine.status_code == 200
    assert theirs.status_code == 404
    assert legacy.status_code == 200


async def test_a_cached_job_that_names_an_owner_is_not_served_to_another(monkeypatch):
    """The Redis mirror carries ``user_id`` too; an entry with one is refused
    to anyone else (it falls through to the row, which answers 404)."""
    from httpx import ASGITransport, AsyncClient

    from packages.db import job_cache
    from services.api import deps

    class _Auth:
        tenant_id = 1
        user_id = 2

    class _NoRow:
        async def execute(self, *a, **k):
            class _R:
                def scalar_one_or_none(self):
                    return None
            return _R()

    async def fake_get(job_id: str) -> dict:
        return {
            "id": job_id, "tenant_id": 1, "user_id": 1, "type": "video_edit",
            "status": "done", "progress": 100, "result": {"secret": True}, "error": None,
            "updated_at": "2026-01-01T00:00:00+00:00",
        }

    monkeypatch.setattr(job_cache, "get", fake_get)
    app.dependency_overrides[deps.current_user] = lambda: _Auth()
    app.dependency_overrides[deps.core_session] = lambda: _NoRow()
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/jobs/vlocal_abcdef12")
    finally:
        app.dependency_overrides.clear()
    assert r.status_code == 404


async def test_a_job_id_never_re_stamps_another_accounts_row():
    """Job ids were ``vlocal_<uid[:8]>`` (32 random bits), and the upsert
    re-stamped whatever row had that id onto the caller: a chance collision
    handed one user's job row (and its result) to another."""
    import uuid
    from types import SimpleNamespace

    from fastapi import HTTPException

    assert videos_local.local_job_id("0123456789abcdef") == "vlocal_0123456789abcdef"
    a = await make_user(email("jobown"))
    b = await make_user(email("jobown"))
    [(tenant_id,)] = await db("SELECT id FROM core.tenants WHERE slug = 'default'")
    victim = SimpleNamespace(user_id=a, tenant_id=tenant_id, tenant_slug="default")
    other = SimpleNamespace(user_id=b, tenant_id=tenant_id, tenant_slug="default")
    job_id = "vlocal_collide-test-" + uuid.uuid4().hex[:8]
    try:
        async with get_sessionmaker()() as s:
            await videos_local._queue_job_row(s, victim, job_id, {"step": "queued"})
            await s.commit()
        async with get_sessionmaker()() as s:
            with pytest.raises(HTTPException) as err:
                await videos_local._queue_job_row(s, other, job_id, {"step": "queued"})
            await s.rollback()
        assert err.value.status_code == 409
        rows = await db("SELECT user_id FROM core.jobs WHERE id = :j", j=job_id)
        assert rows == [(a,)]
    finally:
        await db("DELETE FROM core.jobs WHERE id = :j", j=job_id)
