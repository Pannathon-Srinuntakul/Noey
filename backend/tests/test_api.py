"""API tests. REST endpoints hit the live Postgres; chat mocks the LLM gateway."""

import json
import types

import pytest
from httpx import ASGITransport, AsyncClient

import services.api.chat_service as chat_service
from services.api.main import app


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.asyncio
async def test_health():
    async with _client() as c:
        r = await c.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


@pytest.mark.asyncio
async def test_overview_shape_and_nonnegative():
    # Robust regardless of DB contents: correct shape, non-negative totals.
    async with _client() as c:
        r = await c.get("/metrics/overview")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"gmv", "commission", "units"}
    assert int(body["units"]) >= 0
    assert float(body["gmv"]) >= 0


@pytest.mark.asyncio
async def test_prompt_cron_crud():
    async with _client() as c:
        created = (
            await c.post(
                "/prompts",
                json={"name": "daily", "prompt": "summarize sales", "schedule": "daily:07:00"},
            )
        )
        assert created.status_code == 201
        pid = created.json()["id"]

        listed = await c.get("/prompts")
        assert any(p["id"] == pid for p in listed.json())

        upd = await c.put(
            f"/prompts/{pid}",
            json={"name": "daily2", "prompt": "x", "schedule": "every:2h", "enabled": False},
        )
        assert upd.status_code == 200
        assert upd.json()["enabled"] is False

        deleted = await c.delete(f"/prompts/{pid}")
        assert deleted.status_code == 204

        gone = await c.put(
            f"/prompts/{pid}",
            json={"name": "x", "prompt": "x", "schedule": "x"},
        )
        assert gone.status_code == 404


def _msg(content=None, tool_calls=None):
    m = types.SimpleNamespace(content=content, tool_calls=tool_calls)
    m.model_dump = lambda: {"role": "assistant", "content": content}
    return m


@pytest.mark.asyncio
async def test_chat_direct_answer(monkeypatch):
    async def fake_chat_once(messages, tools=None, **kw):
        return _msg(content="You sold 0 units.")

    monkeypatch.setattr(chat_service, "chat_once", fake_chat_once)
    answer = await chat_service.answer("how many units?")
    assert "0 units" in answer


@pytest.mark.asyncio
async def test_chat_passes_history(monkeypatch):
    seen: dict = {}

    async def fake_chat_once(messages, tools=None, **kw):
        seen["messages"] = messages
        return _msg(content="ข้อเสียคือ…")

    monkeypatch.setattr(chat_service, "chat_once", fake_chat_once)
    await chat_service.answer(
        "แล้วมีข้อเสียมั้ย",
        history=[
            {"role": "user", "content": "วิเคราะห์วิดีโอให้หน่อย"},
            {"role": "assistant", "content": "ช่องคุณเน้นรีวิวสินค้า…"},
        ],
    )
    roles = [m["role"] for m in seen["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert seen["messages"][-1]["content"] == "แล้วมีข้อเสียมั้ย"


@pytest.mark.asyncio
async def test_chat_tool_loop(monkeypatch):
    calls = {"n": 0}
    tool_call = types.SimpleNamespace(
        id="call_1",
        function=types.SimpleNamespace(name="query_overview", arguments="{}"),
    )

    async def fake_chat_once(messages, tools=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _msg(content=None, tool_calls=[tool_call])
        return _msg(content="Overview fetched.")

    monkeypatch.setattr(chat_service, "chat_once", fake_chat_once)
    answer = await chat_service.answer("give me an overview")
    assert answer == "Overview fetched."
    assert calls["n"] == 2  # one tool round, then final


@pytest.mark.asyncio
async def test_chat_stream_emits_status_events(monkeypatch):
    tool_call = types.SimpleNamespace(
        id="call_1",
        function=types.SimpleNamespace(name="query_overview", arguments="{}"),
    )
    calls = {"n": 0}

    async def fake_chat_once(messages, tools=None, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            return _msg(content=None, tool_calls=[tool_call])
        return _msg(content="Overview fetched.")

    monkeypatch.setattr(chat_service, "chat_once", fake_chat_once)

    events = []
    async for event in chat_service.answer_events("give me an overview"):
        events.append(event)

    statuses = [e["message"] for e in events if e["type"] == "status"]
    assert chat_service.TOOL_STATUS["thinking"] in statuses
    assert chat_service.TOOL_STATUS["query_overview"] in statuses
    done_events = [e for e in events if e["type"] == "done"]
    assert done_events[-1]["answer"] == "Overview fetched."


@pytest.mark.asyncio
async def test_custom_table_full_lifecycle():
    """End-to-end: create table → add columns (incl. formula) → rows → summary → cleanup.

    Exercises real DDL: each table is a real pg table, each column a real column, the
    formula column is a GENERATED column computed by Postgres.
    """
    async with _client() as c:
        # create table
        created = await c.post("/tables", json={"display_name": "ทดสอบสินค้า"})
        assert created.status_code == 201
        tid = created.json()["uid"]   # use uid (UUID) not numeric id
        assert created.json()["pg_table_name"].startswith("udt_")
        assert len(tid) == 36  # valid UUID format

        try:
            # add columns: text, select, date, number, then a date_add formula
            async def add_col(body):
                r = await c.post(f"/tables/{tid}/columns", json=body)
                assert r.status_code == 201, r.text
                return r.json()["key"]

            name_k = await add_col({"label": "ชื่อ", "ui_type": "text"})
            cat_k = await add_col(
                {"label": "หมวดหมู่", "ui_type": "select", "options": ["A", "B"]}
            )
            recv_k = await add_col({"label": "วันที่รับ", "ui_type": "date"})
            dur_k = await add_col({"label": "ระยะเวลา", "ui_type": "number"})
            target_k = await add_col(
                {
                    "label": "วันที่ลงคลิป",
                    "ui_type": "formula",
                    "formula": {"type": "date_add", "col_a": recv_k, "col_b": dur_k},
                }
            )

            # add a row; formula should be computed by pg (2026-01-01 + 3 = 2026-01-04)
            row = await c.post(
                f"/tables/{tid}/rows",
                json={
                    "data": {
                        name_k: "เสื้อยืด",
                        cat_k: "A",
                        recv_k: "2026-01-01",
                        dur_k: 3,
                    }
                },
            )
            assert row.status_code == 201, row.text
            rid = row.json()["uid"]   # row uid (UUID)
            assert row.json()["data"][target_k] == "2026-01-04"

            # second row, category B
            await c.post(
                f"/tables/{tid}/rows",
                json={"data": {name_k: "กระเป๋า", cat_k: "B", recv_k: "2026-02-01", dur_k: 5}},
            )

            # list rows (now paginated)
            rows = await c.get(f"/tables/{tid}/rows")
            assert rows.status_code == 200
            page = rows.json()
            assert page["total"] == 2
            assert len(page["rows"]) == 2

            # update a row
            upd = await c.put(
                f"/tables/{tid}/rows/{rid}", json={"data": {dur_k: 10}}
            )
            assert upd.status_code == 200
            assert upd.json()["data"][target_k] == "2026-01-11"  # 2026-01-01 + 10

            # summary grouped by category
            summ = await c.get(f"/tables/{tid}/summary", params={"group_by": cat_k})
            assert summ.status_code == 200, summ.text
            body = summ.json()
            groups = {r["group"]: r["count"] for r in body["rows"]}
            assert groups == {"A": 1, "B": 1}

            # cannot delete a column a formula depends on
            bad = await c.delete(f"/tables/{tid}/columns/{recv_k}")
            assert bad.status_code == 400

            # delete formula column, then its dependency
            assert (await c.delete(f"/tables/{tid}/columns/{target_k}")).status_code == 204
            assert (await c.delete(f"/tables/{tid}/columns/{recv_k}")).status_code == 204

            # delete a row
            assert (await c.delete(f"/tables/{tid}/rows/{rid}")).status_code == 204
        finally:
            # drops the real pg table
            gone = await c.delete(f"/tables/{tid}")
            assert gone.status_code == 204
