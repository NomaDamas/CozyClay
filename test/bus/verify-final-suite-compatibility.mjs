import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const file of ['test/verify-first-shot-handoff.mjs', 'test/verify-layout.mjs', 'test/verify-hierarchy.mjs', 'test/verify-scenes.mjs', 'test/verify-studio-undo-hygiene.mjs']) {
  test(`#496.4 the existing ${file} contract survives removal of native writers`, () => {
    const result = spawnSync(process.execPath, [file], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}
