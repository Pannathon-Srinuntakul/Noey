"""Resuming a run the plan's window paused.

A run that exhausts the plan's quota does not fail — it PAUSES
(``guard.QuotaExhausted`` → ``video_projects.status = "paused_quota"``), keeping
everything it produced. What was missing until now was the other half: starting
again re-ran the whole pipeline, so the user paid a second time for work they
already had.

This module holds the small, shared pieces of the fix:

* the **resume ticket** (``video_projects.resume_state``) — written when a paid
  stage starts, so the SERVER knows which stage is in flight and exactly how to
  redo it; cleared when that stage succeeds. A paused project therefore carries
  the worker task + kwargs to re-enqueue, the estimate kind that prices ONLY
  the remaining stage, and the window/reset the pause hit;
* ``estimate_for`` — the remaining work's estimate, rebuilt from the ticket
  (never from the whole project): resuming charges for the interrupted stage,
  never for the boundaries already behind it;
* ``quota_view`` — whether the plan's windows still cover that estimate, when
  they roll, and what the top-up balance would have to pay if they do not.
  Percentages and baht only; never a token count (docs/token-billing-plan.md §2).

The endpoints that use all this are ``GET``/``POST /videos/{uid}/resume`` in
services/api/routers/videos_local.py, which also documents the client contract.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from packages.billing import estimate as estimator
from packages.billing import limits as limits_mod
from packages.billing import runs, wallet
from packages.billing.accounts import get_account
from packages.billing.estimate import Estimate
from packages.db.models.core_auth import User

#: Bumped when the ticket's shape changes in a way a reader must notice. A
#: ticket from an older version is ignored rather than guessed at — the resume
#: endpoint then falls back to inferring the stage from the files on disk.
TICKET_VERSION = 1

#: Stages the SERVER runs and charges for. Everything else in the pipeline is
#: the client's own machine doing free work.
SERVER_STAGES = ("analyze", "transcribe", "select", "reedit", "effects")


def ticket(
    *,
    stage: str,
    kind: str,
    task: str | None = None,
    kwargs: dict[str, Any] | None = None,
    job_id: str | None = None,
    media_sec: float = 0.0,
    frame_count: int | None = None,
    client_step: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The ticket for a paid stage that is STARTING.

    ``task``/``kwargs`` let the server re-enqueue the identical worker job with
    no help from the client (nothing is re-uploaded — the frames, proxies or
    WAVs this stage needs are already stored, and only a SUCCESSFUL stage purges
    them). ``client_step`` is the alternative for the one paid stage the client
    drives itself, the synchronous ``plan`` call: it carries the request body to
    repeat, because those numbers (the voiceover's length, the clip durations)
    exist only on the user's machine.
    """
    state: dict[str, Any] = {
        "v": TICKET_VERSION,
        "stage": stage,
        "kind": kind,
        "media_sec": round(max(0.0, float(media_sec or 0.0)), 3),
    }
    if task:
        state["task"] = task
        state["kwargs"] = dict(kwargs or {})
    if job_id:
        state["job_id"] = job_id
    if frame_count is not None:
        state["frame_count"] = int(frame_count)
    if client_step:
        state["client_step"] = client_step
    return state


def mark_paused(
    state: dict[str, Any] | None,
    *,
    stage: str | None = None,
    window: str | None = None,
    resets_at: datetime | None = None,
    wallet_can_cover: bool = False,
    wallet_satang: int = 0,
    run_id: str | None = None,
    message: str | None = None,
    at: datetime | None = None,
) -> dict[str, Any]:
    """The same ticket, stamped with why and when it stopped.

    A ticket that is missing (a pause from a build before this existed, or a
    stage that never wrote one) still produces a usable one: the pause facts
    alone are enough for the client to show the reset time and the top-up
    offer, and the endpoint infers the stage from the project's own artifacts.
    """
    out = dict(state or {})
    out.setdefault("v", TICKET_VERSION)
    if stage and not out.get("stage"):
        out["stage"] = stage
    out["paused"] = True
    out["reason"] = "quota"
    out["paused_at"] = runs.iso(at or datetime.now(UTC))
    out["window"] = window
    out["resets_at"] = runs.iso(resets_at)
    out["wallet_can_cover"] = bool(wallet_can_cover)
    out["wallet_satang"] = int(wallet_satang or 0)
    if run_id:
        out["paused_run_id"] = run_id
    if message:
        out["message"] = message
    return out


def is_current(state: Any) -> bool:
    """A ticket this code understands (and not, say, a hand-edited row)."""
    return isinstance(state, dict) and int(state.get("v") or 0) == TICKET_VERSION


def estimate_for(
    state: dict[str, Any] | None,
    *,
    engine: str | None = None,
    precision: str | None = None,
) -> Estimate | None:
    """What finishing costs: the INTERRUPTED stage only.

    Rebuilt from the ticket's own kind and the footage the server measured when
    that stage started — never from the project's full clip list, which would
    price the boundaries already paid for all over again.
    """
    if not is_current(state):
        return None
    kind = str((state or {}).get("kind") or "")
    if kind not in estimator.MODE_PROFILES:
        return None
    media = float((state or {}).get("media_sec") or 0.0)
    frames = (state or {}).get("frame_count")
    return estimator.estimate_run(
        kind=kind,
        engine=engine,
        precision=precision,
        clip_secs=[media] if media > 0 else (),
        frame_count=int(frames) if frames is not None else None,
    )


async def quota_view(
    session: AsyncSession,
    user: User,
    est: Estimate | None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Can the account pay for ``est`` right now, and if not, when or with what.

    ``session`` must already be on the ``core`` search_path. The shape mirrors
    ``POST /usage/estimate`` (docs/token-billing-design.md §19) so a client can
    reuse the same reader: ``fits`` is ``plan`` | ``wallet`` | ``none``, ``pct``
    is this run's share of each enforced window, and the money is baht (satang),
    never tokens.
    """
    at = now or datetime.now(UTC)
    if limits_mod.is_unlimited(user):
        return {
            "fits": "plan", "pct": {}, "wallet_satang": 0, "balance_satang": 0,
            "binding": None, "resets_at": None, "unlimited": True,
        }
    account = await get_account(session, int(user.id))
    plan = runs.effective_plan(user, account, at)
    views = runs.enforced_windows(plan, account, at)
    tokens = int(est.tokens) if est is not None else 0
    pct = {
        v.key: (round(tokens / v.limit * 100, 1) if v.limit > 0 else 100.0) for v in views
    }
    tightest = runs.binding_window(views)
    headroom = tightest.headroom if tightest is not None else tokens
    overflow = max(0, tokens - max(0, headroom))
    need_satang = wallet.satang_for_tokens(overflow)
    spare = 0
    if account is not None:
        spare = await wallet.balance(session, int(user.id), at) - int(
            account.wallet_reserved_satang or 0
        )
    fits = "plan"
    if overflow > 0:
        fits = "wallet" if spare >= need_satang else "none"
    return {
        "fits": fits,
        "pct": pct,
        "wallet_satang": need_satang,
        "balance_satang": max(0, spare),
        "binding": tightest.key if tightest is not None else None,
        "resets_at": runs.iso(tightest.resets_at) if tightest is not None else None,
        "unlimited": False,
    }
