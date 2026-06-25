"""Formula compiler: validates spec → safe SQL expression for GENERATED columns.

A formula spec (stored as JSONB) maps to a PostgreSQL expression used in:
  ALTER TABLE "udt_xxx" ADD COLUMN "col_N" <type> GENERATED ALWAYS AS (<expr>) STORED

All column key references are validated against the table's existing columns before
any SQL is generated. Literals are whitelisted to numeric values only.

Supported formula kinds
-----------------------
math        : +, -, *, /, MOD — over 2+ numeric columns/literals
aggregate   : SUM/AVG/MIN/MAX/COUNT — over 2+ numeric columns
percentage  : pct (a/b*100), growth ((new-old)/NULLIF(old,0)*100) — 2 numeric cols
date        : date_diff (date-date→int), date_add_days/months/years (date+number→date)
legacy      : date_add / date_diff via old FormulaDef.type field
"""

from __future__ import annotations

import re
from typing import Any

_KEY_RE = re.compile(r"^col_\d+$")
_NUM_RE = re.compile(r"^-?\d+(\.\d+)?$")

# Allowed PostgreSQL result types per kind/op
_RESULT_TYPES: dict[str, str] = {
    "math": "NUMERIC",
    "aggregate": "NUMERIC",
    "percentage": "NUMERIC",
    "date_diff": "INTEGER",
    "date_add_days": "DATE",
    "date_add_months": "DATE",
    "date_add_years": "DATE",
    # legacy
    "date_add": "DATE",
}


def _validate_key(key: str, existing_keys: set[str]) -> str:
    if not _KEY_RE.match(key):
        raise ValueError(f"unsafe column key: {key!r}")
    if key not in existing_keys:
        raise ValueError(f"column {key!r} does not exist")
    return key


def _safe_operand(operand: str, existing_keys: set[str]) -> str:
    """Return a safe SQL token for an operand (col key or literal number)."""
    if operand.startswith("lit:"):
        lit = operand[4:]
        if not _NUM_RE.match(lit):
            raise ValueError(f"literal must be numeric: {lit!r}")
        return lit
    _validate_key(operand, existing_keys)
    return f'"{operand}"'


def compile_formula(
    formula: dict[str, Any],
    col_meta_list: list[dict[str, Any]],
) -> tuple[str, str]:
    """Return (sql_expression, pg_result_type) or raise ValueError on invalid spec.

    ``formula`` is the raw dict from JSONB.  ``col_meta_list`` is the list of existing
    column metadata dicts (with 'key' and 'ui_type').
    """
    existing: dict[str, dict] = {c["key"]: c for c in col_meta_list}
    existing_keys = set(existing)

    # ── legacy Phase-1 format ─────────────────────────────────────────────────
    if formula.get("type") in ("date_add", "date_diff"):
        t = formula["type"]
        a = _validate_key(formula["col_a"], existing_keys)
        b = _validate_key(formula["col_b"], existing_keys)
        if t == "date_add":
            return f'"{a}" + ("{b}")::integer', "DATE"
        else:
            return f'"{a}" - "{b}"', "INTEGER"

    # ── Phase-3 expanded format ───────────────────────────────────────────────
    kind = formula.get("kind")
    op = formula.get("op")
    operands: list[str] = formula.get("operands", [])

    if not kind:
        raise ValueError("formula must have 'type' (legacy) or 'kind' (new)")
    if not op:
        raise ValueError("formula must have 'op'")
    if len(operands) < 2:
        raise ValueError("formula needs at least 2 operands")

    if kind == "math":
        allowed_ops = {"+", "-", "*", "/", "MOD"}
        if op not in allowed_ops:
            raise ValueError(f"math op must be one of {allowed_ops}")
        parts = [_safe_operand(o, existing_keys) for o in operands]
        if op == "MOD":
            if len(parts) != 2:
                raise ValueError("MOD needs exactly 2 operands")
            expr = f"({parts[0]} % {parts[1]})"
        else:
            expr = f"({f' {op} '.join(parts)})"
        return expr, "NUMERIC"

    if kind == "aggregate":
        allowed_ops = {"SUM", "AVG", "MIN", "MAX", "COUNT"}
        if op not in allowed_ops:
            raise ValueError(f"aggregate op must be one of {allowed_ops}")
        col_refs = [_safe_operand(o, existing_keys) for o in operands]
        if op == "COUNT":
            # COUNT of non-null values across columns
            nullif_checks = " + ".join(f"CASE WHEN {r} IS NOT NULL THEN 1 ELSE 0 END" for r in col_refs)
            return f"({nullif_checks})", "INTEGER"
        if op == "SUM":
            coalesced = " + ".join(f"COALESCE({r}, 0)" for r in col_refs)
            return f"({coalesced})", "NUMERIC"
        if op == "AVG":
            n = len(col_refs)
            coalesced = " + ".join(f"COALESCE({r}, 0)" for r in col_refs)
            return f"(({coalesced}) / {n}.0)", "NUMERIC"
        if op == "MAX":
            return f"GREATEST({', '.join(col_refs)})", "NUMERIC"
        if op == "MIN":
            return f"LEAST({', '.join(col_refs)})", "NUMERIC"

    if kind == "percentage":
        if len(operands) != 2:
            raise ValueError(f"{op} needs exactly 2 operands")
        a = _safe_operand(operands[0], existing_keys)
        b = _safe_operand(operands[1], existing_keys)
        if op == "pct":
            return f"({a} / NULLIF({b}, 0) * 100)", "NUMERIC"
        if op == "growth":
            return f"(({a} - {b}) / NULLIF({b}, 0) * 100)", "NUMERIC"
        raise ValueError("percentage op must be 'pct' or 'growth'")

    if kind == "date":
        if op == "date_diff":
            if len(operands) != 2:
                raise ValueError("date_diff needs exactly 2 operands")
            a = _validate_key(operands[0], existing_keys)
            b = _validate_key(operands[1], existing_keys)
            return f'("{a}" - "{b}")', "INTEGER"
        if op in ("date_add_days", "date_add_months", "date_add_years"):
            if len(operands) != 2:
                raise ValueError(f"{op} needs exactly 2 operands")
            date_col = _validate_key(operands[0], existing_keys)
            n_col = _safe_operand(operands[1], existing_keys)
            unit = {"date_add_days": "days", "date_add_months": "months", "date_add_years": "years"}[op]
            # Cast n to integer interval
            return f'("{date_col}" + (({n_col})::integer || \' {unit}\')::interval)::date', "DATE"
        raise ValueError("date op must be date_diff/date_add_days/date_add_months/date_add_years")

    raise ValueError(f"unknown formula kind: {kind!r}")
