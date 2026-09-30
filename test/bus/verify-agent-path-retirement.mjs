import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseSync } from 'rolldown/experimental';
import { STUDIO_TOOL_FAMILIES } from '../../src/studio-agent-protocol.js';
import { agentPathLoc } from './agent-path-loc.mjs';
const source = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
test('#495.4: only generic agent families and command aliases remain', () => {
  assert.deepEqual([...STUDIO_TOOL_FAMILIES].sort(), ['inspect_studio', 'run_action', 'verify_result']);
  assert.doesNotMatch(source('src/studio-agent-commands.js'), /function createStudioCommands\b/);
  assert.doesNotMatch(source('src/studio-elements.js'), /agentExposure/);
  assert.doesNotMatch(source('src/domains/objects.js'), /createLegacyObjectHandlers/);
  assert.doesNotMatch(source('src/domains/motion.js'), /loadLiveMotion/);
  const names = new Set(['set_camera', 'add_character', 'update_character', 'remove_character', 'place_object', 'update_object', 'remove_object', 'group_objects', 'ungroup_objects', 'apply_batch', 'set_prompt_blocks', 'load_motion', 'load_scenes', 'import_asset']);
  const ast = parseSync('App.jsx', source('src/App.jsx')).program;
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property') assert.equal(names.has(node.key.name ?? node.key.value), false, `legacy live mutator ${node.key.name}`);
    for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(visit) : typeof value === 'object' && visit(value);
  }; visit(ast);
  assert.doesNotMatch(source('mcp/tool-handlers.mjs'), /fetch\(`\$\{bridge\}\/ardy\/generate/);
});
test('#495.4: the measured Studio-specific agent layer is below 800 LOC', () => {
  const measured = agentPathLoc(); console.log(JSON.stringify(measured));
  assert.ok(measured.total < 800, `agent-only LOC: ${measured.total}`);
});
