"""Supply-chain and exposure guards on the repo's build/deploy config.

These read files, not a running stack: Dockerfiles, the Python lock,
docker-compose.yml, the CI workflow and .gitignore. Each test pins one
hardening decision so a later edit cannot quietly undo it.
"""

from __future__ import annotations

import importlib.util
import pathlib
import re
import shutil
import subprocess

import pytest
import yaml

BACKEND = pathlib.Path(__file__).resolve().parent.parent
REPO = BACKEND.parent

DOCKERFILES = [
    BACKEND / "Dockerfile",
    REPO / "web" / "Dockerfile",
    REPO / "admin" / "Dockerfile",
    REPO / "noey-frontend" / "Dockerfile",
    REPO / "loadtest" / "runner" / "Dockerfile",
]
_DIGEST = re.compile(r"@sha256:[0-9a-f]{64}$")
_SHA = re.compile(r"^[^@\s]+@[0-9a-f]{40}$")


# ── Base images ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("dockerfile", DOCKERFILES, ids=lambda p: str(p.relative_to(REPO)))
def test_every_base_image_is_digest_pinned(dockerfile: pathlib.Path) -> None:
    """A mutable tag lets the base change under a commit that touched nothing."""
    stages: set[str] = set()
    for line in dockerfile.read_text().splitlines():
        m = re.match(r"^FROM\s+(\S+)(?:\s+AS\s+(\S+))?", line, re.IGNORECASE)
        if not m:
            continue
        image, alias = m.group(1), m.group(2)
        if image not in stages:  # `FROM build` reuses an earlier stage — no pull
            assert _DIGEST.search(image), f"{dockerfile.name}: {image} is not pinned to a digest"
        if alias:
            stages.add(alias)


# ── Python lock ───────────────────────────────────────────────────────────────


def test_backend_image_installs_the_lock_hash_checked() -> None:
    runs = [ln for ln in (BACKEND / "Dockerfile").read_text().splitlines() if ln.startswith("RUN ")]
    installs = [ln for ln in runs if "-r requirements.lock" in ln]
    assert installs and all("--require-hashes" in ln for ln in installs)
    # An unpinned, unhashed pip upgrade would sit in front of the checked install.
    assert not any("--upgrade pip" in ln for ln in runs)


def _lock_requirements() -> list[str]:
    """requirements.lock as logical lines (backslash continuations joined)."""
    joined = (BACKEND / "requirements.lock").read_text().replace("\\\n", " ")
    return [ln.strip() for ln in joined.splitlines() if ln.strip() and not ln.startswith("#")]


def test_every_locked_requirement_carries_a_hash() -> None:
    reqs = _lock_requirements()
    assert len(reqs) > 50  # the whole closure, not an empty file
    for req in reqs:
        assert re.match(r"^[A-Za-z0-9_.-]+==\S+ ", req), f"not an exact pin: {req[:60]}"
        assert re.search(r"--hash=sha256:[0-9a-f]{64}", req), f"no hash: {req.split()[0]}"


def _lock_script():
    spec = importlib.util.spec_from_file_location(
        "lock_requirements", BACKEND / "scripts" / "lock_requirements.py"
    )
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize(
    ("filename", "usable"),
    [
        ("arq-0.28.0-py3-none-any.whl", True),
        ("arq-0.28.0.tar.gz", True),
        ("numpy-2.3.0-cp312-cp312-manylinux_2_17_x86_64.manylinux2014_x86_64.whl", True),
        ("numpy-2.3.0-cp312-cp312-manylinux_2_17_aarch64.manylinux2014_aarch64.whl", True),
        ("cryptography-50.0.1-cp311-abi3-manylinux_2_28_x86_64.whl", True),
        ("numpy-2.3.0-cp313-cp313-manylinux_2_17_x86_64.whl", False),
        ("numpy-2.3.0-cp312-cp312-macosx_14_0_arm64.whl", False),
        ("numpy-2.3.0-cp312-cp312-win_amd64.whl", False),
    ],
)
def test_lock_script_hashes_the_files_the_image_can_select(filename: str, usable: bool) -> None:
    """Missing the wheel pip picks = a failed build; extra platforms = noise."""
    assert _lock_script()._image_can_use(filename) is usable


# ── docker-compose (local dev) ────────────────────────────────────────────────


def _compose() -> dict:
    return yaml.safe_load((REPO / "docker-compose.yml").read_text())


@pytest.mark.parametrize("service", ["redis", "postgres"])
def test_compose_datastores_publish_on_loopback_only(service: str) -> None:
    """A bare "6380:6379" binds 0.0.0.0 — the queue and dev DB on shared Wi-Fi."""
    ports = _compose()["services"][service]["ports"]
    assert ports
    for mapping in ports:
        assert str(mapping).startswith("127.0.0.1:"), f"{service} publishes {mapping}"


def test_compose_redis_password_reaches_server_and_clients() -> None:
    services = _compose()["services"]
    assert "--requirepass" in services["redis"]["command"]
    for client in ("api", "worker"):
        url = services[client]["environment"]["REDIS_URL"]
        assert "${REDIS_PASSWORD" in url, f"{client} would not authenticate: {url}"


# ── CI ────────────────────────────────────────────────────────────────────────


def _ci() -> dict:
    return yaml.safe_load((REPO / ".github" / "workflows" / "ci.yml").read_text())


def test_ci_token_is_read_only() -> None:
    assert _ci()["permissions"] == {"contents": "read"}


def test_ci_actions_are_pinned_to_commit_shas() -> None:
    uses = [
        step["uses"]
        for job in _ci()["jobs"].values()
        for step in job.get("steps", [])
        if "uses" in step
    ]
    assert uses
    for ref in uses:
        assert _SHA.match(ref), f"not pinned to a SHA: {ref}"


def test_ci_audits_dependencies_and_checks_every_js_package() -> None:
    ci = _ci()
    runs = "\n".join(
        step.get("run", "") for job in ci["jobs"].values() for step in job.get("steps", [])
    )
    assert "pip-audit" in runs and "npm audit" in runs
    assert "--require-hashes -r requirements.lock" in runs
    workdirs = {
        job.get("defaults", {}).get("run", {}).get("working-directory")
        for job in ci["jobs"].values()
    }
    assert {"backend", "web", "desktop/app"} <= workdirs
    assert set(ci["jobs"]["next"]["strategy"]["matrix"]["app"]) == {"noey-frontend", "admin"}


# ── .gitignore ────────────────────────────────────────────────────────────────


@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
@pytest.mark.parametrize(
    ("path", "ignored"),
    [
        ("backend/.env.production", True),
        (".env.production", True),
        (".env.staging", True),
        ("noey-frontend/.env.local", True),
        (".env", True),
        (".env.example", False),
        ("noey-frontend/.env.example", False),
    ],
)
def test_gitignore_covers_every_env_variant(path: str, ignored: bool) -> None:
    # --no-index: judge the pattern alone, whether or not the file is tracked.
    res = subprocess.run(
        ["git", "check-ignore", "--no-index", "-q", path],
        cwd=REPO,
        check=False,
    )
    assert (res.returncode == 0) is ignored
