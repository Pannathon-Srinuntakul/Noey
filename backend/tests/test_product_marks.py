"""Unit tests for Tier 3c product marks → popup conversion."""

from services.worker.tasks import _marks_to_popups


def _cut(source: str, in_: float, out_: float, label: str = "speech") -> dict:
    return {"type": "cut", "source": source, "in": in_, "out": out_, "label": label}


def test_empty_marks_returns_empty():
    cuts = [_cut("clip0", 0.0, 5.0)]
    assert _marks_to_popups([], cuts) == []


def test_single_mark_inside_cut():
    cuts = [_cut("clip0", 0.0, 10.0)]
    marks = [{"sourceClip": "clip0", "at": 5.0, "productName": "ครีม", "price": ""}]
    popups = _marks_to_popups(marks, cuts)
    assert len(popups) == 1
    assert popups[0]["template"] == "product_name"
    assert popups[0]["start"] == 5.0
    assert popups[0]["data"]["name"] == "ครีม"


def test_mark_with_price_adds_two_popups():
    cuts = [_cut("clip0", 0.0, 10.0)]
    marks = [{"sourceClip": "clip0", "at": 3.0, "productName": "เซรั่ม", "price": "299"}]
    popups = _marks_to_popups(marks, cuts)
    assert len(popups) == 2
    templates = {p["template"] for p in popups}
    assert "product_name" in templates
    assert "price" in templates


def test_mark_outside_all_cuts_skipped():
    cuts = [_cut("clip0", 0.0, 5.0)]
    marks = [{"sourceClip": "clip0", "at": 8.0, "productName": "x", "price": ""}]
    assert _marks_to_popups(marks, cuts) == []


def test_mark_wrong_clip_skipped():
    cuts = [_cut("clip0", 0.0, 5.0)]
    marks = [{"sourceClip": "clip1", "at": 3.0, "productName": "x", "price": ""}]
    assert _marks_to_popups(marks, cuts) == []


def test_output_time_accounts_for_previous_cuts():
    cuts = [_cut("clip0", 0.0, 4.0), _cut("clip0", 10.0, 20.0)]
    marks = [{"sourceClip": "clip0", "at": 12.0, "productName": "y", "price": ""}]
    popups = _marks_to_popups(marks, cuts)
    assert len(popups) == 1
    # First cut is 4 s long, mark is 2 s into second cut → output_t = 4 + (12-10) = 6
    assert abs(popups[0]["start"] - 6.0) < 0.01


def test_multiple_marks():
    cuts = [_cut("clip0", 0.0, 5.0), _cut("clip0", 10.0, 15.0)]
    marks = [
        {"sourceClip": "clip0", "at": 2.0, "productName": "A", "price": ""},
        {"sourceClip": "clip0", "at": 12.0, "productName": "B", "price": ""},
    ]
    popups = _marks_to_popups(marks, cuts)
    assert len(popups) == 2
    assert popups[0]["data"]["name"] == "A"
    assert popups[1]["data"]["name"] == "B"
