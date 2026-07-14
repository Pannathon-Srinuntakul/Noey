/** Burned-in caption style choices for talking_head — font/color/animation
 * are the same catalog the backend's packages/video/fonts.py + caption.py
 * resolve_caption_style() expect. Desktop can't import frontend/src/lib
 * (separate build target), so this palette is a small local duplicate. */

export interface CaptionStyle {
  font: 'kanit' | 'prompt' | 'sarabun' | 'anuphan'
  mode: 'static' | 'word_pop' | 'typewriter'
  color: string
  /** snake_case to match the wire shape sent straight through to the backend
   * (CaptionStyleIn in videos_local.py) — no renaming step anywhere in the
   * pipeline, so a typo here can't silently drop the field. */
  border_color: string
  /** ASS Fontsize on a 1080x1920 canvas (backend packages/video/caption.py) */
  size: number
}

export const CAPTION_SIZE_MIN = 30
export const CAPTION_SIZE_MAX = 130

export const CAPTION_STYLE_DEFAULT: CaptionStyle = {
  font: 'kanit',
  mode: 'static',
  color: '#FFFFFF',
  border_color: '#000000',
  size: 72
}

/** cssFamily matches the @font-face name from @fontsource/<font>/700.css
 * (imported in assets/main.css) — same 4 fonts bundled for ffmpeg burn-in. */
export const CAPTION_FONTS: { value: CaptionStyle['font']; label: string; cssFamily: string }[] = [
  { value: 'kanit', label: 'Kanit', cssFamily: 'Kanit' },
  { value: 'prompt', label: 'Prompt', cssFamily: 'Prompt' },
  { value: 'sarabun', label: 'Sarabun', cssFamily: 'Sarabun' },
  { value: 'anuphan', label: 'Anuphan', cssFamily: 'Anuphan' }
]

export const CAPTION_MODES: { value: CaptionStyle['mode']; label: string }[] = [
  { value: 'static', label: 'นิ่ง (ทีละประโยค)' },
  { value: 'word_pop', label: 'ทีละคำ' },
  { value: 'typewriter', label: 'พิมพ์ดีด' }
]

export const CAPTION_COLORS: string[] = [
  '#FFFFFF',
  '#000000',
  '#FFEB3B',
  '#FF3B30',
  '#00E676',
  '#2196F3'
]

export const CAPTION_BORDER_COLORS: string[] = ['#000000', '#FFFFFF', '#5B3A1A']
