"""DEMO data for the admin dashboard — a local database only.

    cd backend && python scripts/seed_admin_demo.py                 # create / refresh
    cd backend && python scripts/seed_admin_demo.py --reset-admin-password
    cd backend && python scripts/seed_admin_demo.py --remove        # delete every demo row

Creates an admin (``owner@demo.noey.local``) and a spread of customers on every
plan under ``@demo.noey.local``, each with usage rows (tokens per model and
feature, speech-to-text seconds), projects (finished and failed, both quality
tiers) and — for the paying ones — a live subscription mirror with a fake
``cus_demo_*`` customer, across the last ~100 days.

Idempotent: re-running regenerates the demo usage for the demo users and never
touches anything else. The admin's password is random and printed ONCE, when
the account is created (or with --reset-admin-password); it is never stored
anywhere but as a bcrypt hash.

Refuses to run unless POSTGRES_HOST is localhost / 127.0.0.1 / ::1.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import random
import secrets
import sys
import uuid
from datetime import UTC, datetime, timedelta

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from sqlalchemy import text

from packages.auth.accounts import create_account
from packages.auth.hashing import hash_password
from packages.core.settings import get_settings
from packages.db.session import get_engine, get_sessionmaker
from packages.db.tenancy import SHARED_DATA_SCHEMA

DOMAIN = "demo.noey.local"
ADMIN_EMAIL = f"owner@{DOMAIN}"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}

#: (email local part, plan, live subscription, active, projects in 30 days, failure rate,
#:  engine pro share, precision high share, effects share, days since last use, note)
CUSTOMERS = [
    ("pare.kittiya", "starter", True, True, 14, 0.07, 0.78, 0.14, 0.45, 1),
    ("tanaporn.w", "lite", True, True, 9, 0.0, 0.55, 0.0, 0.30, 2),
    ("golden.shop", "pro", True, True, 26, 0.04, 0.9, 0.35, 0.6, 0),
    ("studio.minnie", "studio", True, True, 34, 0.03, 0.95, 0.5, 0.65, 0),
    ("bew.creator", "free", False, True, 22, 0.09, 0.88, 0.33, 0.5, 0),
    ("jaruwan.s", "free", False, True, 5, 0.2, 0.44, 0.0, 0.2, 6),
    ("mint.studio.th", "free", False, True, 2, 0.0, 0.3, 0.0, 0.1, 11),
    ("golf.pornchai", "free", False, True, 0, 0.0, 0.0, 0.0, 0.0, None),
    ("nok.review", "starter", False, True, 6, 0.0, 0.6, 0.0, 0.2, 3),  # plan set by an admin, no payment
    ("ploy.beauty", "pro", True, False, 4, 0.25, 0.8, 0.2, 0.4, 19),  # deactivated
    ("agency.partner", "enterprise", False, True, 12, 0.0, 1.0, 0.6, 0.7, 1),
]

JOB_NAMES = [
    "รีวิวครีมกันแดด", "ไลฟ์ขายกระเป๋า", "แนะนำร้านกาแฟ", "ลูกค้าเล่าประสบการณ์", "เปิดกล่องหูฟัง",
    "สอนแต่งหน้า 3 นาที", "โปรสิ้นเดือน", "พาเที่ยวตลาดน้ำ", "รีวิวรองเท้าวิ่ง", "เมนูอาหารคลีน",
    "ทดสอบเครื่องชงกาแฟ", "เบื้องหลังถ่ายแบบ",
]
MODES = ["dub_first", "talking_head", "speech_scenes", "dub_first", "speech_highlights"]


def _say(message: str) -> None:
    print(message, flush=True)


async def _ensure_user(email: str, *, admin: bool, plan: str, active: bool, name: str) -> tuple[int, int, str, bool]:
    """(user id, tenant id, tenant slug, created now)."""
    engine = get_engine()
    async with engine.begin() as conn:
        row = (
            await conn.execute(
                text(
                    "SELECT u.id, t.id, t.slug FROM core.users u JOIN core.memberships m ON m.user_id = u.id "
                    "JOIN core.tenants t ON t.id = m.tenant_id WHERE u.email = :e"
                ),
                {"e": email},
            )
        ).first()
        if row is not None:
            await conn.execute(
                text("UPDATE core.users SET plan = :p, is_admin = :a, is_active = :act WHERE id = :i"),
                {"p": plan, "a": admin, "act": active, "i": row[0]},
            )
            return int(row[0]), int(row[1]), str(row[2]), False
    async with get_sessionmaker()() as session:
        await session.execute(text("SET search_path TO core, public"))
        user, tenant = await create_account(
            session, email=email, password_hash=hash_password(secrets.token_urlsafe(24)), display_name=name
        )
        user.is_admin = admin
        user.plan = plan
        user.is_active = active
        user.email_verified_at = datetime.now(UTC)
        await session.commit()
        return int(user.id), int(tenant.id), str(tenant.slug), True


async def _clear_usage(user_ids: list[int]) -> None:
    async with get_engine().begin() as conn:
        for table in ("core.llm_usage_logs", "core.stt_usage_logs", f'"{SHARED_DATA_SCHEMA}".video_projects'):
            await conn.execute(text(f"DELETE FROM {table} WHERE user_id = ANY(:ids)"), {"ids": user_ids})
        await conn.execute(text("DELETE FROM core.billing_accounts WHERE user_id = ANY(:ids)"), {"ids": user_ids})


async def _seed_usage(uid: int, tid: int, slug: str, spec: tuple, rng: random.Random, now: datetime) -> int:
    _, plan, live, _active, per_month, fail_rate, pro, high, fx, last = spec
    rows_llm, rows_stt, rows_proj = [], [], []
    if per_month and last is not None:
        # ~100 days of history: the same rhythm, a bit quieter in older months.
        for day in range(last, 100):
            weight = 1.0 if day < 30 else 0.7 if day < 60 else 0.45
            expected = per_month / 30 * weight
            for _ in range(rng.choices([0, 1, 2, 3], weights=[1 - min(expected, 0.95), expected, expected / 4, expected / 12])[0]):
                at = now - timedelta(days=day, hours=rng.uniform(0, 12), minutes=rng.uniform(0, 59))
                project = str(uuid.uuid4())
                engine = "pro" if rng.random() < pro else "lite"
                precision = "high" if rng.random() < high else "standard"
                failed = rng.random() < fail_rate
                footage = rng.uniform(40, 420) if plan != "free" else rng.uniform(30, 280)
                clips = [{"id": f"c{i}", "durationSec": round(footage / 3 * rng.uniform(0.6, 1.4), 1)} for i in range(3)]
                mode = rng.choice(MODES)
                rows_proj.append({
                    "uid": project, "user_id": uid, "slug": slug, "mode": mode, "status": "error" if failed else "done",
                    "engine": engine, "precision": precision, "brief": rng.choice(JOB_NAMES),
                    "meta": json.dumps({"clips": clips}), "at": at,
                })
                rows_stt.append({"u": uid, "t": tid, "r": project, "s": round(footage * rng.uniform(0.9, 1.05), 1),
                                 "m": "scribe_v2", "at": at + timedelta(seconds=20)})
                if failed and rng.random() < 0.5:
                    continue  # died after transcription, before the cut
                vis_in = 101_452 if precision == "high" else 24_496
                cut_model = "gemini/gemini-3.8-flash" if engine == "pro" else "gemini/gemini-3.7-flash"
                rows_llm.append({"u": uid, "t": tid, "f": "video_cut", "r": project, "m": cut_model,
                                 "i": int(vis_in * rng.uniform(0.8, 1.2)), "o": int(2400 * rng.uniform(0.7, 1.4)), "at": at + timedelta(minutes=1)})
                for k in range(3):
                    rows_llm.append({"u": uid, "t": tid, "f": "chat" if k == 2 else "video_cut", "r": project,
                                     "m": "gemini/gemini-3.7-flash", "i": int(1200 * rng.uniform(0.7, 1.3)),
                                     "o": int(400 * rng.uniform(0.7, 1.3)), "at": at + timedelta(minutes=2 + k)})
                if rng.random() < fx:
                    rows_llm.append({"u": uid, "t": tid, "f": "video_effects", "r": project, "m": "gemini/gemini-3.1-pro-preview",
                                     "i": int(30_000 * rng.uniform(0.8, 1.2)), "o": int(1600 * rng.uniform(0.8, 1.2)), "at": at + timedelta(minutes=6)})
                if rng.random() < 0.06:
                    rows_llm.append({"u": uid, "t": tid, "f": "video_style", "r": None, "m": "gemini/gemini-3.1-pro-preview",
                                     "i": int(48_000 * rng.uniform(0.8, 1.2)), "o": 900, "at": at + timedelta(minutes=8)})

    async with get_engine().begin() as conn:
        if rows_proj:
            await conn.execute(
                text(
                    f'INSERT INTO "{SHARED_DATA_SCHEMA}".video_projects '
                    "(uid, user_id, tenant_slug, mode, status, engine, precision, brief, local_meta, origin, created_at, updated_at) "
                    "VALUES (:uid, :user_id, :slug, :mode, :status, :engine, :precision, :brief, CAST(:meta AS jsonb), 'local', :at, :at)"
                ),
                rows_proj,
            )
        if rows_stt:
            await conn.execute(
                text("INSERT INTO core.stt_usage_logs (user_id, tenant_id, reference_id, audio_sec, model, created_at) "
                     "VALUES (:u, :t, :r, :s, :m, :at)"),
                rows_stt,
            )
        if rows_llm:
            await conn.execute(
                text("INSERT INTO core.llm_usage_logs (user_id, tenant_id, feature, reference_id, model, input_tokens, output_tokens, created_at) "
                     "VALUES (:u, :t, :f, :r, :m, :i, :o, :at)"),
                rows_llm,
            )
        if live:
            await conn.execute(
                text(
                    "INSERT INTO core.billing_accounts (user_id, stripe_customer_id, stripe_subscription_id, price_lookup_key, status, "
                    "current_period_end, cancel_at_period_end, pm_brand, pm_last4) "
                    "VALUES (:u, :c, :s, :k, 'active', :end, :cancel, 'visa', '4242')"
                ),
                {"u": uid, "c": f"cus_demo_{uid}", "s": f"sub_demo_{uid}", "k": f"noey_{plan}_monthly",
                 "end": now + timedelta(days=rng.randint(3, 27)), "cancel": plan == "studio"},
            )
        # Signed up before their first project.
        first = min((p["at"] for p in rows_proj), default=now - timedelta(days=(last or 20) + 5))
        await conn.execute(text("UPDATE core.users SET created_at = :at WHERE id = :u"), {"at": first - timedelta(days=2), "u": uid})
    return len(rows_proj)


async def remove() -> None:
    engine = get_engine()
    async with engine.begin() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT u.id, t.slug FROM core.users u JOIN core.memberships m ON m.user_id = u.id "
                    "JOIN core.tenants t ON t.id = m.tenant_id WHERE u.email LIKE :p"
                ),
                {"p": f"%@{DOMAIN}"},
            )
        ).all()
    ids = [int(r[0]) for r in rows]
    if ids:
        await _clear_usage(ids)
    async with engine.begin() as conn:
        await conn.execute(text("DELETE FROM core.admin_audit_events WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        await conn.execute(text("DELETE FROM core.users WHERE email LIKE :p"), {"p": f"%@{DOMAIN}"})
        for _, slug in rows:
            await conn.execute(text("DELETE FROM core.tenants WHERE slug = :s"), {"s": slug})
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "tenant_{slug}" CASCADE'))
    _say(f"removed {len(ids)} demo accounts")


async def seed(reset_password: bool) -> None:
    now = datetime.now(UTC)
    rng = random.Random(20260922)

    admin_id, _, _, created = await _ensure_user(ADMIN_EMAIL, admin=True, plan="studio", active=True, name="[DEMO] Owner")
    if created or reset_password:
        password = secrets.token_urlsafe(12)
        async with get_engine().begin() as conn:
            await conn.execute(
                text("UPDATE core.users SET password_hash = :h, token_version = token_version + 1 WHERE id = :i"),
                {"h": hash_password(password), "i": admin_id},
            )
        _say("")
        _say(f"  DEMO ADMIN   {ADMIN_EMAIL}")
        _say(f"  password     {password}")
        _say("  (shown once — re-run with --reset-admin-password to set a new one)")
        _say("")
    else:
        _say(f"admin {ADMIN_EMAIL} exists — password unchanged (--reset-admin-password to set a new one)")

    people = [(ADMIN_EMAIL, admin_id)]
    ids = [admin_id]
    specs = {}
    for spec in CUSTOMERS:
        email = f"{spec[0]}@{DOMAIN}"
        uid, tid, slug, _ = await _ensure_user(email, admin=False, plan=spec[1], active=spec[3], name=f"[DEMO] {spec[0]}")
        people.append((email, uid))
        ids.append(uid)
        specs[uid] = (tid, slug, spec)
    await _clear_usage(ids)

    async with get_engine().begin() as conn:
        tenant = (
            await conn.execute(
                text("SELECT t.id, t.slug FROM core.tenants t JOIN core.memberships m ON m.tenant_id = t.id WHERE m.user_id = :u"),
                {"u": admin_id},
            )
        ).first()
    owner_spec = ("owner", "studio", False, True, 31, 0.1, 0.94, 0.41, 0.55, 0)
    total = await _seed_usage(admin_id, int(tenant[0]), str(tenant[1]), owner_spec, rng, now)
    for uid, (tid, slug, spec) in specs.items():
        total += await _seed_usage(uid, tid, slug, spec, rng, now)
    _say(f"seeded {len(people)} demo accounts and {total} demo projects under @{DOMAIN}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--reset-admin-password", action="store_true")
    parser.add_argument("--remove", action="store_true", help="delete every @demo.noey.local account and its rows")
    args = parser.parse_args()

    host = (get_settings().postgres_host or "").strip().lower()
    if host not in LOCAL_HOSTS:
        _say(f"Refusing to run: POSTGRES_HOST is {host!r}. Demo data is for a local database only.")
        return 2
    asyncio.run(remove() if args.remove else seed(args.reset_admin_password))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
