"""Centralized configuration (env-driven). Single source of truth for all services."""

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Resolve .env from repo layout, not process cwd (worker cwd may vary).
_BACKEND_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = _BACKEND_DIR.parent
_ENV_FILES = tuple(
    str(p)
    for p in (_REPO_ROOT / ".env", _BACKEND_DIR / ".env")
    if p.is_file()
)


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
    llm_model: str = "anthropic/claude-haiku-4-5-20251001"
    llm_vision_model: str | None = "anthropic/claude-sonnet-4-6"
    # Claude 4.6 effort: low | medium | high — only applies to models that support it
    llm_effort: str | None = None          # default text model (Haiku) — no effort param
    llm_vision_effort: str | None = "medium"  # Sonnet 4.6 vision tasks
    llm_timeout_sec: int = 300  # text/chat — fail fast if API hangs
    llm_vision_timeout_sec: int = 900  # vision (22 frames) — up to 15 min
    llm_max_retries: int = 2  # retries on connection / 5xx / timeout
    llm_base_url: str | None = None
    llm_web_search_enabled: bool = True
    # API keys — passed explicitly to LiteLLM so os.environ is not required
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
    jwt_secret: str = "dev_change_me_in_production"
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

    # --- Video processing ---
    ffmpeg_path: str | None = None  # optional override; else auto-detect PATH / WinGet

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
    plan_starter_monthly_tokens: int = 2_000_000
    plan_pro_monthly_tokens: int = 10_000_000
    plan_enterprise_monthly_tokens: int = 0  # 0 = unlimited

    def plan_token_limit(self, plan: str) -> int:
        """Return the per-day token limit for the given plan name. 0 means unlimited."""
        mapping = {
            "free":       self.plan_free_monthly_tokens,
            "starter":    self.plan_starter_monthly_tokens,
            "pro":        self.plan_pro_monthly_tokens,
            "enterprise": self.plan_enterprise_monthly_tokens,
        }
        return mapping.get(plan, self.plan_free_monthly_tokens)

    @property
    def cors_origins(self) -> list[str]:
        origins = [self.frontend_url.rstrip("/")]
        for raw in self.cors_extra_origins.split(","):
            origin = raw.strip().rstrip("/")
            if origin and origin not in origins:
                origins.append(origin)
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
