import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const source = files(join(root, 'src')).filter(path => /\.(jsx?|tsx?)$/.test(path));
for (const symbol of ['charHistoryRef', 'recordCharacterUndo', 'opClockRef']) {
  const hits = source.flatMap(path => [...readFileSync(path, 'utf8').matchAll(new RegExp(symbol, 'g'))].map(() => relative(root, path)));
  assert.deepEqual(hits, [], `${symbol} has no remaining source references`);
}
assert.equal(existsSync(join(root, 'src/scene-history.js')), false, 'object history is folded into the document store');
assert.equal(existsSync(join(root, 'src/store/legacy-adapter.js')), false, 'the unused legacy state adapter is removed');
console.log('PASS #494.2 zero native history symbols, separate scene history or legacy state adapter');
