"""Workspace provisioning endpoint (admin-only)."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from packages.tables.workspace import provision_workspace
from services.api.deps import CurrentUser, db_session

router = APIRouter(prefix="/workspace", tags=["workspace"])


@router.post("/provision", status_code=200)
async def provision(
    auth: CurrentUser,
    session: AsyncSession = Depends(db_session),
) -> dict:
    """Re-run workspace provisioning for the current tenant.
    No-op if tables already exist (idempotent).
    """
    if not auth.user.is_admin:
        raise HTTPException(403, "admin only")
    await provision_workspace(session, auth.tenant_slug)
    return {"ok": True}
