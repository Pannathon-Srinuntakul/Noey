export interface Overview {
  gmv: string
  commission: string
  units: number
}

export interface ProductRow {
  product_id: string
  title: string
  commission_rate: number | null
  units: number
  gmv: string
  commission: string
}

export interface CreatorRow {
  creator_id: string
  handle: string | null
  name: string | null
  units: number
  gmv: string
  commission: string
}

export interface MarketRow {
  id: number
  captured_at: string
  entity_type: string
  external_id: string | null
  title: string | null
  rank: number | null
  metric: string | null
}

export interface PromptOut {
  id: number
  name: string
  prompt: string
  schedule: string
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface RunOut {
  id: number
  prompt_id: number | null
  status: string
  output: string | null
  error: string | null
  created_at: string
}

export type Dimension = 'content' | 'followers' | 'viewers'

export type RoomName = 'settings' | 'account' | 'catalog' | 'market' | 'revenue' | 'tables'

export interface SettingsOut {
  llm_model: string
  llm_base_url: string | null
  keys: Record<string, boolean>
}

export interface SettingsIn {
  llm_model?: string
  llm_base_url?: string
}

/** Normalized entity rendered as one sphere in the data world (one video). */
export interface Entity {
  id: string
  label: string
  views: number
  engagementRate: number
}

// ── CSV Import ────────────────────────────────────────────────────────────────

export interface ImportRunOut {
  id: number
  export_date: string
  filenames: string[]
  status: 'running' | 'ok' | 'error'
  rows_imported: number
  error: string | null
  created_at: string
}

// ── TikTok Analytics ──────────────────────────────────────────────────────────

export interface TiktokOverview {
  total_video_views: number
  total_profile_views: number
  total_likes: number
  total_comments: number
  total_shares: number
  current_followers: number | null
  avg_engagement_rate: number
}

export interface OverviewDailyRow {
  date: string
  video_views: number
  profile_views: number
  likes: number
  comments: number
  shares: number
}

export interface VideoRow {
  video_id: string
  video_url: string
  video_title: string
  post_date: string | null
  likes: number
  comments: number
  shares: number
  views: number
  engagement_rate: number
}

export interface FollowerHistoryRow {
  date: string
  followers: number
  net_change: number
}

export interface ViewersDailyRow {
  date: string
  total_viewers: number | null
  new_viewers: number | null
  returning_viewers: number | null
}

export interface GenderRow {
  gender: string
  distribution: number
}

export interface TerritoryRow {
  territory: string
  distribution: number
}

export interface DemographicsOut {
  export_date: string | null
  gender: GenderRow[]
  territory: TerritoryRow[]
}

// ── Custom Tables (user-defined dynamic tables) ───────────────────────────────

export type ColumnUiType =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'select'
  | 'multi_select'
  | 'boolean'
  | 'formula'

export interface OptionDef {
  uid: string
  label: string
  color: string
  order: number
}

export interface FormulaDef {
  // Legacy Phase-1
  type?: 'date_add' | 'date_diff'
  col_a?: string
  col_b?: string
  // Phase-3 expanded
  kind?: 'math' | 'aggregate' | 'percentage' | 'date'
  op?: string
  operands?: string[]
}

export interface ColumnMeta {
  key: string
  label: string
  ui_type: ColumnUiType
  options?: (string | OptionDef)[]
  formula?: FormulaDef | null
  width?: number
  seq: number
}

/** Shape sent when creating a column (no key/seq — backend assigns them). */
export interface ColumnMetaIn {
  label: string
  ui_type: ColumnUiType
  options?: (string | OptionDef)[]
  formula?: FormulaDef | null
  width?: number
}

/** Resolve option label from stored value. */
export function resolveOptionLabel(value: unknown, options: (string | OptionDef)[] = []): string {
  if (value == null) return ''
  if (typeof options[0] === 'object') {
    const opt = (options as OptionDef[]).find((o) => o.uid === value || o.label === value)
    return opt?.label ?? String(value)
  }
  return String(value)
}

/** Get option color ('' if options are plain strings). */
export function resolveOptionColor(value: unknown, options: (string | OptionDef)[] = []): string {
  if (typeof options[0] !== 'object') return ''
  const opt = (options as OptionDef[]).find((o) => o.uid === value || o.label === value)
  return opt?.color ?? ''
}

export interface SummaryColConfig {
  col_key: string
  aggs: ('count' | 'sum' | 'avg' | 'min' | 'max' | 'pct')[]
}

export const SUMMARY_AGG_LABELS: Record<string, string> = {
  count: 'นับ (COUNT)',
  sum:   'รวม (SUM)',
  avg:   'เฉลี่ย (AVG)',
  min:   'น้อยสุด (MIN)',
  max:   'มากสุด (MAX)',
  pct:   'เปอร์เซ็นต์ (%)',
}

export interface CustomTableOut {
  uid: string    // external UUID — used in routes: /tables/<uid>
  id: number     // internal PK
  display_name: string
  pg_table_name: string
  columns: ColumnMeta[]
  row_count: number
  position: number
  summary_config: SummaryColConfig[]
  created_at: string
}

export interface RowsPage {
  rows: CustomRowOut[]
  total: number
  page: number
  page_size: number
}

export interface CustomRowOut {
  uid: string    // row UUID
  data: Record<string, unknown>
  created_at: string | null
}

export interface SummaryRow {
  group: string
  count: number
  metrics: Record<string, number | null>
}

export interface SummaryOut {
  group_by: string
  group_by_label: string
  rows: SummaryRow[]
  metric_labels: string[]
}

// ── Chat Sessions ─────────────────────────────────────────────────────────────

export interface ChatSessionOut {
  uid: string
  title: string
  message_count: number
  has_summary: boolean
  created_at: string
  updated_at: string
}

export interface ChatHistoryItem {
  role: 'user' | 'assistant'
  content: string
}

export interface ChatSessionDetail extends ChatSessionOut {
  messages: ChatHistoryItem[]
}
