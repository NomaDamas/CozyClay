import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
const root = new URL('../../src/', import.meta.url);
function sources(url) { return readdirSync(url, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(new URL(`${entry.name}/`, url)) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [new URL(entry.name, url)] : []); }
test('#495.1: generic document reads and kind.set replace duplicate readers and appliers', () => {
  for (const url of sources(root)) assert.doesNotMatch(readFileSync(url, 'utf8'), /\b(PATH_READERS|inspectScopes)\b/, url.pathname);
  const source = readFileSync(new URL('studio-agent-commands.js', root), 'utf8');
  assert.doesNotMatch(source, /function (patchCharacters|patchObjects|patchShot|patchStage|patchTargetRead)\b/);
});
