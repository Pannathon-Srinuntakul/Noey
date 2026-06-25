"""Chat router: session CRUD + streaming chat with DB persistence."""

import json
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from packages.db.models.chat_session import ChatMessage, ChatSession
from packages.db.session import get_sessionmaker
from packages.db.tenancy import set_search_path_sql
from services.api import chat_service
from services.api.deps import CurrentUser, db_session
from services.api.schemas import (
    ChatSessionDetail,
    ChatSessionOut,
    ChatSessionRename,
    ChatStreamIn,
    ChatHistoryItem,
)

router = APIRouter(prefix="/chat", tags=["chat"])


def _session_out(s: ChatSession) -> ChatSessionOut:
    return ChatSessionOut(
        uid=str(s.uid),
        title=str(s.title),
        message_count=int(s.message_count),
        has_summary=s.summary is not None,
        created_at=s.created_at,
        updated_at=s.updated_at,
    )


# ── Session CRUD ──────────────────────────────────────────────────────────────

@router.get("/sessions", response_model=list[ChatSessionOut])
async def list_sessions(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(db_session)],
) -> list[ChatSessionOut]:
    rows = (
        await db.execute(
            select(ChatSession)
            .where(ChatSession.user_id == auth.user_id)
            .order_by(ChatSession.updated_at.desc())
            .limit(100)
        )
    ).scalars().all()
    return [_session_out(r) for r in rows]


@router.post("/sessions", response_model=ChatSessionOut)
async def create_session(
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(db_session)],
) -> ChatSessionOut:
    session = ChatSession(
        uid=str(uuid.uuid4()),
        user_id=auth.user_id,
        title="New Chat",
    )
    db.add(session)
    await db.flush()
    return _session_out(session)


@router.get("/sessions/{uid}", response_model=ChatSessionDetail)
async def get_session(
    uid: str,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(db_session)],
) -> ChatSessionDetail:
    row = (
        await db.execute(
            select(ChatSession).where(
                ChatSession.uid == uid,
                ChatSession.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")

    msgs = (
        await db.execute(
            select(ChatMessage)
            .where(ChatMessage.session_uid == uid)
            .order_by(ChatMessage.created_at.desc())
            .limit(chat_service.MAX_HISTORY_MESSAGES)
        )
    ).scalars().all()

    return ChatSessionDetail(
        **_session_out(row).model_dump(),
        messages=[
            ChatHistoryItem(role=m.role, content=m.content)  # type: ignore[arg-type]
            for m in reversed(msgs)
        ],
    )


@router.delete("/sessions/{uid}", status_code=204)
async def delete_session(
    uid: str,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(db_session)],
) -> None:
    row = (
        await db.execute(
            select(ChatSession).where(
                ChatSession.uid == uid,
                ChatSession.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    await db.delete(row)


@router.patch("/sessions/{uid}", response_model=ChatSessionOut)
async def rename_session(
    uid: str,
    body: ChatSessionRename,
    auth: CurrentUser,
    db: Annotated[AsyncSession, Depends(db_session)],
) -> ChatSessionOut:
    row = (
        await db.execute(
            select(ChatSession).where(
                ChatSession.uid == uid,
                ChatSession.user_id == auth.user_id,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="session not found")
    row.title = body.title[:255]
    await db.flush()
    return _session_out(row)


# ── Streaming chat ─────────────────────────────────────────────────────────────

@router.post("/stream")
async def chat_stream(body: ChatStreamIn, auth: CurrentUser) -> StreamingResponse:
    slug = auth.tenant_slug
    user_id = auth.user_id

    async def event_stream():
        maker = get_sessionmaker()

        # === Pre-stream: resolve/create session, load history, insert user msg ===
        async with maker() as s:
            await s.execute(text(set_search_path_sql(slug)))

            if body.session_uid is None:
                session = ChatSession(
                    uid=str(uuid.uuid4()),
                    user_id=user_id,
                    title=body.message[:50],
                )
                s.add(session)
                await s.flush()
                session_uid = str(session.uid)
                old_summary: str | None = None
            else:
                row = (
                    await s.execute(
                        select(ChatSession).where(
                            ChatSession.uid == body.session_uid,
                            ChatSession.user_id == user_id,
                        )
                    )
                ).scalar_one_or_none()
                if row is None:
                    yield f"data: {json.dumps({'type': 'error', 'message': 'session not found'})}\n\n"
                    return
                session_uid = str(row.uid)
                old_summary = row.summary
                if row.message_count == 0:
                    await s.execute(
                        text("UPDATE chat_sessions SET title = :t WHERE uid = :uid"),
                        {"t": body.message[:50], "uid": session_uid},
                    )

            history_rows = (
                await s.execute(
                    select(ChatMessage)
                    .where(ChatMessage.session_uid == session_uid)
                    .order_by(ChatMessage.created_at.desc())
                    .limit(chat_service.MAX_HISTORY_MESSAGES)
                )
            ).scalars().all()
            history = [
                {"role": m.role, "content": m.content}
                for m in reversed(history_rows)
            ]

            s.add(ChatMessage(
                uid=str(uuid.uuid4()),
                session_uid=session_uid,
                role="user",
                content=body.message,
            ))
            await s.execute(
                text(
                    "UPDATE chat_sessions "
                    "SET message_count = message_count + 1, updated_at = now() "
                    "WHERE uid = :uid"
                ),
                {"uid": session_uid},
            )
            await s.commit()

        # Echo session_uid so frontend can store it (useful for new sessions)
        yield f"data: {json.dumps({'type': 'session', 'session_uid': session_uid})}\n\n"

        # === Stream AI response ===
        full_answer = ""
        async for event in chat_service.answer_events(
            body.message, history, old_summary, slug,
            user_id=user_id, tenant_id=auth.tenant_id,
        ):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            if event["type"] == "done":
                full_answer = event.get("answer", "")

        if not full_answer:
            return

        # === Post-stream: save assistant message ===
        async with maker() as s:
            await s.execute(text(set_search_path_sql(slug)))
            s.add(ChatMessage(
                uid=str(uuid.uuid4()),
                session_uid=session_uid,
                role="assistant",
                content=full_answer,
            ))
            result = await s.execute(
                text(
                    "UPDATE chat_sessions "
                    "SET message_count = message_count + 1, updated_at = now() "
                    "WHERE uid = :uid RETURNING message_count"
                ),
                {"uid": session_uid},
            )
            new_count = result.scalar_one()
            await s.commit()

        # === Auto-summarize if threshold hit ===
        if new_count >= chat_service.SUMMARIZE_THRESHOLD:
            yield f"data: {json.dumps({'type': 'status', 'message': 'กำลังสรุปบทสนทนา…'})}\n\n"
            try:
                async with maker() as s:
                    await s.execute(text(set_search_path_sql(slug)))
                    all_msgs = (
                        await s.execute(
                            select(ChatMessage)
                            .where(ChatMessage.session_uid == session_uid)
                            .order_by(ChatMessage.created_at.asc())
                        )
                    ).scalars().all()

                keep = chat_service.SUMMARIZE_KEEP_RECENT
                if len(all_msgs) > keep:
                    to_compress = [
                        {"role": m.role, "content": m.content}
                        for m in all_msgs[:-keep]
                    ]
                    new_summary = await chat_service._summarize_messages(
                        to_compress, old_summary
                    )
                    async with maker() as s:
                        await s.execute(text(set_search_path_sql(slug)))
                        await s.execute(
                            text("UPDATE chat_sessions SET summary = :summary WHERE uid = :uid"),
                            {"summary": new_summary, "uid": session_uid},
                        )
                        await s.commit()
            except Exception:  # noqa: BLE001
                pass  # summarization failure must not break the chat response

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
