import { registerElementKind } from '../elements.js';

// Array position is the authoritative order. The owner refreshes this persisted
// field after every move, so generic set/read and the project file agree.
registerElementKind('scene', {
  collection: true, documentKey: 'scenes',
  elements: [
    { path: 'scene.name', type: 'string' },
    { path: 'scene.order', type: 'number' },
  ],
  normalize: scene => ({ ...scene, name: scene.name.trim(), order: Math.max(0, Math.round(scene.order)) }),
});
registerElementKind('project', {
  elements: [{ path: 'project.name', type: 'string' }],
  normalize: project => project,
});
