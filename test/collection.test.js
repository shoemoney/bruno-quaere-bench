// Runs scripts/run-behaviors.sh end-to-end: boots a seed-1 server, runs the
// collections/behaviors OpenCollection against it with `bru run --sandbox developer`, and
// checks the script exits 0. Skipped (not failed) when `bru` isn't on PATH, since the Bruno CLI
// is a dev/CI tool, not a runtime dependency of this package.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function hasBru() {
  const result = spawnSync('bru', ['--version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

test('collections/behaviors: all 16 behaviors pass against a live seed-1 server', { timeout: 60_000 }, (t) => {
  if (!hasBru()) {
    t.skip("bru is not on PATH; install the Bruno CLI (npm i -g @usebruno/cli) to run this suite");
    return;
  }

  // Ports picked high and unusual, and independent of collections/behaviors/environments/local.yml
  // (which is fixed at 8080/8081 for a human running scripts/run-behaviors.sh directly), so this
  // test doesn't collide with anything else already listening on the machine running `npm test`.
  const reportJson = path.join(os.tmpdir(), `quaere-behaviors-test-${process.pid}.json`);
  const result = spawnSync('bash', [path.join(repoRoot, 'scripts', 'run-behaviors.sh')], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SEED: '1',
      PORT: '48080',
      ADMIN_PORT: '48081',
      REPORT_JSON: reportJson,
    },
  });

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
  }
  assert.equal(
    result.status,
    0,
    'scripts/run-behaviors.sh should exit 0 (every behavior in collections/behaviors passed via bru run)',
  );
});
