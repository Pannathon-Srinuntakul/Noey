import { useCallback, useEffect, useState } from 'react'
import { Film, Loader2 } from 'lucide-react'
import type { LocalProject } from '../../preload'
import { ApiError, login, me, restoreSession, type Me } from './lib/api'
import type { ApiSession } from './lib/videosLocalApi'
import NewProjectSidebar from './components/NewProjectSidebar'
import ProjectCard from './components/ProjectCard'

// Backend URL is baked in at build time — users never see or set it.
// Override for local dev/self-hosting: VITE_BACKEND_URL=... npm run build
const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'https://noey-api-production.up.railway.app'

interface Session {
  baseUrl: string
  accessToken: string
  refreshToken: string
  profile: Me
}

function LoginPage({ onLogin }: { onLogin: (s: Session) => void }): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.noey.auth.load().then((stored) => {
      if (stored) setEmail(stored.email)
    })
  }, [])

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const pair = await login(BACKEND_URL, email, password)
      const profile = await me(BACKEND_URL, pair.access_token)
      await window.noey.auth.save({
        baseUrl: BACKEND_URL,
        email,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token
      })
      onLogin({
        baseUrl: BACKEND_URL,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        profile
      })
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : 'เข้าสู่ระบบไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full items-center justify-center bg-[#07080d]">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur">
        <h1 className="mb-1 text-xl font-bold text-amber-200">Noey Video Edit</h1>
        <p className="mb-6 text-sm text-zinc-400">เข้าสู่ระบบ</p>

        <form onSubmit={submit} className="space-y-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">อีเมล</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-400">รหัสผ่าน</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"
            />
          </label>
          {error && (
            <div className="space-y-1 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">
              <p>{error}</p>
              <button
                type="button"
                className="text-xs text-red-300/60 underline hover:text-red-200"
                onClick={() => window.noey.log.openFolder()}
              >
                เปิดโฟลเดอร์ log
              </button>
            </div>
          )}
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white shadow hover:bg-amber-500 disabled:opacity-40"
          >
            {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    </div>
  )
}

function Workspace({
  session,
  onLogout
}: {
  session: Session
  onLogout: () => void
}): React.JSX.Element {
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [loadingList, setLoadingList] = useState(true)

  const apiSession: ApiSession = {
    baseUrl: session.baseUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    onTokens: (access, refresh) => {
      window.noey.auth.save({
        baseUrl: session.baseUrl,
        email: session.profile.email,
        accessToken: access,
        refreshToken: refresh
      })
    }
  }

  const load = useCallback(() => {
    window.noey.projects.list().then((list) => {
      setProjects(list)
      setLoadingList(false)
    })
  }, [])

  useEffect(load, [load])

  const handleCreated = (project: LocalProject): void => {
    setProjects((prev) => [project, ...prev])
  }

  const handleDeleted = (uid: string): void => {
    setProjects((prev) => prev.filter((p) => p.uid !== uid))
  }

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: 'linear-gradient(160deg, #1a0e06 0%, #0d1a14 100%)' }}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-white/10 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex items-center gap-3">
          <Film size={18} className="text-amber-400" />
          <h1 className="font-bold tracking-wide text-amber-100">AI Video Editor</h1>
          <span className="rounded-full border border-amber-500/40 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
            MVP · talking_head + dub_first
          </span>
        </div>
        <div className="flex items-center gap-3 text-sm text-zinc-400">
          <span>
            {session.profile.email} · {session.profile.tenant_slug}
          </span>
          <button
            onClick={onLogout}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25 hover:text-white"
          >
            ออกจากระบบ
          </button>
        </div>
      </header>
      <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 lg:flex-row lg:gap-6 lg:overflow-hidden lg:p-6">
        <NewProjectSidebar onCreated={handleCreated} />

        <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-amber-200/70">
            โปรเจกต์ของฉัน
          </h2>
          {loadingList ? (
            <div className="flex items-center gap-2 text-sm text-amber-300/50">
              <Loader2 size={14} className="animate-spin" /> กำลังโหลด…
            </div>
          ) : projects.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-white/10 bg-white/5 py-16 text-center">
              <Film size={40} className="text-amber-400/20" />
              <p className="mt-4 text-sm text-amber-300/50">ยังไม่มีโปรเจกต์</p>
              <p className="mt-1 text-xs text-amber-300/30">อัปโหลดวิดีโอเพื่อเริ่มต้น</p>
            </div>
          ) : (
            <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => (
                <ProjectCard
                  key={p.uid}
                  project={p}
                  session={apiSession}
                  onDeleted={handleDeleted}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null)
  const [restoring, setRestoring] = useState(true)

  useEffect(() => {
    const attempt = async (): Promise<void> => {
      const stored = await window.noey.auth.load()
      if (!stored) return
      // Always use the baked-in backend URL, ignoring any older stored value.
      const pair = await restoreSession(BACKEND_URL, stored.accessToken, stored.refreshToken)
      if (!pair) return
      const profile = await me(BACKEND_URL, pair.access_token)
      await window.noey.auth.save({
        ...stored,
        baseUrl: BACKEND_URL,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token
      })
      setSession({
        baseUrl: BACKEND_URL,
        accessToken: pair.access_token,
        refreshToken: pair.refresh_token,
        profile
      })
    }
    attempt()
      .catch(() => undefined)
      .finally(() => setRestoring(false))
  }, [])

  const logout = useCallback(() => {
    window.noey.auth.clear()
    setSession(null)
  }, [])

  if (restoring)
    return (
      <div className="flex h-full items-center justify-center bg-[#07080d] text-sm text-zinc-400">
        กำลังโหลด…
      </div>
    )
  if (!session) return <LoginPage onLogin={setSession} />
  return <Workspace session={session} onLogout={logout} />
}

export default App
