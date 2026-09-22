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
import { backendMode, type WizardState } from './wizardState'

/**
 * The request for the wizard's current choices, or null while it cannot be
 * asked yet: no files, or a clip whose length is still being probed (an
 * estimate over a partial list would read low and then jump).
 *
 * `separate` upload mode makes one project per clip; they are estimated as one
 * run over all the clips, which differs from N runs only by the per-run
 * prompt — small next to the footage itself.
 */
export function estimateRequestFor(
  state: Pick<WizardState, 'files' | 'uiMode' | 'voiceover' | 'engine' | 'precision'>
): EstimateRequest | null {
  if (state.files.length === 0) return null
  const clips: EstimateRequest['clips'] = []
  for (const f of state.files) {
    if (f.durationSec === null || !Number.isFinite(f.durationSec)) return null
    // The wizard does not know which clips carry sound; assuming all do only
    // ever errs high, and only for the speech modes that transcribe.
    clips.push({ duration_sec: Math.max(0, f.durationSec), has_audio: true })
  }
  return {
    mode: backendMode(state.uiMode, state.voiceover),
    engine: state.engine,
    precision: state.precision,
    clips
  }
}

/** Stable identity of a request, so an unchanged wizard does not re-ask. */
export function estimateKey(req: EstimateRequest | null): string {
  return req ? JSON.stringify(req) : ''
}

export type StartDecision =
  /** Fits the plan, or the user already agreed to use the balance. */
  | 'go'
  /** Fits only with the top-up balance and the user has not said yes yet. */
  | 'ask_wallet'
  /** Does not fit, even with the balance. Nothing is uploaded. */
  | 'blocked'

/**
 * What pressing start does. No estimate (still loading, or the request
 * failed) is `go`: the start route enforces the limit anyway and the pipeline
 * shows its refusal — the preview must never be the reason work cannot start.
 */
export function startDecision(est: UsageEstimate | null, allowWallet: boolean): StartDecision {
  if (!est || est.unlimited || est.fits === 'plan') return 'go'
  if (est.fits === 'wallet') return allowWallet ? 'go' : 'ask_wallet'
  return 'blocked'
}
