"""Video project file paths and on-disk cleanup."""

from __future__ import annotations

import os
import pathlib
import re
import shutil
import stat
import time

from packages.core.logging import get_logger

log = get_logger(__name__)

_RMTREE_RETRIES = 5
_RMTREE_DELAY_SEC = 0.4


def data_root() -> pathlib.Path:
    """Where uploads, renders and web project files live.

    `DATA_DIR` first, `backend/data/` otherwise. The fallback is INSIDE the
    container image (backend/Dockerfile creates it as an image layer and
    docker-compose mounts no volume over it), so on any deployment that
    redeploys or scales, everything written there is gone with the container.
    The web build stores whole projects here — the env override is what makes a
    mounted volume possible.
    """
    from packages.core.settings import get_settings

    configured = (get_settings().data_dir or "").strip()
    if configured:
        return pathlib.Path(configured).expanduser().resolve()
    here = pathlib.Path(__file__).resolve().parent          # packages/video/
    return here.parent.parent / "data"                      # backend/data/


def upload_dir(project_uid: str) -> pathlib.Path:
    return data_root() / "video_uploads" / project_uid


def output_dir(project_uid: str) -> pathlib.Path:
    return data_root() / "video_outputs" / project_uid


def _clear_readonly(func, path: str, exc: BaseException) -> None:
    """Retry unlink/rmdir after clearing read-only (Windows)."""
    os.chmod(path, stat.S_IWRITE)
    func(path)


def _rmtree_resilient(path: pathlib.Path) -> None:
    """Delete a directory tree; retry when files are briefly locked (Windows/ffmpeg)."""
    if not path.exists():
        return
    last_err: OSError | None = None
    for attempt in range(_RMTREE_RETRIES):
        try:
            shutil.rmtree(path, onexc=_clear_readonly)
            log.info("video_files_deleted", path=str(path))
            return
        except OSError as exc:
            last_err = exc
            if attempt < _RMTREE_RETRIES - 1:
                time.sleep(_RMTREE_DELAY_SEC * (attempt + 1))
    assert last_err is not None
    raise last_err


#: A project directory name: what `uuid.uuid4()` produces, plus the legacy
#: ids still on disk. Never '.', '..', a separator or anything else that could
#: walk out of `video_uploads/` / `video_outputs/`.
_PROJECT_DIR_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}")
_PROJECT_PARENTS = ("video_uploads", "video_outputs")


def _safe_project_dir(root: pathlib.Path, parent: str, name: str) -> pathlib.Path | None:
    """`root/parent/name` when it is exactly one level under that parent, else None."""
    if parent not in _PROJECT_PARENTS or not _PROJECT_DIR_RE.fullmatch(name):
        return None
    candidate = root / parent / name
    if candidate.resolve().parent != (root / parent).resolve():
        return None
    return candidate


def _collect_project_dirs(project_uid: str, source_files: list[str] | None) -> list[pathlib.Path]:
    """Return unique upload/output dirs to remove for a project.

    Cross-references to OTHER project folders come only from `source_files`
    (the DB column, written by the server-render upload route). The
    `upload_sources.json` manifest is deliberately NOT read here: the web build
    stores it through `PUT /videos/{uid}/files/upload_sources.json`, so its
    contents are client-controlled — trusting it let one account point a
    delete at `video_outputs/..` (the whole DATA_DIR) or another user's
    project. The server chain writes that manifest as a copy of `source_files`,
    so nothing is lost by ignoring it.
    """
    root = data_root()
    dirs: set[pathlib.Path] = set()
    for parent in _PROJECT_PARENTS:
        own = _safe_project_dir(root, parent, project_uid)
        if own is not None:
            dirs.add(own)
    for rel in list(source_files or []):
        if isinstance(rel, dict):
            rel = rel.get("file") or ""
        if not isinstance(rel, str) or not rel:
            continue
        parts = pathlib.PurePosixPath(rel.replace("\\", "/")).parts
        if len(parts) < 2:
            continue
        safe = _safe_project_dir(root, parts[0], parts[1])
        if safe is not None:
            dirs.add(safe)
    return sorted(dirs, key=lambda p: str(p))


def delete_project_files(project_uid: str, *, source_files: list[str] | None = None) -> None:
    """Remove all upload + output files for a project."""
    root = data_root()
    for d in _collect_project_dirs(project_uid, source_files):
        # Belt and braces: never rmtree anything but a direct child of the two
        # project parents, whatever _collect_project_dirs returned.
        if _safe_project_dir(root, d.parent.name, d.name) != d:
            log.warning("video_files_delete_refused", path=str(d))
            continue
        _rmtree_resilient(d)


# ── uploaded media is not ours to keep ───────────────────────────────────────
# The AI has to SEE the footage, so proxies, speech WAVs and a music track are
# uploaded. Nothing after the job that needed them reads them again, and the
# product's promise is that source video stays on the user's machine — so they
# go the moment the job succeeds.
#
# Measured before this existed: 2.93 GB across 234 files, the oldest from two
# months earlier (2026-09-08).
#
# Deliberately NOT deleted on failure. A retry would otherwise have to re-upload
# everything, and for the speech path that also means paying for transcription
# a second time.

#: What each stage may retire once it has finished. Values are directory names
#: under a project's output dir.
PURGEABLE_MEDIA_DIRS = ("proxy", "audio", "music", "effects", "ai_reedit", "frames")


def purge_uploaded_media(project_uid: str, subdirs: tuple[str, ...] | list[str]) -> int:
    """Delete uploaded media directories for a project. Returns files removed.

    Local only — the caller pairs this with `s3.delete_output_subdir` so a later
    `pull_project_files` cannot restore what was just deleted.
    """
    removed = 0
    base = output_dir(project_uid)
    for name in subdirs:
        if name not in PURGEABLE_MEDIA_DIRS:
            raise ValueError(f"not a purgeable media dir: {name}")
        target = base / name
        if not target.is_dir():
            continue
        for f in target.rglob("*"):
            if f.is_file():
                removed += 1
        _rmtree_resilient(target)
    if removed:
        log.info("purged_uploaded_media", project_uid=project_uid, dirs=list(subdirs), files=removed)
    return removed
