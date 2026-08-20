"""Move cut edges onto real silence, measured from the waveform.

Word timestamps are not enough to promise "never cut while someone is speaking",
and the failure is not hypothetical: on a real 10-minute span every cut edge sat
exactly where the transcript said it should (0.10 s before the first word, 0.15 s
after the last), and 30 of 70 edges still had speech audible across them.

Three ways a transcript-only edge lands inside speech:

* Scribe stamps the word envelope, not the sound. A Thai onset (ก ต ป) starts
  before the stamped start and a tone tail rings after the stamped end.
* Low-confidence words are dropped upstream (``min_logprob``) and filler tokens
  are excluded from the word list — both are still audible, and both are
  invisible to anything reasoning about words.
* Segment ends inherit their last word's end, which may itself have been clamped
  (``MAX_WORD_SEC``).

So the edges are verified against the audio itself: for each one, scan outward
for a window that is actually quiet and move the edge there. Outward only — a
slightly longer cut is never the complaint, a clipped word always is.
"""

from __future__ import annotations

import array
import wave
from pathlib import Path

from packages.core.logging import get_logger

log = get_logger(__name__)

#: Window used to judge "is this moment quiet". Short enough to fit between two
#: sentences, long enough not to trip on a single glottal click.
PROBE_SEC = 0.06

#: How far an edge may travel to find silence. 0.40 s was not enough: a Thai
#: sentence tail plus the pause it leads into routinely needs more, and the
#: edges that could not reach silence were exactly the ones still measuring hot
#: (12 of them on the first real span). Travelling further only ever adds a
#: little material; the alternative is a clipped word.
SEARCH_SEC = 1.00

#: Quiet means "close to the floor AROUND THIS EDGE", not an absolute level and
#: not a whole-file figure. A whole-file floor is measured wherever the file is
#: most silent — a lead-in, a dropout — and on a real recording that came out at
#: RMS 3.8 while the actual silence between sentences sat at 188, so no edge
#: could ever reach it and 44 of 70 edges moved without fixing anything.
QUIET_FACTOR = 3.0

#: Neighbourhood used to learn the local levels around one edge.
LOCAL_FLOOR_SEC = 1.2

#: A probe may count as silence only if it is this much below the local SPEECH
#: level. Without the cap, continuous speech is "quiet" relative to itself.
#: Swept on a real span (edges still measuring hot, out of 134): 0.35 -> 7,
#: 0.25 -> 6, 0.15 -> 3, and the clip grew by 0.7 s across that whole range —
#: strictness is nearly free here, so take the strict end.
SPEECH_FRACTION = 0.15

#: Step for the outward scan.
STEP_SEC = 0.02


class _Wav:
    """Random-access RMS over a 16-bit mono PCM WAV (what the STT step writes)."""

    def __init__(self, path: str | Path) -> None:
        self._w = wave.open(str(path), "rb")
        self.rate = self._w.getframerate()
        self.channels = self._w.getnchannels()
        self.frames = self._w.getnframes()

    def rms(self, t0: float, dur: float) -> float:
        start = max(0, int(t0 * self.rate))
        if start >= self.frames:
            return 0.0
        n = max(1, int(dur * self.rate))
        self._w.setpos(start)
        raw = self._w.readframes(min(n, self.frames - start))
        if not raw:
            return 0.0
        samples = array.array("h")
        samples.frombytes(raw[: len(raw) - (len(raw) % 2)])
        if not samples:
            return 0.0
        return (sum(int(s) * int(s) for s in samples) / len(samples)) ** 0.5

    def close(self) -> None:
        self._w.close()


def noise_floor(wav: _Wav, *, probes: int = 400) -> float:
    """Quiet level of this recording — the 10th percentile of sampled windows.

    Sampling beats scanning: a 70-minute WAV is 134 MB and the floor is stable
    enough that a few hundred windows spread across it agree with the full pass.
    """
    total = wav.frames / wav.rate
    if total <= 0:
        return 0.0
    step = total / probes
    levels = sorted(wav.rms(i * step, PROBE_SEC) for i in range(probes))
    return levels[max(0, len(levels) // 10)]


def _local_levels(wav: _Wav, t: float, *, limit: float) -> tuple[float, float]:
    """(floor, loud) around ``t`` — the 10th and 90th percentile probe levels."""
    half = LOCAL_FLOOR_SEC / 2
    lo, hi = max(0.0, t - half), min(limit, t + half)
    n = max(4, int((hi - lo) / PROBE_SEC))
    step = (hi - lo) / n
    levels = sorted(wav.rms(lo + i * step, PROBE_SEC) for i in range(n))
    return levels[len(levels) // 10], levels[(len(levels) * 9) // 10]


def _quiet_level(wav: _Wav, t: float, *, limit: float) -> float:
    """The level this edge counts as silence.

    Two terms, and the second one is what makes the fail-safe work. Judging
    only against the local floor, a stretch of unbroken speech reads as quiet
    relative to ITSELF — the floor and the speech are the same number, so every
    probe passes and an edge in the middle of a word is declared safe. Capping
    at a fraction of the local speech level means uniform speech has no quiet
    point at all, which is the truth, and the caller then cancels the cut
    instead of making it.

    The small absolute term keeps a digitally-silent stretch (floor exactly 0)
    from demanding an exact zero.
    """
    floor, loud = _local_levels(wav, t, limit=limit)
    return max(min(floor * QUIET_FACTOR, loud * SPEECH_FRACTION), 1.0)


def _first_quiet(
    wav: _Wav, start: float, *, backward: bool, quiet: float, limit: float
) -> tuple[float | None, float]:
    """Scan outward from ``start`` for a window under ``quiet``.

    Returns ``(position, quietest_seen)``: the first position that qualifies as
    silence (or None when none does within :data:`SEARCH_SEC`), plus the
    quietest position observed either way. The second value is the fallback —
    when the speaker genuinely never stops, the least-loud instant in reach is
    still a better place to cut than wherever the transcript happened to end,
    which on a real clip was the middle of a word.
    """
    steps = int(SEARCH_SEC / STEP_SEC)
    best_t, best_level = start, float("inf")
    for i in range(steps + 1):
        t = start - i * STEP_SEC if backward else start + i * STEP_SEC
        if t < 0 or t > limit:
            break
        probe_at = t - PROBE_SEC if backward else t
        level = wav.rms(max(0.0, probe_at), PROBE_SEC)
        if level < best_level:
            best_t, best_level = t, level
        if level <= quiet:
            return t, t
    return None, best_t


#: Two cuts further apart than this are not neighbours — cancelling a removal
#: between them would drag in unrelated material, so the edge stays as it is.
MAX_RESCUE_GAP_SEC = 4.0


def _joins(a: dict, b: dict) -> bool:
    """True when b directly follows a in the same source, close enough to merge."""
    if a.get("source") != b.get("source"):
        return False
    return 0.0 <= float(b["in"]) - float(a["out"]) <= MAX_RESCUE_GAP_SEC


def snap_cuts_to_silence(
    cuts: list[dict],
    wav_path: str | Path,
    *,
    offset: float = 0.0,
) -> list[dict]:
    """Move every cut edge onto measured silence. Edges only ever move outward.

    Growing the kept range is the right trade at every level this app cuts at: a
    slightly longer clip is never the complaint, a clipped word always is.

    (An inward variant existed briefly for a word-level pass that removed
    fillers and stutters. The pass was abandoned — mid-sentence joins sounded
    worse than the stumbles they removed — and the mode went with it.)

    ``offset`` is added to cut times to reach the same instant in the WAV, for
    callers whose cut times are relative to a window rather than the file.

    A missing or unreadable WAV returns the cuts untouched — this is a polish
    pass, and losing it must never fail a render.
    """
    if not cuts or not Path(wav_path).exists():
        return cuts
    try:
        wav = _Wav(wav_path)
    except (wave.Error, OSError) as exc:
        log.warning("audio_edges_wav_unreadable", path=str(wav_path), error=str(exc))
        return cuts

    try:
        limit = wav.frames / wav.rate
        moved = 0
        snapped: list[dict] = []
        ok_in: list[bool] = []
        ok_out: list[bool] = []
        for c in cuts:
            c_in, c_out = float(c["in"]), float(c["out"])
            t_in, t_out = c_in + offset, c_out + offset
            new_in, fb_in = _first_quiet(
                wav, t_in, backward=True,
                quiet=_quiet_level(wav, t_in, limit=limit), limit=limit,
            )
            new_out, fb_out = _first_quiet(
                wav, t_out, backward=False,
                quiet=_quiet_level(wav, t_out, limit=limit), limit=limit,
            )
            # No real silence in reach: take the quietest instant seen instead
            # of leaving the edge wherever the transcript put it.
            adj_in = max(0.0, (new_in if new_in is not None else fb_in) - offset)
            adj_out = (new_out if new_out is not None else fb_out) - offset
            if adj_out <= adj_in:
                adj_in, adj_out = c_in, c_out
            if abs(adj_in - c_in) > 0.001 or abs(adj_out - c_out) > 0.001:
                moved += 1
            snapped.append({**c, "in": round(adj_in, 3), "out": round(adj_out, 3)})
            ok_in.append(new_in is not None)
            ok_out.append(new_out is not None)

        # An edge with no silence within reach means the speaker never stopped
        # there. Rather than cut anyway, cancel the removal: merge the two cuts
        # back into one and let the material through. This is the rule that
        # makes "never cut mid-speech" true even when the alternative is a
        # slightly longer clip — the removed span was filler, the clipped word
        # would have been the sentence.
        merged: list[dict] = []
        rescued = 0
        for i, c in enumerate(snapped):
            if merged and (not ok_out[i - 1] or not ok_in[i]) and _joins(merged[-1], c):
                merged[-1] = {**merged[-1], "out": c["out"]}
                rescued += 1
                continue
            merged.append(c)

        log.info("audio_edges_snapped", cuts=len(cuts), moved=moved,
                 unsafe_joins_cancelled=rescued, out=len(merged))
        return merged
    finally:
        wav.close()

# ── silence INSIDE a kept cut ────────────────────────────────────────────────

#: Silence shorter than this is the speaker breathing; removing it makes speech
#: sound hurried rather than tight.
MIN_GAP_SEC = 0.55

#: Left in place at each end of a removed gap, so the join keeps a beat instead
#: of slamming two words together. 0.12 read as very slightly rushed on real
#: footage; 0.18 keeps the breath without giving the dead air back (a removed
#: gap still loses everything beyond 0.36 s).
GAP_KEEP_SEC = 0.18


def remove_internal_silence(
    cuts: list[dict],
    wav_path: str | Path,
    *,
    offset: float = 0.0,
) -> list[dict]:
    """Split cuts around the silence the transcript could not see.

    The word gaps the cut logic reasons about come from Scribe, and Scribe
    stretches a trailing word over the pause that follows it — measured on real
    audio, a one-syllable word claimed 1.85 s while the waveform went quiet
    after 0.3 s. To anything reading timestamps there is no gap there at all, so
    ~20% of some finished clips was silence nobody could remove.

    Whether someone is speaking is a physical fact, so it is settled here from
    the waveform: scan each kept range, and where it is quiet for longer than
    :data:`MIN_GAP_SEC`, cut the middle out and keep :data:`GAP_KEEP_SEC` of the
    pause on each side. What "quiet" means is learned around each gap, not fixed
    — see :func:`_quiet_level`.

    Runs BEFORE :func:`snap_cuts_to_silence`: this creates edges, that one
    verifies them.
    """
    if not cuts or not Path(wav_path).exists():
        return cuts
    try:
        wav = _Wav(wav_path)
    except (wave.Error, OSError) as exc:
        log.warning("audio_edges_wav_unreadable", path=str(wav_path), error=str(exc))
        return cuts

    try:
        limit = wav.frames / wav.rate
        out: list[dict] = []
        removed = 0.0
        for c in cuts:
            c_in, c_out = float(c["in"]), float(c["out"])
            quiet_at = _quiet_level(wav, (c_in + c_out) / 2 + offset, limit=limit)
            gaps: list[tuple[float, float]] = []
            t = c_in
            run_start: float | None = None
            while t < c_out:
                step = min(STEP_SEC, c_out - t)
                loud = wav.rms(t + offset, max(step, PROBE_SEC)) > quiet_at
                if loud:
                    if run_start is not None and t - run_start >= MIN_GAP_SEC:
                        gaps.append((run_start, t))
                    run_start = None
                elif run_start is None:
                    run_start = t
                t += STEP_SEC
            if run_start is not None and c_out - run_start >= MIN_GAP_SEC:
                gaps.append((run_start, c_out))

            pos = c_in
            for g0, g1 in gaps:
                keep_to = g0 + GAP_KEEP_SEC
                resume = g1 - GAP_KEEP_SEC
                if resume - keep_to < MIN_GAP_SEC / 2:
                    continue
                if keep_to > pos:
                    out.append({**c, "in": round(pos, 3), "out": round(keep_to, 3)})
                removed += resume - keep_to
                pos = resume
            if c_out - pos > 0.05:
                out.append({**c, "in": round(pos, 3), "out": round(c_out, 3)})

        log.info("internal_silence_removed", cuts_in=len(cuts), cuts_out=len(out),
                 removed_sec=round(removed, 1))
        return out
    finally:
        wav.close()
