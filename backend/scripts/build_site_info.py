"""Regenerate packages/blog/site_info.json from noey-frontend's own modules.

The blog MCP tool `get_site_info` must describe the product exactly as the
website does, so its facts are EXTRACTED from noey-frontend/src/lib (site.ts,
scope.ts, guide.ts, plans.ts, modes.ts) instead of being retyped here. The
backend image does not contain noey-frontend, so the extraction runs at
development time and the JSON is committed; tests/test_blog_site_info.py
re-extracts and fails the moment the site's copy changes without a re-run.

Run from backend/ (needs Node >= 22.18, which strips TypeScript types natively):
    python scripts/build_site_info.py          # write
    python scripts/build_site_info.py --check  # exit 1 when out of date
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
FRONTEND_LIB = BACKEND.parent / "noey-frontend" / "src" / "lib"
EXTRACTOR = BACKEND / "scripts" / "site_info" / "extract.mjs"
TARGET = BACKEND / "packages" / "blog" / "site_info.json"


def extract() -> dict:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("node is not on PATH")
    out = subprocess.run(
        [node, "--no-warnings", str(EXTRACTOR), str(FRONTEND_LIB)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return json.loads(out.stdout)


def render(data: dict) -> str:
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    fresh = render(extract())
    if "--check" in sys.argv:
        current = TARGET.read_text(encoding="utf-8") if TARGET.exists() else ""
        if current != fresh:
            print("site_info.json is out of date — run: python scripts/build_site_info.py", file=sys.stderr)
            return 1
        return 0
    TARGET.write_text(fresh, encoding="utf-8")
    print(f"wrote {TARGET.relative_to(BACKEND)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
