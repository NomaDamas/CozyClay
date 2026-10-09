import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const manifest = spawnSync(process.execPath, ['tools/run-tests.mjs', '--list'], { encoding: 'utf8' });
assert.equal(manifest.status, 0, manifest.stderr);
const runnable = new Set([...manifest.stdout.matchAll(/^RUN node (\S+)/gm)].map(match => match[1]));
for (const file of readdirSync(new URL('.', import.meta.url)).filter(file => /^verify-.*\.mjs$/.test(file))) assert.ok(runnable.has(`test/bus/${file}`), file);
assert.ok(runnable.size >= 222, `${runnable.size} runnable verification files`);
// ci.yml and pages.yml run the suite on four shards (#666); two stays covered
// for local half-runs. Every total must partition the runnable set.
for (const total of [2, 4]) {
	const shardRuns = Array.from({ length: total }, (_, index) => {
		const result = spawnSync(process.execPath, ['tools/run-tests.mjs', '--list', '--shard', `${index + 1}/${total}`], { encoding: 'utf8' });
		assert.equal(result.status, 0, result.stderr);
		return [...result.stdout.matchAll(/^RUN node (\S+)/gm)].map(match => match[1]);
	});
	const union = shardRuns.flat();
	assert.equal(new Set(union).size, union.length, `shards of ${total} do not overlap`);
	assert.equal(new Set(union).size, runnable.size, `shards of ${total} cover every runnable file`);
	for (const files of shardRuns) assert.ok(files.length >= Math.floor(runnable.size / total), `shards of ${total} are evenly sized`);
}
console.log(`PASS bus acceptance 9: manifest includes bus tests and disjoint shards (${runnable.size} Node files)`);
