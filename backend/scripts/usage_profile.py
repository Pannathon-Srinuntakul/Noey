"""Measure per-call token profiles from recorded usage — the estimator's constants.

    cd backend && python scripts/usage_profile.py [--days 90] [--include-tests]

Prints p50 / p90 / p99 / max of input, cached and output tokens per
``feature`` × model (successful calls only), plus billed seconds per STT file.
packages/billing/estimate.py's MODE_PROFILES are set from this output; re-run
it against production and update the module docstring + ESTIMATOR_VERSION when
prompts or models change enough to move p99.

Accounts on ``*.example.com`` are the test suite's and are skipped unless
``--include-tests``. Read-only.
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from sqlalchemy import text

from packages.db.session import get_engine

_LLM = """
SELECT l.feature,
       regexp_replace(l.model, '^.*/', '') AS model,
       count(*) AS n,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY l.input_tokens)  AS in50,
       percentile_disc(0.9)  WITHIN GROUP (ORDER BY l.input_tokens)  AS in90,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY l.input_tokens)  AS in99,
       max(l.input_tokens) AS in_max,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY l.cached_tokens) AS cached50,
       percentile_disc(0.5)  WITHIN GROUP (ORDER BY l.output_tokens) AS out50,
       percentile_disc(0.9)  WITHIN GROUP (ORDER BY l.output_tokens) AS out90,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY l.output_tokens) AS out99,
       max(l.output_tokens) AS out_max
FROM core.llm_usage_logs l JOIN core.users u ON u.id = l.user_id
WHERE l.created_at >= now() - make_interval(days => :days)
  AND l.status = 'ok'
  AND (:tests OR u.email NOT LIKE '%.example.com')
GROUP BY 1, 2 ORDER BY 1, 2
"""

_STT = """
SELECT s.model, count(*) AS n,
       percentile_disc(0.5) WITHIN GROUP (ORDER BY s.audio_sec) AS sec50,
       percentile_disc(0.99) WITHIN GROUP (ORDER BY s.audio_sec) AS sec99,
       sum(s.audio_sec) AS total_sec
FROM core.stt_usage_logs s JOIN core.users u ON u.id = s.user_id
WHERE s.created_at >= now() - make_interval(days => :days)
  AND (:tests OR u.email NOT LIKE '%.example.com')
GROUP BY 1 ORDER BY 1
"""


async def main(days: int, tests: bool) -> None:
    async with get_engine().connect() as conn:
        llm = (await conn.execute(text(_LLM), {"days": days, "tests": tests})).all()
        stt = (await conn.execute(text(_STT), {"days": days, "tests": tests})).all()
    await get_engine().dispose()

    head = (
        f"{'feature':<14} {'model':<24} {'n':>5}  {'in p50':>8} {'p90':>8} {'p99':>8} {'max':>8}"
        f"  {'cached50':>8}  {'out p50':>8} {'p90':>8} {'p99':>8} {'max':>8}"
    )
    print(f"LLM calls, last {days} days (status=ok)")
    print(head)
    for r in llm:
        print(
            f"{r.feature:<14} {r.model:<24} {r.n:>5}  {r.in50:>8} {r.in90:>8} {r.in99:>8} {r.in_max:>8}"
            f"  {r.cached50:>8}  {r.out50:>8} {r.out90:>8} {r.out99:>8} {r.out_max:>8}"
        )
    print(f"\nSTT files, last {days} days")
    print(f"{'model':<14} {'n':>5}  {'sec p50':>8} {'p99':>8} {'total h':>8}")
    for r in stt:
        print(f"{r.model or '(none)':<14} {r.n:>5}  {r.sec50:>8.1f} {r.sec99:>8.1f} {r.total_sec / 3600:>8.2f}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days", type=int, default=90)
    ap.add_argument("--include-tests", action="store_true")
    args = ap.parse_args()
    asyncio.run(main(args.days, args.include_tests))
