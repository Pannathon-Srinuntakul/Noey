"""Centralized configuration (env-driven). Single source of truth for all services."""

import os
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env from repo layout, not process cwd (worker cwd may vary).
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _BACKEND_DIR.parent
_ENV_FILES = tuple(
    str(p)
    for p in (_REPO_ROOT / ".env", _BACKEND_DIR / ".env")
    if p.is_file()
)


#: What `jwt_secret` falls back to when nothing sets it. Only ever acceptable on
#: a developer's own machine.
DEV_JWT_SECRET = "dev_change_me_in_production"

#: The seed script's fallback admin password. A fresh production database seeded
#: with this has a publicly known admin login.
DEV_ADMIN_PASSWORD = "ChangeMe123!"

#: `postgres_password`'s fallback.
DEV_POSTGRES_PASSWORD = "change_me"

#: Hosts that mean "this is someone's laptop". Anything else is treated as a
#: real deployment, where the placeholder secret is a refusal.
LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1", "postgres", "db", "host.docker.internal"}


def is_local_deployment(host: str | None) -> bool:
    """Whether the configured database host means "a developer's machine"."""
    return (host or "").strip().lower() in LOCAL_DB_HOSTS


#: Strictly this machine. ``LOCAL_DB_HOSTS`` also admits docker-compose service
#: names, which a self-hosted deployment uses too — fine for "which secrets
#: may be placeholders", not for anything that mints money.
LOOPBACK_DB_HOSTS = {"localhost", "127.0.0.1", "::1"}


def is_loopback_host(host: str | None) -> bool:
    return (host or "").strip().lower() in LOOPBACK_DB_HOSTS


def is_localhost_url(url: str | None) -> bool:
    """Whether a URL points at the machine it is opened on (a dev default)."""
    host = (urlsplit((url or "").strip()).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


class FakeAIInProduction(RuntimeError):
    """LOADTEST_FAKE_AI is set in an environment that says it is production."""


#: Environment variables that name the deployment environment. Railway sets
#: RAILWAY_ENVIRONMENT_NAME (and the older RAILWAY_ENVIRONMENT) on every service.
_ENVIRONMENT_VARS = ("RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "ENVIRONMENT", "APP_ENV")
_PRODUCTION_NAMES = {"production", "prod"}


def production_environment_marker() -> str | None:
    """``"VAR=value"`` for the first env var saying this is production, else None."""
    for var in _ENVIRONMENT_VARS:
        value = (os.getenv(var) or "").strip().lower()
        if value in _PRODUCTION_NAMES:
            return f"{var}={value}"
    return None


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_ENV_FILES or (str(_REPO_ROOT / ".env"), str(_BACKEND_DIR / ".env")),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Database ---
    postgres_user: str = "noey"
    postgres_password: str = "change_me"
    postgres_db: str = "noey_tiktok"
    postgres_host: str = "localhost"
    postgres_port: int = 5432

    # --- LLM gateway (provider-agnostic) ---
    # Gemini across the board (2026-09-08). The defaults used to be Anthropic
    # while every VIDEO path already ran on Gemini, so a single unnoticed
    # dependency — `plan-dub`, the only synchronous model call — kept a third
    # provider's billing alive. The owner uses two providers: Gemini for
    # everything a model does, and the speech service for transcription.
    llm_model: str = "gemini/gemini-3.7-flash"
    llm_vision_model: str | None = "gemini/gemini-3.1-pro-preview"
    # low | medium | high — Gemini maps this to thinking_level.
    llm_effort: str | None = None
    llm_vision_effort: str | None = "medium"
    llm_timeout_sec: int = 300  # text/chat — fail fast if API hangs
    llm_vision_timeout_sec: int = 900  # vision (22 frames) — up to 15 min
    llm_max_retries: int = 2  # retries on connection / 5xx / timeout
    llm_base_url: str | None = None
    llm_web_search_enabled: bool = True
    # API keys — passed explicitly to LiteLLM so os.environ is not required.
    # `anthropic_api_key`/`openai_api_key` stay declared but unset: the gateway
    # still resolves a key per model, so pointing any setting at one of those
    # providers keeps working without a code change. Nothing ships pointing at
    # them.
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None

    # --- Desktop dub_first video analysis (Gemini native video, proxy upload) ---
    # flash was tested and never produced a multi-angle line (always 1 cut per
    # voiceoverLineId) despite explicit prompt reinforcement — pro reasons
    # better about multi-shot editing structure. Still no Pro above 3.1 on the
    # public API (checked 2026-08-14), and 3.1-pro-preview is still a preview
    # with no free tier.
    #
    # Worth re-testing against gemini-3.7-flash (released 2026-08-13): Google's
    # own migration note points 3.1 Pro → 3.7 Flash, it is ~3x cheaper per token
    # in both directions, ~3x faster, and unlike Pro it has no >200k context
    # price step — which this path crosses on any source over ~11 minutes. The
    # flash result above was a much older flash generation. Compare the cut
    # lists before switching: video understanding is the ONE axis 3.7 barely
    # moved on (+1.2 on LVBench), and it is the axis this call lives or dies by.
    # Override via DUB_VISION_MODEL.
    dub_vision_model: str = "gemini-3.1-pro-preview"
    # Text-only segment selection for the speech modes (R17). Empty → falls
    # back to dub_vision_model. Override via SPEECH_SELECT_MODEL.
    speech_select_model: str = ""
    dub_vision_timeout_sec: int = 1200  # video inference is slower than Files-API frames
    # Thinking depth for the dub cut/re-edit calls, sent as `reasoning_effort`
    # which LiteLLM maps to Gemini's `thinking_level` (minimal|low|medium|high).
    # Was hardcoded "medium" at both call sites, so comparing depths — the whole
    # question when swapping the model — meant editing and redeploying code.
    # Note `llm_vision_effort` does NOT reach these: that one belongs to
    # `vision_call_kwargs()`, i.e. the Anthropic vision path. Override via
    # DUB_VISION_EFFORT.
    dub_vision_effort: str = "medium"
    # Cut-style distillation (packages/video/cut_style.py): >0 attaches
    # video_metadata {"fps": N} to the reference upload for denser sampling.
    # Enable ONLY after scripts/probe_gemini_fps.py confirms LiteLLM passes it
    # through to Gemini — PySceneDetect stats carry the rhythm signal regardless.
    cut_style_ref_fps: int = 0
    # Frame sampling rate for the dub/highlight cut call. 0 = Gemini's default
    # (~1 fps). The probe above now confirms per-block passthrough works, and
    # 5 fps measured ±0.08s cut-timestamp error vs ±0.42s at 1 fps while also
    # surfacing moments 1 fps never saw — at ~5x the video input tokens.
    # Intended as the backend half of a user-facing Precision tier.
    # ONLY safe because every caller uploads a 270x480 proxy: the same footage
    # at full resolution and >=8 fps is refused outright by Google
    # (PROHIBITED_CONTENT, not adjustable). See packages/llm/files.py.
    # Practical ceiling ~40 min of footage at 5 fps before the 1M context fills.
    dub_vision_fps: int = 0
    # User-facing quality tiers (packages/video/quality.py). The desktop shows
    # them as Engine lite|pro and Precision standard|high; only these two lines
    # know which provider model / frame rate that means.
    dub_engine_lite: str = "gemini-3.7-flash"
    dub_engine_pro: str = "gemini-3.8-flash"
    dub_precision_high_fps: int = 5
    # Which ตัดฉากเด่น edit-prompt generation the native-video call uses.
    # "v2" (2026-08-15): spans bounded by complete action arcs, spans/moments
    # RANKED rather than merely filtered, state continuity required, and no
    # duration quota — the ~45s norm is calibration, an explicit user target is
    # a ceiling. "v1" restores the exact previous prompts (frozen verbatim in
    # packages/video/dub_ai_v1.py, instruction fragments in dub_ai.py's v1
    # branches) — rollback is this one env var, no redeploy of code needed
    # beyond it. Override via DUB_PROMPT_VERSION.
    dub_prompt_version: str = "v2"

    # --- AI-assisted effects layer (camera motion) placement pass ---
    # Watches the already-cut video and places ffmpeg transforms (punch-zoom,
    # whip-pan, scene-drift). Same pro/video tier as the dub vision call — it
    # is a reasoning-heavy "where does motion belong" judgment, not a cheap
    # text task. Override via EFFECTS_VISION_MODEL.
    effects_vision_model: str = "gemini-3.1-pro-preview"
    effects_vision_timeout_sec: int = 900
    # Thinking depth for effects placement AND both style distillations
    # (effects_style.py, cut_style.py) — all three are "watch this and judge"
    # calls of the same shape. Default "high" keeps the behaviour they were
    # hardcoded to. Override via EFFECTS_VISION_EFFORT.
    effects_vision_effort: str = "high"

    # --- Auth (JWT) ---
    #: The default is a PLACEHOLDER and is refused outside local development —
    #: see `assert_production_secrets()`. It is in the source, so anything
    #: signed with it can be forged by anyone who can read the repo.
    jwt_secret: str = DEV_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_access_ttl: int = 60 * 30  # seconds (30 min)
    jwt_refresh_ttl: int = 60 * 60 * 24 * 14  # 14 days
    allow_registration: bool = False  # Register endpoint gated off per requirements.

    # --- Admin dashboard sessions (services/api/routers/admin.py) ---
    #: Admin access JWTs (audience "noey-admin") live this long; the admin app
    #: refreshes them while the server-side session is alive.
    admin_access_ttl: int = 60 * 30
    #: A session unused this long is dead (idle logout).
    admin_idle_timeout_sec: int = 60 * 30
    #: Absolute session lifetime, however active the admin is.
    admin_session_max_sec: int = 60 * 60 * 12
    #: How long a remembered browser may skip the emailed code (never the password).
    admin_device_ttl_days: int = 14
    #: Comma-separated client IPs allowed to use /admin/* at all. Empty = off.
    #: The IP is resolved with TRUSTED_PROXY_HOPS like every rate limit.
    admin_ip_allowlist: str = ""

    @property
    def admin_ip_allowlist_set(self) -> frozenset[str]:
        return frozenset(p.strip() for p in self.admin_ip_allowlist.split(",") if p.strip())

    # --- CORS (frontend origin + desktop Electron) ---
    frontend_url: str = "http://localhost:5173"
    # Comma-separated extra origins (e.g. another web deploy). Electron packaged
    # apps send Origin: null — always allowed in create_app().
    cors_extra_origins: str = ""

    # --- Encryption (Fernet) for AI keys stored in DB ---
    # urlsafe base64 32-byte key. Set via env in production.
    encryption_key: str | None = None

    # --- Background workers (arq / Redis) ---
    redis_url: str = "redis://localhost:6379/0"

    # --- API surface ---
    #: `/docs`, `/redoc` and `/openapi.json`. OFF by default: the schema lists
    #: every route with its docstring, and those docstrings name the providers.
    #: Nothing the product ships reads the schema — only a developer does, so it
    #: is opt-in per environment rather than public by default.
    api_docs_enabled: bool = False

    # --- Video processing ---
    ffmpeg_path: str | None = None  # optional override; else auto-detect PATH / WinGet
    #: Where uploads, renders and web project files live. Unset → `backend/data`,
    #: which is INSIDE the container image: on a redeploy every byte written
    #: there is gone. A deployment must point this at a mounted volume (or
    #: configure S3), and `data_root()` in packages/video/storage.py honours it.
    data_dir: str | None = None

    # --- S3-compatible object storage (optional — local filesystem used when unset) ---
    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None   # Cloudflare R2: https://<account>.r2.cloudflarestorage.com
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_region: str = "auto"

    # --- Speech-to-text (ElevenLabs Scribe — the only transcription path) ---
    # Replaced faster-whisper + the Modal GPU worker + the Gemini review pass.
    # Scribe returns frame-aligned word timestamps, so the silence cut is decided
    # arithmetically in packages/video/elevenlabs_stt.py — no VAD, no reviewer model.
    elevenlabs_api_key: str | None = None
    elevenlabs_stt_model: str = "scribe_v2"
    elevenlabs_language: str = "th"       # ISO-639-1; "" = auto-detect (risk of drift)
    # One request per clip, no chunking — a 2 h upload plus Scribe's own
    # processing has to fit inside this, so it is sized for the longest clip
    # the app accepts (DUB_MAX_CLIP_SEC), not for a typical one.
    elevenlabs_stt_timeout_sec: int = 2400
    # Character-level timings let word bounds be tightened past the word envelope
    # (leading breath / trailing tone decay). "word" halves the response size.
    elevenlabs_timestamps_granularity: str = "character"  # "character" | "word"
    # Model-side removal of filler words, false starts and disfluencies —
    # replaces the stutter/repeat classification the review pass used to do.
    elevenlabs_no_verbatim: bool = True
    # Tags laughter/applause/etc. build_silence_gaps keeps only the silent spans
    # that contain one of these; every other silent span is cut.
    elevenlabs_tag_audio_events: bool = True
    # Speaker separation — when on, words outside the dominant speaker are dropped
    # (bystanders, TV in the background). Off by default: a single-presenter clip
    # gains nothing and mis-clustering would delete real speech.
    elevenlabs_diarize: bool = False
    elevenlabs_num_speakers: int | None = None
    # Drop words below this log-probability. Conservative default — it only
    # catches tokens hallucinated over music/room noise. Tighten toward -1.0
    # after scripts/probe_elevenlabs.py shows the real distribution on your clips.
    elevenlabs_min_word_logprob: float = -2.0
    # Strip the RIFF header and upload headerless PCM (Scribe's pcm_s16le_16 fast
    # path). extract_speech_wav already writes 16-bit mono 16 kHz; anything else
    # falls back to uploading the container.
    elevenlabs_send_raw_pcm: bool = True
    # Fixed sampling seed so re-running a project transcribes to the same words
    # and therefore cuts at the same places. Any constant works — what matters is
    # that it does not change between runs. Determinism is best-effort per the
    # API docs, not a guarantee. Set to null to let the service pick each time.
    elevenlabs_seed: int | None = 1
    # temperature is deliberately NOT set: omitted, Scribe uses the value tuned
    # for the model (≈0 per the docs), which is what transcription wants.

    # --- Plan limits ---
    # The AI limits (rate-card tokens per rolling 5-hour / weekly / monthly
    # window, concurrency) live in ONE table: packages/billing/limits.py —
    # owner-approved numbers, deliberately not env-tunable. The old per-UTC-day
    # PLAN_*_MONTHLY_TOKENS settings were removed with the daily quota.

    # --- Server storage per plan (web build) ---
    # Default: packages/billing/limits.py PLAN_LIMITS[*].storage_gb (owner,
    # 2026-09-22: Free 1 GB, Lite 3, Starter 5, Pro 10, Studio 30, Agency 60,
    # Max 100 — the website's figures). Each PLAN_<TIER>_STORAGE_BYTES env var
    # still overrides one tier (an operational escape hatch, e.g. a disk
    # emergency). enterprise and admin accounts are unlimited (0).
    plan_free_storage_bytes: int | None = None
    plan_lite_storage_bytes: int | None = None
    plan_starter_storage_bytes: int | None = None
    plan_pro_storage_bytes: int | None = None
    plan_studio_storage_bytes: int | None = None
    plan_agency_storage_bytes: int | None = None
    plan_max_storage_bytes: int | None = None

    def plan_storage_limit(self, plan: str) -> int:
        """Bytes of server storage the given plan allows. 0 means unlimited."""
        from packages.billing.limits import UNLIMITED_PLANS, plan_limits

        name = (plan or "free").lower()
        if name in UNLIMITED_PLANS:
            return 0
        limits = plan_limits(name)
        tier = name if name in ("free", "lite", "starter", "pro", "studio", "agency", "max") else "free"
        override = getattr(self, f"plan_{tier}_storage_bytes", None)
        if override is not None:
            return int(override)
        return int(limits.storage_gb) * 1024**3

    # --- Token billing guards (docs/token-billing-design.md §6, §10, §12) ---
    #: Output + thinking budget the per-call guard assumes for a model call
    #: that sets no max_tokens and runs outside a paid run's profile. Paid runs
    #: use their profile's max_output (packages/billing/estimate.py).
    llm_max_output_tokens: int = 8_000
    #: Cross-process vendor rate limits (packages/billing/vendor_limits.py):
    #: requests / tokens per minute per Gemini family, and concurrent
    #: speech-to-text requests. 0 disables that limit. Defaults sit under the
    #: paid-tier AI Studio limits; set them to the project's real quota.
    #: Jobs one worker process runs at once (arq max_jobs). Most jobs are waiting on
    #: the AI vendors, not using CPU (measured 2026-09-22: 0.25 vCPU peak at 10),
    #: so this can sit well above the core count. The vendor limits below and
    #: `worker_transcode_concurrency` are what actually bound the work.
    worker_max_jobs: int = 30
    #: ffmpeg transcodes (the one CPU/RAM-heavy job) allowed at once per worker
    #: process, so a burst of iPhone HEVC uploads cannot starve the AI jobs
    #: sharing the container or run it out of memory.
    worker_transcode_concurrency: int = 2
    #: Read from the project's AI Studio rate-limit page on 2026-09-23 (Tier 1,
    #: "Default Gemini Project"): Flash 1,000 RPM / 2M TPM / 10,000 requests a
    #: DAY, Pro 25 RPM / 2M TPM / 250 a day. The daily caps are the real
    #: ceiling for the product — a cut uses ~4-5 Flash calls — so they are
    #: enforced alongside the per-minute ones in packages/billing/vendor_limits.py.
    gemini_rpm_flash: int = 1_000
    gemini_tpm_flash: int = 2_000_000
    gemini_rpd_flash: int = 10_000
    #: 25, not 150: Pro's Tier 1 request limit is tiny, and a guard set above
    #: the real quota just turns into 429s from the vendor.
    gemini_rpm_pro: int = 25
    gemini_tpm_pro: int = 2_000_000
    gemini_rpd_pro: int = 250
    #: Warn in the logs once a day, per model family, when the day's requests
    #: pass this share of the daily quota. The point is lead time: the daily cap
    #: does not clear until midnight Pacific, so noticing at 100% is noticing
    #: too late to do anything but wait.
    gemini_rpd_alert_ratio: float = 0.8
    #: Object-storage upload shaping (packages/video/s3.py). boto3's defaults
    #: give every upload 10 threads, 8 MB parts and a 100-deep queue — so a
    #: 527 MB clip is 63 parts and eighty concurrent uploads can ask for 800
    #: threads and gigabytes of buffered chunks. Measured 2026-09-23: at 80
    #: concurrent real uploads 44% returned 500 and throughput fell from
    #: 116 MB/s to 64. These bound it.
    s3_max_concurrent_uploads: int = 8
    s3_transfer_concurrency: int = 4
    s3_multipart_chunk_mb: int = 16
    elevenlabs_max_concurrency: int = 5
    #: How long a call may wait for a vendor slot before failing (retryable).
    vendor_wait_max_sec: int = 300
    #: Free-tier abuse limits (packages/billing/free_tier.py): distinct free
    #: accounts that may start AI work from one IP / device in 30 days, and
    #: free AI runs per IP / device per day. Proposals, env-tunable.
    free_accounts_per_ip: int = 3
    free_runs_per_ip_day: int = 10
    #: Runs per user per UTC day that end in ``our_failure`` and are refunded
    #: in full. Past this, a further failed run is charged what it used
    #: (capped at its ceiling): a failure we cannot tell from input the user
    #: controls (a timeout on an oversized file) must not be free to repeat.
    billing_free_refunds_per_day: int = 3
    #: Longest style-reference clip accepted (seconds) — cut / effects styles
    #: and the plan-effects reference: every second is billed video input.
    reference_max_sec: int = 1200
    #: Mock top-up (credits the wallet without a payment) — explicit opt-in,
    #: and even then only with the database on loopback. Refused at startup on
    #: a real deployment (assert_production_secrets).
    wallet_mock_topup: bool = False

    # --- Load testing (packages/llm/fake.py, loadtest/README.md) ---
    #: FAKE AI: every model call, Files API upload and speech-to-text request
    #: returns a canned answer after a delay instead of reaching a vendor.
    #: Everything around the call — reservation, guard, vendor slots, metering,
    #: queues, DB, Redis, S3 — stays real. For measuring capacity only; the
    #: settings refuse to load with it on in a production environment
    #: (``_refuse_fake_ai_in_production``).
    loadtest_fake_ai: bool = False
    #: Seconds a fake model call takes (median), with ±``jitter`` spread.
    loadtest_fake_ai_delay_sec: float = 75.0
    loadtest_fake_ai_jitter: float = 0.3
    #: Seconds a fake speech-to-text request takes (Scribe is much faster than
    #: a video model call). ±``jitter`` spread too.
    loadtest_fake_stt_delay_sec: float = 15.0
    #: Seconds a fake Files API upload takes.
    loadtest_fake_upload_sec: float = 2.0

    @field_validator("loadtest_fake_ai", mode="before")
    @classmethod
    def _blank_fake_ai_is_off(cls, value: object) -> object:
        # `LOADTEST_FAKE_AI=` (set but empty) means off, not a boot failure.
        return False if isinstance(value, str) and not value.strip() else value

    @model_validator(mode="after")
    def _refuse_fake_ai_in_production(self) -> "Settings":
        if self.loadtest_fake_ai:
            env = production_environment_marker()
            if env:
                raise FakeAIInProduction(
                    f"Refusing to start: LOADTEST_FAKE_AI is on but {env} — fake AI "
                    "answers must never reach a production environment. Unset LOADTEST_FAKE_AI."
                )
        return self

    # --- Billing (Stripe) — see docs/billing-stripe.md ---
    # Everything below is optional: with the key or the webhook secret unset,
    # the /billing endpoints answer 503 and nothing else changes.
    #: A RESTRICTED key (`rk_…`) is the recommendation; a full secret key
    #: (`sk_…`) also works. Never a publishable key.
    stripe_secret_key: str | None = None
    #: The signing secret (`whsec_…`) of the webhook endpoint that targets
    #: POST /billing/webhook. Billing refuses to take money without it: a
    #: subscription whose events cannot be verified would never reach the plan.
    stripe_webhook_secret: str | None = None
    #: Customer-portal configuration (`bpc_…`) printed by scripts/stripe_seed.py.
    #: Unset → the account's default portal configuration.
    stripe_portal_configuration_id: str | None = None
    #: Origin of the public marketing site: Checkout and the portal send the
    #: customer back here, and the browser calls this API from it (CORS).
    site_url: str = "http://localhost:3000"
    #: Stripe Tax on Checkout. OFF: it needs a head-office address and an
    #: active tax registration first, and does not apply to a business located
    #: in Thailand at all (see the tax note in docs/billing-stripe.md).
    billing_automatic_tax: bool = False

    # --- Self-service registration bot check (Cloudflare Turnstile) ---
    #: When set, POST /auth/register (and /auth/forgot-password, /contact)
    #: require a `turnstile_token` and verify it server-side. Unset → no check.
    turnstile_secret_key: str | None = None

    # --- Transactional email (SendGrid) — see docs/email-sendgrid.md ---
    # Unset key or sender → every endpoint whose job is to send mail answers
    # 503; registration still succeeds and logs that the mail was skipped.
    #: A RESTRICTED key with only "Mail Send" access.
    sendgrid_api_key: str | None = None
    #: The From address. Must belong to a domain authenticated in SendGrid
    #: (or be a verified single sender), or SendGrid refuses with 403.
    email_from_address: str | None = None
    email_from_name: str = "Noey Studio"
    #: Where POST /contact delivers (Reply-To is the visitor). Unset → /contact 503.
    contact_to_email: str | None = None
    #: Unverified, non-admin accounts cannot START paid AI work (403) — see
    #: services/api/ai_gate.py for the endpoints it covers.
    require_verified_email_for_ai: bool = True

    # --- Client IP behind proxies (rate limits) ---
    #: How many trusted reverse proxies append to X-Forwarded-For in front of
    #: the API. 0 = use the socket peer. Railway: 1 (docs/email-sendgrid.md).
    trusted_proxy_hops: int = 0

    @property
    def cors_origins(self) -> list[str]:
        origins = [self.frontend_url.rstrip("/")]
        for raw in self.cors_extra_origins.split(","):
            origin = raw.strip().rstrip("/")
            if origin and origin not in origins:
                origins.append(origin)
        # The marketing site signs people up and runs billing from the browser,
        # so its origin is allowed without a second place to remember it —
        # except the localhost default on a real deployment, where it can only
        # mean SITE_URL was never set.
        site = self.site_url.strip().rstrip("/")
        if (
            site
            and site not in origins
            and (is_local_deployment(self.postgres_host) or not is_localhost_url(site))
        ):
            origins.append(site)
        # On a developer's machine, allow BOTH dev servers without anyone having
        # to configure it: the legacy dashboard runs on 5173 and the web build on
        # 5174, and `frontend_url` can only name one of them. Never added on a
        # real deployment — there, every origin is explicit.
        if is_local_deployment(self.postgres_host):
            for port in (5173, 5174):
                for host in ("localhost", "127.0.0.1"):
                    dev = f"http://{host}:{port}"
                    if dev not in origins:
                        origins.append(dev)
        # Electron desktop (file://) sends Origin: null
        if "null" not in origins:
            origins.append("null")
        return origins

    # --- Database connection pool (packages/db/session.py) ---
    #: SQLAlchemy's defaults are pool_size=5 + max_overflow=10 — 15 per process.
    #: The 2026-09-22 load test hit that ceiling at 50 concurrent users: worker
    #: jobs died with QueuePool timeouts, the API answered in exactly 30 s (the
    #: default pool_timeout) and 28% of AI jobs never reached a terminal status,
    #: while every machine sat under 15% CPU. Sized explicitly ever since.
    db_pool_size: int = 30
    db_max_overflow: int = 20
    #: Fail fast instead of pretending to work: an overloaded pool should raise
    #: in seconds, not after half a minute of the client waiting.
    db_pool_timeout_sec: int = 10
    #: Recycle connections before a proxy or Postgres drops them.
    db_pool_recycle_sec: int = 1_800

    @property
    def database_url(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def sync_database_url(self) -> str:
        """Sync URL for Alembic migrations."""
        return (
            f"postgresql+psycopg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()


def reload_settings() -> Settings:
    """Clear cached settings (call after .env changes or in worker startup)."""
    get_settings.cache_clear()
    settings = get_settings()
    from packages.llm.config import sync_llm_env
    sync_llm_env()
    return settings


class InsecureConfiguration(RuntimeError):
    """Raised at startup when a deployment is running on development secrets."""


def assert_production_secrets() -> None:
    """Refuse to start a real deployment that is still on development secrets.

    Every value checked here has a default so a developer can clone and run,
    and every one of those defaults is a string in this repository: a token
    signed with the placeholder JWT secret can be MINTED by anyone who can read
    the source, for any account including an admin one, and a database seeded
    with the placeholder admin password has a publicly known login. JWT_SECRET
    was in fact unset on the live deployment (found 2026-09-08) — documentation
    alone clearly does not prevent that, so the process refuses to boot instead.

    "Real deployment" is inferred from the database host rather than an
    APP_ENV variable, because an APP_ENV that must be remembered is exactly as
    forgettable as the secret it is guarding.
    """
    s = get_settings()
    if is_local_deployment(s.postgres_host):
        return

    problems: list[str] = []
    if s.jwt_secret == DEV_JWT_SECRET:
        problems.append(
            "JWT_SECRET is the development placeholder — tokens signed with it "
            "can be forged by anyone who can read the source. Set it to a long "
            "random value on EVERY service (api AND worker); they must match."
        )
    if s.postgres_password == DEV_POSTGRES_PASSWORD:
        problems.append("POSTGRES_PASSWORD is the development placeholder.")
    seed_password = os.getenv("ADMIN_PASSWORD")
    if seed_password in (None, DEV_ADMIN_PASSWORD):
        problems.append(
            "ADMIN_PASSWORD is unset, so a fresh database is seeded with the "
            "placeholder admin login from scripts/migrate_to_multitenant.py."
        )
    if s.wallet_mock_topup:
        problems.append(
            "WALLET_MOCK_TOPUP is on — it credits wallet balance without a payment. "
            "Development only; unset it."
        )
    if not problems:
        return
    raise InsecureConfiguration(
        f"Refusing to start: POSTGRES_HOST is {s.postgres_host!r} (a real "
        "deployment) but development secrets are still in place.\n  - "
        + "\n  - ".join(problems)
    )


def announce_fake_ai() -> bool:
    """Startup hook for the API and the worker: re-check the production guard
    against the live environment and, when fake AI is on, say so loudly.

    ``get_settings()`` already refuses to build Settings with fake AI in a
    production environment; this re-checks without the settings cache, so a
    process whose environment changed after the first load still refuses.
    Returns whether fake AI is active.
    """
    s = get_settings()
    if not s.loadtest_fake_ai:
        return False
    env = production_environment_marker()
    if env:
        raise FakeAIInProduction(
            f"Refusing to start: LOADTEST_FAKE_AI is on but {env}. Unset LOADTEST_FAKE_AI."
        )
    from packages.core.logging import get_logger

    banner = "!" * 72
    log = get_logger(__name__)
    for line in (
        banner,
        "LOADTEST_FAKE_AI IS ON — every AI call returns a CANNED answer.",
        (
            f"model delay ~{s.loadtest_fake_ai_delay_sec:g}s ±{s.loadtest_fake_ai_jitter:.0%}, "
            f"speech-to-text ~{s.loadtest_fake_stt_delay_sec:g}s. No vendor is contacted."
        ),
        "Never run this in production. Results are for load testing only.",
        banner,
    ):
        log.warning("loadtest_fake_ai_active", banner=line)
    return True
