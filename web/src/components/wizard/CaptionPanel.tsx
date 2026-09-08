import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Film, Maximize2, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import {
  CAPTION_BORDER_COLORS,
  CAPTION_COLORS,
  CAPTION_FONTS,
  CAPTION_MODES,
  CAPTION_SIZE_MAX,
  CAPTION_SIZE_MIN,
  type CaptionStyle
} from '../../lib/captionStyle'
import { Chip } from '../ui/Chip'
import { Slider } from '../ui/Slider'

function Swatch({
  hex,
  selected,
  onSelect
}: {
  hex: string
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={hex}
      title={hex}
      onClick={onSelect}
      style={{ backgroundColor: hex }}
      className={cn(
        // Selection is an outer accent ring, not a border swap — a border would
        // eat 2px of the swatch and misreport the colour it is showing.
        'h-7 w-7 rounded-md border border-border transition-shadow duration-state ease-out',
        selected
          ? 'shadow-[0_0_0_2px_rgb(217_164_65_/_0.5)]'
          : 'hover:shadow-[0_0_0_2px_rgb(243_242_242_/_0.22)]'
      )}
    />
  )
}

function FieldLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="mb-1.5 text-sm text-muted">{children}</p>
}

/** Proportions of the 9:16 frame, so the preview reads the same at any size. */
const CAPTION_BOTTOM_RATIO = 62 / 281
const TIKTOK_UI_WASH_RATIO = 52 / 281

/**
 * The 9:16 frame itself. Sized by the caller (`className`), never by a fixed
 * height here: the caption metrics are derived from the measured height so the
 * small inline copy and the expanded one show the same relative type size.
 *
 * `size` is an ASS Fontsize on the backend's 1080×1920 canvas
 * (`packages/video/caption.py`) — dividing by 1920 is what makes it meaningful.
 */
function CaptionPreviewFrame({
  style,
  previewThumb,
  className
}: {
  style: CaptionStyle
  previewThumb: string | null
  className?: string
}): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const [heightPx, setHeightPx] = useState(0)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    setHeightPx(el.clientHeight)
    const ro = new ResizeObserver(() => setHeightPx(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <div
      ref={boxRef}
      className={cn(
        'relative shrink-0 overflow-hidden rounded-md bg-media bg-cover bg-center',
        className
      )}
      style={previewThumb ? { backgroundImage: `url(${previewThumb})` } : undefined}
    >
      {previewThumb ? null : (
        <Film
          size={Math.max(26, Math.round(heightPx * 0.09))}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted"
        />
      )}
      {heightPx > 0 ? (
        <span
          style={{
            fontFamily: CAPTION_FONTS.find((f) => f.value === style.font)?.cssFamily,
            color: style.color,
            fontSize: `${Math.round((style.size / 1920) * heightPx)}px`,
            WebkitTextStroke: `${Math.max(1, Math.round((4 / 1920) * heightPx))}px ${style.border_color}`,
            paintOrder: 'stroke fill',
            bottom: `${Math.round(CAPTION_BOTTOM_RATIO * heightPx)}px`,
            paddingInline: `${Math.round(0.043 * heightPx)}px`
          }}
          className="absolute inset-x-0 text-center font-bold leading-tight"
        >
          สวัสดีค่ะ
        </span>
      ) : null}
      {/* The wash is where TikTok paints its own UI — the caption sits above it
          so the preview shows what will actually stay visible. */}
      <span
        style={{ height: `${Math.round(TIKTOK_UI_WASH_RATIO * heightPx)}px` }}
        className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-[rgb(0_0_0_/_0.55)] to-transparent"
      />
    </div>
  )
}

/**
 * Full-screen copy of the frame. Deliberately not the shared `Dialog`: this
 * panel is itself rendered inside a Dialog from the timeline editor, and two
 * stacked Dialogs would both act on one Escape. The capture-phase listener with
 * `stopImmediatePropagation` closes only the top layer.
 */
function CaptionPreviewLightbox({
  style,
  previewThumb,
  onClose
}: {
  style: CaptionStyle
  previewThumb: string | null
  onClose: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex flex-col items-center justify-center gap-3 bg-[rgb(23_22_20_/_0.86)] p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button
        type="button"
        aria-label="ปิดพรีวิว"
        onClick={onClose}
        className="absolute right-5 top-5 flex h-9 w-9 items-center justify-center rounded-md text-muted transition-colors duration-state ease-out hover:bg-[rgb(243_242_242_/_0.06)] hover:text-ink"
      >
        <X size={18} />
      </button>
      <CaptionPreviewFrame
        style={style}
        previewThumb={previewThumb}
        // Constrained on BOTH axes: sized from height alone, the 9:16 frame
        // came out wider than a phone and spilled past the backdrop padding.
        className="aspect-[9/16] max-h-[84dvh] max-w-full"
      />
      <p className="text-sm text-muted">แถบจางล่างคือที่ที่ TikTok วาง UI ทับ — กด Esc เพื่อปิด</p>
    </div>,
    document.body
  )
}

/** Caption appearance controls + a 9:16 preview at the real relative size. */
export function CaptionPanel({
  style,
  onChange,
  previewThumb
}: {
  style: CaptionStyle
  onChange: (next: CaptionStyle) => void
  previewThumb: string | null
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    // Preview above the controls below `lg`: a fixed 210px preview column
    // left 76px for every control at 390.
    <div className="flex flex-col gap-5 lg:flex-row lg:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <div>
          <FieldLabel>ฟอนต์</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {CAPTION_FONTS.map(({ value, label, cssFamily }) => (
              <Chip
                key={value}
                dense
                selected={style.font === value}
                onClick={() => onChange({ ...style, font: value })}
              >
                <span style={{ fontFamily: cssFamily }}>{label}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel>การแสดงตัวอักษร</FieldLabel>
          <div className="flex flex-wrap gap-2">
            {CAPTION_MODES.map(({ value, label }) => (
              <Chip
                key={value}
                dense
                selected={style.mode === value}
                onClick={() => onChange({ ...style, mode: value })}
              >
                {label}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-7">
          <div>
            <FieldLabel>สีตัวอักษร</FieldLabel>
            <div className="flex items-center gap-2">
              {CAPTION_COLORS.map((hex) => (
                <Swatch
                  key={hex}
                  hex={hex}
                  selected={style.color === hex}
                  onSelect={() => onChange({ ...style, color: hex })}
                />
              ))}
              <input
                type="color"
                aria-label="เลือกสีตัวอักษรเอง"
                value={style.color}
                onChange={(e) => onChange({ ...style, color: e.target.value })}
                className="h-7 w-7 cursor-pointer rounded-md border border-border bg-transparent p-0"
              />
            </div>
          </div>
          <div>
            <FieldLabel>สีขอบ</FieldLabel>
            <div className="flex items-center gap-2">
              {CAPTION_BORDER_COLORS.map((hex) => (
                <Swatch
                  key={hex}
                  hex={hex}
                  selected={style.border_color === hex}
                  onSelect={() => onChange({ ...style, border_color: hex })}
                />
              ))}
              <input
                type="color"
                aria-label="เลือกสีขอบเอง"
                value={style.border_color}
                onChange={(e) => onChange({ ...style, border_color: e.target.value })}
                className="h-7 w-7 cursor-pointer rounded-md border border-border bg-transparent p-0"
              />
            </div>
          </div>
        </div>

        {/* Label sits inline left of the track (design R7), so it is rendered
            here rather than via Slider's own stacked `label` prop. */}
        <div className="flex items-center gap-3">
          <label htmlFor="caption-size" className="flex-shrink-0 text-sm text-muted">
            ขนาด
          </label>
          <Slider
            id="caption-size"
            className="min-w-0 flex-1"
            min={CAPTION_SIZE_MIN}
            max={CAPTION_SIZE_MAX}
            value={style.size}
            onChange={(size) => onChange({ ...style, size })}
            formatValue={(v) => `${v} / ${CAPTION_SIZE_MAX}`}
          />
        </div>
      </div>

      <div className="flex w-full shrink-0 flex-col items-center gap-2 lg:w-[210px]">
        <p className="self-start text-sm text-muted">พรีวิว 9:16</p>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label="ขยายพรีวิว"
          title="ขยายพรีวิว"
          className="group relative rounded-md outline-none transition-shadow duration-state ease-out hover:shadow-[0_0_0_2px_rgb(217_164_65_/_0.5)] focus-visible:shadow-[0_0_0_2px_rgb(217_164_65_/_0.5)]"
        >
          <CaptionPreviewFrame
            style={style}
            previewThumb={previewThumb}
            className="h-[281px] w-[158px]"
          />
          <span className="pointer-events-none absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-[rgb(23_22_20_/_0.66)] text-ink opacity-0 transition-opacity duration-state ease-out group-hover:opacity-100 group-focus-visible:opacity-100">
            <Maximize2 size={14} />
          </span>
        </button>
        <p className="text-center text-[13px] leading-normal text-muted">
          กดที่ภาพเพื่อขยาย — แถบจางล่างคือที่ที่ TikTok วาง UI ทับ
        </p>
      </div>

      {expanded ? (
        <CaptionPreviewLightbox
          style={style}
          previewThumb={previewThumb}
          onClose={() => setExpanded(false)}
        />
      ) : null}
    </div>
  )
}
