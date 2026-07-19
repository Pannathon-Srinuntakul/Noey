"""Import all models so Alembic autogenerate sees them via Base.metadata."""

from packages.db.models.ai_prompt import AiPrompt
from packages.db.models.video_project import VideoProject
from packages.db.models.chat_session import ChatMessage, ChatSession
from packages.db.models.ai_run import AiRun
from packages.db.models.app_setting import AppSetting
from packages.db.models.core_auth import Job, Membership, Tenant, User
from packages.db.models.creator import Creator
from packages.db.models.custom_table import CustomTableMeta
from packages.db.models.effect_style import EffectStyle
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.market import MarketTrend
from packages.db.models.product import Product
from packages.db.models.sales import SalesDaily
from packages.db.models.scrape_run import ScrapeRun
from packages.db.models.tiktok_csv import (
    CsvImportRun,
    FollowerActivity,
    FollowerGender,
    FollowerHistory,
    FollowerTerritory,
    OverviewDaily,
    VideoContent,
    ViewersDaily,
)

__all__ = [
    "ChatSession",
    "ChatMessage",
    "Product",
    "Creator",
    "SalesDaily",
    "MarketTrend",
    "AiPrompt",
    "AiRun",
    "ScrapeRun",
    "AppSetting",
    "CustomTableMeta",
    "EffectStyle",
    "LlmUsageLog",
    "Tenant",
    "User",
    "Membership",
    "Job",
    "OverviewDaily",
    "VideoContent",
    "FollowerHistory",
    "FollowerActivity",
    "FollowerGender",
    "FollowerTerritory",
    "ViewersDaily",
    "CsvImportRun",
    "VideoProject",
]
