# Unit economics — what a plan earns and what it costs

Written 2026-09-29. The numbers here are DERIVED from the code and from the real
usage rows in production; nothing is assumed. Where a figure is not modelled
anywhere in the code, this file says so rather than inventing one.

Sources of truth (this file explains them, it does not replace them):

| Thing | Lives in |
|---|---|
| What a user is charged (fixed, versioned) | `backend/packages/billing/rate_card.py` |
| What the vendor really costs us | `backend/packages/admin/cost_config.py` (admin-editable) |
| Plan prices and budgets | `backend/packages/billing/limits.py`, website `lib/plans.ts` |
| Live cost/margin per 1M from real rows | admin dashboard (`admin/src/lib/money.ts`) |

---

## 1. The peg, and why margin does not depend on the mix

The rate card is built so that **every resource costs exactly ฿50 per 1M of our
tokens at the 2027 list prices and ฿34.5/USD**. Verified:

| Resource | 2027 list | our rate | vendor units per 1M ours | USD | THB @34.5 |
|---|---|---|---|---|---|
| Flash input | $1.50/1M | 1.035 | 966,184 | $1.449 | ฿50.0 |
| Flash output | $7.50/1M | 5.175 | 193,237 | $1.449 | ฿50.0 |
| Pro input ≤200k | $2.00/1M | 1.38 | 724,638 | $1.449 | ฿50.0 |
| Pro output ≤200k | $12.00/1M | 8.28 | 120,773 | $1.449 | ฿50.0 |
| Scribe v2 | $0.27/h | 51.75/s | 5.368 h | $1.449 | ฿50.0 |

So at 2027 prices the margin is **80% on every plan, whatever the user does** —
a Pro-heavy run and a Flash-heavy run cost the same per token charged. That is
the point of the design, not a coincidence.

Sell price is ฿250/1M on every plan (`SELL_SATANG_PER_1M`), ฿350/1M for the
top-up balance (`TOPUP_SATANG_PER_1M`).

## 2. Is the Gemini price rise already in the numbers?

**Yes — and both sides of it.** Checked against
`https://ai.google.dev/gemini-api/docs/pricing` on 2026-09-29:

| Model | Now (to 2026-12-31) | From 2027-01-01 | In our table? |
|---|---|---|---|
| Gemini 3.7 / 3.8 Flash in | $0.75 | $1.50 | yes, dated schedule (`_FLASH.until/then`) |
| Gemini 3.7 / 3.8 Flash out | $3.75 | $7.50 | yes |
| Gemini 3.1 Pro in ≤200k / >200k | $2.00 / $4.00 | unchanged | yes (`_PRO`) |
| Gemini 3.1 Pro out ≤200k / >200k | $12.00 / $18.00 | unchanged | yes |

- **What we charge** (rate card) is pegged at the POST-rise price. A user's
  limit drains at the 2027 rate today; nothing changes for them on 1 Jan 2027.
- **What we pay** (cost table) follows the dated schedule, so the margin is
  wider today and narrows to the peg on 1 Jan 2027. No one has to remember to
  edit anything that night — `ModelPrice.at(date)` switches itself.

## 3. Measured, not assumed: what production actually costs

Production `core.llm_usage_logs` (status `ok`), read 2026-09-29:

- 92 calls, 564,985 of our tokens, **฿13.63** of real vendor cost
- → **฿24.13 per 1M our tokens**, i.e. 90.3% margin at the ฿250 sell price
- Every token so far came from Flash (the Pro rows are zero-token failures), so
  this is the all-Flash figure and matches the ฿25/1M the arithmetic predicts.
- STT rows exist but carry no tokens yet (`core.stt_usage_logs`: 3 rows, ฿0).

`docs/token-billing-plan.md` §1 quotes "≈฿33/1M", which assumed a Pro/STT share
that has not happened yet. **฿24–25/1M is the number today; ฿50/1M is the number
from January.** The mix is what moves it, and only until the Flash rise lands.

## 4. Per plan, per month (user burns 100% of the budget)

Vendor cost only — payment fees and fixed costs are §5 and §6.

| Plan | ฿/mo | budget | ฿/1M sold | vendor cost today | from 2027 | gross today | gross 2027 |
|---|---|---|---|---|---|---|---|
| Free | 0 | 0.1M | — | ฿2 | ฿5 | −฿2 | −฿5 |
| Lite | 199 | 0.8M | 248.8 | ฿20 | ฿40 | ฿179 (90%) | ฿159 (80%) |
| Starter | 399 | 1.6M | 249.4 | ฿40 | ฿80 | ฿359 (90%) | ฿319 (80%) |
| Pro | 990 | 4M | 247.5 | ฿100 | ฿200 | ฿890 (90%) | ฿790 (80%) |
| Studio | 1,990 | 8M | 248.8 | ฿200 | ฿400 | ฿1,790 (90%) | ฿1,590 (80%) |
| Agency | 3,990 | 16M | 249.4 | ฿400 | ฿800 | ฿3,590 (90%) | ฿3,190 (80%) |
| Max | 6,990 | 28M | 249.6 | ฿700 | ฿1,400 | ฿6,290 (90%) | ฿5,590 (80%) |

Full burn is the WORST case for us and the best case for the user. A user who
spends half their budget doubles our margin on that plan.

**Per clip.** One measured `dub_first` cut (3-minute source → 22 s output,
Pro engine, High precision) charged **70,667 tokens**:

- ฿17.67 of the user's budget · costs us ฿1.77 today, ฿3.53 from 2027
- Free = 1.4 clips/month · Lite 11.3 · Starter 22.6 · Pro 56.6 · Studio 113 ·
  Agency 226 · Max 396

## 5. What is NOT in the cost model yet

These are real money and the admin dashboard does not know about them.

**Payment processing.** Stripe Thailand (checked 2026-09-29,
`https://stripe.com/th/pricing`): domestic card **3.65% + ฿10**, international
card **4.75% + ฿10** (+2% on conversion), **PromptPay 1.65%**. Nothing in
`cost_config.py` subtracts it, so every margin the admin shows is before it.

| Plan | ฿/mo | card fee | PromptPay fee | net after card | gross 2027 after card |
|---|---|---|---|---|---|
| Lite | 199 | ฿17 | ฿13 | ฿182 | ฿142 (71%) |
| Starter | 399 | ฿25 | ฿17 | ฿374 | ฿294 (74%) |
| Pro | 990 | ฿46 | ฿26 | ฿944 | ฿744 (75%) |
| Studio | 1,990 | ฿83 | ฿43 | ฿1,907 | ฿1,507 (76%) |
| Agency | 3,990 | ฿156 | ฿76 | ฿3,834 | ฿3,034 (76%) |
| Max | 6,990 | ฿265 | ฿125 | ฿6,725 | ฿5,325 (76%) |

The ฿10 fixed part is what hurts the cheap plans: it is 5% of Lite and 0.14% of
Max. **PromptPay is less than half the card fee** — steering Thai users to it is
worth ~฿4 on Lite and ~฿140 on Max per month.

**Tax.** `vat_included = False` because the owner is an individual under the
฿1.8M/year VAT threshold. That threshold is ฿150,000/month of revenue — 754
Lite users, or 152 Pro, or 21 Max. Past it, registration is compulsory and 7%
comes off the top unless prices are raised. Profit is also personal income
(progressive to 35%), not corporate 20%: at some size the arithmetic of
incorporating changes. Neither is modelled anywhere in the code.

**Refunds and disputes.** `packages/billing/topup.py` reverses a refunded
top-up's tokens, but the vendor cost of whatever was already spent stays on our
books, and Stripe keeps the ฿10 on a refund.

## 6. Fixed costs and breakeven

`cost_config.py` carries ฿980 Railway + ฿120 R2 + ฿90 domains = **฿1,190/month**,
plus per-user items (SMS OTP ฿1.50/user, SMTP ฿0.35/clip).

At 2027 prices, full burn, after the Stripe card fee, covering the ฿1,190:

| Plan | users to break even |
|---|---|
| Lite | 8.4 |
| Starter | 4.0 |
| Pro | 1.6 |
| Studio | 0.8 |
| Agency | 0.4 |
| Max | 0.2 |

Free users cost up to ฿5/month each at 2027 prices (฿2 today) with no offsetting
revenue — 238 fully-burning Free users would eat the entire fixed budget.
`packages/billing/free_tier.py` is what stands between that and a signup farm.

## 7. What moves the margin

| Lever | Effect |
|---|---|
| FX | The card is fixed at ฿34.5/USD. A weaker baht raises cost only: at ฿38/USD the 2027 cost becomes ฿55/1M (78% margin), at ฿32 it is ฿46/1M (81.4%). |
| Vendor price | A rise hits margin alone, never a user's limit — by design (`rate_card.py` reads no FX and no admin table). |
| Model mix | Only until 1 Jan 2027, and only because Flash is discounted. After that, none: every resource is ฿50/1M. |
| Cached input | 10% of the input rate on both sides, so it is margin-neutral by construction — but it makes a run cheaper for the user, which is what the cache is for. |
| Prompt >200k on Pro | Gemini bills the WHOLE call at the long rate; the card does the same, so still neutral. |

---

## Open questions for the owner

1. **Payment fees are invisible in the admin dashboard.** Adding them to
   `cost_config.py` as a per-charge percentage + fixed item would make the
   margin shown the real one. Worth doing before the first real customers.
2. **PromptPay first?** It is less than half the card fee and Thai users expect
   it. Today `topup.py` opens a Stripe Checkout that offers whatever Stripe
   decides.
3. **฿10 fixed fee on Lite (฿199)** is 5% of the plan. Either accept it, push
   PromptPay, or make the entry plan quarterly/annual so the fixed fee is paid
   once instead of three or twelve times.
