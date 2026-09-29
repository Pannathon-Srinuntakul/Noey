"""Regenerate backend/requirements.lock from the current venv.

Walks Requires-Dist metadata from pyproject.toml's RUNTIME dependencies and
prints ``name==version`` for every distribution reached, markers evaluated for
the Docker image (Linux / CPython 3.12) rather than for this machine. Dev
extras are not roots, so pytest / ruff / mypy and their private deps stay out;
a dependency that only exists on Linux and is not installed here is reported
on stderr instead of silently dropped.

Run from backend/ (not pytest):
    .venv/bin/python scripts/lock_requirements.py > requirements.lock

Every pin carries ``--hash=sha256:`` lines fetched from PyPI's JSON API for
that exact release (sdist + the wheels the image could select: CPython 3.12 /
abi3 / pure-Python, Linux glibc or any platform). pip then installs in
hash-checking mode (the Dockerfile adds ``--require-hashes``), so a release
file replaced upstream under the same version fails the build instead of
shipping to production. ``--no-hashes`` prints bare pins (offline use only;
the image build refuses that file).
"""

from __future__ import annotations

import json
import pathlib
import sys
import tomllib
import urllib.request
from importlib import metadata

from packaging.markers import Marker
from packaging.requirements import Requirement
from packaging.utils import InvalidWheelFilename, canonicalize_name, parse_wheel_filename

HEADER = """\
# Pinned runtime dependency closure of pyproject.toml — what the Docker image
# installs. GENERATED, do not hand-edit versions.
#
# Why: pyproject.toml holds only `>=` floors, so `pip install .` at image build
# time took whatever litellm / fastapi / sqlalchemy happened to be newest that
# day — a push to main (which IS a production deploy) could pull a breaking
# release nobody had run. The Dockerfile installs THIS file with `--no-deps`
# and then the project with `--no-deps`, so the image only ever contains what
# is written here, and `pip check` in the build fails if the set is incomplete.
#
# Hashes: every pin lists the sha256 of the release files PyPI published for
# it, and the image installs with `--require-hashes` — a version re-uploaded
# or replaced upstream fails the build rather than reaching production.
#
# Regenerate (from backend/, in the venv that has the versions you tested):
#   .venv/bin/python scripts/lock_requirements.py > requirements.lock
# The script walks Requires-Dist from pyproject's runtime deps with markers
# evaluated for the image (Linux / CPython 3.12), so dev extras (pytest, ruff,
# mypy) and their private deps are left out, then fetches the hashes from
# PyPI. Bumping a dependency = bump it in the venv, run the tests, regenerate,
# commit both."""

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


def _image_can_use(filename: str) -> bool:
    """Whether pip in the image (CPython 3.12, glibc Linux) could pick this file."""
    if not filename.endswith(".whl"):
        return filename.endswith((".tar.gz", ".zip"))  # sdist
    try:
        _, _, _, tags = parse_wheel_filename(filename)
    except InvalidWheelFilename:
        return False
    for tag in tags:
        py_ok = tag.interpreter in {"py3", "py312", "cp312"} or (
            tag.abi == "abi3" and tag.interpreter.startswith("cp3")
        )
        plat_ok = tag.platform == "any" or tag.platform.startswith(("manylinux", "linux_"))
        if py_ok and plat_ok:
            return True
    return False


def release_hashes(name: str, version: str) -> list[str]:
    """sha256 of every image-usable file PyPI published for ``name==version``."""
    url = f"https://pypi.org/pypi/{name}/{version}/json"
    with urllib.request.urlopen(url, timeout=30) as resp:
        files = json.load(resp)["urls"]
    hashes = sorted({f["digests"]["sha256"] for f in files if _image_can_use(f["filename"])})
    if not hashes:
        raise SystemExit(f"no image-usable release file on PyPI for {name}=={version}")
    return hashes


def main() -> int:
    with_hashes = "--no-hashes" not in sys.argv[1:]
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

    print(HEADER)
    for name in sorted(pinned):
        if not with_hashes:
            print(f"{name}=={pinned[name]}")
            continue
        hashes = release_hashes(name, pinned[name])
        print(f"{name}=={pinned[name]} \\")
        print(" \\\n".join(f"    --hash=sha256:{h}" for h in hashes))
    if missing:
        print("# NOT INSTALLED HERE, pin by hand:", ", ".join(missing), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
