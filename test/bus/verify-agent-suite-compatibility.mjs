import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('#495.5: the existing protocol suite accepts generic families and compatibility aliases', () => {
  const result = spawnSync(process.execPath, ['test/verify-studio-agent-protocol.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
