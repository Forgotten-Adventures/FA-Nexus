// The Path runtime owns its programs, texture cache, cleanup queues, and
// rehydration state. Premium editors receive only the audited geometry surface,
// resolved through the canonical stable runtime module.
export {
  computeSamplesFromPoints,
  createMeshFromSamples,
  createPathShader
} from './path-geometry.js';
