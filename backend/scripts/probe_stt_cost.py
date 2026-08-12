"""Reconcile one transcription's billed length against the ElevenLabs account.

Answers the question the per-user ledger depends on: *is what we record for a
run the same thing ElevenLabs charges the shared account for?* If it is, each
user's own rows can be priced without ever reading account totals.

    cd backend && python scripts/probe_stt_cost.py path/to/clip.wav

Costs one real transcription of that clip. Keep it short.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from packages.core.settings import get_settings  # noqa: E402
from packages.video.elevenlabs_stt import transcribe_clip  # noqa: E402

USAGE_URL = "https://api.elevenlabs.io/v1/usage/character-stats"
# The aggregate lags a little behind a finished request.
POLL_ATTEMPTS = 10
POLL_SLEEP_SEC = 6


def account_usage(api_key: str, metric: str) -> float:
    """Whole-account total for the current UTC day. Diagnostics only — never
    show this to a user; it is every user's usage combined."""
    now_ms = int(time.time() * 1000)
    day_ms = 24 * 60 * 60 * 1000
    start = now_ms - (now_ms % day_ms)
    query = (
        f"?start_unix={start}&end_unix={start + day_ms}"
        f"&breakdown_type=product_type&aggregation_interval=cumulative&metric={metric}"
    )
    req = urllib.request.Request(USAGE_URL + query, headers={"xi-api-key": api_key})
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            payload = json.load(resp)
    except urllib.error.HTTPError as exc:
        print(f"  usage read failed: HTTP {exc.code}")
        return float("nan")
    series = (payload.get("usage") or {}).get("STT") or []
    return float(sum(v for v in series if isinstance(v, (int, float))))


async def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    wav = pathlib.Path(sys.argv[1])
    if not wav.is_file():
        print(f"not a file: {wav}")
        return 2

    api_key = get_settings().elevenlabs_api_key
    if not api_key:
        print("ELEVENLABS_API_KEY not set")
        return 2

    before_credits = account_usage(api_key, "credits")
    before_minutes = account_usage(api_key, "minutes_used")
    print(f"account before : {before_credits:.0f} credits  |  {before_minutes:.4f} min")

    started = time.monotonic()
    response = await transcribe_clip(wav, None)
    elapsed = time.monotonic() - started

    billed_sec = float(response.get("audio_duration_secs") or 0.0)
    text = (response.get("text") or "").strip()
    print(f"transcribed    : {billed_sec:.2f}s billed, {elapsed:.1f}s wall clock")
    print(f"  text         : {text[:70]}{'…' if len(text) > 70 else ''}")
    print(f"  cost fields  : {[k for k in response if 'cost' in k or 'credit' in k] or 'none'}")

    for attempt in range(1, POLL_ATTEMPTS + 1):
        time.sleep(POLL_SLEEP_SEC)
        after_credits = account_usage(api_key, "credits")
        after_minutes = account_usage(api_key, "minutes_used")
        d_credits = after_credits - before_credits
        d_minutes = after_minutes - before_minutes
        print(
            f"  poll {attempt:2d}      : +{d_credits:.0f} credits, "
            f"+{d_minutes * 60:.2f}s ({d_minutes:.4f} min)"
        )
        if d_credits > 0 or d_minutes > 0:
            print()
            print(f"account delta  : {d_credits:.0f} credits  |  {d_minutes * 60:.2f}s")
            print(f"our figure     : {billed_sec:.2f}s")
            if d_minutes > 0:
                drift = abs(d_minutes * 60 - billed_sec)
                print(f"drift          : {drift:.2f}s")
                print(f"credits/second : {d_credits / (d_minutes * 60):.2f}")
                print(f"→ a run of N billed seconds costs ≈ N × "
                      f"{d_credits / (d_minutes * 60):.2f} credits")
            return 0

    print("\naccount total did not move within the polling window — the aggregate")
    print("lags; re-run the reads later to confirm.")
    return 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
