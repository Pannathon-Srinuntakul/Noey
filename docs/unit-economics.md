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

So at 2027 prices the margin is **80% whatever the user does with a token** —
a Pro-heavy run and a Flash-heavy run cost the same per token charged. That is
the point of the design, not a coincidence.

List price is ฿250/1M (`SELL_SATANG_PER_1M`), ฿350/1M for the top-up balance
(`TOPUP_SATANG_PER_1M`). **The plan ladder no longer sells at that list
price.** The 2026-09-29 budget rise left prices alone, so every plan from
Starter up now realises ฿218–225 per 1M (§4), and its full-burn 2027 margin is
77–78% rather than 80%. Mix-independence is intact; the flat 80% is not.

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
- **No speech-to-text has ever run through the billing path.**
  `core.stt_usage_logs` holds exactly three rows, all `status = ok`, carrying
  **16,368 seconds of audio with `tokens = 0` and `cost_thb = NULL`**.

That last line looks like a leak and is not one. The rows are dated 2026-08-21
and 2026-09-01; `packages/billing/metering.py` first landed 2026-09-22
(`cbf31c5`), so they predate token billing rather than escaping it. The current
path cannot reproduce them either: `metering.stt_row` always sets
`"tokens": rate_card.tokens_for_stt(sec)`, and `record_stt_clip` returns before
writing anything when `billed_sec <= 0`. There is no code path that writes a
zero-token STT row for real audio.

Both halves matter. Nothing is leaking — **and** the STT side of the rate card
has never been exercised against a real charge. Every speech figure in this
document (§4.3, the 40,000-token voiceover pass in §4.1, and therefore the
size of the Free credit) rests on the rate card's arithmetic alone.

`docs/token-billing-plan.md` §1 quotes "≈฿33/1M", which assumed a Pro/STT share
that has not happened yet. **฿24–25/1M is the number today; ฿50/1M is the number
from January.** The mix is what moves it, and only until the Flash rise lands.

## 4. Per plan, per month (user burns 100% of the budget)

Vendor cost only — payment fees and fixed costs are §5 and §6.

The plan shape, read from `packages/billing/limits.py` (`PLAN_LIMITS`,
`plan_features.check_precision`), as of 2026-09-29:

| Plan | budget | window enforced | footage cap | High precision |
|---|---|---|---|---|
| Free | 450,000 **one-time** | `lifetime` (never resets) | 10 min | no |
| Lite | 800,000 / mo | `monthly` | 10 min | no |
| Starter | 1,800,000 / mo | `monthly` | 20 min | no |
| Pro | 4,400,000 / mo | `monthly` | 30 min | yes |
| Studio | 9,000,000 / mo | `monthly` | 30 min | yes |
| Agency | 18,000,000 / mo | `monthly` | 30 min | yes |
| Max | 32,000,000 / mo | `monthly` | 30 min | yes |

**One window rule per account.** `weekly` and `five_hour` are now enforced by
nobody — Free spends a `lifetime` credit, every paid plan spends a month. Two
reasons, and the first is the real one:

- **The protection they existed for lives elsewhere and works better.** They
  were vendor-quota guards. `packages/billing/vendor_limits.py` enforces the
  actual daily Gemini cap globally, and `concurrency` bounds how many jobs one
  account has in flight. Measured: a Max account burning its entire 32M month
  in a single day is ~600 Flash calls against a Tier-1 cap of 10,000/day. The
  sub-windows were never what stood between us and the vendor.
- **They hurt.** Pro's 5-hour window was 369,514 tokens against a 777,572-token
  30-minute High clip. `runs.windows_for_run` skips a window smaller than the
  run, so it never blocked the big job it was sized against — it only blocked
  the user's *next, smaller* job for five hours. Studio's 739,030 was short of
  that same clip. Four window rules across seven plans is also unlearnable.

`TRACKED_WINDOWS` still records all four, so nothing about upgrade/downgrade
accounting changes and a sub-window could be switched back on without any
account starting from zero.

**High precision became a Pro-and-up feature** rather than a hidden tax. It is
5.2x the per-second video rate (328.6 vs 63.4 vendor tokens/s); a 10-minute
clip with a voiceover is 369,451 at High against 204,762 at Standard — nearly
double. On Free, Lite and Starter that would silently halve the clip count the
plan was sized for, so it is sold instead of charged.

**Every advertised cap is now runnable.** The pre-flight estimate at each
plan's own `footage_sec`, at the best precision that plan may pick, is 192,510
(Free/Lite), 254,610 (Starter) and 689,310 (Pro and up) — all inside their
budgets, so `plan_features.check_run_size` can no longer refuse anything the
pricing page advertises. That was a live bug: a cap that said 30 minutes while
a 20-minute clip was refused.

And the money, at full burn:

| Plan | ฿/mo | budget | ฿/1M realised | vendor cost today | from 2027 | gross today | gross 2027 |
|---|---|---|---|---|---|---|---|
| Free | 0 | 0.45M once | — | ฿11 once | ฿23 once | −฿11 once | −฿23 once |
| Lite | 199 | 0.8M | 248.8 | ฿20 | ฿40 | ฿179 (90%) | ฿159 (79.9%) |
| Starter | 399 | 1.8M | 221.7 | ฿45 | ฿90 | ฿354 (89%) | ฿309 (77.4%) |
| Pro | 990 | 4.4M | 225.0 | ฿110 | ฿220 | ฿880 (89%) | ฿770 (77.8%) |
| Studio | 1,990 | 9M | 221.1 | ฿225 | ฿450 | ฿1,765 (89%) | ฿1,540 (77.4%) |
| Agency | 3,990 | 18M | 221.7 | ฿450 | ฿900 | ฿3,540 (89%) | ฿3,090 (77.4%) |
| Max | 6,990 | 32M | 218.4 | ฿800 | ฿1,600 | ฿6,190 (89%) | ฿5,390 (77.1%) |

Vendor cost is the budget at ฿25/1M today (the ฿24.13 measured in §3, rounded
against us) and ฿50/1M from January. Free's line is a **once-per-account**
number, not a monthly one — that is the whole point of the `lifetime` window.

**The budget rise moved the realised price, and nobody moved the plan price.**
Budgets went up (Starter 1.6M→1.8M, Pro 4M→4.4M, Studio 8M→9M, Agency
16M→18M, Max 28M→32M) while ฿199/฿399/฿990/… stayed put, so the ladder sells
tokens at **฿218–225 per 1M, not the ฿250 list** — and the 2027 full-burn
margin is 77–78% instead of 80% everywhere except Lite (79.9%) and the Free
credit. That is a deliberate-looking discount that nothing in the code states,
so it is written here: a price change, made by not changing a price.

Full burn is the WORST case for us and the best case for the user. A user who
spends half their budget doubles our margin on that plan.

### 4.1 What one clip actually costs (measured, 2026-09-29)

The earlier "70,667 tokens per cut" figure in this section was an *estimate*,
not a charge, and it was 2.6x too low. Replaced with every paid run production
has ever recorded — three `dub_first` analyses, Pro engine, High precision:

| run | raw footage | vendor in | vendor out | our tokens | our cost | `estimate` then | `estimate` now |
|---|---|---|---|---|---|---|---|
| fbd2c458 | 192.08 s | 69,121 | 17,732 | 163,304 | ฿3.95 | 107,252 | 190,052 |
| 74e0684b | 135.83 s | 50,575 | 27,216 | 193,188 | ฿4.66 | 89,787 | 172,587 |
| f4a7cc89 | 227.17 s | 80,737 | 24,141 | 208,493 | ฿5.03 | 118,147 | 200,947 |
| **total** | **555.08 s** | 200,433 | 69,089 | **564,985** | **฿13.63** | 315,186 | 563,586 |

Our tokens = `vendor_in × 1.035 + vendor_out × 5.175` (§1), reproduced exactly
by the rows. Measured cost: **฿24.13 per 1M our-tokens** — half the ฿50 peg,
because the peg is priced at 2027 Gemini rates and these ran at today's.

The last two columns: "then" is what `estimate_run` returned while
`MODE_PROFILES["analyze_video"].max_output` was 8,000; "now" is the same
function after that constant became `CUT_PLAN_OUTPUT_TOKENS = 24,000`
(2026-09-29, re-measured from these very rows). The fix took the aggregate
error from **−44% to −0.25%**, and the per-run spread from −34%/−54%/−43% to
**+16.4% / −10.7% / −3.6%**.

**Cost is not proportional to the source clip.** The shortest of the three
(135.83 s) is the second most expensive; the longest carries **67% more
footage than the shortest and costs 8% more**. Output explains it: it is a
fifth of the volume and **56% of the cost**, because output is charged 5.175x
input and Gemini bills thinking as output — and output is a function of the
EDIT SCRIPT the model writes, not of the footage it read. A busy 2-minute clip
that yields forty cuts costs more than a slow 4-minute one that yields twelve.

So the cost of a run splits into a term that scales with footage and a term
that does not — and the two must be kept apart, or the prompt gets counted in
both:

```
standard  =  65.6 × seconds  +  125,390
high      = 340.1 × seconds  +  125,390
```

Where each number comes from:

| term | value | source |
|---|---|---|
| per second, Standard | 63.4 vendor tok/s → **65.6** ours | `quality.py`'s controlled fps test (2026-09-07, 24,496 input tokens on a 291.7 s proxy) **less its own 6,000-token prompt** |
| per second, High | 328.6 vendor tok/s → **340.1** ours | same test (101,452 input), prompt-excluded; corroborated per-run below |
| prompt input, 6,000 | `estimate.MODE_PROFILES["analyze_video"].prompt_in` | the dub system prompt (~4.8k) + the script |
| output, 23,030 | mean of 17,732 / 27,216 / 24,141 | the three production rows above |
| `FIXED` = 125,390 | `6,000 × 1.035 + 23,030 × 5.175` | prompt input + mean output |

The ~84 / ~348 figures `quality.py` prints are **prompt-inclusive** — they are
whole requests, prompt and all. Using them *and* adding `FIXED` charges the
prompt twice, which an earlier draft of this document did. The rates above are
the same measurement with the prompt taken out once.

**Residuals against the three runs** (all High), predicted vs charged:

| run | predicted | charged | residual |
|---|---|---|---|
| fbd2c458 | 190,717 | 163,304 | **+16.8%** |
| 74e0684b | 171,586 | 193,188 | **−11.2%** |
| f4a7cc89 | 202,651 | 208,493 | **−2.8%** |
| **total** | **564,954** | **564,985** | **−0.01%** |

Read that honestly. **The per-second term is well grounded** — it comes from a
controlled test where fps was the only variable, and the three production runs
corroborate it independently: subtract the 6,000-token prompt from each run's
`vendor_in` and the implied rate is **328.62, 328.17 and 328.99** tokens/s, a
spread of 0.25% across three unrelated clips. **The fixed term is a mean of
three observations**, and the whole residual above is that term varying: run 1
thought 23% less than the mean, run 2 thought 18% more. Three samples is not a
distribution, and the −0.01% aggregate is a mean fitting its own mean, not
independent confirmation.

All three sources are **between 2 and 4 minutes long**. Everything in §4.2
beyond about 5 minutes is extrapolation, and the 30- and 60-minute rows are
untested — no production run has ever been near them.

**A voiceover/transcript pass adds ~40,000 tokens** on top of any of this, and
that figure is a **planning estimate, not a measurement**. Read against the
profiles it is one text call (`prompt_in=8,000`, `max_output=4,000` →
`8,000 × 1.035 + 4,000 × 5.175 = 28,980`) plus roughly 210 seconds of Scribe
at 51.75/s (~11,000). Nothing has ever verified it: `core.stt_usage_logs` has
three rows and all of them carry zero tokens (§3). **Free's whole size rests
on it** — 450,000 is two 10-minute Standard cuts *with voiceover* at 204,762
each — so it is the single number in this document most worth replacing with a
measurement.

One more thing the model is not: **the pre-flight estimator does not use it and
should not be expected to match it to the token.** `estimate.py` prices footage
at a flat `VIDEO_TOKENS_PER_SEC` of 100 / 300 per second — *above* the
measurement at Standard and *below* it at High — and budgets a flat
`CUT_PLAN_OUTPUT_TOKENS = 24,000` of output, which now also covers
`analyze_frames` and `reedit` (all three are the same request: plan a cut,
reason over footage, emit an edit script; only how the footage arrives
differs). That is deliberate: the estimate only has to be *safe*, because
nothing is reserved and each vendor request is charged as it goes. It is within
+16% / −11% per run and −0.25% in aggregate (§4.1 table), which is good enough
for the two things that read it — `guard.admit` and `plan_features.check_run_size`.

**Standard precision saves far less than it looks.** It cuts input sampling to
~19% but leaves output untouched, and output is 56% of the bill — so a 3-minute
clip falls only 26% (186,608 → 137,202), not 81%. The saving grows with length
because the footage term grows: at 30 minutes Standard is 67% cheaper.

Lite engine is the same rate-card family as Pro (both resolve to a `flash`
model), so it costs the same per token — it buys a different cut, not a cheaper
one.

### 4.2 Cost of one clip, by source length

From the model above. Tokens are our-tokens; ฿ today is at the measured
฿24.13/1M (§3), ฿ 2027 at the ฿50/1M peg. "+VO" adds the 40,000-token
voiceover pass, which is what every plan number in §4.4 is sized on.

| source | Standard | +VO | ฿ today | ฿ 2027 | High | +VO | ฿ today | ฿ 2027 |
|---|---|---|---|---|---|---|---|---|
| 3 min | 137,202 | 177,202 | ฿3.31 | ฿6.86 | 186,608 | 226,608 | ฿4.50 | ฿9.33 |
| 5 min | 145,076 | 185,076 | ฿3.50 | ฿7.25 | 227,421 | 267,421 | ฿5.49 | ฿11.37 |
| 10 min | 164,762 | 204,762 | ฿3.98 | ฿8.24 | 329,451 | 369,451 | ฿7.95 | ฿16.47 |
| 20 min | 204,133 | 244,133 | ฿4.93 | ฿10.21 | 533,511 | 573,511 | ฿12.87 | ฿26.68 |
| 30 min | 243,504 | 283,504 | ฿5.88 | ฿12.18 | 737,572 | 777,572 | ฿17.80 | ฿36.88 |
| 60 min | 361,619 | 401,619 | ฿8.73 | ฿18.08 | 1,349,754 | 1,389,754 | ฿32.57 | ฿67.49 |

(฿ columns price the cut alone, without the VO pass.) Below ~5 minutes the
fixed term dominates and the two precisions are close; above ~20 minutes at
High the footage term takes over and High costs 2.6–3.7x Standard. **Rows past
5 minutes are extrapolated, not measured** (§4.1).

A re-edit or a second analysis pass costs roughly the same again. Every count
in §4.4 is one pass per clip, which is the optimistic case.

### 4.3 The transcript modes cost a fraction of the video modes

`talking_head`, `speech_highlights` and `speech_scenes` **never send video to
the model**. They run ElevenLabs Scribe over the audio and then two text calls
over the transcript (`estimate.MODE_PROFILES["transcribe_audio"]`:
`prompt_in=4,000`, `max_output=4,000`, `transcript_per_sec=15.0`, `calls=2`,
`uses_stt=True`). That gives a ceiling of

```
our_tokens  =  49,680  +  82.8 × seconds
                 │            └─ 51.75 STT (rate_card.stt_per_sec) + 2 × 15 × 1.035 transcript
                 └─ 2 × (4,000 × 1.035 + 4,000 × 5.175)
```

| source | our tokens | STT share | ฿ today | ฿ 2027 |
|---|---|---|---|---|
| 3 min | 64,584 | 14% | ฿1.85 | ฿3.23 |
| 10 min | 99,360 | 31% | ฿3.26 | ฿4.97 |
| 30 min | 198,720 | 47% | ฿7.30 | ฿9.94 |
| 60 min | 347,760 | 54% | ฿13.35 | ฿17.39 |

**A 30-minute transcript-mode clip (198,720) costs less than a 5-minute
video-mode clip at High (227,421).** Per second of media the gap is stark:

| what one second of media costs | our tokens |
|---|---|
| video at High | 340.1 (328.6 × 1.035) |
| video at Standard | 65.6 (63.4 × 1.035) |
| transcript mode, all in | 82.8 |
| the STT alone | 51.75 |

So a second of High-precision video is **6.6x** a second of speech-to-text, and
**4.1x** a whole second of transcript mode including its two text calls. Seen
as input to the model the gap is wider still — 328.6 vendor tokens for a second
of video against 15 for a second of transcript, **22x per call** — but STT, not
the model, is what makes the audio path cost anything at all.

One inversion worth knowing: per second, transcript mode (82.8) is now *dearer*
than a Standard video cut (65.6). It still costs less at every length any plan
allows, because its fixed term is 49,680 against the video path's 125,390 —
2.5x smaller. The two lines do not cross until **~73 minutes of source**, well
past the 30-minute cap, so in practice the transcript modes are always the
cheaper of the two.

**These modes earn a thinner margin today, and the same one from January.**
Scribe is priced at the ฿50/1M peg *now* (rate card `stt_per_sec=51.75` against
$0.27/h, §1), while Gemini Flash is at half the peg until 2026-12-31 (§2). So
the STT share of a run earns 80% and the LLM share earns 90%, blended by
length:

| source | margin today | margin from 2027 |
|---|---|---|
| 3 min | 88.6% | 80.0% |
| 10 min | 86.9% | 80.0% |
| 30 min | 85.3% | 80.0% |
| 60 min | 84.6% | 80.0% |

Against ~90% for the video modes today. **The longer the audio, the more of the
run is at full peg** — a 60-minute transcript job is already 54% STT. Both
paths converge on 80% on 1 January 2027, when Flash reaches the peg too.

(Those percentages are per token sold at the ฿250 list price, so they compare
like with like. At the plan level every figure is 2–3 points lower from Starter
up, because the ladder realises ฿218–225/1M — §4.)

### 4.4 Cuts per plan, at full burn

Every figure below is one analysis pass **with the voiceover pass included**,
which is how `limits.py` sizes the table. There is no per-week table any more:
every paid plan enforces `monthly` alone.

**At a 5-minute source** — the basis the pricing page states — and at the best
precision each plan may pick:

| Plan | budget | Standard (185,076) | High (267,421) |
|---|---|---|---|
| Free | 0.45M once | **2 cuts, ever** | — (Pro and up) |
| Lite | 0.8M | 4 | — |
| Starter | 1.8M | 9 | — |
| Pro | 4.4M | 23 | 16 |
| Studio | 9M | 48 | 33 |
| Agency | 18M | 97 | 67 |
| Max | 32M | 172 | 119 |

**At the plan's own footage cap** — the worst case the limit allows:

| Plan | cap | Standard | High |
|---|---|---|---|
| Free | 10 min | **2, ever** (204,762) | — |
| Lite | 10 min | 3 (204,762) | — |
| Starter | 20 min | 7 (244,133) | — |
| Pro | 30 min | 15 (283,504) | 5 (777,572) |
| Studio | 30 min | 31 | 11 |
| Agency | 30 min | 63 | 23 |
| Max | 30 min | 112 | 41 |

**Free's 450,000 buys exactly two cuts** — two at its full 10-minute cap
(204,762 each), and then the account is out for good. Holding it to Standard is
what makes that work: at High a 10-minute cut is 369,451, so the credit would
buy one and then stall in `paused_quota` partway through a second it could
never finish.

The old worry about the 5-hour windows is **closed by deletion**: Pro's
369,514-token window and Studio's 739,030 were both short of a 30-minute High
clip (777,572), and neither window exists any more (§4).

#### How this is actually sold

**None of the tables above is a meter.** The meter a user sees is a percentage
of their window and nothing else — owner decision 2026-09-22, re-confirmed
2026-09-29. A countable unit was tried today and rejected: an ordinary cut is
~185,000 tokens while a 30-minute High one is 777,572, so any "N clips left"
counter would drop by four on a single upload and read as broken. Percent
cannot contradict itself — one cut takes 5% and a longer one takes 12%, and
nobody expected those to be equal. "Clip" is also already taken in this
codebase (`local_meta["clips"]`, `clip_secs`) for a source video file.

What a percentage cannot do is sell a plan, so the **pricing page quotes an
approximate cut count** — `ตัดได้ราว 22 คลิป/เดือน · คิดจากคลิปดิบ 5 นาที` —
generated by `limits.plan_cuts()` from `TYPICAL_CUT_TOKENS = 200,000`:

| Plan | Free | Lite | Starter | Pro | Studio | Agency | Max |
|---|---|---|---|---|---|---|---|
| quoted cuts | 2 | 4 | 9 | 22 | 45 | 90 | 160 |
| this document's Standard figure | 2 | 4 | 9 | 23 | 48 | 97 | 172 |

It is **marketing copy, never a quota**: nothing is subtracted from it, no
meter is drawn from it, it carries "ราว", and it states its basis. It is also
deliberately conservative — 200,000 is the 185,076 measured cut rounded up, so
the quoted number is never optimistic against the arithmetic above.

The question the count *looks* like it answers — "how many more runs do I
have?" — is answered inside the app by pricing each run before it starts
("งานนี้ใช้ประมาณ 5%"), not by counting anything.

### 4.5 An unpriced risk: the speech-to-text model setting

`packages/video/stt_pricing.py` carries two measured rates against the live
ElevenLabs account (2026-08-12, `scripts/probe_stt_cost.py`):

| model | credits/hour | ratio |
|---|---|---|
| `scribe_v2` | 4,000 | 1x |
| `scribe_v2_5` | 50,000 | **12.5x** |

Production runs `scribe_v2` — it is the default of
`Settings.elevenlabs_stt_model` and no override is set on Railway. But the
rate card has a **single** `stt_per_sec = 51.75` figure, pegged to `scribe_v2`'s
$0.27/h. Nothing in `rate_card.py` reads the model.

So changing one environment variable would multiply our real speech-to-text
cost by 12.5 while the user is charged **exactly the same**. Concretely, on one
30-minute transcript-mode clip:

| | `scribe_v2` | `scribe_v2_5` |
|---|---|---|
| STT our-tokens charged | 93,150 | 93,150 |
| charged to the user | ฿23.29 | ฿23.29 |
| real cost at the 2027 peg | ฿4.66 | ฿58.22 |
| **margin on the STT share** | +฿18.63 (80%) | **−฿34.93 (−150%)** |

The 80%-margin business becomes a loss-making one on that share, silently, with
no code change and no admin alert. `stt_pricing.is_rate_known` exists precisely
because the model is not assumed — but nothing downstream refuses to serve a
model the rate card was not built for. **This is an unpriced risk, not a
current cost:** today the setting is `scribe_v2` and the margin is real.

It would also be **invisible if it happened**, because no STT has ever been
charged (§3): the three rows in `core.stt_usage_logs` carry zero tokens and
predate `metering.py`. There is no baseline to notice a 12.5x departure from.

## 5. What is NOT in the cost model yet

These are real money and the admin dashboard does not know about them.

**Payment processing.** Stripe Thailand, checked 2026-09-29 against
`https://stripe.com/th/pricing`, `https://stripe.com/th/billing/pricing` and
`https://docs.stripe.com/payments/promptpay`. There is more than the card fee
this section used to carry:

| charge | rate | applies to |
|---|---|---|
| domestic card | **3.65% + ฿10** | every card payment |
| international card | **4.75% + ฿10** (+2% on conversion) | a card issued outside Thailand |
| **Stripe Billing** | **+0.7% of billing volume** | anything charged through a subscription/invoice |
| **dispute (chargeback)** | **฿500 per dispute** | won or lost |
| PromptPay | 1.65%, no fixed part | **one-time payments only** |

**PromptPay cannot be used for a subscription at all.** It is a single-use QR
rail: the customer authorises one amount once, there is nothing to store and
re-charge next month, and Stripe Checkout does not offer it in
`mode="subscription"`. The old table's PromptPay column for plan revenue was
therefore misleading — **plan revenue is card-only.** PromptPay is real money
saved where we *do* take a one-time payment, and that is exactly one place:
the wallet top-up (`topup.checkout_params` builds `mode="payment"`, and
`wallet.METHODS` already lists `promptpay` before `card`).

So a subscription costs **3.65% + 0.7% + ฿10 = 4.35% + ฿10** domestically:

| Plan | ฿/mo | card 3.65% | Billing 0.7% | fixed | total fee | net | gross 2027 | gross today |
|---|---|---|---|---|---|---|---|---|
| Lite | 199 | ฿7.26 | ฿1.39 | ฿10 | **฿18.66** | ฿180.34 | ฿140.34 (71%) | ฿160.34 (81%) |
| Starter | 399 | ฿14.56 | ฿2.79 | ฿10 | **฿27.36** | ฿371.64 | ฿281.64 (71%) | ฿326.64 (82%) |
| Pro | 990 | ฿36.14 | ฿6.93 | ฿10 | **฿53.06** | ฿936.93 | ฿716.93 (72%) | ฿826.93 (84%) |
| Studio | 1,990 | ฿72.64 | ฿13.93 | ฿10 | **฿96.56** | ฿1,893.43 | ฿1,443.43 (73%) | ฿1,668.43 (84%) |
| Agency | 3,990 | ฿145.64 | ฿27.93 | ฿10 | **฿183.56** | ฿3,806.43 | ฿2,906.43 (73%) | ฿3,356.43 (84%) |
| Max | 6,990 | ฿255.14 | ฿48.93 | ฿10 | **฿314.06** | ฿6,675.94 | ฿5,075.94 (73%) | ฿5,875.94 (84%) |

Adding Stripe Billing takes roughly **฿1.4 off Lite and ฿49 off Max** per month
versus the card-only figure this document carried before. The ฿10 fixed part is
still what hurts the cheap plans: 5.0% of Lite, 0.14% of Max. An international
card adds another 1.1% (+2% if converted) — unknown mix, not modelled.

**Disputes are the asymmetric one.** ฿500 is charged win or lose, on top of
losing the payment itself if lost. Measured against each plan's 2027 monthly
gross, one dispute costs:

| Plan | months of that user's margin |
|---|---|
| Lite | **3.6** |
| Starter | **1.8** |
| Pro | 0.7 |
| Studio | 0.3 |
| Agency | 0.2 |
| Max | 0.1 |

A single disputed Lite subscription wipes out more than a quarter of a year of
that account. Nothing in `cost_config.py` knows about any of this, so every
margin the admin dashboard shows is before all of it.

**Top-ups are the one place PromptPay applies**, and it matters more there
because there is no ฿10 to amortise and no Billing fee (`mode="payment"` is not
billing volume). Packs are ฿100 / ฿300 / ฿500 / ฿1,000 (`wallet.PACKS_SATANG`)
sold at ฿350/1M (`TOPUP_SATANG_PER_1M`):

| pack | tokens | cost 2027 | gross via PromptPay | gross via card |
|---|---|---|---|---|
| ฿100 | 285,714 | ฿14.29 | ฿84.06 (84%) | ฿72.06 (72%) |
| ฿300 | 857,143 | ฿42.86 | ฿252.19 (84%) | ฿236.19 (79%) |
| ฿500 | 1,428,571 | ฿71.43 | ฿420.32 (84%) | ฿400.32 (80%) |
| ฿1,000 | 2,857,143 | ฿142.86 | ฿840.64 (84%) | ฿810.64 (81%) |

PromptPay is worth **12 percentage points on the ฿100 pack** and 3 on the
฿1,000 one — the fixed ฿10 is the whole story. `wallet.METHODS` already orders
it first.

**Tax.** `vat_included = False` because the owner is an individual under the
฿1.8M/year VAT threshold. That threshold is ฿150,000/month of revenue — 754
Lite users, or 152 Pro, or 21 Max. Past it, registration is compulsory and 7%
comes off the top unless prices are raised. Profit is also personal income
(progressive to 35%), not corporate 20%: at some size the arithmetic of
incorporating changes. Neither is modelled anywhere in the code.

**Refunds.** `packages/billing/topup.py` reverses a refunded top-up's tokens,
but the vendor cost of whatever was already spent stays on our books, and
Stripe keeps the ฿10 on a refund.

## 6. Fixed costs and breakeven

`cost_config.py` carries ฿980 Railway + ฿120 R2 + ฿90 domains = **฿1,190/month**,
plus per-user items (SMS OTP ฿1.50/user, SMTP ฿0.35/clip).

At 2027 prices, full burn, after the full Stripe cost (card 3.65% + Billing
0.7% + ฿10, §5), covering the ฿1,190:

| Plan | users to break even |
|---|---|
| Lite | 8.5 |
| Starter | 4.2 |
| Pro | 1.7 |
| Studio | 0.8 |
| Agency | 0.4 |
| Max | 0.2 |

Free costs **฿23 once** at 2027 prices (฿11 today) per account that burns its
whole 450,000 credit, not ฿23 a month — that is what the `lifetime` window
bought. 53 fully-burning free accounts equal one month of fixed cost, and
unlike a monthly free tier they do not come back next month. `packages/billing/free_tier.py` is
still what stands between that and a signup farm, but the blast radius of a
farm is now bounded by how many accounts it can create, not by how long it
keeps them.

## 7. What moves the margin

| Lever | Effect |
|---|---|
| FX | The card is fixed at ฿34.5/USD. A weaker baht raises cost only: at ฿38/USD the 2027 cost becomes ฿55/1M (78% margin), at ฿32 it is ฿46/1M (81.4%). |
| Vendor price | A rise hits margin alone, never a user's limit — by design (`rate_card.py` reads no FX and no admin table). |
| Model mix | Only until 1 Jan 2027, and only because Flash is discounted. After that, none: every resource is ฿50/1M. |
| Mode mix | Video modes are ~90% margin today, transcript modes 84–89% (§4.3), because Scribe is already at the peg and Flash is not. From January both are 80%. |
| Plan budgets | The biggest single move this month, and not a vendor one: the 2026-09-29 budget rise cut the realised price from ฿250/1M to ฿218–225 from Starter up (§4), i.e. 2–3 points of margin on every paid plan. |
| STT model | The one lever that can go NEGATIVE: `scribe_v2_5` costs 12.5x `scribe_v2` and the rate card charges the same (§4.5). One env var. |
| Cached input | 10% of the input rate on both sides, so it is margin-neutral by construction — but it makes a run cheaper for the user, which is what the cache is for. |
| Prompt >200k on Pro | Gemini bills the WHOLE call at the long rate; the card does the same, so still neutral. |

---

## Open questions for the owner

1. **Payment fees are invisible in the admin dashboard.** Adding them to
   `cost_config.py` as a per-charge percentage + fixed item + a dispute line
   would make the margin shown the real one. Worth doing before the first real
   customers. Three recurring items, not one — 3.65%, 0.7% Billing, ฿10 —
   plus a dispute line at ฿500.
2. **฿10 fixed fee on Lite (฿199)** is 5.0% of the plan, and PromptPay cannot
   rescue it because PromptPay does not do subscriptions (§5). Either accept
   it, or make the entry plan quarterly/annual so the fixed fee is paid once
   instead of three or twelve times.
3. **The speech-to-text model is unpriced (§4.5).** `scribe_v2_5` costs 12.5x
   `scribe_v2` and the rate card charges the same for both. Either add a
   per-model `stt_per_sec` to a new rate-card version, or make the STT path
   refuse a model `stt_pricing.is_rate_known` does not know.
4. **The 40,000-token voiceover pass has never been measured** (§3, §4.1). It
   is the number Free's 450,000 credit is built on, and `core.stt_usage_logs`
   has no row that would confirm it. One real voiceover run through the billing
   path settles it.
5. **Everything past 5 minutes of source is extrapolated.** The three runs that
   ground this document are all 2–4 minutes. A single 30-minute production run
   at each precision would replace the weakest assumption in §4.2 with a
   measurement.
6. **The ladder now realises ฿218–225/1M against a ฿250 list** (§1, §4),
   because budgets rose on 2026-09-29 and prices did not. Full-burn 2027 margin
   is 77–78% from Starter up rather than 80%. That may be exactly what was
   intended — but it is a price cut that no price says, and nothing in the code
   records it as a decision.

**Closed since the last revision:** the 5-hour windows (Pro's 369,514 and
Studio's 739,030, both short of a 777,572-token 30-minute High clip) are gone —
no plan enforces `five_hour` or `weekly` any more.
