"""Regenerate backend/requirements.lock from the current venv.

Walks Requires-Dist metadata from pyproject.toml's RUNTIME dependencies and
prints ``name==version`` for every distribution reached, markers evaluated for
the Docker image (Linux / CPython 3.12) rather than for this machine. Dev
extras are not roots, so pytest / ruff / mypy and their private deps stay out;
a dependency that only exists on Linux and is not installed here is reported
on stderr instead of silently dropped.

Run from backend/ (not pytest):
    .venv/bin/python scripts/lock_requirements.py > requirements.lock
"""

from __future__ import annotations

import pathlib
import sys
import tomllib
from importlib import metadata

from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

#: The image's environment — python:3.12-slim on Railway's x86_64 builders.
IMAGE_ENV = {
    "implementation_name": "cpython",
    "implementation_version": "3.12.0",
    "os_name": "posix",
    "platform_machine": "x86_64",
    "platform_python_implementation": "CPython",
    "platform_release": "",
    "platform_system": "Linux",
    "platform_version": "",
    "python_full_version": "3.12.0",
    "python_version": "3.12",
    "sys_platform": "linux",
}


def _wanted(marker: Marker | None, extras: set[str]) -> bool:
    if marker is None:
        return True
    return any(marker.evaluate({**IMAGE_ENV, "extra": e}) for e in ["", *sorted(extras)])


def main() -> int:
    pyproject = pathlib.Path(__file__).resolve().parent.parent / "pyproject.toml"
    roots = tomllib.loads(pyproject.read_text())["project"]["dependencies"]

    pinned: dict[str, str] = {}
    missing: list[str] = []
    queue = [Requirement(r) for r in roots]
    while queue:
        req = queue.pop()
        name = str(canonicalize_name(req.name))
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            missing.append(str(req))
            continue
        pinned.setdefault(name, dist.version)
        for line in dist.requires or []:
            sub = Requirement(line)
            # Revisit a known package only when a new extra may pull more in.
            if _wanted(sub.marker, set(req.extras)) and (
                canonicalize_name(sub.name) not in pinned or sub.extras
            ):
                queue.append(sub)

    for name in sorted(pinned):
        print(f"{name}=={pinned[name]}")
    if missing:
        print("# NOT INSTALLED HERE, pin by hand:", ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
