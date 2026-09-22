"""The usage facts the admin dashboard computes money from.

Only FACTS leave here — tokens per model and feature, speech-to-text seconds
per model, finished/failed projects, quality tiers chosen, subscription state.

Vendor cost is a fact since 2026-09-22: every usage row records ``cost_thb``
when it is written (packages/billing/metering.py), and ``tokens`` — the
rate-card tokens the user was charged. Each token/STT group reports the sum of
both, plus the vendor units of LEGACY rows that predate cost recording
(``uncosted_*``); the admin app's money module prices only those from the
owner's (draft) price table, and adds fixed costs and per-user extras — so the
arithmetic still lives in ONE place.

Days are Asia/Bangkok calendar days (the owner's clock). Plan limits are the
rolling 5-hour / weekly / monthly windows of core.usage_accounts
(packages/billing/runs.py); each user's ``windows`` carry the REAL rate-card
tokens (the admin sees them; users only ever see percentages), and
``quota_used_pct`` is the fullest enforced window — the same figure the web
app shows.

Project rows live in the shared tenant data schema (packages/db/tenancy.py) —
one table for every tenant — and are attributed by ``user_id``.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.admin.cost_config import model_key
from packages.billing import catalog
from packages.billing import limits as limits_mod
from packages.billing import runs as runs_mod
from packages.db.models.billing import BillingAccount
from packages.db.models.core_auth import User
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog
from packages.db.models.usage_account import UsageAccount
from packages.db.models.wallet import WalletLedger, WalletLot
from packages.db.tenancy import SHARED_DATA_SCHEMA

TZ = ZoneInfo("Asia/Bangkok")
MAX_PERIOD_DAYS = 366
CHART_DAYS = 30
MONTHS = 4

#: A project counts as a finished clip once the cut exists; `error` is a failure.
DONE_STATUSES = ("done", "waiting_vo")
FAILED_STATUSES = ("error",)

_PROJECTS = f'"{SHARED_DATA_SCHEMA}".video_projects'


@dataclass(frozen=True)
class Period:
    start: date  # inclusive, Bangkok
    end: date  # inclusive, Bangkok

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    @property
    def start_utc(self) -> datetime:
        return _day_start_utc(self.start)

    @property
    def end_utc(self) -> datetime:
        """Exclusive."""
        return _day_start_utc(self.end + timedelta(days=1))


def _day_start_utc(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=TZ).astimezone(UTC)


def today_bangkok() -> date:
    return datetime.now(TZ).date()


def make_period(start: date, end: date) -> Period:
    if end < start:
        raise ValueError("the period ends before it starts")
    if (end - start).days + 1 > MAX_PERIOD_DAYS:
        raise ValueError(f"a period is at most {MAX_PERIOD_DAYS} days")
    return Period(start, end)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# ── per-user facts for a period ───────────────────────────────────────────────

async def _users(session: AsyncSession) -> list[dict[str, Any]]:
    rows = (
        await session.execute(
            select(User, BillingAccount.status, BillingAccount.current_period_end, BillingAccount.cancel_at_period_end)
            .outerjoin(BillingAccount, BillingAccount.user_id == User.id)
            .order_by(User.id)
        )
    ).all()
    accounts = {
        int(a.user_id): a for a in (await session.execute(select(UsageAccount))).scalars().all()
    }
    now = datetime.now(UTC)
    out = []
    for user, status, period_end, cancelling in rows:
        plan = str(user.plan or catalog.FREE_TIER)
        out.append(
            {
                "id": int(user.id),
                "email": str(user.email),
                "display_name": user.display_name,
                "plan": plan,
                "internal": bool(user.is_admin),
                "active": bool(user.is_active),
                "email_verified": user.email_verified_at is not None,
                "created_at": _iso(user.created_at),
                "subscription": {
                    "status": status,
                    "live": catalog.is_live(status),
                    "current_period_end": _iso(period_end),
                    "cancel_at_period_end": bool(cancelling),
                },
                "usage_reset_at": _iso(user.usage_reset_at),
                **window_facts(user, accounts.get(int(user.id)), now),
            }
        )
    return out


def window_facts(user: User, account: UsageAccount | None, now: datetime) -> dict[str, Any]:
    """A user's limit state with real tokens (admin only): every enforced
    window, the fullest one as ``quota_*``, the wallet balance cache and any
    scheduled plan change."""
    unlimited = limits_mod.is_unlimited(user)
    plan = runs_mod.effective_plan(user, account, now)
    views = [] if unlimited else runs_mod.enforced_windows(plan, account, now)
    tightest = max(views, key=lambda v: v.used_pct) if views else None
    return {
        "effective_plan": plan,
        "unlimited": unlimited,
        "windows": [
            {
                "key": v.key, "limit_tokens": v.limit, "used_tokens": v.used, "reserved_tokens": v.reserved,
                "used_pct": v.used_pct, "active": v.active, "resets_at": runs_mod.iso(v.resets_at),
            }
            for v in views
        ],
        "quota_window": tightest.key if tightest else None,
        "quota_limit_tokens": tightest.limit if tightest else 0,
        "quota_used_tokens": (tightest.used + tightest.reserved) if tightest else 0,
        "quota_used_pct": min(tightest.used_pct, 999.0) if tightest else None,
        "wallet_balance_satang": int(account.wallet_balance_satang or 0) if account else 0,
        "pending_plan": (
            {"plan": account.pending_plan, "at": runs_mod.iso(account.pending_plan_at)}
            if account is not None and account.pending_plan else None
        ),
        "grace_until": runs_mod.iso(account.grace_until) if account is not None else None,
    }


def _llm_fact_columns() -> list[Any]:
    """Aggregates one token-fact row is built from (``_token_fact``)."""
    uncosted = LlmUsageLog.cost_thb.is_(None)
    return [
        func.coalesce(func.sum(LlmUsageLog.input_tokens), 0),
        func.coalesce(func.sum(LlmUsageLog.output_tokens), 0),
        func.count(LlmUsageLog.id),
        func.coalesce(func.sum(LlmUsageLog.cached_tokens), 0),
        func.coalesce(func.sum(LlmUsageLog.tokens), 0),
        func.coalesce(func.sum(LlmUsageLog.cost_thb), 0),
        func.coalesce(func.sum(LlmUsageLog.input_tokens).filter(uncosted), 0),
        func.coalesce(func.sum(LlmUsageLog.output_tokens).filter(uncosted), 0),
        func.coalesce(func.sum(LlmUsageLog.cached_tokens).filter(uncosted), 0),
        func.count(LlmUsageLog.id).filter(LlmUsageLog.status != "ok"),
    ]


def _token_fact(model: str | None, feature: str | None, agg: Any) -> dict[str, Any]:
    inp, outp, calls, cached, tokens, cost, u_in, u_out, u_cached, failed = agg
    return {
        "model": model_key(model),
        "feature": feature,
        "input": int(inp),
        "output": int(outp),
        "calls": int(calls),
        "cached": int(cached),
        #: Rate-card tokens charged (0 on legacy rows).
        "tokens": int(tokens),
        #: Recorded vendor cost; legacy rows are in uncosted_* instead.
        "cost_thb": round(float(cost), 4),
        "uncosted_input": int(u_in),
        "uncosted_output": int(u_out),
        "uncosted_cached": int(u_cached),
        #: Attempts that failed (retried or not) — each one reached the vendor.
        "failed_calls": int(failed),
    }


def _stt_fact_columns() -> list[Any]:
    uncosted = SttUsageLog.cost_thb.is_(None)
    return [
        func.coalesce(func.sum(SttUsageLog.audio_sec), 0.0),
        func.coalesce(func.sum(SttUsageLog.tokens), 0),
        func.coalesce(func.sum(SttUsageLog.cost_thb), 0),
        func.coalesce(func.sum(SttUsageLog.audio_sec).filter(uncosted), 0.0),
    ]


def _stt_fact(model: str | None, agg: Any) -> dict[str, Any]:
    secs, tokens, cost, u_secs = agg
    return {
        "model": model or "",
        "seconds": round(float(secs), 2),
        "tokens": int(tokens),
        "cost_thb": round(float(cost), 4),
        "uncosted_seconds": round(float(u_secs), 2),
    }


async def _tokens_by_user(session: AsyncSession, period: Period) -> dict[int, list[dict[str, Any]]]:
    rows = (
        await session.execute(
            select(LlmUsageLog.user_id, LlmUsageLog.model, LlmUsageLog.feature, *_llm_fact_columns())
            .where(LlmUsageLog.created_at >= period.start_utc, LlmUsageLog.created_at < period.end_utc)
            .group_by(LlmUsageLog.user_id, LlmUsageLog.model, LlmUsageLog.feature)
        )
    ).all()
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        out[int(row[0])].append(_token_fact(row[1], row[2], row[3:]))
    return out


async def _stt_by_user(session: AsyncSession, period: Period) -> dict[int, list[dict[str, Any]]]:
    rows = (
        await session.execute(
            select(SttUsageLog.user_id, SttUsageLog.model, *_stt_fact_columns())
            .where(SttUsageLog.created_at >= period.start_utc, SttUsageLog.created_at < period.end_utc)
            .group_by(SttUsageLog.user_id, SttUsageLog.model)
        )
    ).all()
    out: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        out[int(row[0])].append(_stt_fact(row[1], row[2:]))
    return out


async def _projects_by_user(session: AsyncSession, period: Period) -> dict[int, dict[str, Any]]:
    rows = (
        await session.execute(
            text(
                f"SELECT user_id, "
                f"count(*) FILTER (WHERE status = ANY(:done)) AS clips, "
                f"count(*) FILTER (WHERE status = ANY(:failed)) AS failed, "
                f"count(*) AS total, "
                f"count(engine) AS with_engine, "
                f"count(*) FILTER (WHERE engine = 'pro') AS engine_pro, "
                f"count(precision) AS with_precision, "
                f"count(*) FILTER (WHERE precision = 'high') AS precision_high "
                f"FROM {_PROJECTS} WHERE created_at >= :a AND created_at < :b GROUP BY user_id"
            ),
            {"done": list(DONE_STATUSES), "failed": list(FAILED_STATUSES), "a": period.start_utc, "b": period.end_utc},
        )
    ).all()
    out: dict[int, dict[str, Any]] = {}
    for r in rows:
        out[int(r.user_id)] = {
            "clips": int(r.clips),
            "failed": int(r.failed),
            "projects": int(r.total),
            "engine_pro_pct": round(r.engine_pro / r.with_engine * 100, 1) if r.with_engine else None,
            "precision_high_pct": round(r.precision_high / r.with_precision * 100, 1) if r.with_precision else None,
        }
    return out


#: Lot sources a customer paid for (``admin`` credits and refund lots are not revenue).
PAID_LOT_SOURCES = ("stripe", "mock")
_NO_WALLET = {"topup_satang": 0, "topups": 0, "wallet_spent_satang": 0}


async def _wallet_by_user(session: AsyncSession, period: Period) -> dict[int, dict[str, int]]:
    """Top-up money per user in the period: what was bought (paid lots, gross
    satang, before the payment fee) and what runs consumed from the balance
    (debits net of refunds)."""
    out: dict[int, dict[str, int]] = defaultdict(lambda: dict(_NO_WALLET))
    bought = (
        await session.execute(
            select(WalletLot.user_id, func.coalesce(func.sum(WalletLot.amount_satang), 0), func.count(WalletLot.id))
            .where(
                WalletLot.source.in_(PAID_LOT_SOURCES),
                WalletLot.created_at >= period.start_utc,
                WalletLot.created_at < period.end_utc,
            )
            .group_by(WalletLot.user_id)
        )
    ).all()
    for uid, satang, n in bought:
        out[int(uid)]["topup_satang"] = int(satang)
        out[int(uid)]["topups"] = int(n)
    # A top-up refunded or disputed at Stripe is taken back from its lot
    # (``reversal`` rows, packages/billing/topup.py) — that money is not
    # revenue. Only the part still unspent can be taken back; a shortfall is
    # an audit event (``topup_reversal_shortfall``), not a ledger row.
    reversed_rows = (
        await session.execute(
            select(WalletLedger.user_id, func.coalesce(func.sum(WalletLedger.amount_satang), 0))
            .where(
                WalletLedger.kind == "reversal",
                WalletLedger.created_at >= period.start_utc,
                WalletLedger.created_at < period.end_utc,
            )
            .group_by(WalletLedger.user_id)
        )
    ).all()
    for uid, signed in reversed_rows:
        row = out[int(uid)]
        row["topup_satang"] = max(0, int(row["topup_satang"]) + int(signed))
    spent = (
        await session.execute(
            select(WalletLedger.user_id, func.coalesce(func.sum(WalletLedger.amount_satang), 0))
            .where(
                WalletLedger.kind.in_(("debit", "refund")),
                WalletLedger.run_id.is_not(None),
                WalletLedger.created_at >= period.start_utc,
                WalletLedger.created_at < period.end_utc,
            )
            .group_by(WalletLedger.user_id)
        )
    ).all()
    for uid, signed in spent:
        # Debits are negative and a refund of one positive: net consumption.
        out[int(uid)]["wallet_spent_satang"] = max(0, -int(signed))
    return dict(out)


async def _last_active(session: AsyncSession) -> dict[int, datetime]:
    rows = (
        await session.execute(
            text(
                "SELECT user_id, max(at) AS last FROM ("
                " SELECT user_id, max(created_at) AS at FROM core.llm_usage_logs GROUP BY user_id"
                " UNION ALL SELECT user_id, max(created_at) FROM core.stt_usage_logs GROUP BY user_id"
                f" UNION ALL SELECT user_id, max(updated_at) FROM {_PROJECTS} GROUP BY user_id"
                ") t GROUP BY user_id"
            )
        )
    ).all()
    return {int(r.user_id): r.last for r in rows if r.last is not None}


# ── series (whole product, split internal / customers) ───────────────────────

async def _series(session: AsyncSession, start_utc: datetime, end_utc: datetime, bucket: str) -> list[dict[str, Any]]:
    """Per bucket ("day" = Bangkok date, "month" = YYYY-MM) and internal flag."""
    fmt = "YYYY-MM-DD" if bucket == "day" else "YYYY-MM"
    key = lambda col: f"to_char(timezone('Asia/Bangkok', {col}), '{fmt}')"
    params = {"a": start_utc, "b": end_utc, "done": list(DONE_STATUSES)}
    tok = (
        await session.execute(
            text(
                f"SELECT {key('l.created_at')} AS k, u.is_admin AS internal, l.model, "
                "sum(l.input_tokens) AS inp, sum(l.output_tokens) AS outp, "
                "sum(l.tokens) AS tokens, coalesce(sum(l.cost_thb), 0) AS cost, "
                "coalesce(sum(l.input_tokens) FILTER (WHERE l.cost_thb IS NULL), 0) AS u_in, "
                "coalesce(sum(l.output_tokens) FILTER (WHERE l.cost_thb IS NULL), 0) AS u_out, "
                "coalesce(sum(l.cached_tokens) FILTER (WHERE l.cost_thb IS NULL), 0) AS u_cached "
                "FROM core.llm_usage_logs l JOIN core.users u ON u.id = l.user_id "
                "WHERE l.created_at >= :a AND l.created_at < :b GROUP BY 1, 2, 3"
            ),
            params,
        )
    ).all()
    stt = (
        await session.execute(
            text(
                f"SELECT {key('s.created_at')} AS k, u.is_admin AS internal, s.model, sum(s.audio_sec) AS secs, "
                "sum(s.tokens) AS tokens, coalesce(sum(s.cost_thb), 0) AS cost, "
                "coalesce(sum(s.audio_sec) FILTER (WHERE s.cost_thb IS NULL), 0) AS u_secs "
                "FROM core.stt_usage_logs s JOIN core.users u ON u.id = s.user_id "
                "WHERE s.created_at >= :a AND s.created_at < :b GROUP BY 1, 2, 3"
            ),
            params,
        )
    ).all()
    clips = (
        await session.execute(
            text(
                f"SELECT {key('p.created_at')} AS k, u.is_admin AS internal, count(*) AS n "
                f"FROM {_PROJECTS} p JOIN core.users u ON u.id = p.user_id "
                "WHERE p.created_at >= :a AND p.created_at < :b AND p.status = ANY(:done) GROUP BY 1, 2"
            ),
            params,
        )
    ).all()
    buckets: dict[tuple[str, bool], dict[str, Any]] = {}

    def slot(k: str, internal: bool) -> dict[str, Any]:
        return buckets.setdefault((k, bool(internal)), {"key": k, "internal": bool(internal), "tokens": [], "stt": [], "clips": 0})

    for r in tok:
        slot(r.k, r.internal)["tokens"].append(
            {
                "model": model_key(r.model), "input": int(r.inp), "output": int(r.outp),
                "tokens": int(r.tokens or 0), "cost_thb": round(float(r.cost), 4),
                "uncosted_input": int(r.u_in), "uncosted_output": int(r.u_out),
                "uncosted_cached": int(r.u_cached),
            }
        )
    for r in stt:
        slot(r.k, r.internal)["stt"].append(
            {
                "model": r.model or "", "seconds": round(float(r.secs), 2),
                "tokens": int(r.tokens or 0), "cost_thb": round(float(r.cost), 4),
                "uncosted_seconds": round(float(r.u_secs), 2),
            }
        )
    for r in clips:
        slot(r.k, r.internal)["clips"] = int(r.n)
    return sorted(buckets.values(), key=lambda b: (b["key"], b["internal"]))


def _month_start(day: date) -> date:
    return day.replace(day=1)


def _months_back(day: date, n: int) -> date:
    y, m = day.year, day.month - n
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


# ── the dashboard payload ────────────────────────────────────────────────────

async def dashboard(session: AsyncSession, period: Period) -> dict[str, Any]:
    users = await _users(session)
    tokens = await _tokens_by_user(session, period)
    stt = await _stt_by_user(session, period)
    projects = await _projects_by_user(session, period)
    wallets = await _wallet_by_user(session, period)
    last = await _last_active(session)

    today = today_bangkok()
    empty_projects = {"clips": 0, "failed": 0, "projects": 0, "engine_pro_pct": None, "precision_high_pct": None}
    for u in users:
        uid = u["id"]
        u["tokens"] = tokens.get(uid, [])
        u["stt"] = stt.get(uid, [])
        u.update(projects.get(uid, empty_projects))
        u.update(wallets.get(uid, _NO_WALLET))
        seen = last.get(uid)
        u["last_active_at"] = _iso(seen)
        u["last_active_days"] = (today - seen.astimezone(TZ).date()).days if seen else None

    chart_end = period.end
    chart_start = chart_end - timedelta(days=CHART_DAYS - 1)
    daily = await _series(session, _day_start_utc(chart_start), _day_start_utc(chart_end + timedelta(days=1)), "day")

    first_month = _months_back(_month_start(today), MONTHS - 1)
    monthly = await _series(session, _day_start_utc(first_month), _day_start_utc(today + timedelta(days=1)), "month")

    models: dict[str, set[str]] = defaultdict(set)
    for rows in tokens.values():
        for row in rows:
            models[row["model"]].add(row["feature"])

    return {
        "period": {"from": period.start.isoformat(), "to": period.end.isoformat(), "days": period.days},
        "today": today.isoformat(),
        "chart": {"from": chart_start.isoformat(), "to": chart_end.isoformat(), "days": CHART_DAYS},
        "months": [_months_back(_month_start(today), i).strftime("%Y-%m") for i in range(MONTHS - 1, -1, -1)],
        "month_to_date_days": today.day,
        "users": users,
        "daily": daily,
        "monthly": monthly,
        "models_seen": [{"model": m, "features": sorted(f)} for m, f in sorted(models.items())],
    }


# ── one user's recent work ───────────────────────────────────────────────────

async def user_detail(session: AsyncSession, user_id: int, limit: int = 8) -> dict[str, Any]:
    projects = (
        await session.execute(
            text(
                "SELECT uid, mode, status, engine, precision, brief, local_meta, created_at "
                f"FROM {_PROJECTS} WHERE user_id = :u ORDER BY created_at DESC LIMIT :n"
            ),
            {"u": user_id, "n": limit},
        )
    ).all()
    uids = [p.uid for p in projects]
    tok: dict[str, list[dict[str, Any]]] = defaultdict(list)
    stt: dict[str, list[dict[str, Any]]] = defaultdict(list)
    if uids:
        for r in (
            await session.execute(
                select(
                    LlmUsageLog.reference_id, LlmUsageLog.model, LlmUsageLog.feature, *_llm_fact_columns()
                )
                .where(LlmUsageLog.user_id == user_id, LlmUsageLog.reference_id.in_(uids))
                .group_by(LlmUsageLog.reference_id, LlmUsageLog.model, LlmUsageLog.feature)
            )
        ).all():
            tok[r[0]].append(_token_fact(r[1], r[2], r[3:]))
        for s_row in (
            await session.execute(
                select(SttUsageLog.reference_id, SttUsageLog.model, *_stt_fact_columns())
                .where(SttUsageLog.user_id == user_id, SttUsageLog.reference_id.in_(uids))
                .group_by(SttUsageLog.reference_id, SttUsageLog.model)
            )
        ).all():
            stt[s_row[0]].append(_stt_fact(s_row[1], s_row[2:]))

    jobs = []
    for p in projects:
        clips = (p.local_meta or {}).get("clips") if isinstance(p.local_meta, dict) else None
        footage = None
        if isinstance(clips, list):
            footage = round(sum(float(c.get("durationSec") or 0) for c in clips if isinstance(c, dict)), 1)
        brief = (p.brief or "").strip().splitlines()[0][:60] if (p.brief or "").strip() else None
        jobs.append(
            {
                "uid": p.uid,
                "name": brief,
                "mode": p.mode,
                "status": p.status,
                "engine": p.engine,
                "precision": p.precision,
                "footage_sec": footage,
                "created_at": _iso(p.created_at),
                "tokens": tok.get(p.uid, []),
                "stt": stt.get(p.uid, []),
            }
        )
    return {"user_id": user_id, "jobs": jobs}
