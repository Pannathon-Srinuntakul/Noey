/**
 * Camera-motion layer — client-side data model for `effects.json`.
 *
 * 1:1 mirror of the Python model in backend/packages/video/effects.py. The JSON
 * on disk is shared between the Python render engine and this TS client, so the
 * shapes must stay in lockstep.
 *
 * Every live instance is `kind: 'transform'` — an ffmpeg filter over the real
 * footage (punch-zoom / whip-pan / scene-drift). `'overlay'` is LEGACY ONLY: the
 * Remotion half was removed 2026-08-12, but effects.json files written before
 * that still contain overlay instances. They are parsed (so an old project
 * still opens) and surfaced read-only by the editor, never rendered.
 */

export const EFFECTS_DOC_VERSION = 1

export type EffectKind = 'transform' | 'overlay'
export type EffectSource = 'ai' | 'template' | 'manual'

export interface EffectInstance {
  id: string
  kind: EffectKind
  componentId: string
  startSec: number
  durationSec: number
  zOrder: number
  /** Open per-component param bag (color/scale/position/easing/…) — validated by the registry, not here. */
  props: Record<string, unknown>
  source: EffectSource
}

export interface EffectsDoc {
  version: number
  instances: EffectInstance[]
}

export function emptyEffectsDoc(): EffectsDoc {
  return { version: EFFECTS_DOC_VERSION, instances: [] }
}

export function effectEndSec(inst: EffectInstance): number {
  return inst.startSec + inst.durationSec
}

/** Instances left over from the removed overlay half — shown read-only so the
 * user can delete them, never rendered. See the module docstring. */
export function legacyOverlayInstances(doc: EffectsDoc): EffectInstance[] {
  return doc.instances.filter((i) => i.kind === 'overlay')
}

export function transformInstances(doc: EffectsDoc): EffectInstance[] {
  return doc.instances.filter((i) => i.kind === 'transform')
}

let _counter = 0
function genId(): string {
  _counter += 1
  return `eff_${Date.now().toString(36)}${_counter.toString(36)}`
}

/**
 * Coerce arbitrary JSON (from disk or an AI response) into a valid EffectsDoc.
 * Tolerant on the way in (drop bad instances, keep the rest), deterministic on
 * the way out (stable sort by start time then z-order) — mirrors the Python
 * normalize_effects_doc so both sides agree on the canonical form.
 */
export function normalizeEffectsDoc(raw: unknown): EffectsDoc {
  if (!raw || typeof raw !== 'object') return emptyEffectsDoc()
  const obj = raw as Record<string, unknown>
  const rawInstances = Array.isArray(obj.instances) ? obj.instances : []
  const instances: EffectInstance[] = []

  for (const entry of rawInstances) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const kind = e.kind
    if (kind !== 'overlay' && kind !== 'transform') continue
    if (typeof e.componentId !== 'string') continue
    if (typeof e.startSec !== 'number' || typeof e.durationSec !== 'number') continue

    const source: EffectSource =
      e.source === 'template' || e.source === 'manual' || e.source === 'ai' ? e.source : 'ai'

    instances.push({
      id: typeof e.id === 'string' ? e.id : genId(),
      kind,
      componentId: e.componentId,
      startSec: Math.max(0, e.startSec),
      durationSec: Math.max(0.01, e.durationSec),
      zOrder: typeof e.zOrder === 'number' ? Math.trunc(e.zOrder) : 0,
      props: e.props && typeof e.props === 'object' ? (e.props as Record<string, unknown>) : {},
      source
    })
  }

  instances.sort((a, b) => a.startSec - b.startSec || a.zOrder - b.zOrder)
  const version = typeof obj.version === 'number' ? obj.version : EFFECTS_DOC_VERSION
  return { version, instances }
}
