import type { ReactNode } from "react";
import { SAMPLE_CLIPS, SAMPLE_CUT_SECONDS, SAMPLE_LINES, SAMPLE_PROJECT, SAMPLE_SOURCE_SECONDS, sceneStill } from "../sample";
import { fmtClock } from "./Wizard";
import { BrandMark, Button, CheckboxMark, Icon, Omit, Spinner, Still, TitleBar, cn } from "./ui";

/**
 * The app's own pages around the editor, as the web build draws them:
 * AppShell (title bar + nav rail), PageHeader, the job progress page, the
 * project page and its export dialog (web/src/components/shell/*,
 * pages/JobProgressPage.tsx, pages/ProjectDetailPage.tsx,
 * components/ExportVideoModal.tsx, components/ArtifactChecklist.tsx).
 * Helper lines and secondary actions are left out in place (Omit).
 */

/** shell/NavRail.tsx on the web build (no สไตล์), โปรเจกต์ active. */
function NavRail() {
  return (
    <nav className="flex w-52 shrink-0 flex-col gap-5 border-r border-divider bg-surface px-3 py-5">
      <div className="flex items-center gap-2.5 px-2">
        <BrandMark size={20} className="text-accent" />
        <span className="am-display whitespace-nowrap text-[19px] text-ink">Noey Studio</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="flex h-11 items-center gap-2.5 rounded-md bg-accent-nav px-2.5 text-[15px] font-semibold text-accent shadow-[inset_2px_0_0_var(--color-accent)] md:h-10">
          <Icon name="FolderOpen" size={17} />
          โปรเจกต์
        </span>
        <span className="flex h-11 items-center gap-2.5 rounded-md px-2.5 text-[15px] text-ink-3 md:h-10">
          <Icon name="Settings" size={17} />
          ตั้งค่า
        </span>
      </div>
      <div className="mt-auto border-t border-divider pt-3.5">
        <div className="flex items-center gap-2.5 px-2">
          <span className="am-display flex h-8 w-8 items-center justify-center rounded-full border border-border text-[17px] text-accent">N</span>
          <span className="min-w-0 truncate text-[15px] text-ink">noey</span>
        </div>
      </div>
    </nav>
  );
}

/** shell/AppShell.tsx: title bar, nav rail, main. */
function AppShell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-ground">
      <TitleBar label={label} />
      <div className="relative flex min-h-0 flex-1">
        <NavRail />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</main>
      </div>
    </div>
  );
}

/** shell/PageHeader.tsx with the back link. */
function PageHeader({ title, subtitle, actions }: { title: string; subtitle: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-divider px-5 pb-[18px] pt-6 sm:flex-nowrap sm:px-8">
      <div className="min-w-0">
        <span className="-ml-2 inline-flex min-h-11 items-center gap-[7px] rounded-md px-2 text-sm text-muted md:-ml-1 md:min-h-0 md:px-1">
          <Icon name="ArrowLeft" size={14} />
          โปรเจกต์ทั้งหมด
        </span>
        <p className="mt-1.5 line-clamp-2 break-words text-[22px] font-semibold leading-[1.2] text-ink sm:line-clamp-1 sm:text-[34px] sm:leading-[1.15]">{title}</p>
        <p className="mt-1 text-sm text-muted">{subtitle}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
    </div>
  );
}

// ─── Job progress ────────────────────────────────────────────────────────────

const STAGES = ["นำเข้า", "วิเคราะห์ภาพ", "ตัดต่อ", "คลิปพร้อม"];

/** One state of the progress card (ui/Progress.tsx). */
function ProgressState({ index, message, eta }: { index: number; message: string; eta?: number }) {
  const percent = index * 25;
  return (
    <>
      <div className="rounded-md border border-accent p-5">
        <div className="flex flex-wrap items-center gap-2">
          {STAGES.map((stage, i) => (
            <span key={stage} className="contents">
              {i > 0 ? <span className={cn("hidden h-px min-w-[20px] flex-1 sm:block", i <= index ? "bg-accent" : "bg-border-faint")} /> : null}
              <span className={cn("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm", i === index ? "font-semibold text-accent" : "text-muted")}>
                {i < index ? <Icon name="Check" size={13} className="text-accent" /> : null}
                {stage}
              </span>
            </span>
          ))}
        </div>
        <div className="mt-4 h-1 rounded-[2px] bg-[rgb(243_242_242_/_0.18)]">
          <div className="h-1 rounded-[2px] bg-accent" style={{ width: `${percent}%` }} />
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-[15px] tabular-nums text-ink-3">
          <Spinner size={13} className="shrink-0 text-accent" />
          {`${percent}%${eta != null ? ` · เหลืออีกประมาณ ${eta} นาที` : ""}`}
        </p>
      </div>
      <div className="rounded-md border border-divider px-5 py-[18px]">
        <p className="text-[15px] font-semibold text-ink">สิ่งที่ AI กำลังทำ</p>
        <p className="mt-2.5 flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} className="shrink-0 text-accent" />
          {message}
        </p>
      </div>
    </>
  );
}

/**
 * The run's states in order, as the web pipeline reports them for a
 * ตัดฉากเด่น job (lib/useProjectPipeline.ts messages, lib/projectFlow.ts
 * stages). `states` picks which to draw; more than one are stacked for the
 * choreography (data-am-state).
 */
const PROGRESS_STATES = [
  { index: 0, message: "กำลังนำเข้าคลิป 3/5…" },
  { index: 1, message: "กำลังย่อวิดีโอให้ AI 4/5…", eta: 3 },
  { index: 1, message: "กำลัง match script กับซีนวิดีโอ…", eta: 2 },
  { index: 2, message: "กำลังตัดซีนที่ 5/8…", eta: 1 },
] as const;

/**
 * When each drawn state takes over in the hero (seconds into the beat, by
 * position in `states`). The hero draws the run from 25% on: opening on the
 * import at 0%, the beat read as a job that had stalled before it started.
 */
const STATE_AT = [0, 1.8, 3.6];

export function JobProgress({ states = [2] }: { states?: readonly number[] }) {
  return (
    <AppShell label={`${SAMPLE_PROJECT} · กำลังทำงาน`}>
      <PageHeader
        title={SAMPLE_PROJECT}
        subtitle={
          <span className="inline-flex items-center gap-1.5">
            <Spinner size={13} className="text-accent" />
            ตัดฉากเด่น · กำลังทำงาน — แก้ไขได้เมื่อเรนเดอร์เสร็จ
          </span>
        }
        actions={
          <Omit>
            <Button variant="danger" icon={<Icon name="Square" size={15} fill="currentColor" />}>
              หยุดงาน
            </Button>
          </Omit>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-8 pt-6 lg:flex-row lg:px-8">
        <div className={cn("flex min-w-0 flex-1 flex-col gap-4", states.length > 1 && "am-states")}>
          {states.map((state, i) => (
            <div
              key={state}
              className="flex flex-col gap-4"
              style={states.length > 1 ? ({ "--in": `${STATE_AT[i]}s`, "--out": `${STATE_AT[i + 1] ?? 99}s` } as React.CSSProperties) : undefined}
            >
              <ProgressState {...PROGRESS_STATES[state]} />
            </div>
          ))}
        </div>
        <div className="w-full shrink-0 rounded-md border border-divider px-5 py-[18px] lg:w-[300px]">
          <p className="mb-3 text-[15px] font-semibold text-ink">ไฟล์ต้นฉบับ</p>
          <div className="flex flex-col gap-2.5 text-sm text-muted">
            {SAMPLE_CLIPS.map((clip, i) => (
              <span key={clip.file} className="flex justify-between gap-2 tabular-nums">
                <span className="min-w-0 truncate">{`norm_00${i}.mp4`}</span>
                <span className="shrink-0 text-ink">{fmtClock(clip.seconds)}</span>
              </span>
            ))}
            <span className="flex justify-between tabular-nums">
              รวม <span className="text-ink">{fmtClock(SAMPLE_SOURCE_SECONDS)}</span>
            </span>
          </div>
          <p className="mt-3.5 border-t border-divider pt-3 text-[13px] leading-[1.6] text-muted">แก้ไขวิดีโอ และส่งออก จะเปิดได้เมื่องานนี้เสร็จ</p>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The progress page's "สิ่งที่ AI กำลังทำ" card while clips are converted on
 * the server (lib/useProjectPipeline.ts: กำลังแปลงคลิป n/total บนเซิร์ฟเวอร์…),
 * the counter stepping through the five sample clips when `animated`.
 */
export function JobProgressMessage({ animated = false }: { animated?: boolean }) {
  const total = SAMPLE_CLIPS.length;
  return (
    <div className="rounded-md border border-divider px-5 py-[18px]">
      <p className="text-[15px] font-semibold text-ink">สิ่งที่ AI กำลังทำ</p>
      <p className="mt-2.5 flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} className="shrink-0 text-accent" />
        {animated ? (
          <span className="am-count am-steps">
            {SAMPLE_CLIPS.map((_, i) => (
              <span key={i} className="am-count__n" style={{ "--k": i } as React.CSSProperties}>
                {`กำลังแปลงคลิป ${i + 1}/${total} บนเซิร์ฟเวอร์…`}
              </span>
            ))}
          </span>
        ) : (
          `กำลังแปลงคลิป 2/${total} บนเซิร์ฟเวอร์…`
        )}
      </p>
    </div>
  );
}

// ─── Project page + export ───────────────────────────────────────────────────

const STEP_LABELS = ["กำลังนำเข้าคลิป", "นำเข้าคลิปแล้ว", "AI กำลังวิเคราะห์", "กำลังตัดวิดีโอ (เงียบ)", "คลิปพร้อม (ภาพอย่างเดียว)"];

/** pages/ProjectDetailPage.tsx for the finished sample cut; `video` sits in the player. */
export function ProjectDetail({ video, exportOpen = false }: { video?: ReactNode; exportOpen?: boolean }) {
  return (
    <div className="relative h-full">
      <AppShell label={SAMPLE_PROJECT}>
        <PageHeader
          title={SAMPLE_PROJECT}
          subtitle={`ตัดฉากเด่น · ภาพอย่างเดียว · ${fmtClock(SAMPLE_SOURCE_SECONDS)} · 1080×1920 · 1 ต.ค. 10:24`}
          actions={
            <Button variant="primary" icon={<Icon name="Download" size={16} />} data-am-target="export">
              ส่งออกวิดีโอ
            </Button>
          }
        />
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pb-8 pt-5 lg:flex-row lg:overflow-hidden lg:px-8">
          <div className="flex shrink-0 flex-col gap-3 lg:sticky lg:top-0">
            <div className="relative aspect-[9/16] w-full max-w-[270px] overflow-hidden rounded-md bg-media lg:h-[480px] lg:w-[270px]">
              <Still src={sceneStill(0)} className="absolute inset-0 h-full w-full object-contain" />
              {video}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <div className="rounded-md border border-divider px-5 py-4">
              <div className="flex items-center gap-3">
                <span className="inline-flex items-center gap-[7px] text-sm font-semibold text-ok">
                  <Icon name="Check" size={14} />
                  คลิปพร้อมใช้ — ภาพอย่างเดียว นำไปพากย์เสียงเองได้
                </span>
                <span className="ml-auto shrink-0 text-sm tabular-nums text-muted">ใช้เวลาทำ 3 นาที 42 วินาที</span>
              </div>
              <p className="mt-1.5 text-[13px] tabular-nums text-muted">
                {`AI คัดไว้ ${fmtClock(SAMPLE_CUT_SECONDS)} จากต้นฉบับ ${fmtClock(SAMPLE_SOURCE_SECONDS)}`}
              </p>
              <Omit>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
                  {STEP_LABELS.map((label) => (
                    <span key={label} className="inline-flex items-center gap-1">
                      <Icon name="Check" size={12} className="text-ok" />
                      <span className="text-ink-3">{label}</span>
                    </span>
                  ))}
                </div>
              </Omit>
            </div>
            <div className="flex flex-col gap-2.5">
              <Button className="h-12 w-full justify-start" icon={<Icon name="Pencil" size={17} className="text-accent" />}>
                แก้ไขวิดีโอ
              </Button>
              <Button className="h-12 w-full justify-start" icon={<Icon name="ArrowLeftRight" size={17} className="text-accent" />}>
                <span>
                  ปรับช็อต{" "}
                  <span className="font-normal text-muted">· 5 ช็อตมีตัวเลือกอื่น</span>
                </span>
              </Button>
            </div>
            <ScriptPanel />
          </div>
        </div>
      </AppShell>
      {exportOpen ? <ExportDialog /> : null}
    </div>
  );
}

/** The project page's "สคริปต์ที่ใช้พากย์" panel — the web build's hand-off for the voiceover. */
export function ScriptPanel({ cycling = false }: { /** The line being spoken moves down the script, as while the player plays. */ cycling?: boolean }) {
  return (
    <div className={cn("flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-md border border-divider px-5 py-4", cycling && "am-cycle")}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[15px] font-semibold text-ink">สคริปต์ที่ใช้พากย์</p>
        <span className="min-w-0 flex-1 truncate text-[13px] text-muted">แก้ข้อความได้เลย — บันทึกให้อัตโนมัติ</span>
        <span className="flex shrink-0 items-center gap-1.5 text-[13px] text-accent">
          <Icon name="Copy" size={14} />
          คัดลอก
        </span>
      </div>
      <div className="mt-2.5 min-h-0 flex-1 overflow-y-auto">
        {SAMPLE_LINES.map((line, i) => (
          <span
            key={line}
            className={cn(
              "block w-full rounded-sm px-2 py-[3px] text-left text-[15px] leading-[1.75]",
              i === 0 && !cycling ? "bg-accent-tint font-semibold text-accent" : "text-ink-2",
            )}
            // The real lines are auto-grown textareas: scrollHeight, a whole 32px.
            style={{ height: 32, "--k": i } as React.CSSProperties}
            data-am-line={i + 1}
          >
            {line}
          </span>
        ))}
      </div>
      <div className="mt-auto flex items-center gap-6 border-t border-divider pt-3.5 text-[13px]">
        <span className="tabular-nums text-muted">{`ต้นฉบับ ${SAMPLE_CLIPS.length} ไฟล์ · ${fmtClock(SAMPLE_SOURCE_SECONDS)} นาที`}</span>
        <Omit>
          <span className="ml-auto text-error">ลบโปรเจกต์นี้</span>
        </Omit>
      </div>
    </div>
  );
}

const EXPORT_ROWS = [
  { label: "คลิปที่ตัดเสร็จ", blurb: "ไฟล์ที่เอาไปโพสต์ได้เลย", size: "11.8 MB", on: true },
  { label: "ไฟล์คำบรรยาย (.srt)", blurb: "เผื่อเอาไปใส่คำบรรยายในแอปอื่น", size: "1 KB", on: false },
  { label: "คลิปแยกทีละฉาก (8 ไฟล์)", blurb: "เอาไปเรียงใหม่เองในแอปตัดต่อ", size: "13.1 MB", on: false },
  { label: "ไฟล์ทั้งชุด (.zip) (1 ไฟล์)", blurb: "คลิปที่ตัดเสร็จ + คลิปแยกฉาก + สคริปต์ ต้องเรียงเองในแอปตัดต่อ", size: "24.9 MB", on: false },
];

function ExportRowBody({ row }: { row: (typeof EXPORT_ROWS)[number] }) {
  return (
    <div className={cn("flex w-full items-center gap-3.5 rounded-md border px-4 py-3.5 text-left", row.on ? "border-accent bg-[rgb(217_164_65_/_0.08)]" : "border-divider")}>
      <CheckboxMark checked={row.on} />
      <div className="min-w-0 flex-1">
        <p className={cn("text-[15px] text-ink", row.on && "font-semibold")}>{row.label}</p>
        <p className="mt-0.5 text-sm text-muted">{row.blurb}</p>
      </div>
      <span className="shrink-0 text-sm tabular-nums text-muted">{row.size}</span>
    </div>
  );
}

/** The export dialog's first row (ArtifactChecklist) on its own; `animated` ticks it. */
export function ExportRow({ animated = false }: { animated?: boolean }) {
  const row = EXPORT_ROWS[0];
  return animated ? (
    <div className="am-swap am-swap--block w-full" data-am="tick">
      <div className="am-swap__a">
        <ExportRowBody row={{ ...row, on: false }} />
      </div>
      <div className="am-swap__b">
        <ExportRowBody row={row} />
      </div>
    </div>
  ) : (
    <ExportRowBody row={row} />
  );
}

/** ExportVideoModal in ui/Dialog.tsx, over its page's scrim. */
export function ExportDialog() {
  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-[rgb(23_22_20_/_0.72)]" data-am="export-dialog">
      <div className="flex max-h-[calc(100dvh-64px)] flex-col rounded-md border border-[rgb(243_242_242_/_0.16)] bg-surface shadow-modal" style={{ width: 620, maxWidth: "calc(100cqw - 32px)" }}>
        <div className="flex items-start justify-between gap-4 px-6 py-5">
          <div>
            <p className="text-2xl font-semibold text-ink">ส่งออกวิดีโอ</p>
            <p className="mt-1 text-sm text-muted">{`${SAMPLE_PROJECT} · เลือกไฟล์ที่จะส่งออก`}</p>
          </div>
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted">
            <Icon name="X" size={18} />
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="flex flex-col gap-2.5">
            {EXPORT_ROWS.map((row) => (
              <ExportRowBody key={row.label} row={row} />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-divider px-5 py-4 sm:flex-nowrap sm:justify-between sm:gap-4 sm:px-6">
          <span className="min-w-0 flex-1 text-sm text-muted">เลือกไว้ 1 ไฟล์ · 11.8 MB</span>
          <div className="flex items-center gap-3">
            <Omit>
              <Button variant="ghost">ยกเลิก</Button>
            </Omit>
            <Button variant="primary" icon={<Icon name="Download" size={16} />}>
              ส่งออก
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
