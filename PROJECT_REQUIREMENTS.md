# TikTok Shop Affiliate Scraper — Project Requirements

## 1. Overview

A web-scraping system that automatically extracts a TikTok affiliate **creator's own**
back-office sales data from the TikTok Seller/Creator center web UI, stores it in
PostgreSQL, and exposes it for self-service filtering and analysis.

The project owner is a TikTok affiliate creator. The system reads **only the owner's own
account data** (their dashboard, their commissions, their orders). It is a personal
analytics tool, not a multi-tenant or third-party data product.

### Why scraping instead of the official API

- Official API onboarding is slow and heavily gated.
- API access carries constraints and the risk of forced ad-spend deductions.
- Decision: **drive the web UI with a browser bot (Playwright)** and read the numbers
  the same way a human operator would. The official API is explicitly **out of scope**.
  (The `docs_raw/` folder holds old official-API notes and is kept only as historical
  reference — not part of the current design.)

## 2. Goals

Replace the manual daily routine (log in → navigate Affiliate / Business Analytics →
copy creator names, product names, units sold, revenue → paste into a spreadsheet →
filter) with an automated bot that runs unattended.

Target dashboard metrics to capture:

- **GMV** (gross merchandise value) — daily and cumulative.
- **My commission earnings** — total and per-product.
- **Units sold** — total and per-product.
- **Per-product breakdown**: for each product, its commission rate, current commission
  earned, and how many units have generated commission.
- **Creator dimension**: which creator drove which sales (for multi-creator scenarios).

## 3. Functional Requirements

### 3.1 Scraping (Playwright bot)

- Automate browser login to TikTok Seller/Creator center.
  - Handle username/password.
  - Handle **OTP** (the flow sends an OTP to the owner's phone — design must allow
    feeding the OTP in, e.g. manual prompt or a relay channel).
- Persist the authenticated session (cookies / storage state) to avoid logging in on
  every run.
- Navigate to the Affiliate / Business Analytics pages.
- Extract:
  - Daily sales figures, cumulative totals, creator list.
  - Per-product: name, units sold, revenue, commission rate, commission earned.
- Run on a schedule (target: continuous / up to 24h cadence).

### 3.2 Storage (PostgreSQL)

Normalize scraped data into category tables. Initial schema (to refine):

- `products` — product id, title, commission rate, metadata.
- `creators` — creator id, handle/name.
- `sales` / `sales_daily` — fact rows: date, product_id, creator_id, units, gmv,
  commission earned. Designed for time-series (daily snapshots + cumulative).

Requirements:

- Idempotent upserts (re-scraping the same day must not duplicate rows).
- Keep daily snapshots so trends over time are queryable.

### 3.3 Filtering / Query

Move query power off the TikTok web UI and onto local data. Must answer questions like:

- "How many black t-shirts did creator A sell this week?"
- "Which product earned the most commission this month?"
- "How many units of product X have generated commission, and at what rate?"

Without clicking through the TikTok web UI (reduces friction and block risk).

## 4. Non-Functional Requirements

- **Anti-block resilience**: human-like pacing, session reuse, retry/backoff. Scraping
  the TikTok back office can violate TikTok ToS and risks account suspension — treat as a
  known risk and minimize footprint.
- **Resumability**: a failed run must be resumable without data loss/duplication.
- **Observability**: log each run's status, rows scraped, and failures.
- **Secrets**: credentials and session state stored securely, never committed.

## 5. Tech Stack

- **Scraper**: Playwright (browser automation).
- **Database**: PostgreSQL.
- **Language/runtime**: TBD (Playwright supports Node.js / Python — decide and record).

## 6. Open Questions

- OTP handling: fully manual, or relayed (e.g. via a messaging channel)?
- Run host: local machine, VPS, or container? Headless or headful?
- Scrape cadence and how cumulative vs. daily snapshots are reconciled.
- Region/locale of the target account (affects DOM selectors and currency).
- Language/runtime choice for the scraper (Node vs. Python).

## 7. Out of Scope

- Official TikTok Shop API integration.
- Scraping or analyzing accounts other than the owner's own.
- Multi-tenant / SaaS productization.
