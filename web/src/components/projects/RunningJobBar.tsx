import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  etaMinutes,
  progressPercent,
  progressStagesFor,
  SHORT_STEP_LABELS,
  type ProjectMode,
  type ProjectStep
} from '../../lib/projectFlow'
import { MODE_LABEL } from '../../lib/modeLabel'
import { useRouter } from '../../lib/router'
import type { ProjectPipeline } from '../../lib/useProjectPipeline'
import { Button } from '../ui/Button'
import { usePreviewFile } from '../../lib/usePreviewFile'
import { seekToPosterFrame } from '../../lib/videoPoster'

/** Full-width bar for the one project currently rendering (HANDOFF §5 item 5).
 * Replaces the per-card progress + AI thinking log the old grid showed. */
export function RunningJobBar({ job }: { job: ProjectPipeline }): React.JSX.Element {
  const { navigate } = useRouter()
  const mode: ProjectMode = job.mode
  // The voiceover tail only exists while it is actually running — without the
  // flag `indexOf` is -1 for these two steps and the bar reads zero for the
  // whole voiced render.
  const voiced = job.step === 'planning' || job.step === 'final_rendering'
  const stages = progressStagesFor(mode, { withVoiceover: voiced })
  const currentIndex = stages.indexOf(job.step as ProjectStep)
  const percent = progressPercent(job.step as ProjectStep, mode)
  const eta = etaMinutes(job.runStartedAt, percent)
  // Same picture the card shows — an empty grey rectangle next to a running
  // job gives no clue WHICH clip is running when several look alike.
  const previewFile = usePreviewFile(job.project.uid, job.step as ProjectStep, mode, job.mediaKey, {
    fallbackClipFile: job.project.clips?.[0]?.file
  })

  return (
    <div className="flex items-center gap-5 rounded-md border border-accent bg-surface p-5">
      <div className="h-28 w-16 shrink-0 overflow-hidden rounded-sm bg-media">
        {previewFile ? (
          <video
            key={`${job.project.uid}-${previewFile}-${job.mediaKey}`}
            src={window.noey.media.urlFor(job.project.uid, previewFile)}
            className="h-full w-full object-cover"
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(e) => seekToPosterFrame(e.currentTarget)}
          />
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-3">
          <p className="truncate text-[17px] font-semibold text-ink">{job.project.name}</p>
          <span className="shrink-0 text-sm text-muted">{MODE_LABEL[mode]}</span>
        </div>

        <div className="my-3 flex items-center gap-2">
          {/* Connectors are siblings of the labels so `flex-1` can stretch —
              nested, they collapse to their min width and bunch the steps at
              the left of the bar (same fix as the Progress primitive). */}
          {stages.map((stage, i) => (
            <Fragment key={stage}>
              {i > 0 ? (
                <span
                  className={cn(
                    'h-px min-w-[20px] flex-1',
                    i <= currentIndex ? 'bg-accent' : 'bg-border-faint'
                  )}
                />
              ) : null}
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm',
                  i === currentIndex ? 'font-semibold text-accent' : 'text-muted'
                )}
              >
                {i < currentIndex ? <Check size={13} className="text-accent" /> : null}
                {SHORT_STEP_LABELS[stage]}
              </span>
            </Fragment>
          ))}
        </div>

        <div className="h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
          <div
            className="h-1 rounded-[2px] bg-accent transition-[width] duration-panel ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2.5 text-sm tabular-nums text-ink-3">
          {percent}%{eta != null ? ` · เหลืออีกประมาณ ${eta} นาที` : ''} ·{' '}
          {job.progressMsg || SHORT_STEP_LABELS[job.step as ProjectStep]}
        </p>
      </div>

      <div className="flex shrink-0 flex-col gap-2">
        <Button
          variant="secondary"
          onClick={() => navigate({ name: 'progress', uid: job.project.uid })}
        >
          ดูรายละเอียด
        </Button>
        <Button variant="ghost" loading={job.stopping} onClick={() => void job.stop()}>
          {job.stopping ? 'กำลังหยุด…' : 'หยุดงาน'}
        </Button>
      </div>
    </div>
  )
}
