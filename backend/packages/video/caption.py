"""ASS karaoke caption builder for TikTok-style word-level captions."""

from __future__ import annotations

_STYLE_DEFAULT: dict = {
    "fontname": "Arial",
    "fontsize": 52,
    "primary": "&H0000FFFF",    # yellow — highlighted (spoken)
    "secondary": "&H00FFFFFF",  # white — pending (not yet spoken)
    "outline": "&H00000000",    # black
    "back": "&H80000000",       # semi-transparent black shadow
    "bold": -1,
    "outline_px": 2.5,
    "alignment": 2,             # bottom-center
    "margin_v": 100,
    "words_per_line": 3,
}

_PLAY_RES_X = 1080
_PLAY_RES_Y = 1920


def _ass_time(seconds: float) -> str:
    """Format seconds as ASS H:MM:SS.cc"""
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _ass_header(s: dict) -> str:
    return (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        f"PlayResX: {_PLAY_RES_X}\n"
        f"PlayResY: {_PLAY_RES_Y}\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{s['fontname']},{s['fontsize']},"
        f"{s['primary']},{s['secondary']},{s['outline']},{s['back']},"
        f"{s['bold']},0,0,0,100,100,0,0,1,{s['outline_px']},0,"
        f"{s['alignment']},20,20,{s['margin_v']},1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def remap_words_to_output(
    words: list[dict],
    cuts: list[dict],
    clip_abs_offsets: dict[str, float],
) -> list[dict]:
    """Map source-timeline word timestamps to output-video timeline.

    words: [{word, start, end}] — absolute timestamps in concatenated source audio
    cuts: [{source: "clipN", in: float, out: float}]
    clip_abs_offsets: {"clip0": 0.0, "clip1": 30.5} — where each clip starts in abs time

    Returns [{word, start, end}] in output timeline (0-based seconds).
    """
    result: list[dict] = []
    output_offset = 0.0

    for cut in cuts:
        clip_id = cut.get("source", "clip0")
        abs_base = clip_abs_offsets.get(clip_id, 0.0)
        cut_in = float(cut["in"])
        cut_out = float(cut["out"])
        cut_dur = cut_out - cut_in
        if cut_dur <= 0:
            continue

        abs_in = abs_base + cut_in
        abs_out = abs_base + cut_out

        for w in words:
            w_start = float(w["start"])
            w_end = float(w["end"])
            if w_end <= abs_in or w_start >= abs_out:
                continue
            cs = max(w_start, abs_in)
            ce = min(w_end, abs_out)
            result.append({
                "word": w["word"],
                "start": round(output_offset + (cs - abs_in), 3),
                "end": round(output_offset + (ce - abs_in), 3),
            })

        output_offset += cut_dur

    return result


def build_ass_karaoke(
    remapped_words: list[dict],
    output_duration: float = 0.0,  # noqa: ARG001 — reserved for future use
    style: dict | None = None,
) -> str:
    """Build ASS file content with \\kf karaoke timing.

    remapped_words: [{word, start, end}] in output timeline.
    Returns full ASS file as string.
    """
    s = {**_STYLE_DEFAULT, **(style or {})}
    header = _ass_header(s)

    if not remapped_words:
        return header

    wpl = int(s.get("words_per_line", 3))
    groups = [remapped_words[i : i + wpl] for i in range(0, len(remapped_words), wpl)]

    dialogue_lines: list[str] = []
    for group in groups:
        start = group[0]["start"]
        end = group[-1]["end"]
        if end <= start:
            continue

        text = ""
        for w in group:
            dur_cs = max(1, round((w["end"] - w["start"]) * 100))
            text += f"{{\\kf{dur_cs}}}{w['word'].strip()} "
        text = text.rstrip()

        dialogue_lines.append(
            f"Dialogue: 0,{_ass_time(start)},{_ass_time(end)},Default,,0,0,0,,{text}"
        )

    return header + "\n".join(dialogue_lines) + "\n"
