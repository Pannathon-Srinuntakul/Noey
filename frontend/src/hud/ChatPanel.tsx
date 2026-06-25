import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  Send,
  Square,
  Trash2,
} from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { formatUserError } from '../errors'
import type { ChatSessionOut } from '../types'

interface Msg {
  role: 'user' | 'assistant'
  text: string
}

const THINKING_DOTS = ['.', '..', '...', '..'] as const

const PANEL_BG =
  'linear-gradient(160deg, rgba(245,233,203,0.98) 0%, rgba(225,205,158,0.98) 100%)'
const HEADER_BG = 'linear-gradient(180deg, #4a2e0c, #5b3a1a)'

function ThinkingIndicator({ label, light }: { label: string; light?: boolean }) {
  const [frame, setFrame] = useState(0)
  const base = label.replace(/…$/, '')

  useEffect(() => {
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % THINKING_DOTS.length)
    }, 450)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div className={`mb-4 pb-2 text-xs ${light ? 'text-[#5b3a1a]/70' : 'text-zinc-500'}`}>
      {base}
      <span className="inline-block w-[1.25em]">{THINKING_DOTS[frame]}</span>
    </div>
  )
}

function formatSessionTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffH = diffMs / 3_600_000
    if (diffH < 1) return 'เมื่อกี้'
    if (diffH < 24) return `${Math.floor(diffH)}ชม.`
    const diffD = Math.floor(diffH / 24)
    if (diffD === 1) return 'เมื่อวาน'
    if (diffD < 7) return `${diffD}วัน`
    return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })
  } catch {
    return ''
  }
}

export function ChatPanel() {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [busyStatus, setBusyStatus] = useState('กำลังคิด…')
  const [sessions, setSessions] = useState<ChatSessionOut[]>([])
  const [activeUid, setActiveUid] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const INPUT_MIN_PX = 36
  const INPUT_MAX_PX = 120

  function resizeInput() {
    const el = textareaRef.current
    if (!el) return
    el.style.overflowY = 'hidden'
    el.style.height = 'auto'
    const next = Math.max(el.scrollHeight, INPUT_MIN_PX)
    if (next > INPUT_MAX_PX) {
      el.style.height = `${INPUT_MAX_PX}px`
      el.style.overflowY = 'auto'
    } else {
      el.style.height = `${next}px`
      el.style.overflowY = 'hidden'
    }
  }

  useLayoutEffect(() => {
    resizeInput()
  }, [input, expanded])

  useLayoutEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [msgs, busy, busyStatus])

  useEffect(() => {
    if (msgs.length === 0 && !busy) return
    const t = window.setTimeout(() => {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }, 50)
    return () => window.clearTimeout(t)
  }, [msgs, busy, busyStatus])

  useEffect(() => {
    if (!expanded) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) setExpanded(false)
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener('keydown', onKey)
    }
  }, [expanded, busy])

  useEffect(() => {
    api.chatSessions.list().then((list) => {
      setSessions(list)
      if (list.length > 0 && activeUid === null) {
        loadSession(list[0].uid)
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadSession(uid: string) {
    try {
      const detail = await api.chatSessions.get(uid)
      setActiveUid(uid)
      setMsgs(detail.messages.map((m) => ({ role: m.role, text: m.content })))
    } catch { /* ignore */ }
  }

  function newSession() {
    setActiveUid(null)
    setMsgs([])
    setInput('')
  }

  async function deleteSession(uid: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await api.chatSessions.delete(uid)
      const updated = sessions.filter((s) => s.uid !== uid)
      setSessions(updated)
      if (activeUid === uid) {
        if (updated.length > 0) {
          loadSession(updated[0].uid)
        } else {
          newSession()
        }
      }
    } catch { /* ignore */ }
  }

  async function sendMessage() {
    const q = input.trim()
    if (!q || busy) return
    setInput('')
    setMsgs((m) => [...m, { role: 'user', text: q }])
    setBusy(true)
    setBusyStatus('กำลังคิด…')
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const result = await api.chatStream(q, activeUid, setBusyStatus, ac.signal)
      setMsgs((m) => [...m, { role: 'assistant', text: result.answer }])

      if (result.sessionUid && result.sessionUid !== activeUid) {
        setActiveUid(result.sessionUid)
      }
      const list = await api.chatSessions.list()
      setSessions(list)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setMsgs((m) => [...m, { role: 'assistant', text: formatUserError(e) }])
    } finally {
      abortRef.current = null
      setBusy(false)
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function activeTitle(): string {
    if (!activeUid) return 'แชทใหม่'
    return sessions.find((s) => s.uid === activeUid)?.title ?? 'แชทใหม่'
  }

  function sessionSidebar() {
    return (
      <div
        className={`flex flex-col transition-all duration-200 overflow-hidden shrink-0 ${
          expanded
            ? `border-r border-[#5b3a1a]/25 bg-[#5b3a1a]/8 ${sidebarOpen ? 'w-52' : 'w-0'}`
            : 'hidden'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between px-3 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[#5b3a1a]/80">
            ประวัติแชท
          </span>
          <button
            type="button"
            onClick={newSession}
            title="แชทใหม่"
            className="rounded p-1 text-[#5b3a1a]/70 hover:bg-[#5b3a1a]/10 hover:text-[#3a2a14]"
          >
            <MessageSquarePlus size={14} />
          </button>
        </div>
        <div className="scroll-ghost flex-1 overflow-y-auto">
          {sessions.map((s) => (
            <button
              key={s.uid}
              type="button"
              onClick={() => loadSession(s.uid)}
              className={`group flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[#5b3a1a]/10 ${
                activeUid === s.uid
                  ? 'bg-[#5b3a1a]/15 text-[#3a2a14]'
                  : 'text-[#5b3a1a]/90'
              }`}
            >
              <span className="line-clamp-2 text-xs leading-tight">{s.title}</span>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#5b3a1a]/55">{formatSessionTime(s.updated_at)}</span>
                <button
                  type="button"
                  onClick={(e) => deleteSession(s.uid, e)}
                  className="hidden rounded p-0.5 text-[#5b3a1a]/40 hover:text-red-700 group-hover:flex"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </button>
          ))}
          {sessions.length === 0 && (
            <p className="px-3 py-2 text-xs text-[#5b3a1a]/50">ยังไม่มีแชท</p>
          )}
        </div>
      </div>
    )
  }

  function sidebarToggle() {
    if (!expanded) return null
    return (
      <button
        type="button"
        onClick={() => setSidebarOpen((v) => !v)}
        className="flex shrink-0 items-center self-stretch border-r border-[#5b3a1a]/20 bg-[#5b3a1a]/5 px-1 text-[#5b3a1a]/50 hover:text-[#3a2a14]"
        title={sidebarOpen ? 'ซ่อนประวัติ' : 'แสดงประวัติ'}
      >
        {sidebarOpen ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
      </button>
    )
  }

  function messageList() {
    return (
      <div className="scroll-light flex-1 space-y-2 overflow-auto p-3 text-sm">
        {msgs.length === 0 && (
          <p className="text-[#5b3a1a]/60">
            Ask about your TikTok analytics, e.g. &quot;top video this week&quot;.
          </p>
        )}
        {msgs.map((m, i) => (
          <div
            key={i}
            className={`min-w-0 rounded-lg px-3 py-2 ${
              m.role === 'user'
                ? 'bg-[#5b3a1a]/12 text-[#3a2a14]'
                : 'bg-white/55 text-[#3a2a14] shadow-sm'
            }`}
          >
            {m.role === 'assistant' ? (
              <div className="chat-markdown chat-markdown-light min-w-0">
                <Markdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children, ...props }) => (
                      <div className="chat-table-wrap">
                        <table {...props}>{children}</table>
                      </div>
                    ),
                  }}
                >
                  {m.text}
                </Markdown>
              </div>
            ) : (
              <p className="m-0 whitespace-pre-wrap">{m.text}</p>
            )}
          </div>
        ))}
        {busy && <ThinkingIndicator label={busyStatus} light />}
        <div ref={bottomRef} className={`shrink-0 ${busy ? 'h-4' : 'h-px'}`} aria-hidden />
      </div>
    )
  }

  function inputBar() {
    return (
      <div className="flex shrink-0 items-end gap-2 border-t border-[#5b3a1a]/20 bg-[#f5e9cb]/80 p-2 px-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              sendMessage()
            }
          }}
          placeholder="Ask…"
          rows={1}
          className="scroll-light flex-1 resize-none overflow-hidden rounded-lg border border-[#5b3a1a]/30 bg-[#fffaf0] px-3 py-2 text-sm leading-normal text-[#3a2a14] outline-none placeholder:text-[#5b3a1a]/35 focus:border-[#5b3a1a]"
          style={{ minHeight: INPUT_MIN_PX, maxHeight: INPUT_MAX_PX }}
        />
        {busy ? (
          <button
            type="button"
            onClick={stop}
            aria-label="หยุด"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#5b3a1a]/80 text-amber-50 hover:bg-[#4a2e0c]"
          >
            <Square size={16} fill="currentColor" strokeWidth={0} />
          </button>
        ) : (
          <button
            type="button"
            onClick={sendMessage}
            disabled={!input.trim()}
            aria-label="ส่ง"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-[#5b3a1a] text-amber-50 hover:bg-[#4a2e0c] disabled:opacity-40"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    )
  }

  function compactHeader() {
    return (
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2"
        style={{ background: HEADER_BG }}
      >
        <h2 className="min-w-0 flex-1 truncate text-sm font-bold text-amber-100" title={activeTitle()}>
          {activeTitle()}
        </h2>
        <button
          type="button"
          onClick={newSession}
          title="แชทใหม่"
          aria-label="แชทใหม่"
          className="shrink-0 rounded p-1 text-amber-200/80 hover:bg-white/10"
        >
          <MessageSquarePlus size={15} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          title="ขยายเต็มหน้า"
          aria-label="ขยายเต็มหน้า"
          className="shrink-0 rounded p-1 text-amber-200/80 hover:bg-white/10"
        >
          <Maximize2 size={15} />
        </button>
      </div>
    )
  }

  function expandedHeader() {
    return (
      <div
        className="flex shrink-0 items-center justify-between gap-3 px-5 py-3"
        style={{ background: HEADER_BG }}
      >
        <h2 className="min-w-0 flex-1 truncate font-bold tracking-wide text-amber-100" title={activeTitle()}>
          {activeTitle()}
        </h2>
        <button
          type="button"
          onClick={newSession}
          title="แชทใหม่"
          aria-label="แชทใหม่"
          className="shrink-0 rounded p-1.5 text-amber-200/80 hover:bg-white/10"
        >
          <MessageSquarePlus size={16} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          title="ย่อกลับ"
          aria-label="ย่อกลับ"
          className="shrink-0 rounded p-1.5 text-amber-200/80 hover:bg-white/10"
        >
          <Minimize2 size={16} />
        </button>
      </div>
    )
  }

  const compactView = (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: PANEL_BG }}>
      {compactHeader()}
      <div className="flex min-h-0 flex-1 flex-col">
        {messageList()}
        {inputBar()}
      </div>
    </div>
  )

  const expandedView = createPortal(
    <div
      className="fixed inset-0 z-100 flex flex-col"
      style={{ background: PANEL_BG }}
    >
      {expandedHeader()}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {sessionSidebar()}
        {sidebarToggle()}
        <div className="flex min-w-0 flex-1 flex-col">
          {messageList()}
          {inputBar()}
        </div>
      </div>
    </div>,
    document.body,
  )

  return (
    <>
      {compactView}
      {expanded && expandedView}
    </>
  )
}
