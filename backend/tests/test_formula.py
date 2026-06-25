"""Unit tests for the formula compiler (packages/tables/formula.py)."""

import pytest

from packages.tables.formula import compile_formula

_COLS = [
    {"key": "col_1", "ui_type": "number"},
    {"key": "col_2", "ui_type": "number"},
    {"key": "col_3", "ui_type": "date"},
    {"key": "col_4", "ui_type": "number"},
]


def test_legacy_date_add():
    expr, pg = compile_formula({"type": "date_add", "col_a": "col_3", "col_b": "col_1"}, _COLS)
    assert pg == "DATE"
    assert "col_3" in expr and "col_1" in expr


def test_legacy_date_diff():
    expr, pg = compile_formula({"type": "date_diff", "col_a": "col_3", "col_b": "col_3"}, _COLS)
    assert pg == "INTEGER"


def test_math_add():
    expr, pg = compile_formula({"kind": "math", "op": "+", "operands": ["col_1", "col_2"]}, _COLS)
    assert pg == "NUMERIC"
    assert '"col_1" + "col_2"' in expr


def test_math_multi_operands():
    expr, pg = compile_formula({"kind": "math", "op": "+", "operands": ["col_1", "col_2", "col_4"]}, _COLS)
    assert '"col_4"' in expr


def test_math_with_literal():
    expr, pg = compile_formula({"kind": "math", "op": "*", "operands": ["col_1", "lit:2"]}, _COLS)
    assert "2" in expr and pg == "NUMERIC"


def test_math_mod():
    expr, pg = compile_formula({"kind": "math", "op": "MOD", "operands": ["col_1", "col_2"]}, _COLS)
    assert "%" in expr


def test_aggregate_sum():
    expr, pg = compile_formula({"kind": "aggregate", "op": "SUM", "operands": ["col_1", "col_2"]}, _COLS)
    assert "COALESCE" in expr and pg == "NUMERIC"


def test_aggregate_avg():
    expr, pg = compile_formula({"kind": "aggregate", "op": "AVG", "operands": ["col_1", "col_2"]}, _COLS)
    assert "2.0" in expr


def test_aggregate_count():
    expr, pg = compile_formula({"kind": "aggregate", "op": "COUNT", "operands": ["col_1", "col_2"]}, _COLS)
    assert "CASE WHEN" in expr and pg == "INTEGER"


def test_aggregate_max():
    expr, pg = compile_formula({"kind": "aggregate", "op": "MAX", "operands": ["col_1", "col_2"]}, _COLS)
    assert "GREATEST" in expr


def test_percentage_pct():
    expr, pg = compile_formula({"kind": "percentage", "op": "pct", "operands": ["col_1", "col_2"]}, _COLS)
    assert "NULLIF" in expr and "100" in expr


def test_percentage_growth():
    expr, pg = compile_formula({"kind": "percentage", "op": "growth", "operands": ["col_1", "col_2"]}, _COLS)
    assert "NULLIF" in expr


def test_date_diff():
    expr, pg = compile_formula({"kind": "date", "op": "date_diff", "operands": ["col_3", "col_3"]}, _COLS)
    assert pg == "INTEGER"


def test_date_add_days():
    expr, pg = compile_formula({"kind": "date", "op": "date_add_days", "operands": ["col_3", "col_1"]}, _COLS)
    assert pg == "DATE" and "days" in expr


def test_date_add_months():
    expr, pg = compile_formula({"kind": "date", "op": "date_add_months", "operands": ["col_3", "col_1"]}, _COLS)
    assert "months" in expr


def test_date_add_years():
    expr, pg = compile_formula({"kind": "date", "op": "date_add_years", "operands": ["col_3", "col_1"]}, _COLS)
    assert "years" in expr


def test_invalid_col_key_rejected():
    with pytest.raises(ValueError, match="does not exist"):
        compile_formula({"kind": "math", "op": "+", "operands": ["col_1", "col_99"]}, _COLS)


def test_unsafe_literal_rejected():
    with pytest.raises(ValueError, match="numeric"):
        compile_formula({"kind": "math", "op": "+", "operands": ["col_1", "lit:DROP TABLE"]}, _COLS)


def test_missing_kind_raises():
    with pytest.raises(ValueError):
        compile_formula({"operands": ["col_1", "col_2"]}, _COLS)
