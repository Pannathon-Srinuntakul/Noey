"""Pydantic request/response models for the API boundary."""

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Overview(BaseModel):
    gmv: Decimal
    commission: Decimal
    units: int


class ProductRow(BaseModel):
    product_id: str
    title: str
    commission_rate: int | None
    units: int
    gmv: Decimal
    commission: Decimal


class CreatorRow(BaseModel):
    creator_id: str
    handle: str | None
    name: str | None
    units: int
    gmv: Decimal
    commission: Decimal


class MarketRow(BaseModel):
    id: int
    captured_at: datetime
    entity_type: str
    external_id: str | None
    title: str | None
    rank: int | None
    metric: Decimal | None


class PromptIn(BaseModel):
    name: str
    prompt: str
    schedule: str  # cron expression or preset token; clamped if it implies scraping
    enabled: bool = True


class PromptOut(PromptIn):
    id: int
    created_at: datetime
    updated_at: datetime


class RunOut(BaseModel):
    id: int
    prompt_id: int | None
    status: str
    output: str | None
    error: str | None
    created_at: datetime


class ChatHistoryItem(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class ChatIn(BaseModel):
    message: str
    history: list[ChatHistoryItem] = Field(default_factory=list)


class ChatOut(BaseModel):
    answer: str


class ChatSessionOut(BaseModel):
    uid: str
    title: str
    message_count: int
    has_summary: bool
    created_at: datetime
    updated_at: datetime


class ChatSessionDetail(ChatSessionOut):
    messages: list[ChatHistoryItem]


class ChatStreamIn(BaseModel):
    message: str
    session_uid: str | None = None


class ChatSessionRename(BaseModel):
    title: str


class DateRange(BaseModel):
    start: date | None = None
    end: date | None = None


class SettingsOut(BaseModel):
    llm_model: str
    llm_base_url: str | None
    keys: dict[str, bool]


class SettingsIn(BaseModel):
    llm_model: str | None = None
    llm_base_url: str | None = None


# ── CSV Import ────────────────────────────────────────────────────────────────


class ImportRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    export_date: date
    filenames: list[str]
    status: str
    rows_imported: int
    error: str | None
    created_at: datetime


# ── TikTok Analytics ──────────────────────────────────────────────────────────


class TiktokOverview(BaseModel):
    total_video_views: int
    total_profile_views: int
    total_likes: int
    total_comments: int
    total_shares: int
    current_followers: int | None
    avg_engagement_rate: float


class OverviewDailyRow(BaseModel):
    date: date
    video_views: int
    profile_views: int
    likes: int
    comments: int
    shares: int


class VideoRow(BaseModel):
    video_id: str
    video_url: str
    video_title: str
    post_date: date | None
    likes: int
    comments: int
    shares: int
    views: int
    engagement_rate: float


class FollowerHistoryRow(BaseModel):
    date: date
    followers: int
    net_change: int


class ViewersDailyRow(BaseModel):
    date: date
    total_viewers: int | None
    new_viewers: int | None
    returning_viewers: int | None


class GenderRow(BaseModel):
    gender: str
    distribution: float


class TerritoryRow(BaseModel):
    territory: str
    distribution: float


class DemographicsOut(BaseModel):
    export_date: date | None
    gender: list[GenderRow]
    territory: list[TerritoryRow]


# ── Custom Tables (user-defined dynamic tables) ───────────────────────────────

# UI type keys allowed for a column.
UI_TYPES = {"text", "number", "date", "datetime", "select", "multi_select", "boolean", "formula"}
FORMULA_KINDS = {"math", "aggregate", "percentage", "date"}
FORMULA_OPS = {
    "math": {"+", "-", "*", "/", "MOD"},
    "aggregate": {"SUM", "AVG", "MIN", "MAX", "COUNT"},
    "percentage": {"pct", "growth"},
    "date": {"date_diff", "date_add_days", "date_add_months", "date_add_years"},
}


class OptionDef(BaseModel):
    uid: str
    label: str
    color: str = "#6b7280"  # default: zinc-500
    order: int = 0


class FormulaDef(BaseModel):
    # Phase-1 legacy date formulas (kept for backward compat)
    type: str | None = None  # "date_add" | "date_diff"
    col_a: str | None = None
    col_b: str | None = None
    # Phase-3 expanded formulas
    kind: str | None = None  # "math" | "aggregate" | "percentage" | "date"
    op: str | None = None    # e.g. "+", "SUM", "pct", "date_diff"
    operands: list[str] = []  # col keys; for literals prefix with "lit:"


class ColumnMetaIn(BaseModel):
    label: str
    ui_type: str
    # options: accept string[] (legacy) or OptionDef[] (new with colors/order)
    options: list[str | OptionDef] = []
    formula: FormulaDef | None = None
    width: int = 160


class ColumnMetaOut(ColumnMetaIn):
    key: str  # "col_N" — the real pg column name
    seq: int


class CustomTableIn(BaseModel):
    display_name: str


class CustomTablePatch(BaseModel):
    display_name: str


class CustomTableOut(BaseModel):
    uid: str       # external-facing UUID (used in API routes and frontend URLs)
    id: int        # internal numeric PK (kept for DB join performance)
    display_name: str
    pg_table_name: str
    columns: list[ColumnMetaOut]
    row_count: int
    position: int
    summary_config: list[dict] = []
    created_at: datetime


class TableReorderIn(BaseModel):
    # Ordered list of table UIDs — backend sets position = index.
    ids: list[str]


SUMMARY_AGGS = {"count", "sum", "avg", "min", "max", "pct"}


class SummaryColConfig(BaseModel):
    col_key: str
    aggs: list[str]  # subset of SUMMARY_AGGS


class SummaryConfigIn(BaseModel):
    config: list[SummaryColConfig]


class ColumnPatch(BaseModel):
    label: str | None = None
    options: list[str | OptionDef] | None = None
    width: int | None = None


class CustomRowIn(BaseModel):
    # {col_key: value} — non-formula columns only.
    data: dict[str, Any]


class CustomRowOut(BaseModel):
    uid: str       # row UUID (external-facing, used for upsert)
    data: dict[str, Any]  # includes computed formula columns
    created_at: datetime | None = None


PAGE_SIZES = {20, 50, 100}
SORT_DIRS = {"asc", "desc"}


class RowsPage(BaseModel):
    rows: list[CustomRowOut]
    total: int
    page: int
    page_size: int


class SummaryRow(BaseModel):
    group: str  # the group-by value (e.g. "A")
    count: int
    metrics: dict[str, Any]  # {col_label: aggregated value}


class SummaryOut(BaseModel):
    group_by: str  # column key grouped on
    group_by_label: str
    rows: list[SummaryRow]
    metric_labels: list[str]  # ordered metric column labels for table header


# ── Usage & Plan schemas ─────────────────────────────────────────────────────

class UsageFeatureRow(BaseModel):
    feature: str
    input_tokens: int
    output_tokens: int
    total_tokens: int


class UsageMeOut(BaseModel):
    plan: str
    period_start: str
    used_tokens: int
    input_tokens: int
    output_tokens: int
    limit_tokens: int
    unlimited: bool
    remaining_tokens: int | None
    usage_pct: float | None
    by_feature: list[UsageFeatureRow]
    estimated_cost_usd: float
    reset_at: str | None


class AdminUsageRow(BaseModel):
    user_id: int
    email: str
    plan: str
    period_start: str
    used_tokens: int
    input_tokens: int
    output_tokens: int
    limit_tokens: int
    unlimited: bool
    usage_pct: float | None
    estimated_cost_usd: float
    reset_at: str | None


class SetPlanIn(BaseModel):
    plan: str
