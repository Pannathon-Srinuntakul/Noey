"""End the beta discount: move every live subscription onto its tier's full price.

    cd backend && python scripts/end_beta_pricing.py --check            # the December question
    cd backend && python scripts/end_beta_pricing.py                    # dry run (the default)
    cd backend && python scripts/end_beta_pricing.py --apply --live     # do it

Why this exists
---------------
The owner's 50% beta discount ends on 31 Dec 2026 with **no grandfathering**:
from the first billing cycle on or after 1 Jan 2027 every subscription pays the
full price, including accounts that subscribed during the beta. That promise is
printed on the pricing page, in the beta notice and inside the consent checkbox
a user ticks before paying.

Nothing else in this codebase keeps it. A Stripe Price is immutable, so both
paths that change a price — ``packages/admin/pricing.py`` and
``scripts/stripe_seed.py --reprice`` — create a NEW price, move the catalog
lookup key to it and ARCHIVE the old one. Archived is not deleted: every
existing subscription keeps renewing at the amount it signed up on, forever.
``service.subscriptions.update_async`` only ever runs when a user changes plan
themselves. This script is the missing step.

What it targets
---------------
The price that currently holds the tier's catalog lookup key — read exactly the
way checkout reads it (``service._active_price``) and the way GET /billing/plans
reads it (``service._fetch_plan_list``). Whatever holds the lookup key is what a
NEW subscriber is charged today, so it is the only defensible thing to charge an
existing one.

That means the full price must already hold the lookup key BEFORE this runs.
Put it there first, either way:

    cd backend && python scripts/stripe_seed.py --reprice     # from catalog.py
    # or the admin dashboard's plan-price editor (packages/admin/pricing.py)

As a guard against forgetting, ``--apply`` refuses when the price holding a
lookup key differs from that tier's amount in ``packages/billing/catalog.py``
(the owner-approved full ladder). ``--allow-off-catalog`` proceeds anyway — for
a real amount set by hand in the Stripe Dashboard, and for the mirror-image job
of putting everyone ON the beta price the day it starts (see "the other
direction" below).

Why proration_behavior="none"
-----------------------------
The rest of the codebase uses ``always_invoice`` (``portal.py`` for the portal's
plan switch, ``plan_switch.py`` for its preview) because there the CUSTOMER
asked for the change, saw the number and consented to it. Here nobody asked: the
price change is ours. ``always_invoice`` would bill the difference for the
remainder of a period the customer already paid for at the beta price — a
surprise card charge on the day the beta ends, on top of an unexpected price.
``create_prorations`` only defers the same surprise to the next invoice as an
extra line. ``none`` leaves the paid period completely alone: the new amount
first appears on the next renewal invoice, which is exactly the promise on the
pricing page ("รอบบิลถัดจากนั้นคิดราคาปกติ"). ``billing_cycle_anchor:
"unchanged"`` (also the default) keeps everyone's billing date where it is.

What each subscription state gets
---------------------------------
- **active / trialing / past_due** — moved. A trial converts at the new price;
  a past_due subscription is not charged anything now (``none`` creates no
  invoice), and its next successful renewal uses the new amount.
- **canceled / incomplete_expired / unpaid / paused / ended** — nothing to do:
  they never renew, and a canceled subscription cannot be updated at all. We do
  not even ask Stripe for the canceled ones (the list call's default is
  "everything not canceled"); the classifier still names the status in case one
  is canceled between the list and the update.
- **incomplete** — a checkout still in flight. It becomes active or expires
  within 23 hours; touching a half-paid subscription is not this script's job.
  Reported under "needs attention" so the owner re-runs the next day.
- **already scheduled to cancel** — skipped when the cancellation lands at the
  current period end (there is no next renewal, so the price would never be
  charged again). A ``cancel_at`` LATER than the period end still renews at
  least once, so those ARE moved.
- **carrying a subscription schedule** — never touched. The schedule owns the
  subscription's future phases and would overwrite (or fight) a direct item
  change; ``service.create_change_plan_session`` refuses these for the same
  reason. Reported under "needs attention".
- **carrying a pending_update** — never touched: a previous change is waiting
  for a payment to confirm, and writing over it would drop it silently.
  Reported under "needs attention".
- **a live subscription on a price that maps to no tier** — never guessed at.
  Same rule as ``service._apply``: a paying customer must not be repriced (or
  demoted) on a guess. Reported under "needs attention".
- **more than one item on the subscription** — not ours to reshape. Reported.

Safety
------
Dry run is the default and writes nothing; ``--apply`` is the only consent.
A live-mode key additionally needs ``--live``, like ``scripts/stripe_seed.py``.
Every write carries an idempotency key derived from (subscription, target
price), and a subscription already on the target price is skipped before any
write — so running twice is harmless and a run that dies halfway can simply be
re-run. Per-subscription failures are collected, never fatal, and every decision
is appended (flushed line by line) to a JSON-lines record under
``backend/data/billing/`` so the change is auditable afterwards.

Exit codes: 0 nothing left undone · 1 at least one live subscription was not
moved (a Stripe failure, or one this script refuses to touch unattended) ·
2 refused to run.

The other direction
-------------------
The same carry-over bug exists when the beta price is switched ON: someone who
subscribes at the full price the day before keeps paying full while the site
advertises the beta half-price. This script fixes that case too — it moves every
live subscription onto whatever the lookup key holds, in either direction — but
the catalog guard fires (the catalog holds the FULL ladder), so that run needs
``--apply --allow-off-catalog``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import pathlib
import sys
import time
from collections.abc import Iterator
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Self

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import stripe

from packages.billing import catalog, service
from packages.billing.client import STRIPE_API_VERSION, build_stripe_client, is_live_mode_key
from packages.billing.objects import field, id_of, items_of
from packages.core.settings import get_settings

if TYPE_CHECKING:
    from stripe.params import SubscriptionListParams, SubscriptionUpdateParams

#: Stripe's maximum page size. Pagination is by cursor (see `iter_subscriptions`).
PAGE_SIZE = 100

#: Refuse to loop forever if `has_more` never goes false (100 000 subscriptions).
MAX_PAGES = 1_000

#: Live mode allows ~100 writes/second. A short pause between updates keeps a
#: few thousand subscriptions comfortably under that without a retry storm.
WRITE_PAUSE_SEC = 0.05

#: Written on every subscription this script moves, so the change is visible in
#: the Stripe Dashboard too. Deliberately NOT a timestamp: the update params
#: have to be byte-identical across runs or the idempotency key would be reused
#: with different parameters, which Stripe rejects. The "when" is in the record
#: file and in Stripe's own event log.
MIGRATED_FROM_KEY = "noey_price_migrated_from"

#: A `cancel_at` within this of the period end counts as "cancels at period end".
CANCEL_AT_PERIOD_END_SLACK_SEC = 60

_ACTION_MOVE = "move"
_ACTION_SKIP = "skip"
_ACTION_ATTENTION = "attention"
_ACTION_FAILED = "failed"


def _say(message: str = "") -> None:
    print(message, flush=True)


def _thb(satang: int | None) -> str:
    return "?" if satang is None else f"{satang / 100:,.2f} THB"


def _signed_thb(satang: int) -> str:
    return f"{'+' if satang >= 0 else '-'}{abs(satang) / 100:,.2f} THB"


# ── the target prices ─────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Target:
    tier: str
    lookup_key: str
    price_id: str
    unit_amount: int


def load_targets(client: stripe.StripeClient) -> tuple[dict[str, Target], list[str]]:
    """tier → the price its catalog lookup key points at right now, and what is wrong.

    Same read as ``service._active_price`` / ``service._fetch_plan_list``: by
    lookup key, active only, one page (there are six tiers).
    """
    page = client.v1.prices.list(
        {
            "lookup_keys": [p.lookup_key for p in catalog.PAID_PLANS],
            "active": True,
            "limit": len(catalog.PAID_PLANS),
        }
    )
    by_key = {str(field(p, "lookup_key")): p for p in page.data}
    targets: dict[str, Target] = {}
    problems: list[str] = []
    for plan in catalog.PAID_PLANS:
        price = by_key.get(plan.lookup_key)
        if price is None:
            problems.append(
                f"{plan.tier}: no active price holds {plan.lookup_key} — run scripts/stripe_seed.py"
            )
            continue
        amount = field(price, "unit_amount")
        if not service._price_is_usable(price) or not isinstance(amount, int):
            problems.append(
                f"{plan.tier}: the price holding {plan.lookup_key} is not a monthly "
                f"{catalog.CURRENCY.upper()} price with an amount"
            )
            continue
        targets[plan.tier] = Target(plan.tier, plan.lookup_key, str(field(price, "id")), int(amount))
    return targets, problems


def catalog_mismatches(targets: dict[str, Target]) -> list[str]:
    """Tiers whose live price is not the owner-approved amount in catalog.py."""
    out: list[str] = []
    for plan in catalog.PAID_PLANS:
        target = targets.get(plan.tier)
        if target is not None and target.unit_amount != plan.mock_unit_amount:
            out.append(
                f"{plan.tier}: {plan.lookup_key} holds {_thb(target.unit_amount)}, "
                f"packages/billing/catalog.py says {_thb(plan.mock_unit_amount)}"
            )
    return out


# ── reading one subscription ──────────────────────────────────────────────────

@dataclass(frozen=True)
class SubFacts:
    id: str
    customer: str | None
    status: str
    live: bool
    tier: str | None
    item_id: str | None
    price_id: str | None
    unit_amount: int | None
    quantity: int
    item_count: int
    schedule: str | None
    pending_update: bool
    ends_before_renewal: bool
    period_end: dt.datetime | None


def _ends_before_renewal(sub: Any) -> bool:
    """True when this subscription will never renew, so its price never applies again.

    ``service._scheduled_to_end`` answers the coarser "is it ending at all";
    a ``cancel_at`` set BEYOND the current period end still renews at least
    once, and that renewal must be at the full price.
    """
    if field(sub, "cancel_at_period_end"):
        return True
    cancel_at = field(sub, "cancel_at")
    if not isinstance(cancel_at, int):
        return False
    period_end = service._period_end(sub)
    if period_end is None:
        return True
    return cancel_at <= period_end.timestamp() + CANCEL_AT_PERIOD_END_SLACK_SEC


def read_facts(sub: Any) -> SubFacts:
    items = items_of(sub)
    item = items[0] if len(items) == 1 else None
    price = field(item, "price")
    amount = field(price, "unit_amount")
    quantity = field(item, "quantity")
    status = str(field(sub, "status") or "")
    return SubFacts(
        id=str(field(sub, "id")),
        customer=id_of(field(sub, "customer")),
        status=status,
        live=catalog.is_live(status),
        tier=service.tier_for_subscription(sub) if item is not None else None,
        item_id=id_of(field(item, "id")),
        price_id=id_of(field(price, "id")),
        unit_amount=int(amount) if isinstance(amount, int) else None,
        quantity=int(quantity) if isinstance(quantity, int) and quantity > 0 else 1,
        item_count=len(items),
        schedule=id_of(field(sub, "schedule")),
        pending_update=field(sub, "pending_update") is not None,
        ends_before_renewal=_ends_before_renewal(sub),
        period_end=service._period_end(sub),
    )


# ── the decision ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Decision:
    action: str
    reason: str
    target: Target | None = None


def decide(facts: SubFacts, targets: dict[str, Target], only_tiers: frozenset[str]) -> Decision:
    """What this subscription gets. Every branch is explained in the module docstring."""
    if facts.status == "incomplete":
        return Decision(_ACTION_ATTENTION, "incomplete: a checkout is still in flight — re-run tomorrow")
    if not facts.live:
        return Decision(_ACTION_SKIP, f"status {facts.status or 'unknown'}: never renews")
    if facts.item_count != 1:
        return Decision(_ACTION_ATTENTION, f"{facts.item_count} subscription items — not ours to reshape")
    if facts.tier is None:
        return Decision(_ACTION_ATTENTION, "live on a price that maps to no tier — never guess a tier")
    target = targets.get(facts.tier)
    if target is None:  # pragma: no cover — a missing tier refuses the whole run earlier
        return Decision(_ACTION_ATTENTION, f"no active price for tier {facts.tier}")
    if facts.price_id == target.price_id:
        return Decision(_ACTION_SKIP, "already on the target price", target)
    if only_tiers and facts.tier not in only_tiers:
        return Decision(_ACTION_SKIP, f"tier {facts.tier} not selected for this run", target)
    if facts.schedule:
        return Decision(_ACTION_ATTENTION, f"a subscription schedule ({facts.schedule}) owns its phases", target)
    if facts.pending_update:
        return Decision(_ACTION_ATTENTION, "a pending update is waiting for payment", target)
    if facts.ends_before_renewal:
        return Decision(_ACTION_SKIP, "already ending at the period end: no renewal to reprice", target)
    if facts.item_id is None:  # pragma: no cover — an item always carries an id
        return Decision(_ACTION_ATTENTION, "the subscription item has no id", target)
    return Decision(_ACTION_MOVE, "on an older price", target)


# ── Stripe reads and the one write ────────────────────────────────────────────

def iter_subscriptions(client: stripe.StripeClient) -> Iterator[Any]:
    """Every subscription that can still renew, page by page.

    No ``status`` filter: Stripe's default is "everything that is not canceled",
    which is exactly the set worth looking at. No ``price`` filter either — the
    list would change under the cursor as subscriptions move off that price, and
    whole pages would be skipped. Sorted by creation date, which nothing here
    touches, so the cursor stays valid for the length of the run.
    """
    params: SubscriptionListParams = {"limit": PAGE_SIZE}
    for _ in range(MAX_PAGES):
        page = client.v1.subscriptions.list(params)
        data = list(page.data)
        if not data:
            return
        yield from data
        if not field(page, "has_more"):
            return
        params = {**params, "starting_after": str(field(data[-1], "id"))}
    _say(f"  WARNING: stopped after {MAX_PAGES} pages — re-run to continue")


def move_subscription(client: stripe.StripeClient, facts: SubFacts, target: Target) -> Any:
    """Put the subscription on ``target``, effective at its next renewal."""
    params: SubscriptionUpdateParams = {
        "items": [{"id": str(facts.item_id), "price": target.price_id}],
        # See the module docstring: the customer did not ask for this change,
        # so nothing may be charged for the period they already paid for.
        "proration_behavior": "none",
        "billing_cycle_anchor": "unchanged",
        "metadata": {MIGRATED_FROM_KEY: facts.price_id or ""},
    }
    # Deterministic per (subscription, target price): a re-run within Stripe's
    # 24-hour idempotency window replays instead of applying twice.
    key = f"noey-end-beta-{facts.id}-{target.price_id}"
    return client.v1.subscriptions.update(facts.id, params, {"idempotency_key": key})


# ── the record ────────────────────────────────────────────────────────────────

class Recorder:
    """Appends one JSON object per line, flushed, so a crash leaves the truth."""

    def __init__(self, path: pathlib.Path | None) -> None:
        self.path = path
        self._fh: Any = None

    def __enter__(self) -> Self:
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._fh = self.path.open("a", encoding="utf-8")
        return self

    def __exit__(self, *_: object) -> None:
        if self._fh is not None:
            self._fh.close()
            self._fh = None

    def write(self, row: dict[str, Any]) -> None:
        if self._fh is None:
            return
        self._fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        self._fh.flush()


def default_record_path(mode: str, now: dt.datetime) -> pathlib.Path:
    backend = pathlib.Path(__file__).resolve().parent.parent
    return backend / "data" / "billing" / f"end-beta-pricing-{mode}-{now:%Y%m%dT%H%M%SZ}.jsonl"


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


# ── check mode ────────────────────────────────────────────────────────────────

def run_check(client: stripe.StripeClient, targets: dict[str, Target], recorder: Recorder) -> int:
    """How many live subscriptions are below the full price, and what that costs.

    Measured against the FULL ladder in ``packages/billing/catalog.py``, not
    against whatever holds the lookup key: while the beta runs, the lookup key
    holds the beta price, so comparing against it would answer "nothing to do"
    every time. The catalog is the owner-approved full price.
    """
    full = {p.tier: p.mock_unit_amount for p in catalog.PAID_PLANS}
    live = at_full = below = other = 0
    now_satang = after_satang = 0
    per_tier: dict[str, int] = {}

    for sub in iter_subscriptions(client):
        facts = read_facts(sub)
        if not facts.live:
            continue
        live += 1
        target_amount = full.get(facts.tier or "")
        if facts.tier is None or target_amount is None or facts.unit_amount is None or facts.item_count != 1:
            other += 1
            recorder.write({"type": "subscription", "mode": "check", "id": facts.id, "state": "unmappable",
                            "status": facts.status, "tier": facts.tier, "items": facts.item_count})
            continue
        current = facts.unit_amount * facts.quantity
        target_total = target_amount * facts.quantity
        now_satang += current
        after_satang += max(current, target_total)
        state = "at_full"
        if current < target_total:
            below += 1
            per_tier[facts.tier] = per_tier.get(facts.tier, 0) + 1
            state = "below_full"
        else:
            at_full += 1
        recorder.write({"type": "subscription", "mode": "check", "id": facts.id, "state": state,
                        "customer": facts.customer, "status": facts.status, "tier": facts.tier,
                        "price": facts.price_id, "unit_amount": facts.unit_amount,
                        "quantity": facts.quantity, "full_unit_amount": target_amount,
                        "ends_before_renewal": facts.ends_before_renewal,
                        "current_period_end": _iso(facts.period_end)})

    delta = after_satang - now_satang
    _say("")
    _say(f"Live subscriptions: {live}")
    _say(f"  already at the full price : {at_full}")
    _say(f"  below the full price      : {below}" + (
        "  (" + ", ".join(f"{t} {n}" for t, n in sorted(per_tier.items())) + ")" if per_tier else ""))
    if other:
        _say(f"  not mappable to a tier    : {other}  (excluded from the numbers below)")
    _say("")
    _say(f"Monthly now            : {_thb(now_satang)}")
    _say(f"Monthly once all move  : {_thb(after_satang)}")
    _say(f"Difference             : {_signed_thb(delta)} per month")
    _say("")
    mismatches = catalog_mismatches(targets)
    if mismatches:
        _say("The catalog lookup keys do NOT hold the full price yet:")
        for line in mismatches:
            _say(f"  {line}")
        _say("  Put the full price on them first (scripts/stripe_seed.py --reprice, or the")
        _say("  admin dashboard's plan-price editor), then run this script with --apply.")
    else:
        _say("The catalog lookup keys hold the full price: --apply is ready to run.")
    recorder.write({"type": "summary", "mode": "check", "live": live, "at_full": at_full,
                    "below_full": below, "unmappable": other, "per_tier": per_tier,
                    "monthly_now_satang": now_satang, "monthly_after_satang": after_satang,
                    "monthly_delta_satang": delta, "catalog_mismatches": mismatches})
    return 0


# ── dry run / apply ───────────────────────────────────────────────────────────

def run_migration(
    client: stripe.StripeClient,
    targets: dict[str, Target],
    recorder: Recorder,
    *,
    apply: bool,
    only_tiers: frozenset[str],
    limit: int | None,
) -> int:
    counts: dict[str, int] = {}
    attention: list[tuple[str, str]] = []
    failures: list[tuple[str, str]] = []
    delta_satang = 0
    moved = 0

    for sub in iter_subscriptions(client):
        facts = read_facts(sub)
        decision = decide(facts, targets, only_tiers)
        if limit is not None and decision.action == _ACTION_MOVE and moved >= limit:
            decision = Decision(_ACTION_SKIP, f"--limit {limit} reached", decision.target)
        counts[decision.action] = counts.get(decision.action, 0) + 1

        row: dict[str, Any] = {
            "type": "subscription",
            "mode": "apply" if apply else "dry-run",
            "id": facts.id,
            "customer": facts.customer,
            "status": facts.status,
            "tier": facts.tier,
            "action": decision.action,
            "reason": decision.reason,
            "applied": False,
            "before": {"price": facts.price_id, "unit_amount": facts.unit_amount, "quantity": facts.quantity},
            "after": (
                {"price": decision.target.price_id, "unit_amount": decision.target.unit_amount,
                 "quantity": facts.quantity}
                if decision.target is not None else None
            ),
            "current_period_end": _iso(facts.period_end),
        }

        if decision.action == _ACTION_ATTENTION:
            attention.append((facts.id, decision.reason))
            _say(f"  {facts.id}  {facts.status:<9} {facts.tier or '-':<8} ATTENTION: {decision.reason}")
        elif decision.action == _ACTION_SKIP:
            pass  # counted; the record file has every one of them
        else:
            target = decision.target
            assert target is not None
            step = (target.unit_amount - (facts.unit_amount or 0)) * facts.quantity
            arrow = f"{_thb(facts.unit_amount):>14} -> {_thb(target.unit_amount):<14}"
            if not apply:
                moved += 1
                delta_satang += step
                _say(f"  {facts.id}  {facts.status:<9} {facts.tier:<8} {arrow}   would move")
            else:
                try:
                    updated = move_subscription(client, facts, target)
                except stripe.StripeError as exc:
                    detail = f"{type(exc).__name__}({exc.code or '-'}): {exc}"
                    failures.append((facts.id, detail))
                    counts[_ACTION_FAILED] = counts.get(_ACTION_FAILED, 0) + 1
                    counts[_ACTION_MOVE] -= 1
                    row["action"] = _ACTION_FAILED
                    row["error"] = {"type": type(exc).__name__, "code": exc.code, "message": str(exc)}
                    _say(f"  {facts.id}  {facts.status:<9} {facts.tier:<8} FAILED: {detail}")
                    recorder.write(row)
                    continue
                after = read_facts(updated)
                row["applied"] = True
                row["after"] = {"price": after.price_id, "unit_amount": after.unit_amount,
                                "quantity": after.quantity}
                moved += 1
                delta_satang += step
                landed = "" if after.price_id == target.price_id else "  WARNING: not on the target price"
                _say(f"  {facts.id}  {facts.status:<9} {facts.tier:<8} {arrow}   moved{landed}")
                time.sleep(WRITE_PAUSE_SEC)
        recorder.write(row)

    _say("")
    verb = "Moved" if apply else "Would move"
    _say(f"{verb}: {moved}   skipped: {counts.get(_ACTION_SKIP, 0)}   "
         f"needs attention: {len(attention)}   failed: {len(failures)}")
    _say(f"Monthly difference from this run: {_signed_thb(delta_satang)}")
    _say("Each moved subscription keeps its billing date; the new amount first "
         "appears on its next renewal invoice.")
    if attention:
        _say("")
        _say("Needs attention (NOT moved — decide by hand in the Stripe Dashboard):")
        for sub_id, reason in attention:
            _say(f"  {sub_id}: {reason}")
    if failures:
        _say("")
        _say("Failed (re-running this script retries exactly these — everything already "
             "moved is skipped):")
        for sub_id, detail in failures:
            _say(f"  {sub_id}: {detail}")
    if not apply:
        _say("")
        _say("Dry run: nothing was changed. Re-run with --apply to write.")

    recorder.write({"type": "summary", "mode": "apply" if apply else "dry-run", "moved": moved,
                    "counts": counts, "monthly_delta_satang": delta_satang,
                    "attention": [{"id": i, "reason": r} for i, r in attention],
                    "failures": [{"id": i, "error": e} for i, e in failures]})
    return 1 if (failures or attention) else 0


# ── entry point ───────────────────────────────────────────────────────────────

def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument(
        "--apply", action="store_true",
        help="actually move the subscriptions (without it the script only prints what it would do)",
    )
    parser.add_argument(
        "--check", action="store_true",
        help="answer, changing nothing: how many live subscriptions are still below the full "
             "price, and what the monthly difference is once they all move",
    )
    parser.add_argument(
        "--live", action="store_true",
        help="allow running with a LIVE key (sk_live_/rk_live_) — this moves real money",
    )
    parser.add_argument(
        "--allow-off-catalog", action="store_true",
        help="apply even though a lookup key holds an amount that differs from "
             "packages/billing/catalog.py (a price set by hand, or the beta price going ON)",
    )
    parser.add_argument(
        "--tier", action="append", default=[], metavar="TIER",
        help="only move this tier (repeatable) — for a cautious first run",
    )
    parser.add_argument("--limit", type=int, default=None, help="stop after moving this many subscriptions")
    parser.add_argument("--record", default=None, metavar="PATH", help="where the JSON-lines record goes")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.check and args.apply:
        _say("Refusing to run: --check answers a question, --apply changes money. Pick one.")
        return 2
    if args.limit is not None and args.limit < 1:
        _say("Refusing to run: --limit must be at least 1.")
        return 2
    only_tiers = frozenset(str(t).strip().lower() for t in args.tier)
    unknown = sorted(t for t in only_tiers if catalog.plan_for_tier(t) is None)
    if unknown:
        _say(f"Refusing to run: --tier {', '.join(unknown)} is not a paid plan.")
        return 2

    settings = get_settings()
    key = (settings.stripe_secret_key or "").strip()
    if not key:
        _say("Refusing to run: STRIPE_SECRET_KEY is not set (environment or .env).")
        return 2
    if not key.startswith(("sk_", "rk_")):
        _say("Refusing to run: STRIPE_SECRET_KEY must be a secret (sk_) or restricted (rk_) key.")
        return 2
    live_key = is_live_mode_key(key)
    if live_key and not args.live:
        _say("Refusing to run: this is a LIVE key. Re-run with --live when you mean it.")
        return 2

    mode = "check" if args.check else ("apply" if args.apply else "dry-run")
    started = dt.datetime.now(dt.UTC)
    client = build_stripe_client(key, asynchronous=False)
    _say(f"Stripe {'LIVE' if live_key else 'test/sandbox'} mode · API {STRIPE_API_VERSION} · {mode}")

    try:
        targets, problems = load_targets(client)
    except stripe.StripeError as exc:
        _say(f"Stripe refused: {type(exc).__name__}: {exc}")
        _say("A restricted key needs Prices READ and Subscriptions WRITE to run this.")
        return 2
    if problems:
        _say("Refusing to run — the plan catalog is not complete in Stripe:")
        for line in problems:
            _say(f"  {line}")
        return 2

    _say("Target price per tier (whatever holds the catalog lookup key today):")
    for plan in catalog.PAID_PLANS:
        target = targets[plan.tier]
        same = target.unit_amount == plan.mock_unit_amount
        note = "" if same else f"   != catalog {_thb(plan.mock_unit_amount)}"
        _say(f"  {plan.tier:<8} {target.price_id:<24} {_thb(target.unit_amount):>14}{note}")

    if mode == "apply":
        mismatches = catalog_mismatches(targets)
        if mismatches and not args.allow_off_catalog:
            _say("")
            _say("Refusing to apply — a lookup key does not hold the catalog amount:")
            for line in mismatches:
                _say(f"  {line}")
            _say("  Most likely the full price is not back on the lookup key yet. Put it there")
            _say("  (scripts/stripe_seed.py --reprice, or the admin dashboard's price editor),")
            _say("  or re-run with --allow-off-catalog if the live amount is deliberate.")
            return 2

    record_path: pathlib.Path | None
    if args.record:
        record_path = pathlib.Path(args.record).expanduser()
    else:
        # A check answers a question; only a run that decides something leaves a file.
        record_path = None if mode == "check" else default_record_path(mode, started)
    if record_path is not None:
        _say(f"Record: {record_path}")
    _say("")

    with Recorder(record_path) as recorder:
        recorder.write({
            "type": "run", "mode": mode, "started_at": started.isoformat(),
            "stripe_mode": "live" if live_key else "test", "api_version": STRIPE_API_VERSION,
            "tiers": sorted(only_tiers) or None, "limit": args.limit,
            "allow_off_catalog": bool(args.allow_off_catalog),
            "targets": {t.tier: {"price": t.price_id, "unit_amount": t.unit_amount} for t in targets.values()},
        })
        try:
            if mode == "check":
                return run_check(client, targets, recorder)
            return run_migration(
                client, targets, recorder,
                apply=(mode == "apply"), only_tiers=only_tiers, limit=args.limit,
            )
        except stripe.StripeError as exc:
            # Only a LIST call can land here; per-subscription failures are caught
            # where they happen and never stop the run.
            _say(f"Stripe refused while reading subscriptions: {type(exc).__name__}: {exc}")
            _say("Re-run: everything already moved is skipped.")
            recorder.write({"type": "aborted", "error": str(exc)})
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
