# k6 load generator for Noey Studio — meant to run NEXT TO the deployment under
# test (a Railway service in the "loadtest" environment), never on the owner's
# laptop: a load generator sharing a CPU with anything else skews its own
# numbers.
#
# Build context is the repo's loadtest/ folder:
#   docker build -f runner/Dockerfile -t noey-loadtest .
#
# It runs the script once and exits; the summary is ONE line on stdout prefixed
# LOADTEST_SUMMARY, so it can be read straight out of the Railway logs:
#   railway logs --service loadtest-runner | grep LOADTEST_SUMMARY
#
# Configure with env vars (see k6/editor.js): BASE_URL, RAMP, RAMP_SEC,
# HOLD_SEC, IDLE_SEC, POLL_SEC, JOB_TIMEOUT_SEC, CLEANUP, ENGINE, PRECISION,
# CLIP_PROFILE, PUSH_NORMALIZED and one of TOKENS_B64 / TOKENS_FILE /
# USERS_B64 / USERS_FILE.

# ── fixtures ──────────────────────────────────────────────────────────────────
# The realistic clip is half a gigabyte, so it is ENCODED HERE rather than
# committed or uploaded: `railway up` would otherwise ship 532 MB from the
# owner's laptop on every deploy, over a connection far slower than the builder's
# own CPU. The parameters are the ones the product actually produces —
# `desktop/sidecar/sidecar/proxy.py` scales to 480 high at 12 fps, CRF 28, no
# audio — so the proxy here is the size a real proxy is.
#
# Synthetic footage compresses better than a real camera's, so treat the proxy
# size as a floor, not an average.
FROM jrottenberg/ffmpeg:6.1-alpine AS fixtures
WORKDIR /out

# A phone's portrait clip: 1080x1920, 7 minutes, ~10 Mbit/s → ~530 MB.
# Bitrate is pinned rather than CRF-chosen so synthetic content cannot encode
# down to an unrealistic size.
RUN ffmpeg -v error -y \
      -f lavfi -i "testsrc2=size=1080x1920:rate=30" \
      -f lavfi -i "sine=frequency=330:sample_rate=48000" \
      -t 420 -c:v libx264 -preset veryfast -b:v 10M -maxrate 12M -bufsize 20M \
      -pix_fmt yuv420p -c:a aac -b:a 128k -ac 2 -movflags +faststart \
      clip_long.mp4 \
 && ffmpeg -v error -y -i clip_long.mp4 -vf "scale=-2:480,fps=12" -an \
      -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p -movflags +faststart \
      proxy_long.mp4

FROM grafana/k6:latest

USER root
WORKDIR /loadtest
COPY k6/ ./k6/
COPY fixtures/ ./fixtures/
COPY --from=fixtures /out/clip_long.mp4 /out/proxy_long.mp4 ./fixtures/
RUN chown -R k6:k6 /loadtest
USER k6

ENV RAMP=10,50,100,200,500 \
    RAMP_SEC=60 \
    HOLD_SEC=300 \
    IDLE_SEC=60 \
    POLL_SEC=2 \
    JOB_TIMEOUT_SEC=900 \
    K6_NO_USAGE_REPORT=true

# --quiet: the progress bar is noise in a log stream; the summary line is the
# output that matters. Any flag can still be appended on the command line.
ENTRYPOINT ["k6", "run", "--quiet", "/loadtest/k6/editor.js"]
