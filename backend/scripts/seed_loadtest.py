"""Load-test accounts — ONLY in an environment running LOADTEST_FAKE_AI.

    cd backend && python scripts/seed_loadtest.py --count 200            # create / refresh
    cd backend && python scripts/seed_loadtest.py --count 200 --tokens   # + mint JWTs for k6
    cd backend && python scripts/seed_loadtest.py --reset-usage          # clear their usage windows
    cd backend && python scripts/seed_loadtest.py --remove               # delete them and their projects

Creates ``lt-<n>@loadtest.noey.local`` (n = 1..count), verified, active, spread
round-robin across the pro / studio / max plans so one plan's per-user job
concurrency is not the only limiter a test measures. Idempotent: an existing
account keeps its password (``--new-passwords`` rotates them) and has its plan
re-applied.

Passwords are random and written ONLY to the local ``--out`` file (default
``loadtest/.secrets/users.json`` at the repo root, mode 0600) — never printed,
never stored anywhere else but as a bcrypt hash. ``--tokens`` also writes
``tokens.json`` next to it: one access + refresh token pair per account,
minted exactly as /auth/login does, so a k6 run does not have to log hundreds
of users in through the login rate limit (100 per IP per 15 min).

Refuses to run unless LOADTEST_FAKE_AI=1 and nothing says this environment is
production (RAILWAY_ENVIRONMENT_NAME / ENVIRONMENT / APP_ENV).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import pathlib
import secrets
import sys
from datetime import UTC, datetime

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from sqlalchemy import text

DOMAIN = "loadtest.noey.local"
#: Default plan spread — per-user job concurrency differs (pro 2, studio 3,
#: max 5), so one plan's ceiling is not the only thing a run measures. Each
#: plan also has a TOKEN budget per 5-hour window, and a fake analysis bills
#: real tokens: ~48k for an 8s clip, i.e. ~7 runs (pro) / 15 (studio) / 53
#: (max) before the start route answers 402 limit_reached. For a capacity run
#: that must not hit that wall, seed with --plans enterprise (unlimited tokens,
#: 5 concurrent jobs) or clear the windows between runs with --reset-usage.
PLANS = ("pro", "studio", "max")
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_OUT = REPO_ROOT / "loadtest" / ".secrets" / "users.json"


def _say(message: str) -> None:
    print(message, flush=True)


def email_for(n: int) -> str:
    return f"lt-{n}@{DOMAIN}"


def refusal() -> str | None:
    """Why this script must not run here, or None."""
    from packages.core.settings import (
        FakeAIInProduction,
        get_settings,
        production_environment_marker,
    )

    env = production_environment_marker()
    if env:
        return f"{env} — load-test accounts never go into production."
    try:
        fake = get_settings().loadtest_fake_ai
    except FakeAIInProduction as exc:  # pragma: no cover — covered by the marker above
        return str(exc)
    if not fake:
        return "LOADTEST_FAKE_AI is not on — load-test accounts belong to a fake-AI environment only."
    return None


async def _existing() -> dict[str, tuple[int, int, str]]:
    """email → (user id, tenant id, tenant slug) for every load-test account."""
    from packages.db.session import get_engine

    async with get_engine().begin() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT u.email, u.id, t.id, t.slug FROM core.users u "
                    "JOIN core.memberships m ON m.user_id = u.id "
                    "JOIN core.tenants t ON t.id = m.tenant_id WHERE u.email LIKE :p"
                ),
                {"p": f"%@{DOMAIN}"},
            )
        ).all()
    return {str(r[0]): (int(r[1]), int(r[2]), str(r[3])) for r in rows}


async def seed(
    count: int, out: pathlib.Path, *, plans: tuple[str, ...], new_passwords: bool, tokens: bool
) -> None:
    from packages.auth.accounts import create_account
    from packages.auth.hashing import hash_password
    from packages.auth.tokens import encode_access, encode_refresh
    from packages.db.session import get_engine, get_sessionmaker

    saved: dict[str, dict] = {}
    if out.is_file():
        try:
            saved = {u["email"]: u for u in json.loads(out.read_text()).get("users", [])}
        except (json.JSONDecodeError, KeyError, TypeError):
            saved = {}

    have = await _existing()
    users: list[dict] = []
    created = updated = 0
    for n in range(1, count + 1):
        email = email_for(n)
        plan = plans[(n - 1) % len(plans)]
        known = saved.get(email)
        password = None if (new_passwords or known is None) else known.get("password")
        if email in have:
            user_id, tenant_id, slug = have[email]
            async with get_engine().begin() as conn:
                params: dict = {"p": plan, "i": user_id, "now": datetime.now(UTC)}
                sql = (
                    "UPDATE core.users SET plan = :p, is_active = true, is_admin = false, "
                    "email_verified_at = COALESCE(email_verified_at, :now)"
                )
                if password is None:
                    # No local copy of its password (or a rotation was asked
                    # for): set a new one, and revoke tokens minted before.
                    password = secrets.token_urlsafe(18)
                    params["h"] = hash_password(password)
                    sql += ", password_hash = :h, token_version = token_version + 1"
                await conn.execute(text(sql + " WHERE id = :i"), params)
            updated += 1
        else:
            password = secrets.token_urlsafe(18)
            async with get_sessionmaker()() as session:
                await session.execute(text("SET search_path TO core, public"))
                user, tenant = await create_account(
                    session, email=email, password_hash=hash_password(password),
                    display_name=f"[LOADTEST] {n}",
                )
                user.plan = plan
                user.email_verified_at = datetime.now(UTC)
                await session.commit()
                user_id, tenant_id, slug = int(user.id), int(tenant.id), str(tenant.slug)
            created += 1
        users.append({"n": n, "email": email, "password": password, "plan": plan,
                      "user_id": user_id, "tenant_id": tenant_id, "tenant_slug": slug})

    out.parent.mkdir(parents=True, exist_ok=True)
    _write_private(out, {"domain": DOMAIN, "users": users})
    _say(f"load-test accounts: {created} created, {updated} refreshed ({count} total, plans {'/'.join(plans)})")
    _say(f"credentials written to {out} (0600) — not printed")

    if tokens:
        async with get_engine().begin() as conn:
            rows = (
                await conn.execute(
                    text("SELECT id, COALESCE(token_version, 0) FROM core.users WHERE email LIKE :p"),
                    {"p": f"%@{DOMAIN}"},
                )
            ).all()
            versions: dict[int, int] = {int(r[0]): int(r[1]) for r in rows}
        pairs = [
            {
                "email": u["email"],
                "access_token": encode_access(u["user_id"], u["tenant_id"], u["tenant_slug"], versions[u["user_id"]]),
                "refresh_token": encode_refresh(u["user_id"], u["tenant_id"], versions[u["user_id"]]),
            }
            for u in users
        ]
        tok_path = out.with_name("tokens.json")
        _write_private(tok_path, pairs)
        _say(f"tokens written to {tok_path} (access tokens expire; k6 refreshes on 401 like the web app)")

    _say("")
    _say("k6 credentials, pick one:")
    _say(f"  pre-issued tokens:  TOKENS_B64=$(base64 < {out.with_name('tokens.json')} | tr -d '\\n')   (run with --tokens)")
    _say(f"  log in per VU:      USERS_B64=$(base64 < {out} | tr -d '\\n')")
    _say("  then pass it as an env var to loadtest/k6/editor.js (see loadtest/README.md).")


def _write_private(path: pathlib.Path, payload: object) -> None:
    tmp = path.with_suffix(".part")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)
    tmp.replace(path)


async def reset_usage() -> None:
    """Clear the load-test accounts' usage windows so a new run starts fresh."""
    from packages.db.session import get_engine

    ids = [uid for uid, _tid, _slug in (await _existing()).values()]
    if not ids:
        _say("no load-test accounts")
        return
    async with get_engine().begin() as conn:
        for table in ("core.llm_usage_logs", "core.stt_usage_logs", "core.ai_runs", "core.usage_accounts"):
            await conn.execute(text(f"DELETE FROM {table} WHERE user_id = ANY(:ids)"), {"ids": ids})
    _say(f"cleared usage for {len(ids)} load-test accounts")


async def remove() -> None:
    """Delete every load-test account, its projects (files too) and tenant."""
    from packages.db.session import get_engine
    from packages.db.tenancy import SHARED_DATA_SCHEMA
    from packages.video.s3 import delete_project as s3_delete_project
    from packages.video.storage import delete_project_files

    have = await _existing()
    ids = [uid for uid, _tid, _slug in have.values()]
    if not ids:
        _say("no load-test accounts")
        return
    async with get_engine().begin() as conn:
        uids = [
            str(r[0]) for r in (
                await conn.execute(
                    text(f'SELECT uid FROM "{SHARED_DATA_SCHEMA}".video_projects WHERE user_id = ANY(:ids)'),
                    {"ids": ids},
                )
            ).all()
        ]
    for uid in uids:
        try:
            delete_project_files(uid)
        except Exception as exc:  # noqa: BLE001
            _say(f"  files of {uid}: {exc}")
        await s3_delete_project(uid)
    tenant_ids = [tid for _uid, tid, _slug in have.values()]
    async with get_engine().begin() as conn:
        await conn.execute(
            text(f'DELETE FROM "{SHARED_DATA_SCHEMA}".video_projects WHERE user_id = ANY(:ids)'), {"ids": ids}
        )
        await conn.execute(text("DELETE FROM core.jobs WHERE tenant_id = ANY(:t)"), {"t": tenant_ids})
        # Everything else hangs off users / tenants with ON DELETE CASCADE.
        await conn.execute(text("DELETE FROM core.users WHERE id = ANY(:ids)"), {"ids": ids})
        for _uid, tid, slug in have.values():
            await conn.execute(text("DELETE FROM core.tenants WHERE id = :t"), {"t": tid})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))
    _say(f"removed {len(ids)} load-test accounts and {len(uids)} projects")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--count", type=int, default=0, help="accounts lt-1..lt-N to create / refresh")
    parser.add_argument(
        "--plans", default=",".join(PLANS),
        help="comma-separated plans to spread the accounts over (default pro,studio,max; "
             "use enterprise for a run that must not hit the token windows)",
    )
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT, help="local credentials file (0600)")
    parser.add_argument("--tokens", action="store_true", help="also mint access/refresh tokens into tokens.json")
    parser.add_argument("--new-passwords", action="store_true", help="rotate every password")
    parser.add_argument("--reset-usage", action="store_true", help="clear the accounts' usage windows")
    parser.add_argument("--remove", action="store_true", help="delete every load-test account and its projects")
    args = parser.parse_args()

    problem = refusal()
    if problem:
        _say(f"Refusing to run: {problem}")
        return 2
    if args.remove:
        asyncio.run(remove())
        return 0
    if args.count <= 0 and not args.reset_usage:
        parser.error("give --count N (and/or --reset-usage, or --remove)")
    plans = tuple(p.strip() for p in args.plans.split(",") if p.strip())
    if not plans:
        parser.error("--plans needs at least one plan name")

    async def _run() -> None:
        if args.count > 0:
            await seed(
                args.count, args.out, plans=plans,
                new_passwords=args.new_passwords, tokens=args.tokens,
            )
        if args.reset_usage:
            await reset_usage()

    asyncio.run(_run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
