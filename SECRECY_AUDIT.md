# Secrecy Audit — what a desktop user can learn, and how to stop it

Audited against the real build artifact `desktop/app/dist/noey-video-edit-0.1.6-setup.exe`
(2026-08-13), not against the source tree. Every claim below was checked by
extracting `app.asar`, reading `win-unpacked/resources/`, and tracing the
server responses the app consumes.

**Threat model.** The adversary is an ordinary end user who installs the app —
a competing affiliate creator, or a customer who wants to rebuild the product.
They have the installer, a valid account, and a network sniffer. They do NOT
have server access. The goal is not perfect protection (client-side code can
always be reversed); it is to remove the exposures that require no skill at all.

---

## 1. What must stay secret

| # | Asset | Why it matters |
| --- | --- | --- |
| S1 | **API keys** — Anthropic, Gemini, OpenAI, ElevenLabs | Direct financial loss; anyone with the key spends our quota |
| S2 | **Which AI vendors/models we use** — Gemini 3.1 Pro (vision/planning), Claude Haiku 4.5 + Sonnet 4.6 (text), ElevenLabs Scribe v2 (STT) | The model mix IS the product decision. A competitor who knows it skips months of evaluation |
| S3 | **The prompts** — ~140 KB of prompt engineering across 11 named constants | The hardest-won IP in the repo. Copyable verbatim, works immediately for anyone |
| S4 | **Prompt-adjacent tuning** — schemas, few-shot examples, the checklist structure of style distillation, cut-decision arithmetic constants | Reproduces behaviour even without the prompt text |
| S5 | **Cost/margin data** — per-model pricing tables, credit-conversion rates | Reveals unit economics |
| S6 | **Server topology** — internal endpoint shapes, queue design, S3 bucket names | Attack surface for abuse of our infrastructure |

### The prompts, by file (all currently shipped to end users)

| Constant | File | Purpose |
| --- | --- | --- |
| `DUB_EDIT_SYSTEM` | `packages/video/dub_ai.py` | dub_first scene selection |
| `DUB_EDIT_SYSTEM_VIDEO` | `dub_ai.py` | same, video-input variant |
| `DUB_EDIT_SYSTEM_VIDEO_NO_VO` | `dub_ai.py` | same, no-voiceover variant |
| `DUB_REEDIT_SYSTEM_VIDEO` | `dub_ai.py` | re-edit pass |
| `DUB_TIMELINE_SYSTEM` | `dub_ai.py` | timeline planning |
| `DUB_EDIT_REMINDER` | `dub_ai.py` | trailing reinforcement block |
| `EFFECTS_PLACEMENT_SYSTEM` | `effects_ai.py` | zoom/transition placement + schema |
| `CUT_STYLE_DISTILL_SYSTEM` | `cut_style.py` | distil a reference clip into cut-style prose |
| `DEFAULT_CUT_STYLE_PROSE` | `cut_style.py` | fallback style description |
| `DEFAULT_REEDIT_CUT_STYLE_PROSE` | `cut_style.py` | fallback for re-edit |
| `STYLE_DISTILL_SYSTEM` | `effects_style.py` | distil a reference clip into zoom-style prose |

(`services/api/chat_service.py` holds one more system prompt, but that file is
server-only and never shipped.)

---

## 2. Findings

### ✅ Not exposed (verified, no action needed)

- **No API key of any kind is in the installer.** Scanned `app.asar` and every
  shipped `.py` for `sk-`, `sk-ant-`, `AIza`, `xai-`, `sk_` → zero hits. The
  architecture is already right: the desktop app never calls a model provider,
  it calls our API, and `prepare-resources.mjs` hard-fails if `packages/llm` is
  ever staged.
- **No `.env` ships.** `find . -name ".env*"` in `win-unpacked` → empty.
- **The JS bundle is clean.** `strings app.asar | grep -i "gemini|claude|elevenlabs|scribe|anthropic"`
  → zero hits. Source comments that name vendors (`lib/api.ts`,
  `videosLocalApi.ts`, `TaskBreakdown.tsx`) are stripped by the minifier.
- **No sourcemaps for our own code.** Only third-party `node_modules/*.map`.
- **Usage endpoints do not leak model names.** `/usage/me` and `/usage/stt`
  group by model server-side and return only totals plus feature/task labels.

### ❌ Exposed — ranked

#### F1 — Prompts and vendor identity ship as readable source (CRITICAL)

`C:\Program Files\Noey Video Edit\resources\backend\packages\video\*.py` are
**plain, uncompiled `.py` files**. No unpacking, no decompiling — Notepad opens
them.

`prepare-resources.mjs` copies the whole `packages/video` directory (24 modules).
The sidecar's actual dependency closure is **12**:

```
audio_extract  caption  dub_render  effects  effects_render  ffmpeg_bin
fonts  render_common  scene  timeline          (10 imported directly)
storage  transforms                            (2 pulled in transitively)
+ core/logging, core/settings
```

Everything else is dead weight that happens to be our IP:

| Shipped file | Bytes | Leaks |
| --- | --- | --- |
| `dub_ai.py` | 66,308 | S3 — 6 prompt constants |
| `effects_ai.py` | 44,850 | S3, S4 — prompt + placement schema |
| `elevenlabs_stt.py` | 25,831 | S2 — ElevenLabs Scribe, plus the word-gap cut arithmetic (S4) |
| `cut_style.py` | 17,488 | S3 |
| `effects_style.py` | 12,477 | S3 |
| `plan_core.py` | 5,366 | S4 |
| `style_profile.py` | 4,781 | S4 |
| `stt_pricing.py` | 1,884 | S5 — per-minute rates |

Plus `beat_analysis.py`, `face_tracker.py`, `s3.py` (S6 — bucket handling).

#### F2 — `core/settings.py` is a model manifest (CRITICAL)

Shipped, and it names every model with the reasoning behind the choice:

```python
llm_model: str = "anthropic/claude-haiku-4-5-20251001"
llm_vision_model: str | None = "anthropic/claude-sonnet-4-6"
dub_vision_model: str = "gemini-3.1-pro-preview"
effects_vision_model: str = "gemini-3.1-pro-preview"
elevenlabs_stt_model: str = "scribe_v2"
anthropic_api_key / openai_api_key / gemini_api_key / elevenlabs_api_key  # None, but named
```

Comments around them explain *why* 3.1-pro over 3.5-pro, which flags were probed,
etc. Values are `None`, so S1 holds — but S2 is fully disclosed.

#### F3 — Error text names Anthropic to the user's face (HIGH)

`packages/core/errors.py:127` and `:208`:

```python
return "เซิร์ฟเวอร์ AI (Anthropic) มีปัญหาชั่วคราว กรุณารอ 1–2 นาทีแล้วกดลองใหม่"
```

Shown on the project card whenever Anthropic returns 520.

#### F4 — Sanitizer falls through to the raw exception (HIGH)

`sanitize_technical_error()` ends with `return text` — anything it does not
recognise is forwarded verbatim. `_is_upstream_llm_error()` only knows:

```
litellm.  litellm.exceptions  anthropicexception  anthropic.
openai.   api.anthropic.com   cloudflare  ray_id
```

**No `gemini`, `vertex`, `google`, or `elevenlabs`** — yet Gemini does all the
vision/planning work and ElevenLabs does all STT. A `VertexAIException ... model
gemini-3.1-pro-preview ...` matches nothing and flows out intact.

Confirmed path: `tasks.py` stores `format_exception_message(exc)` → `Job.error`
→ `GET /jobs/{id}` returns `JobOut.error` unfiltered → rendered on the card.

#### F5 — `.claude/skills/**` packed into the asar (LOW)

Eight leftover `remotion-*` skill directories. `electron-builder.yml` excludes
`.agents/**` but not `.claude/**`. No secret, but it advertises internal tooling
and references a system that was removed.

#### F6 — `sidecar.exe` is PyInstaller (LOW, accepted)

Extractable with `pyinstxtractor` + a `.pyc` decompiler. After F1 is fixed the
only thing inside is ffmpeg orchestration, which is not sensitive. Listed for
completeness — do not spend effort here.

---

## 3. Fix plan

### P1 — Ship only the dependency closure (fixes F1)

In `desktop/app/scripts/prepare-resources.mjs`, replace the directory copy with
an explicit allowlist, and make it fail loudly rather than silently ship extra:

```js
const VIDEO_MODULES = [
  'audio_extract', 'caption', 'dub_render', 'effects', 'effects_render',
  'ffmpeg_bin', 'fonts', 'render_common', 'scene', 'storage', 'timeline',
  'transforms'
]
const CORE_MODULES = ['logging', 'settings', 'errors']
```

Then, in the same script, **verify the closure instead of trusting the list**:
walk the staged files, regex out every `from packages.X import` /
`import packages.X`, and throw if any resolves to a module that was not staged.
That turns "someone adds an import later" from a runtime crash in the field into
a build failure.

Guard against regression the way `packages/llm` is already guarded — assert the
staged tree contains none of:

```
dub_ai  effects_ai  cut_style  effects_style  plan_core
elevenlabs_stt  stt_pricing  style_profile  beat_analysis  s3  face_tracker
```

**Verify:** after building, `grep -rl "SYSTEM\|PROMPT" win-unpacked/resources/backend`
must return nothing, and both render paths (dub + talking_head) must still
complete end-to-end from the installed app.

### P2 — Split the settings file (fixes F2)

`core/settings.py` is one class serving both server and sidecar. The sidecar
needs `ffmpeg_path`, data dirs, and logging level — nothing else.

Two options, in order of preference:

1. **Split the class.** Extract a `RenderSettings` (paths + ffmpeg only) that the
   sidecar imports, leaving model names and key fields in the server-only
   `Settings`. Cleanest, and makes the boundary explicit in the code.
2. **Strip at stage time.** Have `prepare-resources.mjs` emit a reduced
   `settings.py` containing only the fields the staged modules reference. Faster
   to do, but generated code that drifts from the original is its own hazard —
   prefer option 1 unless the split proves invasive.

Either way the shipped file must contain no model identifier and no `*_api_key`
field name.

### P3 — Deny-by-default error sanitising (fixes F3, F4)

In `packages/core/errors.py`:

- Drop `"(Anthropic)"` from both strings — say `"เซิร์ฟเวอร์ AI มีปัญหาชั่วคราว"`.
- Replace the final `return text` with a generic message.
- Keep an explicit allowlist of messages that are *ours* and must reach the user
  verbatim (they are already Thai, already user-facing) — e.g. the no-speech
  message from `plan_core.py`. Simplest robust rule: our own domain errors raise
  a dedicated exception type (`UserFacingError`), and only that type passes
  through untouched. Matching on "is it Thai text" is not a rule, it is a
  coincidence.
- Log the raw exception server-side (already happens via structlog) so
  debuggability does not regress.

Add `gemini`, `vertex`, `google`, `elevenlabs`, `scribe` to
`_is_upstream_llm_error()` markers as defence in depth — after the fallback is
closed this only affects which generic message is chosen, but it keeps the
detector honest.

**Verify:** unit tests in `backend/tests/` asserting that a synthetic
`VertexAIException ... gemini-3.1-pro-preview ...`, an ElevenLabs 401, and an
Anthropic 520 all produce messages containing none of
`gemini|vertex|anthropic|claude|openai|elevenlabs|scribe`.

### P4 — Exclude `.claude/**` from the package (fixes F5)

Add to `electron-builder.yml` `files:`

```yaml
  - '!.claude/**'
```

next to the existing `!.agents/**`, with the same one-line reason.

### P5 — Second line of defence (optional, decide separately)

Compile the staged Python to `.pyc` and ship those instead of `.py`. It stops
casual reading — a decompiler still recovers logic, and comments are lost, which
is exactly the point. Only worth doing after P1, since after P1 there is little
left worth hiding. Do **not** treat this as a substitute for P1.

---

## 4. Order and cost

| Step | Fixes | Risk if skipped | Effort |
| --- | --- | --- | --- |
| P1 | F1 | 140 KB of prompt IP in every installer | M — must trace imports |
| P2 | F2 | Full model lineup disclosed | M — API surface change |
| P3 | F3, F4 | Model names leak via error toast | S–M — needs the allowlist done right |
| P4 | F5 | Minor noise | XS |
| P5 | F6 | Accepted risk | S |

P1 and P4 are mechanical. P2 and P3 change interfaces and need tests. Nothing
here is user-visible except P3's wording, which improves it.

**Note on what this does NOT fix.** Anyone can still watch the network: they see
requests to our API, the shape of `/videos/{uid}/plan-dub`, and how long each
takes. They do not see which model runs behind it. That is the correct boundary —
the server is the only thing that knows, and it should stay that way.
