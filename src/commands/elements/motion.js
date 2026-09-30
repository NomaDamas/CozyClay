import { registerElementKind } from '../elements.js';
import { wrapAngle } from '../../scene-objects.js';

const elements = [
  ...['anchorX', 'anchorZ', 'rotationDeg'].map(field => ({ path: `motion.take.${field}`, type: 'number' })),
  { path: 'motion.take.prompt', type: 'string' },
  { path: 'motion.ikKeys', type: 'array', readOnly: true },
  { path: 'motion.takeRecipe', type: 'object', readOnly: true },
  { path: 'motion.takeVersions', type: 'array', readOnly: true },
];
registerElementKind('motion', { collection: true, elements, normalize: row => ({ ...row, take: row.take && { ...row.take,
  anchorX: Math.max(-240, Math.min(240, row.take.anchorX ?? 0)), anchorZ: Math.max(-240, Math.min(240, row.take.anchorZ ?? 0)),
  rotationDeg: wrapAngle(row.take.rotationDeg ?? 0),
} }) });
