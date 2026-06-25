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
    llm_base_url: str | None = None
    llm_web_search_enabled: bool = True
    # API keys — passed explicitly to LiteLLM so os.environ is not required
    anthropic_api_key: str | None = None
    openai_api_key: str | None = None
    gemini_api_key: str | None = None

    # --- Auth (JWT) ---
    jwt_secret: str = "dev_change_me_in_production"
    jwt_algorithm: str = "HS256"
    jwt_access_ttl: int = 60 * 30  # seconds (30 min)
    jwt_refresh_ttl: int = 60 * 60 * 24 * 14  # 14 days
    allow_registration: bool = False  # Register endpoint gated off per requirements.

    # --- CORS (frontend origin) ---
    frontend_url: str = "http://localhost:3000"

    # --- Encryption (Fernet) for AI keys stored in DB ---
    # urlsafe base64 32-byte key. Set via env in production.
    encryption_key: str | None = None

    # --- Background workers (arq / Redis) ---
    redis_url: str = "redis://localhost:6379/0"

    # --- Video processing ---
    ffmpeg_path: str | None = None  # optional override; else auto-detect PATH / WinGet

    # --- Modal Whisper service (optional — local faster-whisper used when unset) ---
    modal_whisper_url: str | None = None  # set to Modal endpoint URL to use GPU transcription

    # --- S3-compatible object storage (optional — local filesystem used when unset) ---
    s3_bucket: str | None = None
    s3_endpoint_url: str | None = None   # Cloudflare R2: https://<account>.r2.cloudflarestorage.com
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_region: str = "auto"

    # --- Speech-to-text (faster-whisper) ---
    # large-v3-turbo: best quality/speed tradeoff for Thai on CPU (~4x large-v3 speed, ~93% quality).
    # Upgrade to large-v3 + whisper_device=cuda for maximum accuracy.
    whisper_model: str = "large-v3-turbo"
    whisper_device: str = "cpu"          # "cpu" | "cuda"
    whisper_compute: str = "int8"        # cpu: int8 | cuda: float16
    whisper_language: str = "th"         # force language; "" = auto-detect (risk of drift)

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
