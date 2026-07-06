"""Video project file paths and on-disk cleanup."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import stat
import time

from packages.core.logging import get_logger

log = get_logger(__name__)

_RMTREE_RETRIES = 5
_RMTREE_DELAY_SEC = 0.4


def data_root() -> pathlib.Path:
    """Absolute path to backend/data/."""
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


def _collect_project_dirs(project_uid: str, source_files: list[str] | None) -> list[pathlib.Path]:
    """Return unique upload/output dirs to remove for a project."""
    dirs = {upload_dir(project_uid), output_dir(project_uid)}
    root = data_root()
    rel_paths = list(source_files or [])
    manifest = output_dir(project_uid) / "upload_sources.json"
    if manifest.is_file():
        try:
            rel_paths.extend(json.loads(manifest.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            log.warning("upload_sources_invalid", path=str(manifest))
    for rel in rel_paths:
        rel_path = pathlib.Path(rel)
        parts = rel_path.parts
        if not parts:
            continue
        if parts[0] == "video_uploads" and len(parts) >= 2:
            dirs.add(root / "video_uploads" / parts[1])
        elif parts[0] == "video_outputs" and len(parts) >= 2:
            dirs.add(root / "video_outputs" / parts[1])
    return sorted(dirs, key=lambda p: str(p))


def delete_project_files(project_uid: str, *, source_files: list[str] | None = None) -> None:
    """Remove all upload + output files for a project."""
    for d in _collect_project_dirs(project_uid, source_files):
        _rmtree_resilient(d)
