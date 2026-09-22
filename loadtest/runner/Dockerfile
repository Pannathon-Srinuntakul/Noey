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
# HOLD_SEC, IDLE_SEC, POLL_SEC, JOB_TIMEOUT_SEC, CLEANUP, ENGINE, PRECISION and
# one of TOKENS_B64 / TOKENS_FILE / USERS_B64 / USERS_FILE.
FROM grafana/k6:latest

USER root
WORKDIR /loadtest
COPY k6/ ./k6/
COPY fixtures/ ./fixtures/
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
