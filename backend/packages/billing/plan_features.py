"""Per-plan feature rules the website promises (docs/token-billing-plan.md §8).

The source of truth is the pricing page (noey-frontend/src/lib/plans.ts); the
numbers live in ``limits.PLAN_LIMITS``. Admin / internal / enterprise accounts
(``limits.is_unlimited``) pass every check.

Each check returns ``None`` when allowed, else the refusal body a route turns
into an HTTP error — a dict with a stable ``code`` the clients branch on and a
Thai ``message`` they can show as is:

- ``footage_over_limit`` (422): total footage above the plan's per-project cap
  — or, for a mode that sends the whole project to the model in ONE video
  request, above what that request can hold at the chosen ความละเอียด;
- ``run_too_large`` (422): the run cannot fit an enforced window even empty;
- ``project_limit`` (403): creating one more project than the plan keeps.
  Existing projects past the cap stay openable and editable — only a NEW one
  is refused, nothing is ever deleted (owner, 2026-09-22);
- ``plan_feature`` (403): background music (Lite and up) or server file
  conversion (Starter and up).
"""

from __future__ import annotations

from typing import Any, Literal

from packages.billing import catalog
from packages.billing.limits import (
    VIDEO_CALL_MODES,
    is_unlimited,
    plan_limits,
    video_call_footage_sec,
    window_limit,
)

Feature = Literal["music", "transcode"]

#: A proxy re-encode can come out a frame or two longer than the source;
#: never refuse footage that sits exactly on the cap.
FOOTAGE_TOLERANCE_SEC = 5.0

#: Estimate kinds whose ``media_sec`` is the project's footage.
FOOTAGE_KINDS = frozenset({"analyze_video", "transcribe_audio", "analyze_frames", "server_pipeline"})

_FEATURE_TEXT: dict[str, str] = {
    "music": "เพลงประกอบ",
    "transcode": "การแปลงไฟล์ที่เบราว์เซอร์เปิดไม่ได้",
}

#: The editor's Thai window names (web/src/lib/usageLimits.ts LIMIT_LABELS).
_WINDOW_TEXT: dict[str, str] = {
    "five_hour": "โควตารอบ 5 ชั่วโมง",
    "weekly": "โควตารายสัปดาห์",
    "monthly": "โควตารายเดือน",
}

_PLAN_LABEL: dict[str, str] = {
    "free": "ฟรี", "lite": "Lite", "starter": "Starter", "pro": "Pro",
    "studio": "Studio", "agency": "Agency", "max": "Max",
}


def _plan(user: Any) -> str:
    return str(getattr(user, "plan", None) or catalog.FREE_TIER)


def minimum_plan(feature: Feature) -> str:
    """The cheapest plan that has ``feature``."""
    from packages.billing.limits import PLAN_LIMITS

    for tier in ("free", "lite", "starter", "pro", "studio", "agency", "max"):
        if getattr(PLAN_LIMITS[tier], feature):
            return tier
    return "max"


def _fmt_minutes(sec: float) -> str:
    minutes = sec / 60.0
    if minutes >= 60 and float(minutes).is_integer() and minutes % 60 == 0:
        return f"{int(minutes // 60)} ชั่วโมง"
    if minutes >= 10:
        return f"{round(minutes)} นาที"
    return f"{round(minutes, 1):g} นาที"


def footage_limit_sec(
    user: Any, *, mode: str | None = None, precision: str | None = None
) -> int | None:
    """The shortest cap that applies: the plan's, and — for a mode that sends
    the whole project to the model in one request — what that request can
    hold at ``precision`` (limits.video_call_footage_sec).

    An unlimited account skips the PLAN cap but not the request one: no plan
    can make a 2-hour request fit a 1 M-token context.
    """
    unlimited = is_unlimited(user)
    plan_cap = None if unlimited else plan_limits(_plan(user)).footage_sec
    if mode not in VIDEO_CALL_MODES:
        return plan_cap
    call_cap = video_call_footage_sec(precision, unlimited=unlimited)
    return call_cap if plan_cap is None else min(plan_cap, call_cap)


def check_footage(
    user: Any, total_sec: float, *, mode: str | None = None, precision: str | None = None
) -> dict[str, Any] | None:
    limit = footage_limit_sec(user, mode=mode, precision=precision)
    if limit is None or total_sec <= limit + FOOTAGE_TOLERANCE_SEC:
        return None
    # Say which knob moves the cap. When the request — not the plan — is what
    # binds, changing plan would not help; lowering ความละเอียด would.
    plan_cap = None if is_unlimited(user) else plan_limits(_plan(user)).footage_sec
    by_precision = mode in VIDEO_CALL_MODES and (plan_cap is None or limit < plan_cap)
    if by_precision:
        standard = video_call_footage_sec("standard")
        advice = (
            f"ลดความละเอียดเป็น Standard (รับได้ถึง {_fmt_minutes(standard)}) หรือตัดฟุตเทจให้สั้นลง"
            if (precision or "standard") != "standard"
            else "ตัดให้สั้นลงหรือแยกเป็นสองโปรเจกต์"
        )
        reason = " ที่ความละเอียดนี้"
    else:
        advice = "ตัดให้สั้นลงหรือแยกเป็นสองโปรเจกต์"
        reason = "ของแผนนี้"
    return {
        "code": "footage_over_limit",
        "limit_sec": limit,
        "total_sec": round(float(total_sec), 1),
        "plan": _plan(user),
        "by_precision": by_precision,
        "message": (
            f"ฟุตเทจรวม {_fmt_minutes(total_sec)} เกินเพดาน {_fmt_minutes(limit)}{reason} — {advice}"
        ),
    }


def check_run_size(user: Any, tokens: int) -> dict[str, Any] | None:
    """The ONE pre-flight quota check left (owner, 2026-09-26): refuse a run
    that fits NO enforced window even when that window is completely empty.
    Nothing else is checked before starting — a run that might fit is started
    and charged as it goes (packages/billing/runs.py).

    Measured against the BIGGEST window, not every one: Pro's 5-hour window is
    40 % of its weekly one, so an hour of footage outgrows it however empty it
    is, and a run is allowed to overshoot a window it cannot fit
    (``runs.windows_for_run``). Only a run past them all is impossible.

    Waiting for a reset or topping up cannot make this run work, so it is a
    422 (the request's shape), not a 402 (the balance).
    """
    if is_unlimited(user) or tokens <= 0:
        return None
    plan = _plan(user)
    windows = plan_limits(plan).windows
    if not windows:
        return None
    key = max(windows, key=lambda w: window_limit(plan, w))
    if tokens <= window_limit(plan, key):
        return None
    return {
        "code": "run_too_large",
        "window": key,
        "plan": plan,
        "message": (
            f"งานนี้ใหญ่เกิน{_WINDOW_TEXT.get(key, 'โควตา')}ทั้งรอบของแผนนี้ "
            "แม้โควตาจะยังไม่ได้ใช้เลยก็ทำไม่สำเร็จ — "
            "ตัดฟุตเทจให้สั้นลง ลดความละเอียด หรือเปลี่ยนแผน"
        ),
    }


def project_limit(user: Any) -> int | None:
    return None if is_unlimited(user) else plan_limits(_plan(user)).max_projects


def check_new_project(user: Any, existing: int, adding: int = 1) -> dict[str, Any] | None:
    limit = project_limit(user)
    if limit is None or existing + max(1, adding) <= limit:
        return None
    return {
        "code": "project_limit",
        "limit": limit,
        "count": int(existing),
        "plan": _plan(user),
        "message": (
            f"แผนนี้เก็บโปรเจกต์ได้ {limit} โปรเจกต์ ลบโปรเจกต์เก่าหรือเปลี่ยนแผนเพื่อสร้างใหม่ "
            "โปรเจกต์เดิมยังเปิดและแก้ได้ตามปกติ"
        ),
    }


def has_feature(user: Any, feature: Feature) -> bool:
    return is_unlimited(user) or bool(getattr(plan_limits(_plan(user)), feature))


def check_feature(user: Any, feature: Feature) -> dict[str, Any] | None:
    if has_feature(user, feature):
        return None
    need = minimum_plan(feature)
    return {
        "code": "plan_feature",
        "feature": feature,
        "required_plan": need,
        "plan": _plan(user),
        "message": _feature_message(feature, _PLAN_LABEL.get(need, need)),
    }


def _feature_message(feature: Feature, plan_label: str) -> str:
    base = f"{_FEATURE_TEXT[feature]}ใช้ได้ตั้งแต่แผน {plan_label} ขึ้นไป"
    if feature == "transcode":
        # Reaches the user as a failed import: say what to do about the file.
        return f"ไฟล์นี้เบราว์เซอร์เปิดไม่ได้ และ{base} — แปลงเป็น MP4 (H.264) ก่อนแล้วลองใหม่ หรือเปลี่ยนแผน"
    return base


def queue_lead_sec(user: Any) -> int:
    """How far ahead of "now" this user's jobs are scored in the arq queue."""
    from packages.billing.limits import QUEUE_LEAD_FIRST_SEC

    if user is None:
        return 0
    if is_unlimited(user):
        return QUEUE_LEAD_FIRST_SEC
    return plan_limits(_plan(user)).queue_lead_sec


def features_payload(user: Any) -> dict[str, Any]:
    """The plan's feature facts for ``GET /usage/me`` (clients lock controls
    and refuse over-limit uploads before sending anything)."""
    from packages.billing.limits import QUEUE_LEAD_FIRST_SEC

    unlimited = is_unlimited(user)
    lim = plan_limits(_plan(user))
    lead = QUEUE_LEAD_FIRST_SEC if unlimited else lim.queue_lead_sec
    return {
        "footage_sec": None if unlimited else lim.footage_sec,
        # The single-video-request cap per ความละเอียด, so a client can refuse
        # over-long footage before uploading anything (it is not a plan number:
        # it binds unlimited accounts too).
        "video_call_footage_sec": {
            "standard": video_call_footage_sec("standard"),
            "high": video_call_footage_sec("high"),
        },
        "video_call_modes": sorted(VIDEO_CALL_MODES),
        "max_projects": None if unlimited else lim.max_projects,
        "music": unlimited or lim.music,
        "transcode": unlimited or lim.transcode,
        "music_min_plan": minimum_plan("music"),
        "transcode_min_plan": minimum_plan("transcode"),
        "queue": "first" if lead >= QUEUE_LEAD_FIRST_SEC else ("ahead" if lead > 0 else "normal"),
    }
