/**
 * The two quality dials, as the user reads them (owner, 2026-09-30).
 *
 * The names live HERE, not in the wizard, because the plan list and the
 * locked-feature lines describe the same two settings one click away — when
 * the words lived in two places they drifted, and the plan screen ended up
 * calling the dial's `ละเอียด` something else. Pure and self-contained: the
 * desktop keeps a byte-identical copy at `desktop/app/src/renderer/src/lib`.
 *
 * THE STORED VALUES NEVER CHANGE. `video_projects.engine` is `lite`/`pro` and
 * `.precision` is `standard`/`high`; the API allow-lists accept exactly those
 * and rows already hold them. Everything here is display only — rename a
 * `value` and every existing project stops matching.
 *
 * The model names are a LADDER with a rung left empty on purpose:
 *
 *     Scout  →  Director  →  Auteur   (reserved, the next tier up)
 *                  ↑
 *              Cutter               (reserved, should one ever land between)
 *
 * so a third tier can be added without renaming what people already know.
 * `Draft`/`Master` was dropped for the opposite reason: nothing sits above
 * Master, so the whole set would have to be renamed the first time it grew.
 *
 * NEVER use Free, Lite, Starter, Pro, Studio, Agency or Max as a model name.
 * Those are the PLAN names, and the old "Pro" engine colliding with the Pro
 * plan is the entire reason for this rename. Reach for a reserved rung above
 * instead of reaching for "Pro" again.
 *
 * `description` is the line inside the menu, `hint` the longer one under the
 * trigger. Both say what the user gets — never a vendor, a model id, a setting
 * or a frame rate. Deeper also means slower and dearer, and the Director lines
 * say so: hiding it only moves the surprise to the quota screen. No absolute
 * wait time anywhere, though — the same job measured 87–114 s with nothing the
 * user chose differing, so a number would be a promise the queue cannot keep.
 */

export interface QualityTierOption<V extends string> {
  value: V
  /** The name on the trigger and at the top of the menu row. */
  label: string
  /** The one line under the name, inside the menu. */
  description: string
  /** The longer line under the trigger, for the current choice. */
  hint: string
}

export const ENGINE_OPTIONS: QualityTierOption<'lite' | 'pro'>[] = [
  {
    value: 'lite',
    label: 'Scout',
    description: 'ออกไปหาช็อตเร็ว ๆ แล้วกลับมาพร้อมของที่ใช้ได้',
    hint: 'อ่านฟุตเทจแบบไว ๆ แล้วเลือกช็อตที่เด่นชัด — เสร็จไวกว่าและใช้โควตาน้อยกว่า เหมาะกับคลิปง่าย ๆ หรือลองดูก่อน'
  },
  {
    value: 'pro',
    label: 'Director',
    description: 'ดูทุกเทคแล้วเลือก ได้ช็อตกว้างกว่าและสำรองเยอะกว่า',
    hint: 'ไล่ดูฟุตเทจทั้งม้วนแล้วเทียบทุกเทคก่อนตัดสินใจ ได้ช็อตกว้างกว่าและสำรองเยอะกว่า — คิดนานกว่าและใช้โควตามากกว่าราว 1.3 เท่า'
  }
]

export const PRECISION_OPTIONS: QualityTierOption<'standard' | 'high'>[] = [
  {
    value: 'standard',
    label: 'ปกติ',
    description: 'สมดุลระหว่างคุณภาพกับความเร็ว เหมาะกับงานทั่วไป',
    hint: 'ดูคลิปแบบห่าง ๆ พอเห็นว่าแต่ละช่วงเป็นอะไร เหมาะกับงานทั่วไป'
  },
  {
    value: 'high',
    label: 'ละเอียด',
    description: 'จับจังหวะสั้น ๆ ที่ระดับปกติมองข้าม — ใช้โควตามากกว่า',
    hint: 'ตัดได้คมและถี่ขึ้น จับจังหวะสั้น ๆ ที่ระดับปกติมองข้าม — ใช้เวลานานขึ้นและใช้โควตามากกว่า'
  }
]

/** The dial's own words, for the places OUTSIDE the dial that describe the
 * same setting: a plan row, a locked reason, a review summary, a marketing
 * page. Read from the options above so the two can never say different
 * things. */
export const ENGINE_NAMES = {
  lite: ENGINE_OPTIONS[0].label,
  pro: ENGINE_OPTIONS[1].label
} as const

export const PRECISION_NAMES = {
  standard: PRECISION_OPTIONS[0].label,
  high: PRECISION_OPTIONS[1].label
} as const

/** "ระดับละเอียด" — the dial's option name in a sentence, where the bare
 * `ละเอียด` would read as an adjective instead of a named choice. */
export function precisionLevelName(value: keyof typeof PRECISION_NAMES): string {
  return `ระดับ${PRECISION_NAMES[value]}`
}
