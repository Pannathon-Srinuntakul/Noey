# Load test — real footage, and how far the API goes (2026-09-23)

The two earlier runs (`load-test-2026-09-22.md`, `load-test-2026-09-23.md`) both
drove the stack with an **8-second, 106 KB** clip. That is enough to exercise
every endpoint and says nothing at all about what happens when someone uploads
what they actually shot. This run fixes that.

## The footage

| | Earlier runs | This run |
|---|---|---|
| Source clip | 270×480, 8 s, **106 KB** | 1080×1920, 7 min, 10.1 Mbit/s, **532 MB** |
| Proxy sent for analysis | the same 106 KB file | 270×480, 12 fps, CRF 28, no audio — **5.4 MB** |

The proxy parameters are the product's own (`desktop/sidecar/sidecar/proxy.py`
scales to 480 high at 12 fps, CRF 28). Both fixtures are encoded in the runner's
image build, so nothing large is ever uploaded from a laptop.

**The proxy is 1% of the source.** That ratio is why the architecture separates
them — but `normalized/` is still synced to the server at full size
(`web/src/lib/projectSync.ts`, `SYNC_ROOTS`), so a real project really does push
half a gigabyte.

## Why two tracks

600 virtual users × 532 MB is 319 GB per stage. No load generator pushes that in
a five-minute hold, and k6 holds each opened file in memory per VU, so the run
would measure the generator rather than the stack. The two questions are asked
separately:

- **Track A — the upload path.** Real 532 MB clip, 5 → 10 → 20 users.
- **Track B — the API's ceiling.** Real 5.4 MB proxy only (`PUSH_NORMALIZED=0`),
  200 → 400 → 600 users.

Both run against `http://lt-api.railway.internal:8080` — Railway's private
network, so there is no egress bill and no edge in the way. That also means the
numbers exclude Railway's edge and TLS, which real users do go through.

## A result before the results: k6 cannot carry a real clip

The first attempt ran the normal k6 session with the 532 MB fixture at **five**
virtual users. Five sessions started, and then the runner died with no summary
line and a single `Starting Container` in its log — Railway reported it
`Crashed`.

The cause is k6's own contract: `open()` loads the file into memory **once per
virtual user**, and the multipart body is copied again per in-flight request.
Five users is 2.7 GB of fixture before a byte is sent, and roughly double that
while the uploads are in flight — past the container's limit.

So the upload track is measured with `runner/upload_probe.sh`: the same session
(create project → PUT the clip → delete) driven by curl, which streams from
disk. N parallel uploads cost N sockets and almost no memory. k6 still drives
the API-concurrency track, where each virtual user carries only the 5.4 MB
proxy.

This is worth stating plainly: **the load generator, not the product, is what
broke first when the footage became realistic.**

## Results

_(filled in as the stages land)_

### Track A — real 532 MB clip

| Users | Sessions | Jobs done | Jobs lost | Uploaded | HTTP p50 / p95 | `PUT files/*` p50 / p95 | Errors |
|---|---|---|---|---|---|---|---|

### Track B — 5.4 MB proxy, no normalized push

| Users | Sessions | Jobs done | Jobs lost | HTTP req/s | HTTP p50 / p95 | Queue wait p50 | Errors |
|---|---|---|---|---|---|---|---|
