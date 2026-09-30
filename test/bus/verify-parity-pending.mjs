import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const directory = new URL('./parity-pending/', import.meta.url);
assert.equal(existsSync(directory), true, 'parallel domain migrations need separate pending files');
assert.equal(existsSync(new URL('./parity-pending.json', import.meta.url)), false);
assert.deepEqual(readdirSync(directory).sort(), ['cast.json', 'motion.json', 'objects.json', 'project.json', 'shots.json']);
const { readParityPending, pendingErrors } = await import('./verify-parity-matrix.mjs');
const current = readParityPending(directory);
assert.deepEqual(current, [], '#496.3 every domain has completed the parity matrix');
assert.deepEqual(pendingErrors(['shots', 'objects', 'cast', 'motion', 'project'], current), []);
const fixture = mkdtempSync(join(tmpdir(), 'cozyclay-parity-pending-'));
const write = (domain, pending) => writeFileSync(join(fixture, `${domain}.json`), JSON.stringify({ version: 1, pending }));
try {
  write('shots', ['shots']); write('cast', ['cast']);
  assert.throws(() => readParityPending(fixture), assert.AssertionError, '#496.3 reintroducing even known parity debt must fail');
  const before = readParityPending(fixture, { allowPending: true });
  write('shots', []);
  const after = readParityPending(fixture, { allowPending: true });
  assert.deepEqual(after, ['cast']);
  assert.deepEqual(pendingErrors(before, after), []);
  assert.deepEqual(pendingErrors(after, before), ['shots: newly pending']);
  write('cast', []);
  assert.deepEqual(readParityPending(fixture), []);
  write('cast', ['shots']);
  assert.throws(() => readParityPending(fixture), assert.AssertionError, 'pending ids cannot move to another domain file');
  write('cast', ['cast', 'cast']);
  assert.throws(() => readParityPending(fixture), assert.AssertionError, 'duplicate ids cannot inflate pending rows');
} finally { rmSync(fixture, { recursive: true, force: true }); }
console.log('PASS per-domain pending files aggregate independently and preserve the shrink-only ratchet');
