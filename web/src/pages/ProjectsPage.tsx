import { Plus } from 'lucide-react'
import { useJobs } from '../lib/jobs'
import { useRouter } from '../lib/router'
import { useDeleteProject } from '../lib/useDeleteProject'
import { isBusy, type ProjectStep } from '../lib/projectFlow'
import { PageHeader } from '../components/shell/PageHeader'
import { FirstRunPanel } from '../components/projects/FirstRunPanel'
import { ProjectGridCard } from '../components/projects/ProjectGridCard'
import { RunningJobBar } from '../components/projects/RunningJobBar'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'

export default function ProjectsPage(): React.JSX.Element {
  const { projects, loading, jobFor, runningJobs } = useJobs()
  const { navigate } = useRouter()
  const requestDelete = useDeleteProject()

  const openProject = (uid: string, step: ProjectStep): void => {
    // While a job runs, every entry point routes to progress — the editor,
    // effects and export stay unreachable until it finishes.
    navigate(isBusy(step) ? { name: 'progress', uid } : { name: 'detail', uid })
  }

  const empty = !loading && projects.length === 0

  // One definition, two homes: the page header normally, the first-run tips row
  // when the workspace is empty.
  const entryActions = (
    <>
      <Button
        variant="primary"
        icon={<Plus size={16} />}
        onClick={() => navigate({ name: 'wizard' })}
      >
        สร้างวิดีโอใหม่
      </Button>
    </>
  )

  return (
    <>
      <PageHeader
        title={empty ? 'ยินดีต้อนรับ · เริ่มจากคลิปแรก' : 'โปรเจกต์ของฉัน'}
        subtitle={
          empty ? (
            'เลือกว่าอยากได้วิดีโอแบบไหน แล้วโยนคลิปดิบเข้ามา ที่เหลือระบบจัดการให้'
          ) : loading ? undefined : (
            <span className="tabular-nums">
              {projects.length} โปรเจกต์
              {runningJobs.length > 0 ? ` · กำลังทำ ${runningJobs.length} งาน` : ''}
            </span>
          )
        }
        // On the first run these move down into FirstRunPanel's tips row
        // (R2 screen 1) — the welcome header carries only its own words.
        actions={empty ? undefined : entryActions}
      />

      <div className="scroll-ghost flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pb-8 pt-5 sm:px-8">
        {runningJobs.map((job) => (
          <RunningJobBar key={job.project.uid} job={job} />
        ))}

        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(325px,100%),325px))] gap-4">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-md border border-border-faint p-4"
              >
                <Skeleton variant="media" className="h-[180px] w-full" />
                <Skeleton variant="text" index={0} className="h-4 w-3/5" />
                <Skeleton variant="text" index={1} className="h-3 w-2/5" />
              </div>
            ))}
          </div>
        ) : empty ? (
          <FirstRunPanel actions={entryActions} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(325px,100%),325px))] gap-4">
            {projects.map((p) => {
              const job = jobFor(p.uid)
              if (!job) {
                return (
                  <div
                    key={p.uid}
                    className="flex w-full max-w-[325px] flex-col gap-3 rounded-md border border-border-faint p-4"
                  >
                    <Skeleton variant="media" className="h-[180px] w-full" />
                    <p className="truncate text-[15px] text-ink">{p.name}</p>
                  </div>
                )
              }
              // Running jobs already have the full-width bar above.
              if (isBusy(job.step as ProjectStep)) return null
              return (
                <ProjectGridCard
                  key={p.uid}
                  job={job}
                  onOpen={() => openProject(p.uid, job.step as ProjectStep)}
                  onDelete={() => void requestDelete(p.uid, p.name)}
                />
              )
            })}
          </div>
        )}
      </div>
    </>
  )
}
