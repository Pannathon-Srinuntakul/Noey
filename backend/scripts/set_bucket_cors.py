"""Allow the web app's origins to PUT presigned uploads into the bucket.

Direct uploads (`POST /videos/{uid}/uploads`) hand the browser a presigned
URL, and the browser's PUT is a cross-origin request the bucket must answer
with CORS headers — Railway buckets, R2 and S3 all refuse it until told the
page origins. One-off, per bucket; rerun when an origin is added.

Run from `backend/` with the bucket's S3_* variables in the environment
(locally from .env, or `railway run --service "Noey Api" -- python
scripts/set_bucket_cors.py ...` against production):

    python scripts/set_bucket_cors.py https://noey-studio-production.up.railway.app http://localhost:5174
"""

from __future__ import annotations

import asyncio
import sys

from packages.video import s3


def main(argv: list[str]) -> int:
    origins = [o.rstrip("/") for o in argv if o.startswith(("http://", "https://"))]
    if not origins:
        print(__doc__)
        return 2
    if not s3.s3_enabled():
        print("storage is not configured (S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)")
        return 1
    asyncio.run(s3.put_bucket_cors(origins))
    print(f"CORS set on the bucket for PUT from: {', '.join(origins)}")
    print(f"presigned uploads go to {s3.upload_origin()} — put that in VITE_UPLOAD_ORIGIN for the web build")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
