import { useCallback, useEffect, useState } from 'react'
import type { LocalProject } from '../../../preload'
import { STEP_LABELS, type ProjectStep } from '../lib/projectFlow'
import { deleteRemote, type ApiSession } from '../lib/videosLocalApi'

interface Props {
  session: ApiSession
  onOpen: (project: LocalProject) => void
  onCreate: (files: { path: string; name: string }[]) => void
}

function pickVideoFiles(): Promise<{ path: string; name: string }[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'video/*'
    input.multiple = true
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      resolve(
        files
          .map((f) => ({
            path:
              window.electron.webUtils?.getPathForFile?.(f) ??
              (f as unknown as { path?: string }).path ??
              '',
            name: f.name
          }))
          .filter((f) => f.path)
      )
    }
    input.oncancel = () => resolve([])
    input.click()
  })
}

export default function ProjectListPage({ session, onOpen, onCreate }: Props): React.JSX.Element {
  const [projects, setProjects] = useState<LocalProject[]>([])
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const load = useCallback(() => {
    window.noey.projects.list().then(setProjects)
  }, [])

  useEffect(load, [load])

  const startCreate = async (): Promise<void> => {
    const files = await pickVideoFiles()
    if (files.length > 0) onCreate(files)
  }

  const doDelete = async (uid: string): Promise<void> => {
    const project = projects.find((p) => p.uid === uid)
    await window.noey.projects.delete(uid)
    // Best-effort: remove the server-side record too so the web dashboard
    // doesn't keep listing a project whose files are gone.
    if (project?.remote?.uid) {
      deleteRemote(session, project.remote.uid).catch(() => undefined)
    }
    setConfirmDelete(null)
    load()
  }

  return (
    <div className="project-list">
      <header>
        <h1>โปรเจกต์วิดีโอ</h1>
        <button onClick={startCreate}>+ สร้างโปรเจกต์ใหม่</button>
      </header>
      {projects.length === 0 && (
        <p className="placeholder">ยังไม่มีโปรเจกต์ — เลือกคลิปเพื่อเริ่มตัดต่อด้วย AI</p>
      )}
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.uid} className="project-card" onClick={() => onOpen(p)}>
            <div className="project-name">{p.name}</div>
            <div className={`project-step step-${p.step}`}>
              {STEP_LABELS[p.step as ProjectStep] ?? p.step}
            </div>
            <div className="project-meta">
              {p.clips.length} คลิป · {new Date(p.createdAt).toLocaleDateString('th-TH')}
            </div>
            {p.error && <div className="project-error">{p.error}</div>}
            <div className="project-actions" onClick={(e) => e.stopPropagation()}>
              {confirmDelete === p.uid ? (
                <>
                  <button className="danger" onClick={() => doDelete(p.uid)}>
                    ยืนยันลบ
                  </button>
                  <button onClick={() => setConfirmDelete(null)}>ยกเลิก</button>
                </>
              ) : (
                <button onClick={() => setConfirmDelete(p.uid)}>ลบ</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
