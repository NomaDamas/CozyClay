import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = spawnSync(process.execPath, ['tools/run-tests.mjs', '--list'], { encoding: 'utf8' });
assert.equal(manifest.status, 0, manifest.stderr);
const runnable = new Set([...manifest.stdout.matchAll(/^RUN node (\S+)/gm)].map(match => match[1]));
for (const file of readdirSync(new URL('.', import.meta.url)).filter(file => /^verify-.*\.mjs$/.test(file))) assert.ok(runnable.has(`test/bus/${file}`), file);
assert.ok(runnable.size >= 222, `${runnable.size} runnable verification files`);
const shardRuns = [1, 2].map(shard => {
	const result = spawnSync(process.execPath, ['tools/run-tests.mjs', '--list', '--shard', `${shard}/2`], { encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return new Set([...result.stdout.matchAll(/^RUN node (\S+)/gm)].map(match => match[1]));
});
assert.equal(new Set([...shardRuns[0], ...shardRuns[1]]).size, runnable.size, 'shards cover every runnable file');
assert.equal(new Set([...shardRuns[0]].filter(file => shardRuns[1].has(file))).size, 0, 'shards do not overlap');
console.log(`PASS bus acceptance 9: manifest includes bus tests and disjoint shards (${runnable.size} Node files)`);
