import { useCallback, useEffect, useState } from 'react'
import type { LocalProject } from '../../preload'
import { ApiError, login, me, restoreSession, type Me } from './lib/api'
import type { ApiSession } from './lib/videosLocalApi'
import ProjectListPage from './pages/ProjectListPage'
import DubWizard from './pages/DubWizard'

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
    <div className="login-page">
      <h1>Noey Video Edit</h1>
      <form onSubmit={submit} className="login-form">
        <label>
          อีเมล
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoFocus
            required
          />
        </label>
        <label>
          รหัสผ่าน
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy}>
          {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
        </button>
      </form>
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
  const [openProject, setOpenProject] = useState<LocalProject | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)

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

  const createFromFiles = useCallback(
    async (files: { path: string; name: string }[]): Promise<void> => {
      setImporting(true)
      setImportError(null)
      try {
        const name = files[0].name.replace(/\.[^.]+$/, '')
        const project = await window.noey.projects.create({ name })
        const projectDir = await window.noey.projects.dir(project.uid)
        const done = await window.noey.sidecar.ingest.run({
          projectDir,
          sources: files.map((f) => f.path)
        })
        const updated = await window.noey.projects.update(project.uid, {
          clips: done.clips as LocalProject['clips'],
          step: 'imported'
        })
        setOpenProject(updated)
      } catch (err) {
        setImportError(String((err as Error).message ?? err))
      } finally {
        setImporting(false)
      }
    },
    []
  )

  if (openProject) {
    return (
      <DubWizard project={openProject} session={apiSession} onBack={() => setOpenProject(null)} />
    )
  }

  return (
    <div className="workspace">
      <header className="workspace-header">
        <span>
          {session.profile.email} · {session.profile.tenant_slug}
        </span>
        <button onClick={onLogout}>ออกจากระบบ</button>
      </header>
      {importing && <p className="progress-msg">กำลังนำเข้าคลิป…</p>}
      {importError && <div className="wizard-error">{importError}</div>}
      <ProjectListPage session={apiSession} onOpen={setOpenProject} onCreate={createFromFiles} />
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

  if (restoring) return <div className="login-page">กำลังโหลด…</div>
  if (!session) return <LoginPage onLogin={setSession} />
  return <Workspace session={session} onLogout={logout} />
}

export default App
