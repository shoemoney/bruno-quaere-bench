#!/usr/bin/env bash
# Launches every lineup model in .quaere/settings.json as its own detached
# `caffeinate -i -s node bin/quaere.js run ...` process -- one full climb per model, seeded
# base+i (i = the model's 0-based position in the settings file), sharing the same wall/skill
# budget. See CLAUDE.md's "Running a calibration round" for the manual single-model form this
# fans out; this script is the whole-round version for it.
#
# Usage: scripts/launch-round.sh <base-seed>
#
# Requires .quaere/settings.json (run `node bin/quaere.js doctor --no-smoke` first if it's
# missing -- this script does that for you, once, the first time it doesn't find one).
#
# Bash, not zsh (this repo's other scripts are bash; a zsh `for p in $paths` word-splits
# differently and has bitten a prior round -- CLAUDE.md's "Running a calibration round").
#
# NEVER echoes a key value, NEVER writes one to a log file, and NEVER `set -x`s (which would
# trace exported env vars into this script's own stdout). A key only ever lives in a bash
# variable, in scope for the one `caffeinate` command it is prefixed onto.

set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SETTINGS_FILE="$ROOT_DIR/.quaere/settings.json"

BASE_SEED="${1:-}"
if [ -z "$BASE_SEED" ]; then
  echo "usage: scripts/launch-round.sh <base-seed>" >&2
  exit 1
fi
case "$BASE_SEED" in
  ''|*[!0-9]*)
    echo "launch-round: <base-seed> must be a non-negative integer, got: $BASE_SEED" >&2
    exit 1
    ;;
esac

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "launch-round: $SETTINGS_FILE is missing -- running 'node bin/quaere.js doctor --no-smoke' first" >&2
  node "$ROOT_DIR/bin/quaere.js" doctor --no-smoke || {
    echo "launch-round: doctor failed to produce $SETTINGS_FILE" >&2
    exit 1
  }
fi
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "launch-round: doctor ran but $SETTINGS_FILE still does not exist" >&2
  exit 1
fi

OUT_DIR="/tmp/quaere-round-$BASE_SEED"
mkdir -p "$OUT_DIR"

# One line per lineup model: "<index>\t<id>\t<driver>\t<cli-or-dash>", in the settings file's own
# key order (doctor writes it from settings.js's LINEUP, in lineup order; JSON preserves it).
# A plain node --input-type=module one-liner rather than a dependency -- this repo is zero-deps.
MODEL_LINES="$(node --input-type=module -e "
  import fs from 'node:fs';
  const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
  const models = settings.models || {};
  let i = 0;
  for (const [id, info] of Object.entries(models)) {
    console.log([i, id, info.driver, info.cli || '-'].join('\t'));
    i += 1;
  }
")" || { echo "launch-round: could not read models from $SETTINGS_FILE" >&2; exit 1; }

if [ -z "$MODEL_LINES" ]; then
  echo "launch-round: $SETTINGS_FILE has no models -- nothing to launch" >&2
  exit 1
fi

# fetchProviderKey(provider) -> the key VALUE on stdout, nothing else -- captured into a bash
# variable via command substitution by the caller, never echoed or logged by this script.
# google/deepseek come from aigate; openrouter's own search order (settings.js
# findOpenrouterKey()) lands on ./.env for this repo -- both are "the settings module's file-only
# sources" the brief calls for, not an operator's already-exported shell env var.
fetch_provider_key() {
  local provider="$1"
  node --input-type=module -e "
    import { findProviderKey, readProviderKey, findOpenrouterKey, readOpenrouterKey } from '$ROOT_DIR/src/harness/settings.js';
    const provider = '$provider';
    try {
      if (provider === 'openrouter') {
        const record = await findOpenrouterKey({ repoRoot: '$ROOT_DIR' });
        if (!record.found) throw new Error('no openrouter key found');
        process.stdout.write(await readOpenrouterKey(record, {}));
      } else {
        const record = await findProviderKey(provider, {});
        if (!record.found) throw new Error(\`no \${provider} key found\`);
        process.stdout.write(await readProviderKey(provider, record, {}));
      }
    } catch (err) {
      process.stderr.write(\`fetch_provider_key(\${provider}): \${err.message}\n\`);
      process.exit(1);
    }
  "
}

echo "launch-round: base seed $BASE_SEED, logs under $OUT_DIR"

while IFS=$'\t' read -r idx id driver cli; do
  [ -n "$id" ] || continue
  seed=$((BASE_SEED + idx))
  name="${id//\//-}"
  log="$OUT_DIR/$name.log"

  args=(run --yes --model "$id" --seed "$seed" --attempts 1 --skill-mode sloppy --skill-bytes 5000000 --wall-ms 21600000)

  key_var=""
  key_val=""
  case "$driver" in
    cli)
      args=(--driver cli --cli "$cli" "${args[@]}")
      ;;
    google)
      args=(--driver google "${args[@]}")
      key_var="GEMINI_API_KEY"
      ;;
    deepseek)
      args=(--driver deepseek "${args[@]}")
      key_var="DEEPSEEK_API_KEY"
      ;;
    xai)
      args=(--driver xai "${args[@]}")
      key_var="XAI_API_KEY"
      ;;
    openrouter)
      args=(--driver openrouter "${args[@]}")
      key_var="OPENROUTER_API_KEY"
      ;;
    *)
      echo "launch-round: $id -- unrecognized driver \"$driver\", skipping" >&2
      continue
      ;;
  esac

  if [ -n "$key_var" ]; then
    provider="$driver"
    key_val="$(fetch_provider_key "$provider")" || {
      echo "launch-round: $id -- could not fetch a $provider key, skipping" >&2
      continue
    }
  fi

  if [ -n "$key_var" ]; then
    env "$key_var=$key_val" caffeinate -i -s node "$ROOT_DIR/bin/quaere.js" "${args[@]}" \
      >"$log" 2>&1 </dev/null &
  else
    caffeinate -i -s node "$ROOT_DIR/bin/quaere.js" "${args[@]}" \
      >"$log" 2>&1 </dev/null &
  fi
  pid=$!
  disown "$pid" 2>/dev/null || true
  unset key_val
  echo "launch-round: $name seed=$seed pid=$pid log=$log"
done <<< "$MODEL_LINES"

echo "launch-round: all lineup models launched. Watch with:"
echo "  bash -c 'until find $ROOT_DIR/runs -path \"*/<seed>/1/result.json\" 2>/dev/null | grep -q .; do sleep 5; done'"
