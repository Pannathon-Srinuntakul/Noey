"""Upload the built desktop installer to S3 for the web download link.

Run after `npm run build:win` in desktop/app:

    cd backend && python scripts/upload_desktop_release.py \
        ../desktop/app/dist/noey-video-edit-0.1.0-setup.exe
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent.parent))

from packages.video.s3 import upload_release_file  # noqa: E402


def main() -> None:
    if len(sys.argv) != 2:
        print("usage: python scripts/upload_desktop_release.py <path-to-setup.exe>")
        raise SystemExit(1)
    src = pathlib.Path(sys.argv[1]).resolve()
    if not src.is_file():
        print(f"file not found: {src}")
        raise SystemExit(1)

    print(f"uploading {src} ({src.stat().st_size / 1_048_576:.1f} MB)…")
    upload_release_file(src, "noey-video-edit-setup.exe")
    print("done — available at GET /releases/desktop/windows")


if __name__ == "__main__":
    main()
