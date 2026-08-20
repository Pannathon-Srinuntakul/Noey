"""Speech-driven segment selection for the two R17 modes (NEW file — the
video-driven prompts in ``dub_ai.py`` are untouched and stay the only prompts
for ตัดฉากเด่น).

Two selectors over one contract:

- ``select_highlights``  — mode A (``speech_highlights``): a long clip in, a
  handful of self-contained highlight windows out.
- ``select_scenes``      — mode B (``speech_scenes``): pick the segments that
  chain into ONE watchable story, original audio kept.

**The model returns SEGMENT NUMBERS, never seconds.** The smallest unit the
model can refer to is a sentence, so a mid-word cut is impossible by
construction and no model-arithmetic timestamp (the 442-bug family) can reach
the render. Segment → seconds happens in :func:`picks_to_cuts`, in code:

1. in  = first word's start of the first segment
   out = last word's end of the last segment + a small tail
2. each edge slides to the nearest word-gap silence within ``SNAP_WINDOW_SEC``
3. ``resnap_selected_cuts`` (timeline.py) runs last, then ``filter_short_cuts``
   + ``remove_overlapping_cuts`` — the same mechanical cleanup every other
   mode trusts.

The weak-highlight gates (R17.2) are enforced HERE, not requested in prose:
score >= 4 only, a count ceiling from source length, and hard length bounds.
An empty survivor list raises a Thai error like ``plan_core`` does — it is
never padded back up to a quota.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from packages.core.logging import get_logger
from packages.video.audio_edges import remove_internal_silence, snap_cuts_to_silence

log = get_logger(__name__)

# ── gates (mode A) ────────────────────────────────────────────────────────────

#: A gap this long between speech segments is dead air, not a beat. Lower than
#: the shared EDITORIAL_BLOCK_GAP (1.0 s) because the podcast measurement put
#: most real gaps at 0.5-1.0 s — at 1.0 the cut never fires on them at all.
SPEECH_GAP_THRESHOLD = 0.5

#: The one quality gate left in code. Length and count are NOT gated: how long
#: a highlight should run and how many a recording contains are editorial calls
#: that differ per creator and per recording, and the fixed numbers this file
#: used to carry (20-180 s, one per 8 min, 10 max) were doing real damage — on
#: the first long-form run three of four highlights landed within 6 s of the
#: 180 s ceiling, i.e. the ceiling ended them, not the material. The model now
#: decides; the prompt carries the guidance instead.
MIN_HIGHLIGHT_SCORE = 4

#: NOT an editorial limit — a runaway guard. A malformed response asking for
#: hundreds of renders would spend hours of ffmpeg and fill the disk before
#: anyone could stop it. It is logged when it bites, so a legitimate long
#: recording hitting it is visible rather than silently truncated.
HIGHLIGHT_RUNAWAY_CEILING = 60

#: Edge handling shared by both modes.
TAIL_SEC = 0.15
SNAP_WINDOW_SEC = 0.8

#: A cut may only land where the speaker had actually stopped. Any boundary
#: whose surrounding silence is shorter than this is not a pause — it is the
#: breath in the middle of a sentence — and cutting there clips a word in half
#: however good the editorial reason was. Enforced from the word timestamps in
#: code, both for the selector's window edges and for the content trim's
#: boundaries: prose asking a model to "not cut mid-sentence" is a request, this
#: is a guarantee.
MIN_CUT_GAP_SEC = 0.25

#: A kept piece shorter than this cannot carry a thought — it is a fragment of
#: one, and played next to material from a minute away it reads as noise. The
#: shared MIN_KEEP_CUT_SEC (1.0 s) is not a substitute: there, one second is a
#: continuous sentence with its edges trimmed; here it is a sentence lifted out
#: of a paragraph. Measured on a real run before this existed: 8 kept pieces
#: under 3 s, the shortest 1.3 s, and it opened a clip.
MIN_PIECE_SEC = 4.0

#: A jump this wide between kept pieces is worth flagging in the log — but it
#: is NOT acted on. It used to drop the smaller side, and on a real story-framed
#: run that "smaller side" was the setup the model had deliberately kept: the
#: code deleted the story's opening to enforce a number. Whether a leap reads as
#: one conversation is a meaning question, and meaning questions belong to the
#: model (seamless rule 4); code only handles what is physically checkable.
MAX_PIECE_JUMP_SEC = 60.0



# ── prompt text ───────────────────────────────────────────────────────────────

# Adapted from dub_ai.py's <continuity> block (2026-08-18 wording) for a
# transcript-driven selection; the source block itself is not modified.
CONTINUITY_BLOCK = """<continuity>
The picked segments play back to back as one video. A viewer reads them as continuous unless something tells them otherwise.

Never cut backwards. Play the material in the order it was given: clips in the order they were supplied, and inside each clip forward in time. What changes BETWEEN clips — outfit, hair, location, day, lighting — is not a continuity error and is never a reason to avoid a clip; the user chose to shoot it that way. Pick across every clip that has strong material.

Each pick is a RANGE of consecutive segments (segFrom..segTo). Ranges must not overlap and must be listed in source order.
</continuity>"""

SPEECH_SCENES_SYSTEM = """<role>
You edit a spoken video down to its strongest scenes. The original audio stays — you never write a script, never plan a voiceover, and the viewer hears exactly the words in the transcript. Your only tool is CHOOSING which transcript segments survive.
</role>

<goal>
Chain the chosen ranges into ONE video that tells a complete story on its own: it opens on something that earns attention, every range advances the story the speaker is telling, and it closes on a real ending — a conclusion, a punchline, a result. A stranger who has never seen the full video must be able to follow it without feeling that sentences are missing between cuts.
</goal>

<selection>
- A range must be self-contained speech: it starts where a thought starts and ends where that thought lands. Never start a range on a segment that only makes sense given the previous (unpicked) segment — pronouns pointing at unseen things, answers without their question, "ดังนั้น/เพราะฉะนั้น" openers.
- Prefer fewer, longer ranges over many one-segment fragments; every join is a place the story can break.
- Cut everything that does not move the story: greetings and channel talk, filler, repeated takes, tangents that never return, technical fiddling.
- The transcript may tag speakers (SPK_1, SPK_2...). Keep exchanges intact — never cut an answer away from the question that produced it.
</selection>

__CUT_STYLE_BLOCK__

""" + CONTINUITY_BLOCK + """

<duration>
When a target duration is given, treat it as a ceiling: land close beneath it, never above. Undershoot only when strong material genuinely runs out — a shorter honest video beats a padded one. With no target, keep everything that carries the story and nothing that doesn't.
</duration>

<output_format>
Return ONLY JSON:
{
  "picks": [
    { "segFrom": 12, "segTo": 19, "why": "one line: what this range contributes" }
  ]
}
segFrom/segTo are the segment numbers shown in the transcript, inclusive, segFrom <= segTo, ranges in source order, non-overlapping.
</output_format>"""

SPEECH_HIGHLIGHTS_SYSTEM = """<role>
You find the highlight moments in a long spoken recording (podcast, live, interview, longform video). Each highlight becomes its own standalone short clip with the original audio — nothing is re-voiced, nothing is summarized. Your only tool is CHOOSING ranges of transcript segments.
</role>

<what_counts>
A highlight is any stretch a viewer would actually keep — not only the exciting moments. All of these count equally: the important substance (a key explanation, a how-to that completes, advice that stands alone), the story reaching its peak, a punchline that lands, a sharp answer, a claim that surprises, a confession, a demonstration paying off. Judge by whether the CONTENT matters, not by energy level — a calm, complete explanation of the thing the recording is about is as much a highlight as a laugh. Each one must work for someone who has NOT heard the rest of the recording: it carries its own setup and its own landing inside the range.

NOT highlights: introductions and pleasantries, housekeeping, ad reads, the host summarizing what will come later, mid-build sections that only pay off elsewhere, anything that needs outside context to make sense.
</what_counts>

<selection>
- Start each range where the moment's own setup starts (often 1–3 segments before the peak) and end where the moment lands — never open cold on the punchline, never leave a question hanging.
- The FIRST segment of a range must be able to open a video. Test it, do not eyeball it: read that segment ALONE, as the first thing a stranger hears, and ask whether they know what is being talked about. A reply particle, an answer to an unheard question, a sentence pointing at something never named, a continuation of a previous sentence — all fail, whatever words they use. Thai marks this at the front in dozens of ways and no list of them would be complete, so judge by the test, not by matching words.

  When it fails, walk BACKWARDS segment by segment until you reach the one that introduces the subject — the question that was asked, the thing being reacted to, the claim being made — and start there instead, even at the cost of a few dull segments. The pass after you can trim inside your range but can NEVER reach outside it: a subject introduced one segment before your start is lost for good.

  Include enough context to be understood, not the whole conversation. Usually this is one to three segments, not thirty.
- The LAST segment of a range must be where the SUBJECT finishes, not where a good sentence happens to land. Do not decide this from the segment you are keeping — decide it from the NEXT one, the first you would leave out. Read that segment: if it is still explaining the same thing, still giving reasons for it, still working towards its conclusion, then the subject has not finished and your range must swallow it too. Keep walking forward that way until the next segment genuinely belongs to something else.

  A sentence that sounds like a conclusion is not evidence the subject ended — speakers land small conclusions all the way through a topic and then keep going. The only evidence is what comes after.

  This costs you nothing. The pass after you removes everything inside your range that does not earn its place, so an ending a few segments late is trimmed back; an ending a few segments EARLY is a topic the viewer never sees the end of, and nothing downstream can repair it. Err long.
- Score honestly, 1–5: 5 = would spread on its own; 4 = clearly worth posting; 3 or below = filler, and it will be discarded. Do not inflate — an empty result is an acceptable answer and a padded one is not.
- The transcript may tag speakers (SPK_1, SPK_2...). Keep exchanges intact — an answer without its question is not a highlight.
- Ranges must not overlap. If two candidate moments share segments, keep the stronger one.
</selection>

""" + CONTINUITY_BLOCK + """

<later_passes>
You are the FIRST of three passes, and knowing that changes what you should return.

After you: a second pass reads your chosen span sentence by sentence and removes the padding, the repetition and the detours inside it. After that, a mechanical pass cuts the silences and stumbles. Neither of them can widen what you chose — they only ever remove.

So choose the WHOLE topic. Start where it starts and end where it actually finishes, including the parts that ramble, repeat themselves, or wander before coming back. Excluding good material because filler sits next to it is the one mistake nothing downstream can repair; including filler costs nothing.
</later_passes>

<duration>
Choose the span the CONTENT needs. There is no minimum and no maximum — a moment that lands in 15 seconds should be 15 seconds, and one that needs four minutes to pay off should get four minutes. Never stretch a moment past its natural end, and never clip its setup off, to hit a number.

Never shrink a range to be tight and never skip one because it contains dead air or slow patches — the passes after you handle both. When a preferred length is given, it applies to the FINISHED clip and the second pass is what lands it; your job is to hand that pass the whole topic, not a pre-trimmed version of it.
</duration>

<how_many>
There is NO upper limit, and no number to aim at. Work through the transcript from the first segment to the last and return EVERY distinct stretch worth watching. If the recording holds thirty of them, return thirty. If it holds three, return three.

Never stop early. Finding several strong moments in the first part of a recording is not a reason to look less carefully at the rest — the far end of a long recording is where a tiring editor stops paying attention, and it is exactly as likely to hold the best material.

Do not pad either: a stretch you would not watch does not become worth returning because the list looks short.
</how_many>

<distinct>
Every pick is a DIFFERENT subject. Two picks may never make the same point, however far apart they sit in the recording — when a speaker returns to something already covered, choose the single clearest telling and leave the other one out. Ranges may not overlap.

Splitting one continuous explanation into two picks is equally wrong: if the second half only means something after the first, it is one pick, not two.
</distinct>

<output_format>
Return ONLY JSON:
{
  "picks": [
    { "segFrom": 41, "segTo": 58, "score": 5, "title": "3-6 word hook naming the moment",
      "why": "one line: why this stands alone",
      "opensWith": "quote of segment 41, then one Thai line: what a stranger learns from it alone",
      "endsWith": "quote of the segment AFTER segTo (here 59), then one Thai line: what subject that segment belongs to, and why it is not this one" }
  ]
}
segFrom/segTo are the segment numbers shown in the transcript, inclusive, non-overlapping, in source order.

If the "opensWith" line cannot be written — the quoted segment does not tell a stranger what this is — the range starts too late. Move segFrom back to the segment that introduces the subject and try again BEFORE answering.

"endsWith" quotes the segment that comes AFTER your range — the first one you are leaving out — not the last one you kept. Quote it exactly, then say what subject it belongs to.

Reading that quote settles the question: if it is still the same subject as your range, the range ends too early. Move segTo forward past it and try again BEFORE answering. Only when the quoted segment genuinely belongs to something else is the range finished.
</output_format>"""

#: Mode B default editing prose for the __CUT_STYLE_BLOCK__ slot. Written for
#: transcript-driven cutting; the video-driven default in dub_ai stays there.
DEFAULT_SPEECH_CUT_PROSE = """<editing_style>
Default pace: ranges of a few connected sentences each, cutting only where the spoken thought completes. Joins should feel like the speaker simply kept talking — favor cutting at sentence boundaries that end on a falling tone, and avoid chaining many sub-3-second fragments in a row.
</editing_style>"""

SCHEMA_SCENES: dict[str, Any] = {
    "type": "object",
    "properties": {
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "segFrom": {"type": "integer"},
                    "segTo": {"type": "integer"},
                    "why": {"type": "string"},
                },
                "required": ["segFrom", "segTo", "why"],
            },
        }
    },
    "required": ["picks"],
}

SCHEMA_HIGHLIGHTS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "picks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "segFrom": {"type": "integer"},
                    "segTo": {"type": "integer"},
                    "score": {"type": "integer"},
                    "title": {"type": "string"},
                    "why": {"type": "string"},
                    # Asked for ranges alone, the model picks where the good
                    # material starts, which is routinely one segment after the
                    # question that set it up — and nothing downstream can
                    # reach back for it. Quoting the opening forces the test in
                    # <selection> to actually run.
                    "opensWith": {"type": "string"},
                    # Its mirror. Ranges were ending on a strong-sounding
                    # sentence while the speaker carried on explaining the same
                    # thing, and layer 2 cannot reach past segTo to fix it.
                    "endsWith": {"type": "string"},
                },
                "required": [
                    "segFrom", "segTo", "score", "title", "why",
                    "opensWith", "endsWith",
                ],
            },
        }
    },
    "required": ["picks"],
}


# ── layer 2: content trim inside a chosen span ───────────────────────────────
# The selector (layer 1) decides WHERE a topic starts and ends. This pass
# decides WHICH SENTENCES INSIDE IT ARE WORTH KEEPING, and the silence cut
# (layer 3, arithmetic only) then tightens the edges of whatever survives.
#
# It exists because layers 1 and 3 leave a gap that showed up on the first real
# long-form run: the silence cut removes dead air but cannot hear that a
# paragraph is padding or that a point is being made for the third time, so
# every second of a chosen span shipped. Knowing that, the selector kept its
# spans narrow — and material that belonged to the same topic, just further
# out, never made it in. Trimming here is what lets layer 1 choose the whole
# topic without dragging the filler along.

SPAN_TRIM_SYSTEM = """You are a video editor turning one chosen stretch of a recording into a standalone highlight clip.

The stretch tells ONE story. Your job is to retell that story in less time — NOT to collect its strongest sentences. A pile of good sentences with no setup and no landing is not a clip: a viewer who cannot tell what is being talked about within the first seconds closes the video, no matter how strong the middle was.

<how_to_work>
Before judging any sentence, read the whole stretch and work out what job each part of it does. Most spoken material moves through three:

- SETUP — where the subject enters: the question someone asked, the situation being described, the claim being made, the thing on screen being introduced. Setups are often casual, chatty or slow, and they are still the reason everything after them makes sense.
- DEVELOPMENT — the reasons, the steps, the examples, the argument, the demonstration.
- PAYOFF — where it lands: the answer, the conclusion, the punchline, the result, the lesson.

Keep every part the stretch actually HAS, in the speaker's own order. Compression happens INSIDE a part: keep the sentences that do that part's work, drop the ones that repeat it or stall it.

Not every stretch has all three, and you must not invent the missing one:
- A LIST or walkthrough ("five ways to...", a step-by-step) is a chain of small arcs. Keep the sentence that says what the list is, then treat each item as its own tiny setup-and-payoff. Never keep half an item.
- A short funny or shocking MOMENT may be almost all payoff, with a sentence or two of setup. That is complete as it stands — do not pad it.
- A REACTION to something on screen has its setup in what the speaker says about what they are looking at. Keep enough of that for a viewer who cannot see what the speaker saw.
- A stretch that is one continuous EXPLANATION with no separate conclusion ends where the explanation is finished, not at an artificial summary.

The rule underneath all of these: whatever makes the stretch understandable to a stranger must survive, and nothing that is merely a repeat of it should.
</how_to_work>

<the_test>
For a sentence inside a part, ask: if this were gone, would the part still do its job? If yes, drop it — not "maybe", not "it adds colour". A sentence earns its place or it goes.

NEVER apply the test to a whole part. Dropping the entire setup because it is slow, or the payoff because the middle feels clear enough, is not compression — it is deleting the story. When a part rambles, compress it down to its one or two tightest sentences: shorter, but never absent. The one sentence that tells a stranger what they are watching is the most valuable sentence in the clip, however plain it sounds.

This holds whatever the material is — an interview answer, a tutorial step, a rant, a story, a reaction. The names of the parts matter less than the question they encode: after your cuts, can a stranger still tell what this is and where it ended up?
</the_test>

<drop>
Inside a part, these always go:
- Padding: throat-clearing, restating the question, announcing what is about to be said, filler asides.
- Repetition: the same point said again. Keep the single clearest telling.
- Circling: returning to something already finished without adding anything.
- Dead ends: a thought started, abandoned, restarted — keep only the completed version.
- Detours that are never referred to again.
- The second, third, fourth example of one point. One good example proves it.
</drop>

<keep>
- Whichever sentences carry the setup — even when they are chatty. If the speaker's own introduction is rambling, keep its tightest one or two sentences rather than none.
- Every step of reasoning the payoff depends on.
- The specifics: numbers, names, prices, comparisons, the ONE example that proves the point.
- The payoff itself, and enough after it that it feels finished rather than cut off.
</keep>

<seamless>
What you keep is played back to back with nothing between. Read your kept sentences in order, as a stranger who never hears the rest, and check:

1. THE OPENING TELLS THEM WHAT THIS IS. The first kept sentence, together with the one or two after it, must establish the subject. Never open on a fragment, a subordinate clause, or a sentence whose pronouns point at things never introduced.

2. EVERY KEPT RUN IS A WHOLE THOUGHT, AND FEWER RUNS IS BETTER. Under about four seconds a run cannot be one; a lone connective says nothing. If only scraps of a thought survive, drop the whole thought.

   Every extra run is another jump for the viewer to survive, so prefer few long ones over many short ones. When two runs are separated by a sentence or two that are merely ordinary — not repetition, not padding, just unremarkable — keep that bridge and let them be one run. Reach for a new run only when what sits between them genuinely deserves to go.

   A run of a single sentence is the expensive case: it costs a jump on both sides to buy one line. Keep one only when that line is worth both jumps — a punchline, a number, a verdict. Otherwise either take its neighbours with it or let it go.

3. NOTHING POINTS AT WHAT YOU DROPPED. Every pronoun and every reference must point at something a kept sentence established. Questions keep their answers, setups keep their payoffs, a first point keeps its second, a comparison keeps both sides — and keeps the sentence that brings it back to the point.

   Check the FIRST sentence of every kept run this way, not only the first sentence of the clip. A run that resumes by pointing backwards — a pronoun, a "that kind of thing", a word standing in for something named earlier — is pointing at material you dropped just before it. Two ways out: keep whatever named the thing, or drop that run entirely. Leaving it in is how a clip becomes a sequence of half-heard remarks.

4. NO UNEXPLAINED LEAPS. Two kept pieces must read as the same conversation continuing. If what connected them was dropped, either restore a bridge or end the clip before the leap.

5. THE CLIP DELIVERS WHAT IT PROMISES. Your opening makes a promise; the clip is finished only when it is paid. Before finalising, look at what comes AFTER your last kept sentence: if those sentences are still answering the question you opened — still giving the reasons, still finishing the story — you stopped in the middle and they belong in the clip. Material only stops belonging when the speaker has moved to a different subject. When unsure where to stop, stop LATER.

A clip that leaves the viewer confused is a failure even if every sentence in it was strong. When compressing further would break any of these five, stop compressing.
</seamless>

<verdict_per_sentence>
Return a verdict for EVERY numbered sentence. No sentence may be left out.
</verdict_per_sentence>

<target_length>
When a target length is given it is the length of the FINISHED clip, and it is a requirement. Order of sacrifice: padding, then repetition, then extra examples, then the weakest stretch of the development — never the setup, never the payoff. If the story cannot fit, tell a SMALLER COMPLETE story: narrow the subject and keep its own setup-development-payoff intact.

With no target given, compress to what the story needs and not a second more.
</target_length>

<never_mid_speech>
Every boundary must land where the speaker actually stopped — a real pause, visible as a gap between the timestamps you were given. Never begin or end a kept run in the middle of someone speaking. When the only way to remove something would cut into live speech, keep it.
</never_mid_speech>

<calibration>
Unscripted speech carries real fat: losing a third to two-thirds of a stretch is common. But the measure of success is never how much you removed — it is that a stranger watches the result and gets the WHOLE story. Removing so much that the story loses its setup or its payoff is a worse failure than removing too little. When ruthlessness and the story pull against each other, the story wins.
</calibration>

<output_format>
Answer in this order — the order is part of the method:

1. "story": {"subject": "...", "payoff": "..."} — one Thai line each, naming what this stretch is about and where it lands. Write this FIRST; you cannot trim a story you have not named.
2. "verdicts": for every sentence number, "keep" or "drop", with a short Thai reason for each "drop".
3. "opening": {"firstKept": n, "whyItOpens": "..."} — in Thai: how your first kept sentences tell a stranger what they are watching. If you cannot answer, your opening is wrong — go back and fix the verdicts.
4. "closing": {"lastKept": n, "promiseKept": "...", "whyNothingAfterIsNeeded": "..."} — in Thai: what the clip promised, how the last sentence pays it, and why the sentences after it belong to a different subject. If you cannot answer the last one, they do not — go back, keep them, and update the verdicts.

Return nothing else — no timings, no rewritten text, no summary.
</output_format>"""

SCHEMA_SPAN_TRIM: dict[str, Any] = {
    "type": "object",
    "properties": {
        # Order mirrors the method: name the story, judge the sentences, then
        # justify both edges. Each is a required field precisely because prose
        # requests get skipped — a required key cannot be waved through (the
        # lesson from verdict-per-sentence, applied twice more).
        "story": {
            "type": "object",
            "properties": {
                "subject": {"type": "string"},
                "payoff": {"type": "string"},
            },
            "required": ["subject", "payoff"],
        },
        "verdicts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer"},
                    "v": {"type": "string", "enum": ["keep", "drop"]},
                    "why": {"type": "string"},
                },
                "required": ["n", "v"],
            },
        },
        "opening": {
            "type": "object",
            "properties": {
                "firstKept": {"type": "integer"},
                "whyItOpens": {"type": "string"},
            },
            "required": ["firstKept", "whyItOpens"],
        },
        "closing": {
            "type": "object",
            "properties": {
                "lastKept": {"type": "integer"},
                "promiseKept": {"type": "string"},
                "whyNothingAfterIsNeeded": {"type": "string"},
            },
            "required": ["lastKept", "promiseKept", "whyNothingAfterIsNeeded"],
        },
    },
    "required": ["story", "verdicts", "opening", "closing"],
}


# ── transcript rendering ──────────────────────────────────────────────────────


def render_transcript(segments: list[dict[str, Any]]) -> str:
    """Segments → the numbered transcript the model reads.

    Timestamps are DISPLAY ONLY (plain seconds — no MM:SS anywhere near a
    model, see the 442-bug) and the numbers are what the model answers with.
    """
    lines: list[str] = []
    for i, seg in enumerate(segments):
        spk = f" [{seg['speaker']}]" if seg.get("speaker") else ""
        lines.append(
            f"#{i}{spk} ({float(seg['start']):.1f}s-{float(seg['end']):.1f}s) {seg['text']}"
        )
    return "\n".join(lines)


def _valid_ranges(
    picks: list[dict[str, Any]], segment_count: int
) -> list[dict[str, Any]]:
    """Drop malformed / out-of-range / overlapping picks, keep source order."""
    cleaned: list[dict[str, Any]] = []
    last_to = -1
    for p in sorted(
        (p for p in picks if isinstance(p, dict)),
        key=lambda p: int(p.get("segFrom", 0)),
    ):
        try:
            a, b = int(p["segFrom"]), int(p["segTo"])
        except (KeyError, TypeError, ValueError):
            continue
        if a > b or a < 0 or b >= segment_count:
            continue
        if a <= last_to:  # overlap with the previous kept range
            continue
        cleaned.append({**p, "segFrom": a, "segTo": b})
        last_to = b
    return cleaned


# ── segment numbers → cuts ────────────────────────────────────────────────────


def _word_gaps(segments: list[dict[str, Any]]) -> list[float]:
    """Midpoints of every silence between consecutive words — snap targets."""
    words = [w for seg in segments for w in seg.get("words", [])]
    words.sort(key=lambda w: float(w["start"]))
    gaps: list[float] = []
    for prev, nxt in zip(words, words[1:]):
        gap = float(nxt["start"]) - float(prev["end"])
        if gap > 0.05:
            gaps.append((float(prev["end"]) + float(nxt["start"])) / 2.0)
    return gaps


def _snap(t: float, gaps: list[float], window: float = SNAP_WINDOW_SEC) -> float:
    best = t
    best_d = window
    for g in gaps:
        d = abs(g - t)
        if d < best_d:
            best, best_d = g, d
    return best


def _pause_before(segments: list[dict[str, Any]], idx: int) -> float:
    """Silence immediately before segment ``idx`` (inf at the recording start)."""
    if idx <= 0:
        return float("inf")
    return float(segments[idx]["start"]) - float(segments[idx - 1]["end"])


def _pause_after(segments: list[dict[str, Any]], idx: int) -> float:
    """Silence immediately after segment ``idx`` (inf at the recording end)."""
    if idx >= len(segments) - 1:
        return float("inf")
    return float(segments[idx + 1]["start"]) - float(segments[idx]["end"])


def snap_pick_to_pauses(
    pick: dict[str, Any],
    segments: list[dict[str, Any]],
) -> tuple[int, int]:
    """Move a pick's edges outward until both sit at a real pause.

    The model answers in segment numbers, and a segment boundary is usually a
    pause — but not always: Scribe splits on a word gap, and a 0.1 s gap is a
    breath, not a stop. Starting on one of those cuts into the run-up of a
    sentence. Widening (never narrowing) keeps the speech whole; the worst case
    is a slightly longer clip.
    """
    a, b = int(pick["segFrom"]), int(pick["segTo"])
    while a > 0 and _pause_before(segments, a) < MIN_CUT_GAP_SEC:
        a -= 1
    while b < len(segments) - 1 and _pause_after(segments, b) < MIN_CUT_GAP_SEC:
        b += 1
    return a, b


def enforce_pause_boundaries(
    ranges: list[tuple[int, int]],
    segments: list[dict[str, Any]],
) -> list[tuple[int, int]]:
    """Cancel any drop whose edges are not real pauses, then merge what touches.

    A drop between two kept pieces creates two new cut edges. If either one
    lands mid-sentence, the drop is refused rather than moved: keeping a
    sentence of filler costs the viewer a moment, cutting a word in half costs
    them the sentence.
    """
    if not ranges:
        return ranges
    kept = {i for a, b in ranges for i in range(a, b + 1)}
    for a, b in ranges:
        if _pause_before(segments, a) < MIN_CUT_GAP_SEC:
            # re-absorb backwards until the edge is a pause again
            i = a - 1
            while i >= 0:
                kept.add(i)
                if _pause_before(segments, i) >= MIN_CUT_GAP_SEC:
                    break
                i -= 1
        if _pause_after(segments, b) < MIN_CUT_GAP_SEC:
            i = b + 1
            while i < len(segments):
                kept.add(i)
                if _pause_after(segments, i) >= MIN_CUT_GAP_SEC:
                    break
                i += 1

    out: list[tuple[int, int]] = []
    start: int | None = None
    for i in range(len(segments)):
        if i in kept and start is None:
            start = i
        elif i not in kept and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(segments) - 1))
    return out


def pick_to_window(
    pick: dict[str, Any],
    segments: list[dict[str, Any]],
    gaps: list[float],
) -> tuple[float, float]:
    """One pick → (in, out) seconds, snapped to word-gap silence."""
    a, b = snap_pick_to_pauses(pick, segments)
    first = segments[a]
    last = segments[b]
    w_first = first.get("words") or [{"start": first["start"]}]
    w_last = last.get("words") or [{"end": last["end"]}]
    t_in = float(w_first[0]["start"])
    t_out = float(w_last[-1]["end"]) + TAIL_SEC
    return _snap(t_in, gaps), _snap(t_out, gaps)


def picks_to_cuts(
    picks: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    source_duration: float,
) -> list[dict[str, Any]]:
    """Mode B: all picks → ONE ordered cut list (absolute source seconds).

    The same cleanup chain talking_head trusts runs after this in the caller
    (resnap → filter_short → remove_overlapping).
    """
    gaps = _word_gaps(segments)
    cuts: list[dict[str, Any]] = []
    for p in picks:
        t_in, t_out = pick_to_window(p, segments, gaps)
        t_in = max(0.0, t_in)
        t_out = min(float(source_duration), t_out)
        if t_out > t_in:
            cuts.append({"type": "cut", "source": "clip0", "in": round(t_in, 3),
                         "out": round(t_out, 3)})
    return cuts


def tighten_window_cuts(
    pick: dict[str, Any],
    segments: list[dict[str, Any]],
    *,
    source_duration: float,
) -> list[dict[str, Any]]:
    """The silence-cut pass INSIDE one highlight window.

    A highlight window is chosen for its content, not its tightness — the
    silences, hesitations and stumbles inside it are removed here exactly the
    way ตัดช่วงเงียบ removes them from a whole clip, by reusing the same
    machinery over just the window's segments. So the picker may (and should)
    take the full arc of a moment, and the finished clip still plays tight.
    """
    from packages.video.timeline import (
        SPEECH_BLOCK_PROFILE,
        SPEECH_PROFILE,
        build_speech_cuts,
        filter_short_cuts,
        remove_overlapping_cuts,
        resnap_selected_cuts,
    )

    window_segments = segments[int(pick["segFrom"]): int(pick["segTo"]) + 1]
    cuts = build_speech_cuts(
        window_segments,
        gap_threshold=SPEECH_GAP_THRESHOLD,
        source_duration=source_duration,
        profile=SPEECH_BLOCK_PROFILE,
    )
    # Resnap against the FULL transcript so edge padding sees neighbouring
    # words outside the window and never bleeds into them.
    cuts = resnap_selected_cuts(
        cuts, segments, source_duration=source_duration, profile=SPEECH_PROFILE
    )
    cuts = filter_short_cuts(cuts)
    cuts = remove_overlapping_cuts(cuts)
    # Clamp to the window: resnap's breathing room must not reach into the
    # neighbouring (unpicked) content.
    gaps = _word_gaps(segments)
    w_in, w_out = pick_to_window(pick, segments, gaps)
    w_in, w_out = max(0.0, w_in), min(float(source_duration), w_out)
    clamped: list[dict[str, Any]] = []
    for c in cuts:
        c_in = max(float(c["in"]), w_in)
        c_out = min(float(c["out"]), w_out)
        if c_out > c_in:
            clamped.append({**c, "in": round(c_in, 3), "out": round(c_out, 3)})
    return clamped


def enforce_piece_shape(
    ranges: list[tuple[int, int]],
    segments: list[dict[str, Any]],
) -> list[tuple[int, int]]:
    """Make the kept pieces playable, whatever the model returned.

    One structural rule, and it is a physical fact rather than editorial taste:
    a piece shorter than :data:`MIN_PIECE_SEC` cannot carry a thought no matter
    how good the sentence in it was, so it is absorbed into the piece before it
    (restoring the material between them) or, with nothing to absorb into,
    dropped.

    Wide leaps between pieces are only LOGGED (:data:`MAX_PIECE_JUMP_SEC`).
    Acting on them meant deleting whichever side had less material, and on a
    real run that side was the story's setup — whether a leap still reads as one
    conversation is a meaning question, which belongs to the model.
    """
    if not ranges:
        return ranges

    def span_sec(a: int, b: int) -> float:
        return float(segments[b]["end"]) - float(segments[a]["start"])

    # 1. absorb the fragments
    merged: list[list[int]] = []
    for a, b in ranges:
        if span_sec(a, b) < MIN_PIECE_SEC and merged:
            merged[-1][1] = b          # swallow the gap with it
        else:
            merged.append([a, b])
    while merged and span_sec(merged[0][0], merged[0][1]) < MIN_PIECE_SEC:
        # nothing before it to merge into: it cannot open a clip
        log.info("piece_dropped_too_short", seg_from=merged[0][0], seg_to=merged[0][1])
        merged.pop(0)
    if not merged:
        return ranges

    # 2. wide leaps are logged, never acted on: judging whether a jump still
    #    reads as one conversation is the model's job (seamless rule 4), and
    #    acting on it here once deleted a setup the model had rightly kept.
    for prev, cur in zip(merged, merged[1:], strict=False):
        gap = float(segments[cur[0]]["start"]) - float(segments[prev[1]]["end"])
        if gap > MAX_PIECE_JUMP_SEC:
            log.info("piece_leap_flagged", gap_sec=round(gap, 1),
                     after_seg=prev[1], next_seg=cur[0])

    return [(a, b) for a, b in merged]


async def trim_span_content(
    segments: list[dict[str, Any]],
    *,
    seg_from: int,
    seg_to: int,
    title: str = "",
    why: str = "",
    target_sec: int | None = None,
    project_uid: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> list[tuple[int, int]]:
    """Which parts of one chosen span survive. Returns GLOBAL segment ranges.

    The model answers in local numbering (#0 = the span's first segment) — it
    never sees the rest of the recording, so local numbers are what it can
    actually verify, and the offset is added back here.

    Falls back to the whole span whenever the answer is empty or unusable. This
    pass may only ever *improve* a highlight; a bad trim response must not be
    able to delete one.
    """
    span = segments[seg_from: seg_to + 1]
    if len(span) < 3:
        return [(seg_from, seg_to)]

    header = ""
    if title.strip() or why.strip():
        header = f"<topic>\n{title.strip()}\n{why.strip()}\n</topic>\n\n"
    if target_sec:
        # The user's own number, and it reaches THIS layer rather than only the
        # selector: the selector cannot know how much this pass and the silence
        # cut will remove, so upstream it could only ever be a guess.
        span_sec = float(span[-1]["end"]) - float(span[0]["start"])
        header += (
            f"<target_length>\nThe finished clip must run about {int(target_sec)} seconds.\n"
            f"This span currently runs {span_sec:.0f} seconds.\n</target_length>\n\n"
        )
    user = header + f"<transcript>\n{render_transcript(span)}\n</transcript>"

    try:
        raw = await _select(
            SPAN_TRIM_SYSTEM, SCHEMA_SPAN_TRIM, user,
            project_uid=project_uid, on_thinking=on_thinking, key="verdicts",
            extra_keys=("story", "opening", "closing"),
        )
    except Exception as exc:  # noqa: BLE001 — a trim failure must not lose the clip
        log.warning("span_trim_failed", error=str(exc), seg_from=seg_from, seg_to=seg_to)
        return [(seg_from, seg_to)]

    # A verdict per sentence, not a list of ranges: asked for ranges, the model
    # returns one range covering everything and calls it a day — the lazy answer
    # and the "this span is already tight" answer look identical. A verdict per
    # number cannot be waved through, and an unanswered number defaults to keep.
    verdict: dict[int, str] = {}
    for v in raw:
        try:
            n = int(v["n"])
        except (KeyError, TypeError, ValueError):
            continue
        if 0 <= n < len(span):
            verdict[n] = str(v.get("v") or "keep")
    if not verdict:
        log.info("span_trim_empty_keeping_all", seg_from=seg_from, seg_to=seg_to)
        return [(seg_from, seg_to)]

    ranges: list[tuple[int, int]] = []
    run_start: int | None = None
    for i in range(len(span)):
        keep = verdict.get(i, "keep") != "drop"
        if keep and run_start is None:
            run_start = i
        elif not keep and run_start is not None:
            ranges.append((seg_from + run_start, seg_from + i - 1))
            run_start = None
    if run_start is not None:
        ranges.append((seg_from + run_start, seg_from + len(span) - 1))

    if not ranges:
        log.warning("span_trim_dropped_everything_keeping_all",
                    seg_from=seg_from, seg_to=seg_to)
        return [(seg_from, seg_to)]

    # The model was told not to cut into live speech; this makes it true.
    # Checked in the span's own numbering, then offset back.
    local = enforce_pause_boundaries([(a - seg_from, b - seg_from) for a, b in ranges], span)
    ranges = [(seg_from + a, seg_from + b) for a, b in local]
    ranges = enforce_piece_shape(ranges, segments)

    dropped = len(span) - sum(b - a + 1 for a, b in ranges)
    log.info("span_trim_done", seg_from=seg_from, seg_to=seg_to,
             pieces=len(ranges), segments_dropped=dropped, of=len(span))
    return ranges


def gate_highlights(
    picks: list[dict[str, Any]],
    segments: list[dict[str, Any]],
    *,
    source_duration: float,
    wav_path: str | None = None,
) -> list[dict[str, Any]]:
    """Score gate + decoration. Length and count are the model's to decide.

    Each surviving pick is decorated with ``srcIn``/``srcOut`` (the raw
    window), ``cuts`` (the tightened, silence-free cut list inside it) and
    ``durationSec`` (the KEPT length — what the finished clip will run).

    What is deliberately NOT here: a minimum or maximum highlight length, and a
    count derived from source duration. A 12 s punchline and a 5 min
    explanation are both legitimate outputs depending on who is recording, and
    an hour of dense material genuinely holds more moments than an hour of
    rambling. Only two things still drop a pick: the model's own score, and a
    runaway ceiling that exists to protect the render queue, not the edit.

    Raises ValueError (Thai, actionable) when nothing survives — the empty
    answer is surfaced, never padded.
    """
    gaps = _word_gaps(segments)
    survivors: list[dict[str, Any]] = []
    for p in picks:
        if int(p.get("score", 0)) < MIN_HIGHLIGHT_SCORE:
            continue
        t_in, t_out = pick_to_window(p, segments, gaps)
        t_in = max(0.0, t_in)
        t_out = min(float(source_duration), t_out)
        # ``pieces`` is what the content trim left of the span (layer 2). It is
        # absent when the trim is off or failed, and then the whole span is the
        # single piece — the two-layer behaviour, unchanged.
        pieces: list[tuple[int, int]] = list(p.get("pieces") or [
            (int(p["segFrom"]), int(p["segTo"]))
        ])
        cuts: list[dict[str, Any]] = []
        for a, b in pieces:
            cuts.extend(tighten_window_cuts(
                {"segFrom": a, "segTo": b}, segments, source_duration=source_duration
            ))
        if cuts and wav_path:
            # The waveform has the last word on silence, in both directions:
            # first it removes pauses the transcript hid inside a word, then it
            # verifies that no edge — new or old — lands on live speech. Only
            # meaningful for a single-clip source, which is what this mode is
            # (one long recording in, N clips out).
            cuts = remove_internal_silence(cuts, wav_path)
            cuts = snap_cuts_to_silence(cuts, wav_path)
        kept = sum(float(c["out"]) - float(c["in"]) for c in cuts)
        if not cuts:
            # Nothing renderable survived the silence cut — not an editorial
            # judgment, there is simply no footage left to write.
            log.info("highlight_empty_after_tighten",
                     seg_from=p.get("segFrom"), seg_to=p.get("segTo"))
            continue
        survivors.append({**p, "srcIn": round(t_in, 3), "srcOut": round(t_out, 3),
                          "cuts": cuts, "durationSec": round(kept, 3)})

    if len(survivors) > HIGHLIGHT_RUNAWAY_CEILING:
        log.warning("highlight_runaway_ceiling_hit",
                    returned=len(survivors), kept=HIGHLIGHT_RUNAWAY_CEILING)
        survivors = sorted(survivors, key=lambda p: -int(p["score"]))[:HIGHLIGHT_RUNAWAY_CEILING]
        survivors.sort(key=lambda p: p["srcIn"])

    if not survivors:
        raise ValueError(
            "คลิปนี้ไม่มีช่วงที่ฟังจบได้ในตัวเอง — AI ให้คะแนนทุกช่วงต่ำกว่าเกณฑ์ "
            "ลองเล่าให้ AI ฟังว่าหัวข้อไหนในคลิปสำคัญ หรือใช้คลิปที่เนื้อหาชัดกว่านี้"
        )
    return survivors


# ── LLM calls ─────────────────────────────────────────────────────────────────


async def _select(
    system: str,
    schema: dict[str, Any],
    user_text: str,
    *,
    project_uid: str,
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
    key: str = "picks",
    extra_keys: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    from packages.core.settings import get_settings
    from packages.llm.config import call_kwargs
    from packages.llm.gateway import acompletion_stream_thinking
    from packages.video.timeline import parse_llm_json

    settings = get_settings()
    # Text-only call, but the dub vision model (Gemini) is the model already
    # keyed and priced for this pipeline; SPEECH_SELECT_MODEL overrides.
    model_name = getattr(settings, "speech_select_model", "") or settings.dub_vision_model
    model = model_name if "/" in model_name else f"gemini/{model_name}"

    extra = call_kwargs(model=model, effort=settings.dub_vision_effort)
    extra["timeout"] = settings.dub_vision_timeout_sec
    extra["response_format"] = {
        "type": "json_object",
        "response_schema": schema,
        "enforce_validation": True,
    }
    resp = await acompletion_stream_thinking(
        [{"role": "user", "content": [{"type": "text", "text": user_text}]}],
        system=system,
        project_uid=project_uid,
        on_thinking=on_thinking,
        **extra,
    )
    parsed = parse_llm_json(resp.choices[0].message.content or "")
    for ek in extra_keys:
        if parsed.get(ek):
            # Logged, not used: these fields exist to force the model to check
            # its own story and both edges; reading them back is how anyone can
            # tell whether it did.
            log.info(f"select_{ek}", **{
                k: str(v)[:160] for k, v in dict(parsed[ek]).items()
            })
    return list(parsed.get(key) or [])


async def select_scenes(
    segments: list[dict[str, Any]],
    *,
    brief: str = "",
    target_duration_sec: int | None = None,
    style_prompt: str = "",
    project_uid: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    """Mode B: ranges that chain into one story. Returns validated picks."""
    from packages.video.dub_ai import apply_cut_style

    system = apply_cut_style(
        SPEECH_SCENES_SYSTEM, style_prompt, default_prose=DEFAULT_SPEECH_CUT_PROSE
    )
    target = (
        f"Target duration: at most {int(target_duration_sec)} seconds of kept speech."
        if target_duration_sec
        else "No target duration — keep what carries the story."
    )
    user = (
        (f"<brief>\n{brief}\n</brief>\n\n" if brief.strip() else "")
        + f"{target}\n\n<transcript>\n{render_transcript(segments)}\n</transcript>"
    )
    picks = _valid_ranges(
        await _select(system, SCHEMA_SCENES, user,
                      project_uid=project_uid, on_thinking=on_thinking),
        len(segments),
    )
    if not picks:
        raise ValueError(
            "AI ไม่พบช่วงที่ร้อยเป็นเรื่องเดียวกันได้จากคำพูดในคลิป — "
            "ลองเล่าให้ AI ฟังว่าคลิปเกี่ยวกับอะไร หรือใช้โหมดตัดช่วงเงียบแทน"
        )
    return picks


async def select_highlights(
    segments: list[dict[str, Any]],
    *,
    brief: str = "",
    preferred_len_sec: int | None = None,
    source_duration: float,
    wav_path: str | None = None,
    trim: bool = True,
    project_uid: str = "",
    on_thinking: Callable[[str], Awaitable[None]] | None = None,
) -> list[dict[str, Any]]:
    """Mode A: the three layers, in order, for one recording.

    1. this call's own LLM pass picks the topic spans
    2. :func:`trim_span_content` drops the padding inside each (parallel)
    3. :func:`gate_highlights` runs the arithmetic silence cut over what is
       left, and — given ``wav_path`` — verifies every edge against the
       waveform before anything is written.
    """
    pref = (
        f"Preferred highlight length: around {int(preferred_len_sec)} seconds each."
        if preferred_len_sec
        else "No preferred length — let each moment run exactly as long as it needs."
    )
    user = (
        (f"<brief>\n{brief}\n</brief>\n\n" if brief.strip() else "")
        + f"{pref}\n\n<transcript>\n{render_transcript(segments)}\n</transcript>"
    )
    picks = _valid_ranges(
        await _select(SPEECH_HIGHLIGHTS_SYSTEM, SCHEMA_HIGHLIGHTS, user,
                      project_uid=project_uid, on_thinking=on_thinking),
        len(segments),
    )
    picks = [p for p in picks if int(p.get("score", 0)) >= MIN_HIGHLIGHT_SCORE]

    if trim and picks:
        # Layer 2, one call per surviving pick, all at once: each looks only at
        # its own span, so they neither help nor block each other.
        results = await asyncio.gather(*[
            trim_span_content(
                segments,
                seg_from=int(p["segFrom"]), seg_to=int(p["segTo"]),
                title=str(p.get("title") or ""), why=str(p.get("why") or ""),
                target_sec=preferred_len_sec,
                project_uid=project_uid,
            )
            for p in picks
        ], return_exceptions=True)
        for p, res in zip(picks, results, strict=False):
            if isinstance(res, BaseException):
                log.warning("span_trim_call_failed", error=str(res),
                            seg_from=p.get("segFrom"))
                continue
            p["pieces"] = res

    return gate_highlights(
        picks, segments, source_duration=source_duration, wav_path=wav_path,
    )
