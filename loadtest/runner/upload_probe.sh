#!/bin/sh
# Track A: how the upload path behaves with the footage a real user shot.
#
# k6 cannot ask this question. `open()` holds the whole file in memory once per
# virtual user, so five users and a 532 MB clip is 2.7 GB before a single byte
# is sent, and the runner is killed before it reports anything (measured
# 2026-09-23: the container exited with no summary at 5 users). curl streams
# from disk, so N parallel uploads cost N sockets and almost no memory.
#
# One session per worker: create a project, PUT the normalized clip, delete it.
# Every upload prints its own line; the last line is UPLOAD_SUMMARY {...} so it
# can be read out of the Railway logs the same way k6's summary is.
#
# Env: BASE_URL, TOKENS_FILE (or TOKENS_B64), CLIP (path), PARALLEL, ROUNDS.
set -u

BASE="${BASE_URL:?BASE_URL is required}"
CLIP="${CLIP:-/loadtest/fixtures/clip_long.mp4}"
PARALLEL="${PARALLEL:-5}"
ROUNDS="${ROUNDS:-2}"
CLIP_SEC="${CLIP_SEC:-420}"
OUT="${OUT_DIR:-/tmp/upload}"

if [ -n "${TOKENS_B64:-}" ]; then
  echo "$TOKENS_B64" | base64 -d > /tmp/tokens.json
  TOKENS_FILE=/tmp/tokens.json
fi
: "${TOKENS_FILE:?TOKENS_FILE or TOKENS_B64 is required}"

BYTES=$(wc -c < "$CLIP")
ACCOUNTS=$(jq 'length' "$TOKENS_FILE")
echo "UPLOAD_START clip=$CLIP bytes=$BYTES parallel=$PARALLEL rounds=$ROUNDS accounts=$ACCOUNTS base=$BASE"

rm -rf "$OUT"; mkdir -p "$OUT"

one() {   # one <worker-index> <round>
  idx="$1"; round="$2"
  tok=$(jq -r ".[$(( (idx + round * PARALLEL) % ACCOUNTS ))].access" "$TOKENS_FILE")
  auth="Authorization: Bearer $tok"

  uid=$(curl -sS -X POST "$BASE/videos/local" -H "$auth" -H 'Content-Type: application/json' \
    -d "{\"mode\":\"dub_first\",\"clips\":[{\"id\":\"clip0\",\"durationSec\":$CLIP_SEC,\"width\":1080,\"height\":1920,\"fps\":30}]}" \
    | jq -r '.uid // empty')
  if [ -z "$uid" ]; then
    echo "CREATE_FAILED worker=$idx round=$round"
    echo "create" >> "$OUT/failures"
    return
  fi

  # -w gives curl's own timing, which is the number that matters here.
  res=$(curl -sS -o /dev/null -w '%{http_code} %{time_total} %{speed_upload}' \
    -X PUT "$BASE/videos/$uid/files/normalized/clip0.mp4" -H "$auth" \
    -F "file=@$CLIP;type=video/mp4")
  code=$(echo "$res" | cut -d' ' -f1)
  secs=$(echo "$res" | cut -d' ' -f2)
  bps=$(echo "$res" | cut -d' ' -f3)
  echo "UPLOAD worker=$idx round=$round status=$code sec=$secs bytes_per_sec=$bps uid=$uid"
  if [ "$code" = "200" ] || [ "$code" = "201" ] || [ "$code" = "204" ]; then
    echo "$secs" >> "$OUT/times"
  else
    echo "$code" >> "$OUT/failures"
  fi

  curl -sS -o /dev/null -X DELETE "$BASE/videos/$uid" -H "$auth"
}

started=$(date +%s)
round=0
while [ "$round" -lt "$ROUNDS" ]; do
  i=0
  while [ "$i" -lt "$PARALLEL" ]; do
    one "$i" "$round" &
    i=$(( i + 1 ))
  done
  wait
  round=$(( round + 1 ))
done
elapsed=$(( $(date +%s) - started ))

ok=$( [ -f "$OUT/times" ] && wc -l < "$OUT/times" || echo 0 )
bad=$( [ -f "$OUT/failures" ] && wc -l < "$OUT/failures" || echo 0 )
stats='{"p50":null,"p95":null,"max":null,"avg":null}'
if [ "$ok" -gt 0 ]; then
  stats=$(sort -n "$OUT/times" | jq -R 'tonumber' | jq -s '{
    p50: (sort | .[(length*0.5|floor)]),
    p95: (sort | .[(length*0.95|floor|if . >= (length) then length-1 else . end)]),
    max: max, avg: (add/length)
  }')
fi
total_bytes=$(( ok * BYTES ))
echo "UPLOAD_SUMMARY $(jq -nc --argjson s "$stats" \
  --arg base "$BASE" --argjson par "$PARALLEL" --argjson rounds "$ROUNDS" \
  --argjson bytes "$BYTES" --argjson ok "$ok" --argjson bad "$bad" \
  --argjson total "$total_bytes" --argjson elapsed "$elapsed" \
  '{base_url:$base, parallel:$par, rounds:$rounds, clip_bytes:$bytes,
    uploads_ok:$ok, uploads_failed:$bad, total_bytes:$total,
    elapsed_sec:$elapsed,
    aggregate_MB_per_sec: (if $elapsed > 0 then (($total/1048576)/$elapsed) else null end),
    upload_sec:$s}')"
