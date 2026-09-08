/**
 * "Which files do you want?" — shared by ส่งไปมือถือ and ส่งออกวิดีโอ.
 *
 * Both surfaces hand over the exact same set of rendered artifacts and differ
 * only in where they put them (a LAN download vs. a folder on disk), so the
 * choice itself lives here: one list, one set of labels, one definition of what
 * "the final clip" means. Export used to skip the question entirely and dump
 * whatever the preview happened to be pointing at.
 */

export interface Artifact {
  id: string
  path: string
  label: string
  name: string
  size: number
  kind: 'final' | 'subs' | 'scene' | 'bundle'
}

/** Checklist rows are per kind — "all scenes" is one tick, not N. */
export interface KindRow {
  kind: Artifact['kind']
  label: string
  /** What the file is for, in the user's terms. */
  blurb: string
  ids: string[]
  totalSize: number
}

/** Every kind is listed in this order whether or not the project has it — a
 * row the project is missing is dimmed with its reason rather than hidden, so
 * the list does not silently change shape between projects. */
export const KINDS: { kind: Artifact['kind']; label: string; blurb: string }[] = [
  { kind: 'final', label: 'คลิปที่ตัดเสร็จ', blurb: 'ไฟล์ที่เอาไปโพสต์ได้เลย' },
  {
    kind: 'subs',
    label: 'ไฟล์คำบรรยาย (.srt)',
    blurb: 'เผื่อเอาไปใส่คำบรรยายในแอปอื่น'
  },
  { kind: 'scene', label: 'คลิปแยกทีละฉาก', blurb: 'เอาไปเรียงใหม่เองในแอปตัดต่อ' },
  // Named for what the file actually is. It is a plain zip of the rendered
  // clip + script.txt + the per-scene clips (build_dub_bundle_zip) — no CapCut
  // project file, no cut list, no captions. The old wording promised "เปิดต่อ
  // ใน CapCut ได้ทั้งโปรเจกต์", so people downloaded twice the bytes expecting
  // the edit to come across, and it never did: CapCut only sees loose videos.
  {
    kind: 'bundle',
    label: 'ไฟล์ทั้งชุด (.zip)',
    blurb: 'คลิปที่ตัดเสร็จ + คลิปแยกฉาก + สคริปต์ ต้องเรียงเองในแอปตัดต่อ'
  }
]

export function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.round(n / 1024)} KB`
}

export function toKindRows(artifacts: Artifact[]): Map<Artifact['kind'], KindRow> {
  const byKind = new Map<Artifact['kind'], Artifact[]>()
  for (const a of artifacts) {
    const list = byKind.get(a.kind) ?? []
    list.push(a)
    byKind.set(a.kind, list)
  }
  const rows = new Map<Artifact['kind'], KindRow>()
  for (const def of KINDS) {
    const found = byKind.get(def.kind)
    if (!found || found.length === 0) continue
    // 'final' counts too: speech_highlights renders N finished clips
    // (highlights/hNN.mp4), and "(6 ไฟล์)" is the difference between a row
    // that promises one video and one that delivers six.
    const many = def.kind === 'scene' || def.kind === 'bundle' || found.length > 1
    rows.set(def.kind, {
      kind: def.kind,
      label: many ? `${def.label} (${found.length} ไฟล์)` : def.label,
      blurb: def.blurb,
      ids: found.map((a) => a.id),
      totalSize: found.reduce((s, a) => s + a.size, 0)
    })
  }
  return rows
}

/** Ids behind the ticked kinds — what both callers actually send onward. */
export function selectedIds(
  rows: Map<Artifact['kind'], KindRow>,
  checked: Set<Artifact['kind']>
): string[] {
  return KINDS.filter((k) => checked.has(k.kind)).flatMap((k) => rows.get(k.kind)?.ids ?? [])
}

export function selectedSummary(
  rows: Map<Artifact['kind'], KindRow>,
  checked: Set<Artifact['kind']>
): { files: number; bytes: number } {
  const picked = KINDS.filter((k) => checked.has(k.kind)).map((k) => rows.get(k.kind))
  return {
    files: picked.reduce((s, r) => s + (r?.ids.length ?? 0), 0),
    bytes: picked.reduce((s, r) => s + (r?.totalSize ?? 0), 0)
  }
}
