"""SFX asset catalog and rule-based placement engine."""

from __future__ import annotations

import pathlib

from packages.video.storage import data_root

SFX_CATALOG: dict[str, dict] = {
    "pop":    {"file": "pop.wav",    "duration": 0.12, "category": "transition"},
    "whoosh": {"file": "whoosh.wav", "duration": 0.45, "category": "transition"},
    "ding":   {"file": "ding.wav",   "duration": 0.60, "category": "accent"},
    "click":  {"file": "click.wav",  "duration": 0.05, "category": "accent"},
    "punch":  {"file": "punch.wav",  "duration": 0.20, "category": "impact"},
}


def sfx_path(name: str) -> pathlib.Path:
    """Absolute path to a SFX WAV file. Raises ValueError for unknown names."""
    if name not in SFX_CATALOG:
        raise ValueError(f"Unknown SFX '{name}'. Available: {sorted(SFX_CATALOG)}")
    return data_root() / "sfx" / SFX_CATALOG[name]["file"]


def sfx_suggestions_for_cuts(
    cuts: list[dict],
    output_duration: float,  # noqa: ARG001 — reserved for future budget logic
) -> list[dict]:
    """Rule-based SFX placement — no LLM call.

    Returns list of {"name": str, "at": float, "volume": float}
    where "at" is position on the *output* timeline (0-based, seconds after concat).

    Rules:
    - Opening cut (first)  → ding  at 0.0
    - Internal boundaries  → alternating whoosh / pop
    - Conclusion cut (last)→ pop   at its output-start time
    - Single cut           → ding  at 0.0
    - Empty cuts           → []
    """
    if not cuts:
        return []

    result: list[dict] = []
    out_pos = 0.0  # accumulates output timeline position

    for i, cut in enumerate(cuts):
        cut_dur = float(cut["out"]) - float(cut["in"])
        is_first = i == 0
        is_last = i == len(cuts) - 1

        if is_first:
            result.append({"name": "ding", "at": round(out_pos, 3), "volume": 0.5})
        elif is_last:
            result.append({"name": "pop", "at": round(out_pos, 3), "volume": 0.5})
        else:
            # internal transition — alternate whoosh / pop (0-indexed count of internal cuts)
            internal_idx = i - 1
            name = "whoosh" if internal_idx % 2 == 0 else "pop"
            result.append({"name": name, "at": round(out_pos, 3), "volume": 0.45})

        out_pos += cut_dur

    return result
