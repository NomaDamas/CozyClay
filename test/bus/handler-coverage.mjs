import assert from 'node:assert/strict';
import { parseSync } from 'rolldown/experimental';
import { writerName, isRunCall } from './verify-bus-coverage.mjs';

// Static reachability, not proximity to the next `run` in the file. Follow
// lexical callback/alias bindings; a hover or a registered transient command
// is not a document edit. Opaque forwarded props are measured at their binding
// site, not counted again in a child that knows nothing about their effects.
export function handlerCoverage(source, file, declarations) {
  const parsed = parseSync(file, source);
  assert.deepEqual(parsed.errors, [], file);
  const kinds = new Map(declarations.map(command => [command.id, command.kind]));
  const scopes = new WeakMap(), handlers = [];
  const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
  const children = node => Object.entries(node).filter(([key]) => key !== 'parent' && key !== 'loc')
    .flatMap(([, value]) => Array.isArray(value) ? value : [value]).filter(value => value && typeof value === 'object');
  function index(node, scope) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration') scope.bindings.set(node.id.name, node);
    if (node.type === 'Program' || node.type === 'BlockStatement' || functions.has(node.type)) scope = { parent: scope, bindings: new Map() };
    scopes.set(node, scope);
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier') scope.bindings.set(node.id.name, node.init);
    if (node.type === 'JSXAttribute' && /^on[A-Z]/.test(node.name.name) && node.value?.type === 'JSXExpressionContainer') handlers.push(node.value.expression);
    for (const child of children(node)) index(child, scope);
  }
  index(parsed.program, { bindings: new Map() });
  const resolve = (name, scope) => {
    for (let current = scope; current; current = current.parent) if (current.bindings.has(name)) return current.bindings.get(name);
  };
  function effects(root) {
    const found = { run: false, writer: false }, seen = new Set();
    function visit(node, callable = false) {
      if (!node || seen.has(node) || functions.has(node.type) && !callable) return;
      seen.add(node);
      if (functions.has(node.type)) { visit(node.body); return; }
      if (node.type === 'Identifier') {
        if (writerName(node.name)) found.writer = true;
        else if (callable) visit(resolve(node.name, scopes.get(node)), true);
        return;
      }
      if (node.type === 'MemberExpression') {
        const name = node.computed ? node.property.value : node.property.name;
        if (writerName(name)) found.writer = true;
        return;
      }
      if (node.type === 'CallExpression') {
        if (isRunCall(node) || node.callee.type === 'Identifier' && node.callee.name === 'runStudioAction') {
          const id = node.arguments[0]?.value;
          // Dynamic command ids and transaction controls conservatively count.
          if (kinds.get(id) !== 'transient') found.run = true;
        } else visit(node.callee, true);
        for (const argument of node.arguments) visit(argument, true);
        return;
      }
      if (node.type === 'Property') { if (node.computed) visit(node.key); visit(node.value, callable); return; }
      if (node.type === 'VariableDeclarator') { visit(node.init); return; }
      for (const child of children(node)) visit(child, callable);
    }
    visit(root, true);
    return found;
  }
  const sites = handlers.map(effects).filter(site => site.run || site.writer);
  return { handlerTotal: sites.length, handlerSites: sites.filter(site => site.run && !site.writer).length };
}
