"""ElevenLabs Scribe speech-to-text — the only transcription path.

Replaces the former Whisper stack (local faster-whisper + the Modal GPU worker)
*and* the Gemini per-clip video review that used to decide which silent
stretches were worth keeping.

Why the rewrite: the old pipeline's timestamps came from Whisper + Silero VAD.
On Thai, Whisper splits text into grapheme clusters whose timestamps can sit
~0.9 s apart *inside a single word*, so every silence-cut boundary was guesswork
padded with hand-tuned constants, and a second (expensive, video-watching) model
had to clean up after it. Scribe returns frame-aligned word timestamps directly,
so the cut is decided here, in code: no VAD tuning, no hallucination phrase
list, no reviewer model.

The output contract is unchanged, so everything downstream (``plan_core``,
``caption``, both renderers) keeps working as-is::

    {
      "segments": [{"start", "end", "text", "words": [{"word", "start", "end"}]}],
      "silence_gaps": [],  # always empty — see build_silence_gaps
      "text": "<full script, one segment per line, no audio-event tags>",
      "audio_events": [{"text", "start", "end"}],  # informational only
    }

All timestamps are absolute across the concatenated clips.

Two Thai behaviours, both confirmed against real Scribe responses rather than
the docs (the docs are wrong on the second):

1. ``type="word"`` tokens are GRAPHEME CLUSTERS, not words — "แต่งหน้ากันจ้ะ"
   arrives as ``แ|ต่|ง|ห|น้|า|กั|น|จ้|ะ``. :func:`merge_pieces_to_words` rebuilds
   words with pythainlp before anything downstream sees them.

   The merge exists for CAPTIONS, not for the cut. Piece timings are contiguous
   (``แ`` ends at 6.299, ``ต่`` starts at 6.299 — no 0.9 s void mid-word the way
   Whisper produced), so gap arithmetic gives the same answer either way. What
   needs words is ``caption.py``: it breaks lines every N words and reveals one
   word at a time, so raw pieces would break mid-word and pop one letter at a
   time. Timings still come from the pieces, so a pythainlp mis-segmentation
   costs a line break, never a wrong cut.
2. ``spacing`` tokens DO appear in Thai, at real pauses and around Latin words
   embedded in Thai speech — the docs say they do not exist for scriptio-continua
   languages. They are used to rebuild segment text, never to derive a gap: a gap
   is always ``word[i].end -> word[i+1].start``.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import re
import wave
from collections.abc import Awaitable, Callable
from typing import Any

from packages.core.logging import get_logger

log = get_logger(__name__)

STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"

# A gap between consecutive words longer than this ends the current segment.
# Segments are a *caption/planning* unit only — the cut boundary threshold lives
# downstream in plan_core (EDITORIAL_BLOCK_GAP). Kept well below it so a segment
# never straddles a stretch the planner would want to cut.
SEGMENT_SPLIT_GAP = 0.45

# A merged word longer than this is a timing glitch, not speech — a probe run on
# real footage produced a single "word" spanning 12.2 s. Its end sets its
# segment's end, so an unclamped one drags twelve seconds of nothing into the cut.
MAX_WORD_SEC = 2.0

# Retry backoff for 429 / 5xx, in seconds.
_RETRY_BACKOFF = (2.0, 6.0, 15.0)
_RETRY_STATUS = frozenset({429, 500, 502, 503, 504})

# (phase, clip_index, clip_total) — phase: "clip" | "done"
ProgressFn = Callable[[str, int, int], Awaitable[None]]
# return True to abort (partial result is discarded by the caller)
AbortFn = Callable[[], Awaitable[bool]]


class ElevenLabsSTTError(RuntimeError):
    """Scribe request failed after retries, or returned an unusable body."""


# ── request ───────────────────────────────────────────────────────────────────


def raw_pcm_from_wav(wav_path: pathlib.Path) -> bytes | None:
    """Strip the WAV container and return raw little-endian PCM frames.

    Scribe's ``file_format="pcm_s16le_16"`` fast path means *headerless* 16-bit
    mono 16 kHz PCM — sending a .wav file under that flag would feed the 44-byte
    RIFF header in as audio. ``extract_speech_wav`` already produces exactly that
    encoding, so the header is all that stands in the way.

    Returns None when the file is not 16-bit/mono/16 kHz; the caller then falls
    back to uploading the container with ``file_format="other"``.
    """
    try:
        with wave.open(str(wav_path), "rb") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != 2 or wf.getframerate() != 16000:
                return None
            return wf.readframes(wf.getnframes())
    except (wave.Error, OSError):
        return None


def build_stt_fields(
    *,
    model_id: str,
    language: str,
    granularity: str,
    no_verbatim: bool,
    tag_audio_events: bool,
    diarize: bool,
    num_speakers: int | None,
    keyterms: list[str] | None,
    file_format: str,
    seed: int | None = None,
) -> dict[str, str]:
    """Multipart form fields for POST /v1/speech-to-text.

    Booleans and lists go over multipart as strings — httpx will not JSON-encode
    them for us, and the API rejects Python's ``True``/``['a']`` reprs.

    ``temperature`` is intentionally absent: omitted, Scribe applies the value
    tuned for the model (≈0), which is the right one for transcription.
    """
    fields: dict[str, str] = {
        "model_id": model_id,
        "timestamps_granularity": granularity,
        "file_format": file_format,
        "no_verbatim": "true" if no_verbatim else "false",
        "tag_audio_events": "true" if tag_audio_events else "false",
        "diarize": "true" if diarize else "false",
    }
    if language:
        fields["language_code"] = language
    if seed is not None:
        fields["seed"] = str(int(seed))
    if diarize and num_speakers:
        fields["num_speakers"] = str(int(num_speakers))
    if keyterms:
        # Max 1000 terms, 50 chars each (batch mode). Trim rather than 400.
        trimmed = [t.strip()[:50] for t in keyterms if t and t.strip()][:1000]
        if trimmed:
            fields["keyterms"] = json.dumps(trimmed, ensure_ascii=False)
    return fields


async def transcribe_clip(
    wav_path: pathlib.Path,
    keyterms: list[str] | None = None,
) -> dict[str, Any]:
    """POST one WAV to Scribe and return the parsed response body.

    ``keyterms`` biases the model towards project-specific product/brand names.
    They carry a per-request surcharge, so they are only sent when supplied.

    Raises ElevenLabsSTTError on a non-retryable failure or exhausted retries.
    """
    from packages.core.settings import get_settings

    s = get_settings()
    if not s.elevenlabs_api_key:
        raise ElevenLabsSTTError(
            "ELEVENLABS_API_KEY is not set — speech-to-text cannot run. "
            "Add it to .env (ElevenCreative → Settings → API Keys)."
        )

    pcm = raw_pcm_from_wav(wav_path) if s.elevenlabs_send_raw_pcm else None
    if pcm is not None:
        payload, file_format = pcm, "pcm_s16le_16"
    else:
        payload, file_format = wav_path.read_bytes(), "other"

    fields = build_stt_fields(
        model_id=s.elevenlabs_stt_model,
        language=s.elevenlabs_language,
        granularity=s.elevenlabs_timestamps_granularity,
        no_verbatim=s.elevenlabs_no_verbatim,
        tag_audio_events=s.elevenlabs_tag_audio_events,
        diarize=s.elevenlabs_diarize,
        num_speakers=s.elevenlabs_num_speakers,
        keyterms=keyterms,
        file_format=file_format,
        seed=s.elevenlabs_seed,
    )
    return await _post_stt(
        payload, fields, wav_path.name, timeout_sec=s.elevenlabs_stt_timeout_sec,
    )


async def _post_stt(
    payload: bytes,
    fields: dict[str, str],
    filename: str,
    *,
    timeout_sec: int,
) -> dict[str, Any]:
    import httpx

    from packages.core.settings import get_settings

    s = get_settings()
    size_mb = len(payload) / 1024 / 1024
    timeout = httpx.Timeout(
        connect=60.0,
        read=float(timeout_sec),
        write=max(300.0, size_mb * 4.0),
        pool=60.0,
    )
    headers = {"xi-api-key": s.elevenlabs_api_key or ""}
    files = {"file": (filename, payload, "application/octet-stream")}

    last_err: Exception | None = None
    async with httpx.AsyncClient(timeout=timeout) as client:
        for attempt in range(len(_RETRY_BACKOFF) + 1):
            try:
                resp = await client.post(STT_URL, headers=headers, data=fields, files=files)
                if resp.status_code == 200:
                    return resp.json()
                if resp.status_code in _RETRY_STATUS and attempt < len(_RETRY_BACKOFF):
                    log.warning(
                        "elevenlabs_stt_retry",
                        status=resp.status_code, attempt=attempt + 1, file=filename,
                    )
                    await asyncio.sleep(_RETRY_BACKOFF[attempt])
                    continue
                raise ElevenLabsSTTError(
                    f"Scribe returned {resp.status_code}: {resp.text[:500]}"
                )
            except (httpx.TransportError, httpx.TimeoutException) as exc:
                last_err = exc
                if attempt < len(_RETRY_BACKOFF):
                    log.warning(
                        "elevenlabs_stt_retry",
                        error=str(exc), attempt=attempt + 1, file=filename,
                    )
                    await asyncio.sleep(_RETRY_BACKOFF[attempt])
                    continue
                raise ElevenLabsSTTError(f"Scribe request failed: {exc}") from exc
    raise ElevenLabsSTTError(f"Scribe request failed: {last_err}")


# ── response → tokens ─────────────────────────────────────────────────────────


def _tighten_with_characters(tok: dict[str, Any]) -> tuple[float, float]:
    """Word bounds from its character timings when granularity="character".

    Scribe's word ``start``/``end`` already bound the word; the character list
    occasionally trims a hair tighter (leading breath, trailing decay). Falls
    back to the word's own bounds when characters are absent or unusable.
    """
    start, end = float(tok["start"]), float(tok["end"])
    chars = tok.get("characters") or []
    times = [
        (float(c["start"]), float(c["end"]))
        for c in chars
        if c.get("start") is not None and c.get("end") is not None
    ]
    if not times:
        return start, end
    c_start = min(t[0] for t in times)
    c_end = max(t[1] for t in times)
    if c_end <= c_start:
        return start, end
    return c_start, c_end


def dominant_speaker(tokens: list[dict[str, Any]]) -> str | None:
    """Speaker id holding the most speech time, or None when not diarized."""
    totals: dict[str, float] = {}
    for tok in tokens:
        sid = tok.get("speaker_id")
        if tok.get("type") != "word" or not sid:
            continue
        totals[sid] = totals.get(sid, 0.0) + max(0.0, float(tok["end"]) - float(tok["start"]))
    if not totals:
        return None
    return max(totals, key=lambda k: totals[k])


def extract_pieces(response: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Scribe response → (pieces, audio_events), timed and clip-local.

    A "piece" is one ``type="word"`` token exactly as Scribe returned it. On Thai
    that is a GRAPHEME CLUSTER, not a word — a real response splits "แต่งหน้ากันจ้ะ"
    into ``แ|ต่|ง|ห|น้|า|กั|น|จ้|ะ``. :func:`merge_pieces_to_words` puts them back
    together; nothing downstream should consume pieces directly.

    Nothing is filtered here — not even zero-length or low-confidence pieces —
    because dropping a single grapheme corrupts the word it belongs to. Filtering
    happens after the merge, at word granularity.
    """
    raw = response.get("words") or []
    pieces: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []

    for idx, tok in enumerate(raw):
        ttype = tok.get("type")
        if tok.get("start") is None or tok.get("end") is None:
            continue
        if ttype == "audio_event":
            events.append({
                "text": str(tok.get("text", "")).strip(),
                "start": round(float(tok["start"]), 3),
                "end": round(float(tok["end"]), 3),
            })
            continue
        if ttype != "word":
            continue
        text = str(tok.get("text", ""))
        if not text:
            continue
        start, end = _tighten_with_characters(tok)
        pieces.append({
            "idx": idx,
            "text": text,
            "start": round(start, 3),
            "end": round(max(end, start), 3),
            "logprob": tok.get("logprob"),
            "speaker_id": tok.get("speaker_id"),
        })

    events.sort(key=lambda e: e["start"])
    return pieces, events


def _tokenize_run(text: str) -> list[str]:
    """Split a Thai run into words, losslessly (``"".join(out) == text``).

    pythainlp's newmm dictionary tokenizer is already a project dependency and is
    what makes Scribe's grapheme stream usable: it is the only thing here that
    knows "แต่งหน้ากันจ้ะ" is four words. Latin text passes through unharmed.
    """
    from pythainlp.tokenize import word_tokenize

    parts = [p for p in word_tokenize(text, engine="newmm") if p]
    if "".join(parts) != text:  # tokenizer dropped or altered something — trust the source
        log.warning("elevenlabs_tokenize_lossy", text=text)
        return [text]
    return parts


def merge_pieces_to_words(
    pieces: list[dict[str, Any]],
    *,
    min_logprob: float,
    keep_speaker: str | None = None,
) -> list[dict[str, Any]]:
    """Grapheme pieces → real words with timings, then filter at word level.

    Pieces are grouped into runs of consecutive raw tokens (a ``spacing`` or
    ``audio_event`` token between them ends a run), each run is word-segmented,
    and each word takes its first piece's start and its last piece's end.

    A word is dropped when it has no duration (Scribe emits zero-length pieces
    over noise), when its weakest piece falls below ``min_logprob``, or when it
    belongs to a speaker other than ``keep_speaker``. Doing this after the merge
    is the point: filtering pieces would delete a grapheme out of the middle of
    an otherwise good word.
    """
    if not pieces:
        return []

    runs: list[list[dict[str, Any]]] = [[pieces[0]]]
    for piece in pieces[1:]:
        if piece["idx"] == runs[-1][-1]["idx"] + 1:
            runs[-1].append(piece)
        else:
            runs.append([piece])

    words: list[dict[str, Any]] = []
    for run in runs:
        cursor = 0
        for token in _tokenize_run("".join(p["text"] for p in run)):
            span: list[dict[str, Any]] = []
            consumed = 0
            while cursor < len(run) and consumed < len(token):
                span.append(run[cursor])
                consumed += len(run[cursor]["text"])
                cursor += 1
            if not span:
                continue
            logprobs = [float(p["logprob"]) for p in span if p["logprob"] is not None]
            words.append({
                "idx": span[0]["idx"],
                "idx_end": span[-1]["idx"],
                "word": token,
                "start": span[0]["start"],
                "end": span[-1]["end"],
                "logprob": min(logprobs) if logprobs else None,
                "speaker_id": span[0]["speaker_id"],
            })

    kept: list[dict[str, Any]] = []
    for w in words:
        if w["end"] <= w["start"]:
            continue
        if w["logprob"] is not None and w["logprob"] < min_logprob:
            log.debug("elevenlabs_low_confidence_word", word=w["word"], logprob=w["logprob"])
            continue
        if keep_speaker is not None and w["speaker_id"] not in (None, keep_speaker):
            continue
        if w["end"] - w["start"] > MAX_WORD_SEC:
            log.debug("elevenlabs_overlong_word_clamped",
                      word=w["word"], span=round(w["end"] - w["start"], 2))
            w["end"] = round(w["start"] + MAX_WORD_SEC, 3)
        kept.append(w)

    kept.sort(key=lambda w: w["start"])
    return kept


def extract_tokens(
    response: dict[str, Any],
    *,
    min_logprob: float,
    keep_speaker: str | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Scribe response → (words, audio_events) — pieces extracted then merged."""
    pieces, events = extract_pieces(response)
    words = merge_pieces_to_words(pieces, min_logprob=min_logprob, keep_speaker=keep_speaker)
    return words, events


# ── tokens → segments ─────────────────────────────────────────────────────────


def _segment_text(raw: list[dict[str, Any]], group: list[dict[str, Any]]) -> str:
    """Rebuild a segment's text from its words plus the spacing between them.

    Spacing has to come from the raw token list, not from the words: Scribe emits
    ``spacing`` tokens in Thai too (at real pauses and at the boundaries of Latin
    words inside Thai speech), and dropping them would run sentences together.
    """
    covered = {i for w in group for i in range(w["idx"], w["idx_end"] + 1)}
    parts: list[str] = []
    previous_end = group[0]["idx"]
    for w in group:
        for i in range(previous_end + 1, w["idx"]):
            if i < len(raw) and raw[i].get("type") == "spacing" and i not in covered:
                parts.append(str(raw[i].get("text", "")))
        parts.append(w["word"])
        previous_end = w["idx_end"]
    # A dropped word leaves the spacing on both of its sides behind; collapse the
    # run so the text reads as if the word had never been transcribed.
    return re.sub(r"[ \t]{2,}", " ", "".join(parts)).strip()


def build_segments(
    words: list[dict[str, Any]],
    raw_tokens: list[dict[str, Any]],
    *,
    split_gap: float = SEGMENT_SPLIT_GAP,
) -> list[dict[str, Any]]:
    """Group words into segments, splitting wherever they fall ``split_gap`` apart.

    A segment is the unit captions and planning consume. It carries the same
    shape the Whisper path produced, so ``plan_core`` / ``caption`` need no
    changes: ``{start, end, text, words: [{word, start, end}]}``.
    """
    if not words:
        return []

    groups: list[list[dict[str, Any]]] = [[words[0]]]
    for w in words[1:]:
        if w["start"] - groups[-1][-1]["end"] > split_gap:
            groups.append([w])
        else:
            groups[-1].append(w)

    segments: list[dict[str, Any]] = []
    for group in groups:
        text = _segment_text(raw_tokens, group)
        if not text:
            continue
        segments.append({
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": text,
            "words": [{"word": w["word"], "start": w["start"], "end": w["end"]} for w in group],
        })
    return segments


def build_silence_gaps(
    segments: list[dict[str, Any]],
    audio_events: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Silent spans worth KEEPING in the cut — deliberately always none.

    Everything Scribe tags as an ``audio_event`` (the bracketed entries in the
    transcript: ``[เสียงเพลง]``, ``[เสียงโฆษณาจากโทรทัศน์]``, ``[เสียงวางแปรง]``)
    is non-speech, and for a talking-head TikTok cut non-speech is noise. So no
    silence survives on its own: if there is no word in it, it goes.

    This deliberately replaces two earlier designs, in order:

    1. Gemini watched the clip and kept the silent beats it judged visually
       important. Removed with the rest of the Whisper-era stack.
    2. An event was kept when it looked like a "moment" rather than ambience,
       decided by tag length plus a keyword list. Real footage killed it: the
       list needed music, then a television in the next room, then a radio —
       an open-ended guessing game against a localised, free-form label.

    The signature keeps ``audio_events`` so callers do not change and the
    intent stays legible at the call site. Breathing room around each cut comes
    from the padding constants in ``timeline.py``, not from kept silence; a beat
    that genuinely needs to stay is added by hand in the timeline editor.
    """
    return []


def offset_items(items: list[dict[str, Any]], offset: float, keys: tuple[str, ...]) -> list[dict[str, Any]]:
    """Shift the named time keys by ``offset`` (clip-local → project-absolute)."""
    out: list[dict[str, Any]] = []
    for item in items:
        shifted = dict(item)
        for key in keys:
            if key in shifted:
                shifted[key] = round(float(shifted[key]) + offset, 3)
        if "words" in shifted:
            shifted["words"] = [
                {"word": w["word"],
                 "start": round(float(w["start"]) + offset, 3),
                 "end": round(float(w["end"]) + offset, 3)}
                for w in shifted["words"]
            ]
        out.append(shifted)
    return out


# ── orchestration ─────────────────────────────────────────────────────────────


async def run_transcription(
    audio_files: list[pathlib.Path],
    *,
    keyterms: list[str] | None = None,
    project_uid: str = "",
    on_progress: ProgressFn | None = None,
    should_abort: AbortFn | None = None,
) -> dict[str, Any] | None:
    """Transcribe every clip WAV with Scribe and assemble the project transcript.

    Returns the transcript dict documented at module level, or None when
    ``should_abort`` fired (the caller discards the partial result).

    Clips run sequentially: it keeps progress reporting and abort honest, and
    Scribe is fast enough on the batch endpoint that the wall-clock saved by
    fanning out is not worth losing a responsive stop button.
    """
    from packages.core.settings import get_settings
    from packages.video.ffmpeg_bin import media_duration

    s = get_settings()

    async def _progress(phase: str, idx: int, total: int) -> None:
        if on_progress:
            await on_progress(phase, idx, total)

    all_segments: list[dict[str, Any]] = []
    all_events: list[dict[str, Any]] = []
    script_parts: list[str] = []
    offset = 0.0
    # Scribe is billed per audio minute and its reply carries no cost or credit
    # field, so `audio_duration_secs` is the billable quantity for this run.
    # Taken from the reply rather than measured off the WAVs, because it is
    # what the service says it processed.
    billed_audio_sec = 0.0

    for idx, wav in enumerate(audio_files):
        if should_abort and await should_abort():
            return None
        await _progress("clip", idx, len(audio_files))

        response = await transcribe_clip(wav, keyterms)
        clip_billed = response.get("audio_duration_secs")
        if isinstance(clip_billed, (int, float)):
            billed_audio_sec += float(clip_billed)
        raw_tokens = response.get("words") or []
        keep_speaker = dominant_speaker(raw_tokens) if s.elevenlabs_diarize else None
        words, events = extract_tokens(
            response,
            min_logprob=s.elevenlabs_min_word_logprob,
            keep_speaker=keep_speaker,
        )
        segments = build_segments(words, raw_tokens)

        all_segments.extend(offset_items(segments, offset, ("start", "end")))
        all_events.extend(offset_items(events, offset, ("start", "end")))
        # Built from the segments, NOT from response["text"]: the raw field
        # inlines every audio-event tag ("[เสียงดนตรี]แต่งหน้ากัน…") and keeps
        # the words this module dropped, so it would not match the speech that
        # actually survives into the cut.
        script_parts.extend(seg["text"] for seg in segments if seg["text"])

        log.info(
            "elevenlabs_clip_done",
            project_uid=project_uid, clip=idx, words=len(words),
            segments=len(segments), events=len(events),
            billed_audio_sec=clip_billed,
        )
        offset += media_duration(wav)

    if should_abort and await should_abort():
        return None

    silence_gaps = build_silence_gaps(all_segments, all_events)
    await _progress("done", len(audio_files), len(audio_files))
    log.info(
        "elevenlabs_transcription_done",
        project_uid=project_uid, clips=len(audio_files),
        segments=len(all_segments), silence_gaps=len(silence_gaps),
        billed_audio_sec=round(billed_audio_sec, 2),
    )
    return {
        "segments": all_segments,
        "silence_gaps": silence_gaps,
        "audio_events": all_events,
        "text": "\n".join(script_parts),
        # What this run cost, in the unit ElevenLabs charges on. The rate
        # depends on the model (scribe_v2_5 is ~12.5x scribe_v2 per second),
        # so the model travels with it — see packages/video/stt_pricing.py.
        "billed_audio_sec": round(billed_audio_sec, 2),
        "stt_model": s.elevenlabs_stt_model,
    }
