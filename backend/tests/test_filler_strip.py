"""Unit tests for hesitation/filler block removal (talking_head smartness)."""

from packages.video.timeline import _is_filler_only, strip_filler_cuts, strip_filler_words_from_cuts


def _seg(start, end, text, words=None):
    return {"start": start, "end": end, "text": text, "words": words or []}


def _word(w, s, e):
    return {"word": w, "start": s, "end": e}


def _cut(source, in_, out_, label="speech"):
    return {"type": "cut", "source": source, "in": in_, "out": out_, "label": label}


# ── _is_filler_only ────────────────────────────────────────────────────────────

def test_filler_only_thai():
    assert _is_filler_only("เอ่อ") is True
    assert _is_filler_only("เอ่อ อืม") is True


def test_filler_only_english():
    assert _is_filler_only("um") is True
    assert _is_filler_only("uh um") is True


def test_filler_with_repetition_mark():
    assert _is_filler_only("เอ่อๆ") is True


def test_real_speech_not_filler():
    assert _is_filler_only("สวัสดีครับ") is False
    assert _is_filler_only("um actually the product") is False


def test_empty_not_filler():
    assert _is_filler_only("") is False
    assert _is_filler_only("   ") is False


def test_filler_with_punctuation():
    assert _is_filler_only("um...") is True
    assert _is_filler_only("เอ่อ,") is True


# ── strip_filler_cuts ──────────────────────────────────────────────────────────

def test_strip_removes_pure_filler_block():
    segments = [
        _seg(0.0, 2.0, "สวัสดีครับ", [_word("สวัสดีครับ", 0.0, 2.0)]),
        _seg(2.5, 3.0, "เอ่อ", [_word("เอ่อ", 2.5, 3.0)]),
        _seg(3.5, 6.0, "วันนี้มารีวิว", [_word("วันนี้มารีวิว", 3.5, 6.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 2.0), _cut("clip0", 2.5, 3.0), _cut("clip0", 3.5, 6.0)]
    kept = strip_filler_cuts(cuts, segments)
    assert len(kept) == 2
    assert all(c["in"] != 2.5 for c in kept)


def test_strip_keeps_speech_containing_filler():
    segments = [
        _seg(0.0, 3.0, "um the product is great",
             [_word("um", 0.0, 0.3), _word("the", 0.3, 0.6),
              _word("product", 0.6, 1.5), _word("is", 1.5, 1.8),
              _word("great", 1.8, 3.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 3.0)]
    kept = strip_filler_cuts(cuts, segments)
    assert len(kept) == 1


def test_strip_relabels_opening_conclusion():
    segments = [
        _seg(0.0, 0.5, "เอ่อ", [_word("เอ่อ", 0.0, 0.5)]),
        _seg(1.0, 3.0, "เริ่มเลย", [_word("เริ่มเลย", 1.0, 3.0)]),
        _seg(3.5, 6.0, "จบแล้ว", [_word("จบแล้ว", 3.5, 6.0)]),
    ]
    cuts = [
        _cut("clip0", 0.0, 0.5, "opening"),
        _cut("clip0", 1.0, 3.0, "speech"),
        _cut("clip0", 3.5, 6.0, "conclusion"),
    ]
    kept = strip_filler_cuts(cuts, segments)
    assert len(kept) == 2
    assert kept[0]["label"] == "opening"
    assert kept[-1]["label"] == "conclusion"


def test_strip_all_filler_keeps_originals():
    segments = [
        _seg(0.0, 0.5, "เอ่อ", [_word("เอ่อ", 0.0, 0.5)]),
        _seg(1.0, 1.5, "อืม", [_word("อืม", 1.0, 1.5)]),
    ]
    cuts = [_cut("clip0", 0.0, 0.5), _cut("clip0", 1.0, 1.5)]
    kept = strip_filler_cuts(cuts, segments)
    # Fallback: never empty the whole edit
    assert len(kept) == 2


def test_strip_empty_input():
    assert strip_filler_cuts([], []) == []


# ── strip_filler_words_from_cuts ───────────────────────────────────────────────

def test_strip_words_removes_inline_filler():
    segments = [
        _seg(0.0, 3.0, "เออ ทำ คอนเทนต์",
             [_word("เออ", 0.0, 0.4), _word("ทำ", 0.5, 1.0),
              _word("คอนเทนต์", 1.0, 3.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 3.0)]
    kept = strip_filler_words_from_cuts(cuts, segments)
    assert len(kept) == 1
    assert kept[0]["in"] >= 0.4
    assert kept[0]["out"] <= 3.0


def test_strip_words_splits_around_middle_filler():
    segments = [
        _seg(0.0, 5.0, "วันนี้ เอ่อ มารีวิว",
             [_word("วันนี้", 0.0, 1.0), _word("เอ่อ", 1.2, 1.6),
              _word("มารีวิว", 2.0, 5.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 5.0)]
    kept = strip_filler_words_from_cuts(cuts, segments)
    assert len(kept) == 2
    assert kept[0]["out"] <= 1.1
    assert kept[1]["in"] >= 1.9


def test_strip_words_removes_pure_filler_cut():
    segments = [
        _seg(0.0, 0.5, "อืม", [_word("อืม", 0.0, 0.5)]),
        _seg(1.0, 3.0, "เริ่มเลย", [_word("เริ่มเลย", 1.0, 3.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 0.5), _cut("clip0", 1.0, 3.0)]
    kept = strip_filler_words_from_cuts(cuts, segments)
    assert len(kept) == 1
    assert kept[0]["in"] == 1.0


def test_strip_words_thai_um_in_sentence():
    segments = [
        _seg(0.0, 3.0, "um the product is great",
             [_word("um", 0.0, 0.3), _word("the", 0.3, 0.6),
              _word("product", 0.6, 1.5), _word("is", 1.5, 1.8),
              _word("great", 1.8, 3.0)]),
    ]
    cuts = [_cut("clip0", 0.0, 3.0)]
    kept = strip_filler_words_from_cuts(cuts, segments)
    assert len(kept) == 1
    assert kept[0]["in"] >= 0.25
