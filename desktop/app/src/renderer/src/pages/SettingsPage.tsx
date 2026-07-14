import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, Loader2, RefreshCw } from 'lucide-react'
import type { Session } from '../App'
import { ApiError, getUsage, restoreSession, type Usage } from '../lib/api'

async function fetchUsage(session: Session): Promise<Usage> {
  let accessToken = session.accessToken
  try {
    return await getUsage(session.baseUrl, accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
  }
  const pair = await restoreSession(session.baseUrl, accessToken, session.refreshToken)
  if (!pair) throw new ApiError(401, 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')
  accessToken = pair.access_token
  await window.noey.auth.save({
    baseUrl: session.baseUrl,
    email: session.profile.email,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token
  })
  return getUsage(session.baseUrl, accessToken)
}

export default function SettingsPage({
  session,
  onBack
}: {
  session: Session
  onBack: () => void
}): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const loadUsage = useCallback(async (opts?: { silent?: boolean }): Promise<void> => {
    const silent = opts?.silent ?? false
    if (!silent) setLoading(true)
    else setRefreshing(true)
    setError(null)
    try {
      const result = await fetchUsage(session)
      setUsage(result)
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'โหลดข้อมูลไม่สำเร็จ')
    } finally {
      if (!silent) setLoading(false)
      else setRefreshing(false)
    }
  }, [session])

  useEffect(() => {
    void loadUsage()
  }, [loadUsage])

  return (
    <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 sm:p-6">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-300 hover:border-white/25 hover:text-white"
        >
          <ArrowLeft size={14} />
        </button>
        <h2 className="flex-1 text-sm font-semibold uppercase tracking-widest text-amber-200/70">
          การใช้งาน AI
        </h2>
        <button
          type="button"
          onClick={() => void loadUsage({ silent: true })}
          disabled={loading || refreshing}
          className="flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-white/25 hover:text-white disabled:opacity-40"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'กำลังรีเฟรช…' : 'รีเฟรช'}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-amber-300/50">
          <Loader2 size={14} className="animate-spin" /> กำลังโหลด…
        </div>
      ) : error ? (
        <div className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</div>
      ) : usage ? (
        <div className="max-w-lg space-y-4">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs uppercase tracking-widest text-amber-200/70">แผน</span>
              <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                {usage.plan}
              </span>
            </div>
            <p className="mt-3 text-3xl font-bold text-amber-100">
              {usage.used_tokens.toLocaleString()}{' '}
              <span className="text-sm font-normal text-zinc-400">token</span>
            </p>
            <p className="mt-2 text-xs text-zinc-500">
              input {usage.input_tokens.toLocaleString()} · output {usage.output_tokens.toLocaleString()}
              <span className="text-zinc-600"> (output รวม thinking ของ Gemini/Claude)</span>
            </p>
            <p className="mt-1 text-sm text-zinc-400">
              จำกัด: {usage.unlimited ? 'ไม่จำกัด' : `${usage.limit_tokens.toLocaleString()} token`}
              {!usage.unlimited && usage.remaining_tokens !== null && (
                <> · เหลือ {usage.remaining_tokens.toLocaleString()} token</>
              )}
            </p>
            {!usage.unlimited && usage.usage_pct !== null && (
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full bg-amber-500"
                  style={{ width: `${Math.min(100, usage.usage_pct)}%` }}
                />
              </div>
            )}
            {usage.reset_at && (
              <p className="mt-3 text-xs text-zinc-500">
                รีเซ็ตในรอบถัดไป: {new Date(usage.reset_at).toLocaleString('th-TH')}
              </p>
            )}
          </div>

          {usage.by_feature.length > 0 && (
            <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
              <h3 className="mb-3 text-xs uppercase tracking-widest text-amber-200/70">
                แยกตามฟีเจอร์
              </h3>
              <div className="space-y-2">
                {[...usage.by_feature]
                  .sort((a, b) => b.total_tokens - a.total_tokens)
                  .map((f) => (
                    <div key={f.feature} className="flex items-start justify-between gap-3 text-sm">
                      <div>
                        <p className="text-zinc-300">{f.feature}</p>
                        <p className="text-[10px] text-zinc-500">
                          in {f.input_tokens.toLocaleString()} · out {f.output_tokens.toLocaleString()}
                        </p>
                      </div>
                      <span className="shrink-0 text-zinc-400">
                        {f.total_tokens.toLocaleString()} token
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-zinc-600">
            นับจาก LLM calls ผ่าน server (Gemini review, Claude dub) — ไม่รวม Whisper/Modal
            เพราะไม่ใช่ token billing ของ LLM API
          </p>
        </div>
      ) : null}
    </div>
  )
}
