"""Public download links for the desktop app installer (no auth — same as a
marketing/download page). Files live in S3 under releases/desktop/, uploaded
via scripts/upload_desktop_release.py after each `npm run build:win`."""

from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse

from packages.video.s3 import release_presigned_url

router = APIRouter(prefix="/releases", tags=["releases"])

WINDOWS_INSTALLER_FILENAME = "noey-video-edit-setup.exe"


@router.get("/desktop/windows")
async def download_desktop_windows() -> RedirectResponse:
    """Redirect to a fresh presigned URL for the latest Windows installer."""
    url = await release_presigned_url(WINDOWS_INSTALLER_FILENAME)
    if url is None:
        raise HTTPException(404, "ยังไม่มีไฟล์ติดตั้งให้ดาวน์โหลด")
    return RedirectResponse(url, status_code=307)
