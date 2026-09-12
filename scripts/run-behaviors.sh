#!/usr/bin/env bash
# Boots a quaere instance, runs the collections/behaviors OpenCollection against it with
# `bru run`, prints pass/fail counts, tears the server down, and exits nonzero on any failure
# (bru itself missing, the server never coming up, or any behavior test failing).
#
# Env overrides: SEED (default 1), PORT / ADMIN_PORT (default 0 = let the OS pick a free port).
#
# Ports default to 0 on purpose. node's listen(PORT) with no host binds [::], which on macOS does
# NOT collide with another process already holding 127.0.0.1:PORT -- so a hardcoded 8080 can
# "start fine" while every curl to 127.0.0.1:8080 lands on the stranger's server instead. The
# readiness probe below therefore also checks it is talking to *this* quaere (a real bearer token
# for this seed's api key), not merely to something that answers.

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SEED="${SEED:-1}"
PORT="${PORT:-0}"
ADMIN_PORT="${ADMIN_PORT:-0}"
REPORT_JSON="${REPORT_JSON:-/tmp/quaere-behaviors.json}"

if ! command -v bru >/dev/null 2>&1; then
  echo "run-behaviors: 'bru' is not on PATH. Install the Bruno CLI (npm i -g @usebruno/cli)." >&2
  exit 1
fi
if [ ! -f "$ROOT_DIR/bin/quaere.js" ]; then
  echo "run-behaviors: $ROOT_DIR/bin/quaere.js not found" >&2
  exit 1
fi

# The collection's environment file hardcodes seed 1's credentials; derive them from the world so
# a SEED override actually works, and hand them to bru as --env-var.
CREDS="$(node --input-type=module -e "
  import { makeWorld } from '$ROOT_DIR/src/world.js';
  const w = makeWorld(${SEED});
  console.log(w.auth.apiKey);
  console.log(w.auth.secret);
")" || { echo "run-behaviors: could not derive credentials for seed $SEED" >&2; exit 1; }
API_KEY="$(printf '%s\n' "$CREDS" | sed -n 1p)"
HMAC_SECRET="$(printf '%s\n' "$CREDS" | sed -n 2p)"

SERVER_LOG="$(mktemp -t quaere-serve)"
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -f "$SERVER_LOG"
}
trap cleanup EXIT INT TERM

echo "run-behaviors: starting bin/quaere.js serve --seed $SEED --port $PORT --admin-port $ADMIN_PORT"
node "$ROOT_DIR/bin/quaere.js" serve --seed "$SEED" --port "$PORT" --admin-port "$ADMIN_PORT" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# quaere serve prints the port it actually bound; with PORT=0 that is the only way to learn it.
BASE_URL=""
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "run-behaviors: server process exited before it came up" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  BASE_URL="$(sed -n 's|^public  *\(http://127\.0\.0\.1:[0-9]*\).*$|\1|p' "$SERVER_LOG" | head -n 1)"
  [ -n "$BASE_URL" ] && break
  sleep 0.1
done
if [ -z "$BASE_URL" ]; then
  echo "run-behaviors: server never printed its public URL" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi

echo "run-behaviors: waiting for ${BASE_URL}/auth/token ..."
UP=0
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "run-behaviors: server process exited before it came up" >&2
    cat "$SERVER_LOG" >&2
    exit 1
  fi
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${BASE_URL}/auth/token" \
    -H 'content-type: application/json' -d "{\"api_key\":\"${API_KEY}\",\"apiKey\":\"${API_KEY}\"}" 2>/dev/null)"
  if [ "$CODE" = "200" ]; then
    UP=1
    break
  fi
  sleep 0.1
done
if [ "$UP" -ne 1 ]; then
  echo "run-behaviors: nothing at ${BASE_URL}/auth/token issued a token for seed ${SEED}" >&2
  cat "$SERVER_LOG" >&2
  exit 1
fi
echo "run-behaviors: server is up at ${BASE_URL}"

echo "run-behaviors: bru run collections/behaviors --env local -r --sandbox developer (baseUrl=$BASE_URL)"
# bru run insists the path it's given is a collection root relative to the CWD ("You can run
# only at the root of a collection" otherwise), so cd into it rather than pass an absolute path.
# --env-var overrides environments/local.yml so this run uses the port and seed it actually got.
(
  cd "$ROOT_DIR/collections/behaviors" &&
  bru run . --env local \
    --env-var "baseUrl=${BASE_URL}" \
    --env-var "apiKey=${API_KEY}" \
    --env-var "hmacSecret=${HMAC_SECRET}" \
    -r --sandbox developer --reporter-json "$REPORT_JSON"
)
BRU_EXIT=$?

node -e "
  const fs = require('fs');
  let summary;
  try {
    const raw = JSON.parse(fs.readFileSync('$REPORT_JSON', 'utf8'));
    const iterations = Array.isArray(raw) ? raw : [raw];
    summary = iterations.reduce((acc, it) => {
      const s = it.summary || it;
      acc.totalRequests += s.totalRequests || 0;
      acc.passedRequests += s.passedRequests || 0;
      acc.failedRequests += s.failedRequests || 0;
      acc.totalTests += s.totalTests || 0;
      acc.passedTests += s.passedTests || 0;
      acc.failedTests += s.failedTests || 0;
      return acc;
    }, { totalRequests: 0, passedRequests: 0, failedRequests: 0, totalTests: 0, passedTests: 0, failedTests: 0 });
  } catch (err) {
    console.error('run-behaviors: could not read reporter JSON at $REPORT_JSON:', err.message);
    process.exit(1);
  }
  console.log('run-behaviors: requests ' + summary.passedRequests + '/' + summary.totalRequests +
    ' passed, tests ' + summary.passedTests + '/' + summary.totalTests + ' passed');
  if (summary.failedRequests > 0 || summary.failedTests > 0 || summary.totalTests === 0) {
    process.exit(1);
  }
"
SUMMARY_EXIT=$?

if [ "$BRU_EXIT" -ne 0 ] || [ "$SUMMARY_EXIT" -ne 0 ]; then
  echo "run-behaviors: FAIL"
  exit 1
fi

echo "run-behaviors: PASS"
exit 0
