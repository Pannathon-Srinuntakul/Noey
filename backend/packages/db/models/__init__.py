"""Model registry.

Importing this module registers every model on Base.metadata — alembic's
autogenerate and the tenant-schema provisioning both read that registry, so a
model missing here is a table that silently never exists.

The analytics/dashboard family (CSV imports, custom tables, chat, prompts,
scrape runs, products/creators/market) was removed 2026-09-09 along with the
legacy frontend that was its only consumer.
"""

from packages.db.models.admin import (
    AdminAuditEvent,
    AdminDevice,
    AdminLoginChallenge,
    AdminSession,
    AdminSetting,
    PlanPriceOverride,
)
from packages.db.models.ai_run import AiRun
from packages.db.models.auth_token import AuthToken
from packages.db.models.billing import BillingAccount, StripeEvent
from packages.db.models.core_auth import Job, Membership, Tenant, User
from packages.db.models.effect_style import EffectStyle
from packages.db.models.fx import FxRate, VendorInvoice
from packages.db.models.llm_usage import LlmUsageLog
from packages.db.models.stt_usage import SttUsageLog
from packages.db.models.usage_account import UsageAccount
from packages.db.models.video_project import VideoProject
from packages.db.models.wallet import WalletLedger, WalletLot

__all__ = [
    "AdminAuditEvent",
    "AdminDevice",
    "AdminLoginChallenge",
    "AdminSession",
    "AdminSetting",
    "AiRun",
    "AuthToken",
    "BillingAccount",
    "EffectStyle",
    "FxRate",
    "Job",
    "LlmUsageLog",
    "Membership",
    "PlanPriceOverride",
    "StripeEvent",
    "SttUsageLog",
    "Tenant",
    "UsageAccount",
    "User",
    "VendorInvoice",
    "VideoProject",
    "WalletLedger",
    "WalletLot",
]
