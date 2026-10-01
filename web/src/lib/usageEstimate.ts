/**
 * The wizard's pre-flight estimate — what it sends, and what it lets the user
 * do with the answer. Pure, so the gate the start button obeys is tested
 * without a server.
 *
 * The server's answer is a preview: every start route recomputes the estimate
 * from durations the SERVER holds and reserves that (docs/token-billing-design.md
 * §5), so a wrong number here can mislead but never overspend.
 */
import type { EstimateRequest, UsageEstimate } from './usageLimits'
import { backendMode, buildSubmission, type WizardState } from './wizardState'

/**
 * The request for the wizard's current choices, or null while it cannot be
 * asked yet: no files, or a clip whose length is still being probed (an
 * estimate over a partial list would read low and then jump).
 *
 * `separate` upload mode makes one project per clip; they are estimated as one
 * run over all the clips, which differs from N runs only by the per-run
 * prompt — small next to the footage itself.
 *
 * It also says what the user ASKED the cut to be — the requested result
 * length and their voiceover script — because the AI's answer, the dearest
 * part of a run, grows with them (server estimate e4). Same numbers the
 * submission sends (`buildSubmission`).
 */
export function estimateRequestFor(state: WizardState): EstimateRequest | null {
  if (state.files.length === 0) return null
  const clips: EstimateRequest['clips'] = []
  for (const f of state.files) {
    if (f.durationSec === null || !Number.isFinite(f.durationSec)) return null
    // The wizard does not know which clips carry sound; assuming all do only
    // ever errs high, and only for the speech modes that transcribe.
    clips.push({ duration_sec: Math.max(0, f.durationSec), has_audio: true })
  }
  const sub = buildSubmission(state)
  return {
    mode: backendMode(state.uiMode, state.voiceover),
    engine: state.engine,
    precision: state.precision,
    clips,
    ...(sub.targetDurationSec ? { target_duration_sec: sub.targetDurationSec } : {}),
    ...(sub.userScript ? { user_script: sub.userScript } : {})
  }
}

/** Stable identity of a request, so an unchanged wizard does not re-ask. */
export function estimateKey(req: EstimateRequest | null): string {
  return req ? JSON.stringify(req) : ''
}

export type StartDecision =
  /** Nothing refuses it (it may still go past what is left — see below). */
  | 'go'
  /** Refused unless the top-up balance carries it; the user has not said yes yet. */
  | 'ask_wallet'
  /** Refused, and the balance cannot carry it. Nothing is uploaded. */
  | 'blocked'

/**
 * What pressing start does (owner, 2026-10-01 — the strict start gate): a NEW
 * run starts only when its estimate fits what is left of the binding window
 * (on Pro and up the closer-to-full of the week and the month). The server's
 * two gates stop it here, before a byte uploads: the window is already full,
 * or the run is bigger than what is left (`overage_too_large`). Once
 * started, a run that outgrows its estimate pauses at 100 % and its in-flight
 * overage counts into the next period.
 *
 * No estimate (still loading, or the request failed) is `go`: the start route
 * enforces the gates anyway and the pipeline shows its refusal — the preview
 * must never be the reason work cannot start.
 */
export function startDecision(est: UsageEstimate | null, allowWallet: boolean): StartDecision {
  if (!est || est.unlimited) return 'go'
  if (!est.full && !est.overage_too_large) return 'go'
  if (est.fits === 'wallet') return allowWallet ? 'go' : 'ask_wallet'
  return 'blocked'
}
