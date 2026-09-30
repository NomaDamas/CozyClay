// Count nonblank, non-comment source lines in the Studio-specific agent layer.
// Shared bus/protocol schemas, domain geometry planners and the command journal
// serve UI commands too and are excluded. MCP transport and memory-only tools
// are not Studio duplicate paths; its generation/load handlers are included.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSync } from 'rolldown/experimental';
const root = new URL('../../', import.meta.url);
export function agentPathLoc(revision) {
  const read = path => revision ? execFileSync('git', ['show', `${revision}:${path}`], { cwd: root, encoding: 'utf8' }) : readFileSync(new URL(path, root), 'utf8');
  const counts = {};
  function count(path, select = () => true, shared = new Set()) {
    const source = read(path), parsed = parseSync(path, source), ranges = [];
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (select(node)) { ranges.push([node.start, node.end]); return; }
      for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(walk) : typeof value === 'object' && walk(value);
    };
    walk(parsed.program);
    const chars = source.split('').map(() => ' ');
    for (const [start, end] of ranges) for (let i = start; i < end; i++) chars[i] = source[i];
    function exclude(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'FunctionDeclaration' && shared.has(node.id.name)) {
        for (let i = node.start; i < node.end; i++) chars[i] = ' ';
        return;
      }
      for (const [key, value] of Object.entries(node)) if (key !== 'parent') Array.isArray(value) ? value.forEach(exclude) : typeof value === 'object' && exclude(value);
    }
    exclude(parsed.program);
    for (const comment of parsed.comments ?? []) for (let i = comment.start; i < comment.end; i++) chars[i] = source[i] === '\n' ? '\n' : ' ';
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') chars[i] = '\n';
    counts[path] = chars.join('').split('\n').filter(line => line.trim()).length;
  }
  // These three binding functions supply read/readback/history to the bus for
  // EVERY origin, including UI. Exclude them at both revisions, not by filename.
  count('src/studio-app-binding.js', () => true, new Set(['refresh', 'actionReadback', 'commandBus']));
  for (const path of ['src/studio-agent-context.js', 'src/studio-agent-motion.js', 'bin/agent/studio-tools.mjs', 'bin/agent/studio-prompt.mjs']) count(path);
  const privateFunctions = new Set(['survives', 'patchedValue', 'patchCharacters', 'patchObjects', 'patchShot', 'patchStage', 'patchPlan', 'patchTargetRead', 'readback', 'createStudioCommands']);
  count('src/studio-agent-commands.js', node => node.type === 'FunctionDeclaration' && privateFunctions.has(node.id.name) || node.type === 'VariableDeclaration' && node.declarations.some(d => ['PATH_READERS', 'DOMAIN_KEYS', 'domainState', 'withDomain'].includes(d.id.name)));
  // Follow the same named regions through shell extractions at either revision.
  // UI JSX is shared, not an agent-only path, so moving a panel adds zero LOC.
  const shellPaths = revision
    ? execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'src/shell'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    : readdirSync(new URL('src/shell/', root), { recursive: true }).map(path => `src/shell/${path}`);
  for (const path of ['src/App.jsx', ...shellPaths.filter(path => /\.(js|jsx)$/.test(path)).sort()]) {
    const source = read(path);
    count(path, node => node.type === 'FunctionDeclaration' && node.id.name === 'operateStudio' || node.type === 'IfStatement' && source.slice(node.test.start, node.test.end) === '!liveHandlersRef.current' || node.type === 'VariableDeclaration' && node.declarations.some(item => item.id.name === 'liveQueries'));
  }
  count('src/domains/motion.js', node => node.type === 'FunctionDeclaration' && node.id.name === 'loadLiveMotion');
  count('mcp/tool-handlers.mjs', node => node.type === 'CallExpression' && node.callee.name === 'tool' && ['generate_motion', 'load_motion'].includes(node.arguments[0]?.value));
  return { method: 'Nonblank source lines after removing parser comments; fixed adapter files plus named duplicate-path AST regions. Shared geometry, journal, schemas, binding refresh/actionReadback/commandBus, transport and memory-only MCP tools excluded.', counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}
if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) console.log(JSON.stringify(agentPathLoc(process.argv[2]), null, 2));
