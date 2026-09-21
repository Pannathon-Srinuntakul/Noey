"""Centralized configuration (env-driven). Single source of truth for all services."""

import os
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

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


def is_localhost_url(url: str | None) -> bool:
    """Whether a URL points at the machine it is opened on (a dev default)."""
    host = (urlsplit((url or "").strip()).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"}


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

    # --- LLM plan limits (tokens per DAILY window, 0 = unlimited) ---
    # The window is a rolling UTC calendar day — see packages/llm/usage.py:_period_start.
    # Env var names keep the "_monthly_" spelling for backward compatibility only.
    # 10M/day while the product is in testing with a single owner (owner's call,
    # 2026-08-12). It was 0 (unlimited), but the desktop settings screen shows
    # usage as a share of the quota and there is no share of "unlimited".
    # Raise it here or via PLAN_FREE_MONTHLY_TOKENS — do not hardcode the number
    # anywhere else.
    plan_free_monthly_tokens: int = 10_000_000
    # PLACEHOLDER (2026-09-21): lite and studio were added with self-service
    # billing before the owner costed them. The numbers only keep the paid
    # ladder in price order around starter/pro — they are not a decision.
    # Override via PLAN_LITE_MONTHLY_TOKENS / PLAN_STUDIO_MONTHLY_TOKENS.
    plan_lite_monthly_tokens: int = 1_000_000
    plan_starter_monthly_tokens: int = 2_000_000
    plan_pro_monthly_tokens: int = 10_000_000
    plan_studio_monthly_tokens: int = 20_000_000
    plan_enterprise_monthly_tokens: int = 0  # 0 = unlimited

    def plan_token_limit(self, plan: str) -> int:
        """Return the per-day token limit for the given plan name. 0 means unlimited."""
        mapping = {
            "free":       self.plan_free_monthly_tokens,
            "lite":       self.plan_lite_monthly_tokens,
            "starter":    self.plan_starter_monthly_tokens,
            "pro":        self.plan_pro_monthly_tokens,
            "studio":     self.plan_studio_monthly_tokens,
            "enterprise": self.plan_enterprise_monthly_tokens,
        }
        return mapping.get(plan, self.plan_free_monthly_tokens)

    # --- Server storage per plan (web build) ---
    # How much project storage an account may keep on the server. Same shape as
    # the token limits above and settable by env for the same reason: the plans
    # differ in exactly these figures, and the number must live in ONE place.
    # 10 GB across the board for the original four — the tiers were not sold
    # yet. The owner's pricing design says free 1 GB / starter 5 GB / pro 10 GB;
    # aligning these is the owner's call, so they are deliberately untouched.
    # lite and studio take the design's figures (3 GB / 30 GB).
    plan_free_storage_bytes: int = 10 * 1024**3
    plan_lite_storage_bytes: int = 3 * 1024**3
    plan_starter_storage_bytes: int = 10 * 1024**3
    plan_pro_storage_bytes: int = 10 * 1024**3
    plan_studio_storage_bytes: int = 30 * 1024**3
    plan_enterprise_storage_bytes: int = 0  # 0 = unlimited

    def plan_storage_limit(self, plan: str) -> int:
        """Bytes of server storage the given plan allows. 0 means unlimited."""
        mapping = {
            "free":       self.plan_free_storage_bytes,
            "lite":       self.plan_lite_storage_bytes,
            "starter":    self.plan_starter_storage_bytes,
            "pro":        self.plan_pro_storage_bytes,
            "studio":     self.plan_studio_storage_bytes,
            "enterprise": self.plan_enterprise_storage_bytes,
        }
        return mapping.get(plan, self.plan_free_storage_bytes)

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
    if not problems:
        return
    raise InsecureConfiguration(
        f"Refusing to start: POSTGRES_HOST is {s.postgres_host!r} (a real "
        "deployment) but development secrets are still in place.\n  - "
        + "\n  - ".join(problems)
    )
