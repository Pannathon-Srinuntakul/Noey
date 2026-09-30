import type { CSSProperties } from "react";
import {
  SAMPLE_CUT_SECONDS,
  SAMPLE_LINES,
  SAMPLE_MUSIC,
  SAMPLE_MUSIC_PEAKS,
  SAMPLE_PROJECT,
  SAMPLE_SCENES,
  SAMPLE_VOICEOVER,
  sceneStill,
  tileAt,
  type SampleScene,
} from "../sample";
import {
  fmtTime,
  fmtTimeTenths,
  lineLabel,
  lineScenes,
  sceneAt,
  sceneMeta,
} from "./editorMath";
import {
  Button,
  ButtonBody,
  Icon,
  Omit,
  Still,
  Tabs,
  TextareaBox,
  Tile,
  TitleBar,
  cn,
} from "./ui";

/**
 * The timeline editor (web/src/components/TimelineEditor.tsx and
 * components/timeline/*) for the sample project, as it opens after a
 * ตัดฉากเด่น run on the web build: title strip, header row, the 9:16 preview
 * with its caption overlay, the 360px inspector, and the timeline block —
 * toolbar, ruler, ภาพ / บทพากย์ / เพลง / คำบรรยาย lanes, playhead. Geometry
 * follows timeline/constants.ts; the controls the picture does not need are
 * left out in place (Omit), so what is drawn sits where the app puts it.
 *
 * Rendered at a fixed playhead time; EditorLive (client) plays the footage,
 * moves the playhead, caption and "speaking" line with it, and lets a visitor
 * scrub and pick scenes. The data-am-* attributes are its handles.
 */

export const HEADER_COL_PX = 92;
const RULER_PX = 22;
const IMG_LANE_PX = 40;
const VO_LANE_PX = 32;
const MUSIC_LANE_PX = 32;
const CAPTION_LANE_PX = 24;
const TRACK_GAP_PX = 3;
const TAIL_PX = 160;
const MIN_LANE_PX = 80;
const BADGE_ROOM_PX = 38;
const TRACK_LABEL =
  "sticky left-0 z-40 flex h-full shrink-0 items-center gap-1.5 bg-ground pr-3 pl-3 text-[13px] text-ink-3";

/** The zoom the editor opens at: the whole cut fitted, 160px of tail (viewportMath.fitPxPerSec). */
export const fitPxPerSec = (windowWidth: number) =>
  Math.min(
    160,
    Math.max(
      4,
      Math.max(windowWidth - HEADER_COL_PX - TAIL_PX, 120) / SAMPLE_CUT_SECONDS,
    ),
  );

/** Content width of the lanes (useTimelineViewport.getContentWidthPx). */
const contentWidth = (windowWidth: number, px: number) =>
  Math.max(SAMPLE_CUT_SECONDS * px, MIN_LANE_PX) +
  Math.max(TAIL_PX, Math.round(windowWidth / 2));

/** lib/timelineMath.rulerTicks. */
function rulerTicks(px: number, duration: number) {
  const step =
    [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((c) => c * px >= 140) ?? 600;
  const divs = (step / 10) * px >= 12 ? 10 : 5;
  const r9 = (n: number) => Math.round(n * 1e9) / 1e9;
  const majorCount = Math.max(1, Math.ceil(duration / step) + 1);
  const majors = Array.from({ length: majorCount }, (_, i) => r9(i * step));
  const minors: number[] = [];
  for (let i = 1; i < (majorCount - 1) * divs; i += 1)
    if (i % divs !== 0) minors.push(r9((i * step) / divs));
  return { majors, minors };
}

// ─── Header ──────────────────────────────────────────────────────────────────

/** timeline/EditorHeader.tsx on the web build (no "ให้ AI แก้ให้"): back, save; the rest left out. */
export function EditorHeader() {
  return (
    <>
      <TitleBar label={`แก้ไขวิดีโอ — ${SAMPLE_PROJECT} · ตัดฉากเด่น`} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-divider px-4 py-3 md:flex-nowrap md:px-6">
        <Button variant="ghost" icon={<Icon name="ArrowLeft" size={16} />}>
          กลับไปหน้าโปรเจกต์
        </Button>
        <Omit>
          <span className="h-5 w-px bg-divider" />
          <Button icon={<Icon name="Undo2" size={15} />} disabled>
            เลิกทำ
          </Button>
          <Button icon={<Icon name="Redo2" size={15} />} disabled>
            ทำซ้ำ
          </Button>
          <p className="min-w-0 flex-1 truncate text-sm text-muted">
            ยังไม่ได้แก้อะไร
          </p>
          <Button variant="ghost" icon={<Icon name="HelpCircle" size={16} />}>
            แป้นพิมพ์ลัด
          </Button>
        </Omit>
        <Button variant="primary" icon={<Icon name="Save" size={16} />}>
          บันทึกและเรนเดอร์
        </Button>
      </div>
    </>
  );
}

// ─── Preview ─────────────────────────────────────────────────────────────────

/**
 * timeline/PreviewPane.tsx: the 9:16 stage and its caption overlay. The
 * transport (ui/VideoTransport.tsx) is left out: the app fades it away while
 * the cut plays, and the mock-up is always playing. `note` is the part's
 * hover/focus note; the picture itself is hidden from assistive technology.
 */
export function PreviewPane({
  time,
  note,
  children,
}: {
  time: number;
  note?: string;
  children?: React.ReactNode;
}) {
  const scene = sceneAt(time);
  return (
    <div
      className="relative flex h-full min-h-0 max-w-full flex-1 items-center justify-center"
      style={{ width: "auto", aspectRatio: "9 / 16" }}
      data-am-stage=""
    >
      <div
        className="absolute inset-0 h-full w-full overflow-hidden rounded-xl bg-black"
        aria-hidden="true"
      >
        <Still
          src={sceneStill(scene)}
          className="am-still h-full w-full object-cover"
        />
        {children}
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-[9%] z-10 px-6 text-center text-[15px] leading-snug font-bold whitespace-pre-wrap text-white"
        style={{
          textShadow: "0 0 3px #000, 0 0 3px #000, 0 2px 6px rgba(0,0,0,.95)",
        }}
        aria-hidden="true"
        data-am-caption=""
      >
        {SAMPLE_SCENES[scene].caption}
      </div>
      {note ? (
        <span className="am-hits" inert>
          <span className="am-tipzone" style={{ inset: 0 }}>
            <Tip text={note} />
          </span>
        </span>
      ) : null}
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────────────────

/**
 * inspector/SelectedSceneHeader, Tabs, ScriptTab and SceneActions for the
 * selected scene (delete left out). The data-am-i hooks are what EditorLive
 * rewrites when another scene is picked.
 */
export function Inspector({ selected }: { selected: number }) {
  const scene = SAMPLE_SCENES[selected];
  const angles = lineScenes(scene.line);
  return (
    <aside
      className="flex min-h-[210px] w-full shrink-0 flex-col overflow-hidden border-t border-divider lg:max-h-none lg:min-h-0 lg:w-[360px] lg:border-l lg:border-t-0"
      aria-hidden="true"
    >
      <div className="shrink-0 border-b border-divider px-4 py-3">
        <p className="flex items-center gap-2 text-[13px] text-muted">
          ฉากที่เลือกอยู่
        </p>
        <p className="mt-0.5 min-w-0 text-sm text-muted">
          <span className="text-lg font-semibold text-ink">
            ฉาก <span data-am-i="no">{selected + 1}</span>
          </span>{" "}
          <span data-am-i="meta">{sceneMeta(selected)}</span>
        </p>
      </div>
      <Tabs
        className="shrink-0 px-4"
        items={["บทพากย์", "คำบรรยายบนภาพ"]}
        active="บทพากย์"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <p className="mb-1.5 text-[13px] text-muted" data-am-i="line-label">
          {lineLabel(selected)}
        </p>
        <TextareaBox
          rows={4}
          value={<span data-am-i="line">{SAMPLE_LINES[scene.line - 1]}</span>}
        />
        {/* The line's angles: below the fold of a 768px window (the app cuts
            them off there too), so they are left out in place. */}
        <Omit>
          <p className="mt-4 mb-1.5 text-[13px] text-muted">
            มุมของประโยคนี้{" "}
            <span className="font-semibold text-ink" data-am-i="angles">
              {angles.length} มุม
            </span>
          </p>
        </Omit>
        <Omit>
          <div className="flex items-center gap-1.5">
            {/* Two slots: every line has one or two angles; EditorLive refills them. */}
            {[0, 1].map((k) => {
              const angle = angles[k];
              return (
                <span
                  key={k}
                  className="am-angle h-11 w-[26px] overflow-hidden rounded border border-border bg-black"
                  hidden={!angle}
                  data-am-angle={k}
                  data-sel={angle?.index === selected ? "" : undefined}
                >
                  <Tile
                    index={angle ? tileAt(angle.scene, 0.08) : 0}
                    className="h-full w-full"
                  />
                </span>
              );
            })}
            <span className="flex h-11 w-[26px] items-center justify-center rounded border border-dashed border-border text-muted">
              <Icon name="Plus" size={12} />
            </span>
          </div>
        </Omit>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-divider px-4 py-3">
        <Button className="flex-1" icon={<Icon name="Scissors" size={14} />}>
          แยกฉาก
        </Button>
        <Button icon={<Icon name="SquarePlay" size={15} />} iconOnly />
        <Button className="flex-1" icon={<Icon name="Copy" size={14} />}>
          ทำซ้ำ
        </Button>
        <Button icon={<Icon name="EyeOff" size={15} />} iconOnly />
        <Button icon={<Icon name="Shuffle" size={15} />} iconOnly />
        <Omit>
          <Button
            variant="danger"
            icon={<Icon name="Trash2" size={15} />}
            iconOnly
          />
        </Omit>
      </div>
    </aside>
  );
}

// ─── Timeline ────────────────────────────────────────────────────────────────

function ToggleButton({
  icon,
  children,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-accent bg-accent-nav px-2.5 py-1.5 text-[13px] font-medium text-accent">
      {icon}
      {children}
    </span>
  );
}

/**
 * timeline/TimelineToolbar.tsx, edited view, a scene selected: the view
 * switch, split, add and the zoom slider drawn; the rest left out in place.
 */
export function TimelineToolbar({ px }: { px: number }) {
  const zoom = ((px - 4) / (160 - 4)) * 100;
  return (
    <div
      className="flex items-center gap-2 overflow-x-auto px-4 py-2"
      aria-hidden="true"
    >
      <div className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5">
        <span className="whitespace-nowrap rounded-md border border-accent bg-accent-nav px-2.5 py-1 text-[13px] font-medium text-accent">
          ตัดแล้ว
        </span>
        <span className="whitespace-nowrap rounded-md border border-transparent px-2.5 py-1 text-[13px] font-medium text-muted">
          ต้นฉบับ
        </span>
      </div>
      <span className="h-5 w-px bg-divider" />
      <Button icon={<Icon name="Scissors" size={14} />}>
        แยกที่หัวเล่น <span className="text-muted">S ⌘B</span>
      </Button>
      <Button icon={<Icon name="Plus" size={14} />}>
        เพิ่มฉาก <span className="text-muted">N</span>
      </Button>
      <Omit>
        <Button icon={<Icon name="Trash2" size={14} />}>ลบแล้วดึงชิด</Button>
      </Omit>
      <span className="flex-1" />
      <Omit>
        <ToggleButton icon={<Icon name="Magnet" size={13} />}>
          ดูดขอบ
        </ToggleButton>
        <ToggleButton icon={<Icon name="Crosshair" size={13} />}>
          แกนพรีวิว
        </ToggleButton>
      </Omit>
      {/* The zoom slider, left out with the controls around it (alone it floats). */}
      <Omit>
        <div className="w-44">
          <div className="flex items-center gap-3">
            {/* 129px: a native range's intrinsic width, which keeps the real one from shrinking. */}
            <span
              className="relative block h-[3px] w-[129px] min-w-0 flex-1 rounded-[2px]"
              style={{
                background: `linear-gradient(to right, var(--color-accent) ${zoom}%, var(--color-border) ${zoom}%)`,
              }}
            >
              <span
                className="absolute top-1/2 h-[13px] w-[13px] -translate-y-1/2 rounded-full bg-ink"
                style={{ left: `calc(${zoom}% - ${(zoom / 100) * 13}px)` }}
              />
            </span>
            <Omit>
              <span className="flex-shrink-0 whitespace-nowrap text-sm tabular-nums text-ink">
                {Math.round(px)} px/วิ
              </span>
            </Omit>
          </div>
        </div>
      </Omit>
      <Omit>
        <Button icon={<Icon name="Scan" size={14} />}>พอดีฉาก</Button>
        <Button icon={<Icon name="Maximize2" size={14} />}>พอดีจอ</Button>
      </Omit>
    </div>
  );
}

function TrackRow({
  height,
  label,
  laneClassName,
  width,
  children,
}: {
  height: number;
  label: React.ReactNode;
  laneClassName: string;
  width: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center"
      style={{ height, marginBottom: TRACK_GAP_PX }}
    >
      <div className={TRACK_LABEL} style={{ width: HEADER_COL_PX }}>
        {label}
      </div>
      <div className={laneClassName} style={{ width }}>
        {children}
      </div>
    </div>
  );
}

/**
 * EditedCutBlock + FilmstripCanvas: the scene's own frames, 23×40 slots at
 * 60%. `frames` swaps in other footage (a picked backup shot), `swapped` shows
 * the "you changed this" badge, `extraSlots` draws frames past the block's end
 * (for a trim that is about to lengthen it); `className`/`style` let the
 * choreography animate the block.
 */
function SceneBlock({
  scene,
  index,
  px,
  selected,
  frames = scene,
  swapped = false,
  extraSlots = 0,
  className,
  style,
}: {
  scene: SampleScene;
  index: number;
  px: number;
  selected: boolean;
  frames?: Pick<SampleScene, "shot" | "from">;
  swapped?: boolean;
  extraSlots?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const width = scene.seconds * px;
  const slot = Math.round((54 / 96) * IMG_LANE_PX);
  const slots = Math.ceil(width / slot) + extraSlots;
  return (
    <li
      className={cn(
        "relative flex h-full shrink-0 list-none items-end",
        className,
      )}
      style={{ width, ...style }}
      data-am-scene={index}
      data-sel={selected ? "" : undefined}
    >
      {/* Selected (data-sel): gold border, inset ring, trim bars — mock.css, so the page script can move it. */}
      <div className="am-block absolute inset-0 overflow-hidden rounded-[5px] border border-border bg-black">
        <span
          className="pointer-events-none absolute top-0 left-0 flex"
          style={{ opacity: "var(--am-film)" }}
        >
          {Array.from({ length: slots }, (_, i) => (
            <Tile
              key={i}
              index={tileAt(frames, (i * slot + slot / 2) / px)}
              className="block shrink-0"
              style={{ width: slot, height: IMG_LANE_PX }}
            />
          ))}
        </span>
        {width >= BADGE_ROOM_PX ? (
          <span className="pointer-events-none absolute left-0.5 top-0.5 z-10 flex items-center gap-0.5">
            {scene.alternates > 0 ? (
              <span className="flex items-center gap-px rounded-sm bg-black/80 px-0.5 py-px text-[10px] font-semibold leading-none tabular-nums text-white">
                <Icon name="Repeat2" size={11} />
                {scene.alternates}
              </span>
            ) : null}
            {swapped ? (
              <span className="flex items-center rounded-sm bg-black/80 px-0.5 py-px text-accent">
                <Icon name="UserRoundPen" size={11} />
              </span>
            ) : (
              <span className="flex items-center rounded-sm bg-black/80 px-0.5 py-px text-white/60">
                <Icon name="Sparkles" size={11} />
              </span>
            )}
          </span>
        ) : null}
        <span
          className="am-handle absolute inset-y-0 left-0 z-30 rounded-l-[5px]"
          style={{ width: 12 }}
        >
          <span
            className="absolute inset-y-0 left-0 flex items-center justify-center rounded-l-[5px] bg-accent"
            style={{ width: 5 }}
          >
            <span className="block h-3 w-px rounded bg-black/40" />
          </span>
        </span>
        <span
          className="am-handle absolute inset-y-0 right-0 z-30 rounded-r-[5px]"
          style={{ width: 12 }}
        >
          <span
            className="absolute inset-y-0 right-0 flex items-center justify-center rounded-r-[5px] bg-accent"
            style={{ width: 5 }}
          >
            <span className="block h-3 w-px rounded bg-black/40" />
          </span>
        </span>
      </div>
      <span
        className="pointer-events-none sticky z-20 pb-0.5 pl-1.5 text-[13px] font-semibold tabular-nums text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]"
        style={{ left: HEADER_COL_PX + 4 }}
      >
        {index + 1}
      </span>
    </li>
  );
}

/**
 * The lanes viewport: ruler, the four lanes, the playhead. Its scrollbar is
 * not drawn: the editor's thin scrollbars overlay on macOS until scrolled.
 */
export function Lanes({
  windowWidth,
  px,
  time,
  selected,
  music,
  run = false,
  interactive = false,
}: {
  windowWidth: number;
  px: number;
  time: number;
  selected: number;
  music: boolean;
  /** Sweep the playhead across the cut in CSS (a picture with no footage playing). */
  run?: boolean;
  /** The visitor can scrub, pick scenes and read the lane notes (EditorLive). */
  interactive?: boolean;
}) {
  const contentW = contentWidth(windowWidth, px);
  const { majors, minors } = rulerTicks(px, SAMPLE_CUT_SECONDS);
  const selectedLine = SAMPLE_SCENES[selected].line;
  const x = HEADER_COL_PX + time * px;
  const head = {
    transform: `translateX(${x}px)`,
    ...(run
      ? {
          "--x0": `${HEADER_COL_PX}px`,
          "--x1": `${HEADER_COL_PX + SAMPLE_CUT_SECONDS * px}px`,
        }
      : null),
  } as CSSProperties;
  const barW =
    (SAMPLE_CUT_SECONDS * px) / Math.max(SAMPLE_MUSIC_PEAKS.length, 1);
  return (
    <div
      className="relative max-h-[248px] overflow-hidden"
      data-am-px={px}
      data-am-lanes=""
    >
      <div
        className="relative"
        style={{ width: HEADER_COL_PX + contentW }}
        aria-hidden="true"
      >
        <div className="flex" style={{ height: RULER_PX }}>
          <div
            className="sticky left-0 z-40 h-full shrink-0 bg-ground"
            style={{ width: HEADER_COL_PX }}
          />
          <div
            className="relative h-full shrink-0 border-b border-divider"
            style={{ width: contentW, height: RULER_PX }}
          >
            {majors.map((t) => (
              <span
                key={t}
                className="absolute top-0.5 text-[13px] leading-none tabular-nums text-ink-3"
                style={
                  t === 0
                    ? { left: 0 }
                    : {
                        left: t * px,
                        transform: "translateX(calc(-100% - 4px))",
                      }
                }
              >
                {fmtTime(t)}
              </span>
            ))}
            {majors.map((t) =>
              t === 0 ? null : (
                <span
                  key={`M${t}`}
                  className="absolute bottom-0 h-1.5 w-px bg-border"
                  style={{ left: t * px }}
                />
              ),
            )}
            {minors.map((t) => (
              <span
                key={`m${t}`}
                className="absolute bottom-0 h-1 w-px bg-border-faint"
                style={{ left: t * px }}
              />
            ))}
          </div>
        </div>

        <TrackRow
          height={IMG_LANE_PX}
          label={
            <>
              ภาพ
              <span className="tabular-nums text-ink-3">
                {SAMPLE_SCENES.length}
              </span>
            </>
          }
          laneClassName="relative h-full"
          width={contentW}
        >
          <ul className="flex h-full items-stretch">
            {SAMPLE_SCENES.map((scene, index) => (
              <SceneBlock
                key={index}
                scene={scene}
                index={index}
                px={px}
                selected={index === selected}
              />
            ))}
          </ul>
        </TrackRow>

        <TrackRow
          height={VO_LANE_PX}
          label="บทพากย์"
          laneClassName="relative h-full rounded-md bg-surface"
          width={contentW}
        >
          {SAMPLE_VOICEOVER.map((block) => (
            <span
              key={block.line}
              className="am-vo absolute inset-y-0.5 overflow-hidden rounded border border-border bg-ground text-muted"
              style={{
                left: block.start * px,
                width: Math.max(block.seconds * px - 2, 20),
              }}
              data-am-vo={block.line}
              data-sel={block.line === selectedLine ? "" : undefined}
            >
              <ButtonBody className="h-full px-2 text-left text-[13px] whitespace-nowrap">
                <span className="truncate">{`${block.line} · ${block.script}`}</span>
              </ButtonBody>
            </span>
          ))}
        </TrackRow>

        <TrackRow
          height={MUSIC_LANE_PX}
          label={
            <>
              เพลง
              {music ? (
                <span className="flex items-center gap-0.5">
                  <span className="rounded p-0.5 text-muted">
                    <Icon name="Volume2" size={12} />
                  </span>
                  <span className="rounded p-0.5 text-muted">
                    <Icon name="RefreshCw" size={12} />
                  </span>
                  <span className="rounded p-0.5 text-muted">
                    <Icon name="Trash2" size={12} />
                  </span>
                </span>
              ) : null}
            </>
          }
          laneClassName="relative h-full"
          width={contentW}
        >
          {music ? (
            <MusicBlock
              width={Math.max(SAMPLE_CUT_SECONDS * px, 24)}
              barW={barW}
            />
          ) : (
            <span
              className="flex h-full items-center justify-center gap-2 rounded-md border border-dashed border-border text-[13px] text-muted"
              style={{ width: Math.max(SAMPLE_CUT_SECONDS * px, MIN_LANE_PX) }}
            >
              <Icon name="Music2" size={13} />
              เพิ่มเพลงประกอบ — ไฟล์เพลง หรือวิดีโอที่มีเพลงก็ได้
            </span>
          )}
        </TrackRow>

        <TrackRow
          height={CAPTION_LANE_PX}
          label="คำบรรยาย"
          laneClassName="relative h-full"
          width={contentW}
        >
          {SAMPLE_SCENES.map((scene, index) => (
            <span
              key={index}
              className="am-cap absolute inset-y-0 rounded border border-border-faint bg-surface"
              style={{
                left: scene.start * px,
                width: Math.max(scene.seconds * px - 2, 16),
              }}
              data-am-cap={index}
              data-sel={index === selected ? "" : undefined}
            >
              <ButtonBody
                inline
                className="h-full w-full overflow-hidden px-2 text-left text-[13px] whitespace-nowrap text-ink-2"
              >
                <span className="truncate">{scene.caption}</span>
              </ButtonBody>
            </span>
          ))}
        </TrackRow>

        <div
          className={cn(
            "pointer-events-none absolute top-0 bottom-0 left-0 z-20",
            run && "am-sweep",
          )}
          style={head}
          data-am-playhead=""
        >
          <div
            className="absolute top-0 bottom-0 -translate-x-1/2"
            style={{ width: 8 }}
          >
            <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-ink" />
          </div>
          <div
            className="absolute top-0 h-3 -translate-x-1/2 rounded-[2px_2px_4px_4px] bg-ink"
            style={{ width: 18 }}
          />
        </div>
        <div
          className={cn(
            "pointer-events-none absolute top-0 bottom-0 left-0 z-[35]",
            run && "am-sweep",
          )}
          style={head}
          data-am-playhead=""
        >
          <span className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-ink" />
          <span
            className="absolute top-0 left-0 h-3 -translate-x-1/2 rounded-[2px_2px_4px_4px] bg-ink"
            style={{ width: 18 }}
          />
        </div>
      </div>
      {interactive ? (
        <LaneHits px={px} time={time} selected={selected} />
      ) : null}
    </div>
  );
}

const LANE_TOPS = {
  image: RULER_PX,
  voice: RULER_PX + IMG_LANE_PX + TRACK_GAP_PX,
  music: RULER_PX + IMG_LANE_PX + VO_LANE_PX + 2 * TRACK_GAP_PX,
};
const LANES_H =
  RULER_PX +
  IMG_LANE_PX +
  VO_LANE_PX +
  MUSIC_LANE_PX +
  CAPTION_LANE_PX +
  4 * TRACK_GAP_PX;

/**
 * The part of the timeline a visitor can use (MOCKUP_FIX_PROMPT.md 2.4): the
 * ruler and lanes are a slider (click or drag to scrub, arrow keys to step),
 * each scene is a button that selects it, and the lane names explain
 * themselves on hover or focus. EditorLive (client) wires them up; until it
 * does — no script, or a hero beat that is not showing yet — the layer is inert.
 */
/** The scene the hero's pointer clicks when the editor appears (EditorLive picks it). */
export const DEMO_PICK = 4;

function LaneHits({
  px,
  time,
  selected,
}: {
  px: number;
  time: number;
  selected: number;
}) {
  const labels: Array<[number, number, string]> = [
    [LANE_TOPS.image, IMG_LANE_PX, "แก้ทับได้ทุกช็อต"],
    [LANE_TOPS.voice, VO_LANE_PX, "พากย์เสียง พร้อมสคริปต์จาก AI"],
    [LANE_TOPS.music, MUSIC_LANE_PX, "ใส่เพลงประกอบ"],
    [
      LANE_TOPS.music + MUSIC_LANE_PX + TRACK_GAP_PX,
      CAPTION_LANE_PX,
      "ซับไทยอัตโนมัติ",
    ],
  ];
  return (
    <div className="am-hits" data-am-hits="" inert>
      <div
        className="am-scrub"
        role="slider"
        tabIndex={0}
        aria-label="หัวเล่น"
        aria-valuemin={0}
        aria-valuemax={Math.round(SAMPLE_CUT_SECONDS * 10) / 10}
        aria-valuenow={Math.round(time * 10) / 10}
        aria-valuetext={`${fmtTimeTenths(time)} จาก ${fmtTime(SAMPLE_CUT_SECONDS)}`}
        style={{
          left: HEADER_COL_PX,
          top: 0,
          width: SAMPLE_CUT_SECONDS * px,
          height: LANES_H,
        }}
        data-am-scrub=""
      />
      {SAMPLE_SCENES.map((scene, index) => (
        <button
          key={index}
          type="button"
          className="am-pick"
          aria-label={`ฉาก ${index + 1} · ยาว ${scene.seconds.toFixed(2)} วิ`}
          aria-pressed={index === selected}
          style={{
            left: HEADER_COL_PX + scene.start * px,
            top: LANE_TOPS.image,
            width: scene.seconds * px,
            height: IMG_LANE_PX,
          }}
          data-am-pick={index}
          data-am-target={index === DEMO_PICK ? "pick" : undefined}
        />
      ))}
      {labels.map(([top, height, text]) => (
        <span
          key={text}
          className="am-tipzone"
          style={{ left: 0, top, width: HEADER_COL_PX, height }}
        >
          <Tip text={text} />
        </span>
      ))}
    </div>
  );
}

/**
 * A hover/focus note on a part of the mock-up, in the site's own words
 * (MOCKUP_FIX_PROMPT.md 2.4) — never a new claim. Fills its positioned parent.
 */
export function Tip({ text }: { text: string }) {
  return (
    <span className="am-tip" tabIndex={0} role="note" aria-label={text}>
      <span className="am-tip__bubble" aria-hidden="true">
        {text}
      </span>
    </span>
  );
}

/** lanes/MusicBlock.tsx: waveform, name, volume, the native range, trim handles. */
export function MusicBlock({
  width,
  barW,
  volume = SAMPLE_MUSIC.volume,
  animated = false,
}: {
  width: number;
  barW: number;
  volume?: number;
  animated?: boolean;
}) {
  return (
    <div
      className="absolute inset-y-0 flex items-center rounded-[5px] border border-border bg-surface"
      style={{ left: 0, width }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[5px]">
        <svg
          className="absolute inset-0 h-full w-full"
          width={width}
          height={MUSIC_LANE_PX}
          viewBox={`0 0 ${width} ${MUSIC_LANE_PX}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {SAMPLE_MUSIC_PEAKS.map((peak, i) => {
            const h = Math.max(peak * (MUSIC_LANE_PX - 6), 1.5);
            return (
              <rect
                key={i}
                x={i * barW}
                y={(MUSIC_LANE_PX - h) / 2}
                width={Math.max(barW - 0.5, 0.5)}
                height={h}
                fill="rgba(217, 164, 65, 0.4)"
              />
            );
          })}
        </svg>
      </div>
      <div className="pointer-events-none relative z-10 flex min-w-0 items-center gap-2 pr-3 pl-3 text-[13px] text-ink">
        <span className="truncate">{SAMPLE_MUSIC.file}</span>
        {animated ? (
          // The value is a counter that follows the dragged slider (parts.css).
          <span className="am-volume shrink-0 tabular-nums text-muted" />
        ) : (
          <span className="shrink-0 tabular-nums text-muted">
            {Math.round(volume * 100)}%
          </span>
        )}
      </div>
      <span
        className={cn(
          "am-range relative z-10 h-[3px] w-16 shrink-0",
          animated && "am-range--drag",
        )}
        style={{ "--v": volume } as CSSProperties}
      />
      <span className="absolute top-0 left-0 z-20 h-full w-[10px] rounded-l-[5px] bg-accent/60" />
      <span className="absolute top-0 right-0 z-20 h-full w-[10px] rounded-r-[5px] bg-accent/60" />
    </div>
  );
}

/** lanes/DragReadout.tsx over a trim. */
function DragReadout({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute -top-6 right-0 z-50 whitespace-nowrap rounded-md border border-border-strong bg-[rgb(28_28_30_/_0.96)] px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-ink shadow-md",
        className,
      )}
    >
      {text}
    </span>
  );
}

/**
 * One lane of the timeline on its own, as the feature strips show it — the
 * same rows the editor draws (label column included), at the editor's fitted
 * zoom for a 1024px window. The motion is in parts.css.
 */
export function LaneCrop({
  kind,
  px,
}: {
  kind: "subs" | "music" | "trim" | "swap";
  px: number;
}) {
  const width = contentWidth(1024, px);
  if (kind === "subs") {
    return (
      <div className="relative pt-2">
        <TrackRow
          height={CAPTION_LANE_PX}
          label="คำบรรยาย"
          laneClassName="relative h-full"
          width={width}
        >
          {SAMPLE_SCENES.map((scene, index) => (
            <span
              key={index}
              className="absolute inset-y-0 rounded border border-border-faint bg-surface"
              style={{
                left: scene.start * px,
                width: Math.max(scene.seconds * px - 2, 16),
              }}
            >
              <ButtonBody
                inline
                className="h-full w-full overflow-hidden px-2 text-left text-[13px] whitespace-nowrap text-ink-2"
              >
                <span className="truncate">{scene.caption}</span>
              </ButtonBody>
            </span>
          ))}
        </TrackRow>
        <span
          className="am-run absolute top-0 bottom-0 left-0 z-[35] w-0.5 -translate-x-1/2 bg-ink"
          style={
            {
              "--x0": `${HEADER_COL_PX}px`,
              "--x1": `${HEADER_COL_PX + SAMPLE_SCENES[2].start * px}px`,
              "--run": `${SAMPLE_SCENES[2].start}s`,
            } as CSSProperties
          }
        />
      </div>
    );
  }
  if (kind === "music") {
    const barW = (SAMPLE_CUT_SECONDS * px) / SAMPLE_MUSIC_PEAKS.length;
    return (
      <div className="pt-1">
        <TrackRow
          height={MUSIC_LANE_PX}
          label={
            <>
              เพลง
              <span className="flex items-center gap-0.5">
                <span className="rounded p-0.5 text-muted">
                  <Icon name="Volume2" size={12} />
                </span>
                <span className="rounded p-0.5 text-muted">
                  <Icon name="RefreshCw" size={12} />
                </span>
                <span className="rounded p-0.5 text-muted">
                  <Icon name="Trash2" size={12} />
                </span>
              </span>
            </>
          }
          laneClassName="relative h-full"
          width={width}
        >
          <MusicBlock width={SAMPLE_CUT_SECONDS * px} barW={barW} animated />
        </TrackRow>
      </div>
    );
  }
  const selected = 2;
  const scenes = SAMPLE_SCENES.map((scene, index) => {
    if (kind === "trim" && index === selected) {
      const grown = scene.seconds + 0.4;
      return (
        <SceneBlock
          key={index}
          scene={scene}
          index={index}
          px={px}
          selected
          extraSlots={2}
          className="am-trim"
          style={
            {
              "--w0": `${scene.seconds * px}px`,
              "--w1": `${grown * px}px`,
            } as CSSProperties
          }
        />
      );
    }
    if (kind === "swap" && index === selected) {
      return (
        <li
          key={index}
          className="am-swap am-swap--block relative h-full shrink-0 list-none"
          style={{ width: scene.seconds * px }}
          data-am="shot"
        >
          <ul className="am-swap__a flex h-full">
            <SceneBlock scene={scene} index={index} px={px} selected={false} />
          </ul>
          <ul className="am-swap__b flex h-full">
            <SceneBlock
              scene={scene}
              index={index}
              px={px}
              selected={false}
              frames={{ shot: "texture", from: 60 }}
              swapped
            />
          </ul>
        </li>
      );
    }
    return (
      <SceneBlock
        key={index}
        scene={scene}
        index={index}
        px={px}
        selected={false}
      />
    );
  });
  return (
    <div className={cn("relative", kind === "trim" ? "pt-7" : "pt-1")}>
      <TrackRow
        height={IMG_LANE_PX}
        label={
          <>
            ภาพ
            <span className="tabular-nums text-ink-3">
              {SAMPLE_SCENES.length}
            </span>
          </>
        }
        laneClassName="relative h-full"
        width={width}
      >
        <ul className="flex h-full items-stretch">{scenes}</ul>
        {kind === "trim" ? (
          <span
            className="am-readout absolute top-0 bottom-0"
            style={{
              left: 0,
              width:
                (SAMPLE_SCENES[selected].start +
                  SAMPLE_SCENES[selected].seconds +
                  0.4) *
                px,
            }}
          >
            <DragReadout
              text={`+0.40 วิ (+12 เฟรม) · ยาว ${(SAMPLE_SCENES[selected].seconds + 0.4).toFixed(2)} วิ`}
            />
          </span>
        ) : null}
      </TrackRow>
    </div>
  );
}

/** The timeline block under the middle: toolbar, lanes, and the hint line's place (left out). */
export function TimelineBlock({
  windowWidth,
  time,
  selected,
  music = false,
  run = false,
  interactive = false,
}: {
  windowWidth: number;
  time: number;
  selected: number;
  music?: boolean;
  run?: boolean;
  interactive?: boolean;
}) {
  const px = fitPxPerSec(windowWidth);
  return (
    <div className="shrink-0 border-t border-divider">
      <TimelineToolbar px={px} />
      <Lanes
        windowWidth={windowWidth}
        px={px}
        time={time}
        selected={selected}
        music={music}
        run={run}
        interactive={interactive}
      />
      <Omit>
        <p
          className="truncate px-4 py-1.5 text-[13px] text-muted"
          aria-hidden="true"
        >
          ลากขอบ = ยืด–หด · Alt+ลาก = เลื่อนหน้าต่าง · ⌘/Ctrl+ลากที่จับ =
          เลื่อนรอยตัด · Shift+ลาก = เลือกหลายฉาก · Alt ค้าง = ปิดดูดขอบ ·
          ⌘/Ctrl+ล้อ = ซูม
        </p>
      </Omit>
    </div>
  );
}

/**
 * The whole editor at `windowWidth` × its window height (the AppScreen
 * decides the height; the middle row takes what is left). `interactive`
 * adds what a visitor can use — the timeline's scrub and scenes, the parts'
 * notes — for EditorLive to wake; the rest is a picture, hidden from
 * assistive technology.
 */
export function EditorScreen({
  windowWidth,
  time,
  selected = 2,
  music = false,
  interactive = false,
  video,
}: {
  windowWidth: number;
  time: number;
  selected?: number;
  /** The project has background music (the hero's run did not pick any). */
  music?: boolean;
  interactive?: boolean;
  video?: React.ReactNode;
}) {
  return (
    <div
      className="absolute inset-0 z-100 flex flex-col bg-ground text-ink"
      data-am-editor=""
    >
      <div className="contents" aria-hidden="true">
        <EditorHeader />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <div className="flex min-h-[46dvh] min-w-0 flex-1 flex-col items-center justify-center gap-2 px-5 py-3 lg:min-h-0">
          <PreviewPane
            time={time}
            note={interactive ? "AI ตัดคลิปให้อัตโนมัติ" : undefined}
          >
            {video}
          </PreviewPane>
        </div>
        <Inspector selected={selected} />
      </div>
      <TimelineBlock
        windowWidth={windowWidth}
        time={time}
        selected={selected}
        music={music}
        interactive={interactive}
      />
    </div>
  );
}
