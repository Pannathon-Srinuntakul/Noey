"""End-to-end video pipeline test.

Usage:
    python scripts/e2e_video.py <video_path> [--email <email>] [--password <pw>]
                                              [--api <url>] [--mode talking_head]
                                              [--duration <sec>]

Defaults: api=http://localhost:8000, mode=talking_head
Credentials: reads E2E_EMAIL / E2E_PASSWORD from env, or from .env, or CLI args.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import httpx

# ── helpers ───────────────────────────────────────────────────────────────────

def _load_dotenv(base: Path) -> None:
    for candidate in (base / ".env", base.parent / ".env"):
        if candidate.exists():
            for line in candidate.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, _, v = line.partition("=")
                    os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
            break


def _login(api: str, email: str, password: str) -> str:
    r = httpx.post(f"{api}/auth/login", json={"email": email, "password": password}, timeout=10)
    if r.status_code != 200:
        print(f"[LOGIN FAIL] {r.status_code}: {r.text}")
        sys.exit(1)
    token = r.json()["access_token"]
    print(f"[LOGIN OK] user={email}")
    return token


def _upload(
    api: str,
    token: str,
    video_path: Path,
    mode: str,
    duration: int | None,
    duration_mode: str = "full",
) -> tuple[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    data: dict[str, str] = {"mode": mode, "upload_mode": "merge", "duration_mode": duration_mode}
    if duration:
        data["target_duration_sec"] = str(duration)

    size_mb = round(video_path.stat().st_size / 1_048_576, 1)
    print(f"[UPLOAD] {video_path.name} ({size_mb} MB) ...")
    t0 = time.time()
    with video_path.open("rb") as fh:
        r = httpx.post(
            f"{api}/videos",
            headers=headers,
            data=data,
            files={"files": (video_path.name, fh, "video/mp4")},
            timeout=300,
        )
    elapsed = round(time.time() - t0, 1)
    if r.status_code not in (200, 201):
        print(f"[UPLOAD FAIL] {r.status_code}: {r.text}")
        sys.exit(1)

    projects = r.json()["projects"]
    uid = projects[0]["project_uid"]
    job_id = projects[0]["job_id"]
    print(f"[UPLOAD OK] {elapsed}s  project={uid}  job={job_id}")
    return uid, job_id


def _poll(api: str, token: str, job_id: str, uid: str, timeout: int = 1800) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.time() + timeout
    last_step = ""
    spinner = ["|", "/", "-", "\\"]
    tick = 0

    print(f"[POLL] job={job_id}  (timeout {timeout}s)")
    while time.time() < deadline:
        r = httpx.get(f"{api}/jobs/{job_id}", headers=headers, timeout=10)
        if r.status_code != 200:
            print(f"\n[POLL ERR] {r.status_code}: {r.text}")
            sys.exit(1)

        data = r.json()
        status = data.get("status", "?")
        result = data.get("result") or {}
        step = result.get("step", "")
        msg = result.get("message", "")
        progress = data.get("progress", 0)

        if step != last_step:
            print(f"\n[STEP] {step}: {msg}")
            last_step = step

        if status in ("complete", "ok"):
            print(f"\n[DONE] progress={progress}%")
            _show_result(api, token, uid)
            return
        if status == "error":
            err = data.get("error", "")
            print(f"\n[ERROR] {err}")
            print(f"  result: {result}")
            sys.exit(1)

        spin = spinner[tick % 4]
        print(f"\r  {spin} {status} {progress}%  ", end="", flush=True)
        tick += 1
        time.sleep(4)

    print("\n[TIMEOUT]")
    sys.exit(1)


def _show_result(api: str, token: str, uid: str) -> None:
    headers = {"Authorization": f"Bearer {token}"}
    r = httpx.get(f"{api}/videos/{uid}", headers=headers, timeout=10)
    if r.status_code != 200:
        print(f"[RESULT ERR] {r.status_code}")
        return
    proj = r.json()
    print(f"\n{'='*60}")
    print(f"Project : {uid}")
    print(f"Status  : {proj['status']}")
    print(f"Mode    : {proj['mode']}")
    print(f"final   : {proj.get('final_path') or '—'}")
    print(f"zip     : {proj.get('zip_path') or '—'}")
    if proj.get("error_msg"):
        print(f"error   : {proj['error_msg']}")
    print(f"Download: {api}/videos/{uid}/download")
    print("="*60)


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    _load_dotenv(Path(__file__).parent.parent)

    p = argparse.ArgumentParser(description="E2E video pipeline test")
    p.add_argument("video", help="Path to video file")
    p.add_argument("--email", default=os.environ.get("E2E_EMAIL", ""))
    p.add_argument("--password", default=os.environ.get("E2E_PASSWORD", ""))
    p.add_argument("--api", default=os.environ.get("E2E_API", "http://localhost:8000"))
    p.add_argument("--mode", default="talking_head", choices=["talking_head", "dub_first"])
    p.add_argument("--duration-mode", default="full", choices=["full", "auto", "custom"],
                   help="full=AI editorial, auto=Claude picks length, custom=--duration sets budget")
    p.add_argument("--duration", type=int, default=None, help="Target duration seconds (required for --duration-mode custom)")
    p.add_argument("--timeout", type=int, default=1800, help="Poll timeout seconds (default 1800)")
    args = p.parse_args()

    if not args.email or not args.password:
        print("Need credentials: --email / --password  or  E2E_EMAIL / E2E_PASSWORD env vars")
        sys.exit(1)

    if args.duration_mode == "custom" and not args.duration:
        print("--duration required when --duration-mode=custom")
        sys.exit(1)

    video = Path(args.video)
    if not video.exists():
        print(f"File not found: {video}")
        sys.exit(1)

    token = _login(args.api, args.email, args.password)
    uid, job_id = _upload(args.api, token, video, args.mode, args.duration, args.duration_mode)
    _poll(args.api, token, job_id, uid, timeout=args.timeout)


if __name__ == "__main__":
    main()
