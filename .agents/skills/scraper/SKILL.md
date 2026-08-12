---
name: scraper
description: Conventions and safety rules for the Playwright scraper service (own dashboard + external market trend). Load before writing or changing any code under services/scraper, login/OTP/session handling, selectors, or scrape cadence.
---

# Scraper Skill — Playwright, deterministic, account-safe

Scope: `backend/services/scraper`. Extracts the owner's own TikTok back-office data and
external market-trend data. **The owner's account is the income source — safety is the
top rule.**

## Hard rules

1. **No AI in the scraping path.** Drive the browser with explicit selectors only.
   (An AI self-healing selector fallback may be added later, isolated, off the hot path.)
2. **Respect the cadence floor.** Never schedule or "run now" below the enforced minimum
   interval. The floor + jitter live in `packages/core/cadence.py` — call it; never
   re-implement or bypass it. A requested value below the floor is clamped, logged, and
   surfaced to the UI, never silently honored.
3. **One reused session, no parallel hammering.** Single browser context per account;
   serialize runs. Never fan out concurrent logged-in sessions.
4. **Headful + stealth.** Use a real headful browser with `playwright-stealth` (or
   equivalent). Randomized human-like delays/jitter between actions.
5. **Surface captcha/OTP to the user — never loop on it.** If a captcha or re-login
   appears, stop, record it, and signal the UI; do not retry-spam.

## Structure

```
backend/services/scraper/
  auth.py            # login flow, OTP handoff, persist storage_state
  session.py         # load/validate/refresh storage_state; expiry detection
  selectors.py       # ALL selectors centralized here (single point to fix on DOM churn)
  own_dashboard.py   # scrape GMV / commission / units / per-product / creators
  market_trend.py    # scrape external trending products/creators (slower, isolated)
  pacing.py          # human-like delays/jitter helpers
  runner.py          # orchestrates a run; writes scrape_runs audit row
```

## Conventions

- **Selectors centralized** in `selectors.py` — when TikTok changes the DOM, one file
  changes. Prefer role/text/data-attribute selectors over brittle nth-child chains.
- **Persist `storage_state`** to skip re-login/OTP each run. Validate it before scraping;
  on expiry, prompt the owner (manual OTP) — don't auto-loop.
- **Idempotent writes.** Map scraped rows to `packages/db` upserts (see `database` skill);
  re-running the same day must not duplicate. Daily snapshots for time series.
- **Every run audited.** Write a `scrape_runs` row: started/finished, rows scraped,
  status, error. Structured logging throughout.
- **Market-trend scraper is isolated** from the own-data scraper and runs on its own,
  slower cadence so a block there never endangers the logged-in account.
- **Backoff + retry** with jitter on transient failures; hard-stop (not retry) on
  captcha / auth challenges.

## Open knobs (confirm with user during build)

- Exact safety-floor interval values (tune toward "safe").
- Headful vs headed-but-hidden; proxy (residential) if blocks appear.
- Target account region/locale (affects selectors + currency).
