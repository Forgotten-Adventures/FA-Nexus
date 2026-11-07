import {COMPOSITION_COLLECTIONS} from './scene-group-snapshot.js';
import {readSemanticTileFlags} from './scene-group-tile-transform.js';
import {createCompositionScene, transformCompositionScene, reprojectCompositionSceneGrid} from './scene-group-copy-runtime.js';

// Foundry's Scene autoReposition bypasses embedded Tile transform hooks. Plan
// the Nexus-owned closure with the ordinary composition adapters before the
// same Scene update is persisted; unrelated native documents keep core's plan.
export function projectCompositionSceneReposition(scene, changes, options) {
  if (!options?.autoReposition) return false;
  const scaleX = Number(changes.width ?? scene.width) / scene.width;
  const scaleY = Number(changes.height ?? scene.height) / scene.height;
  const documents = Object.entries(COMPOSITION_COLLECTIONS).flatMap(([type, key]) =>
    Array.from(scene[key], doc => ({type, doc})));
  const registry = scene.getFlag('fa-nexus', 'compositionRegistry');
  const selected = new Set(Object.values(registry?.groups || {}).flatMap(group => group.directMemberUuids));
  for (const {type, doc} of documents) if (type === 'Tile' && readSemanticTileFlags(doc)) selected.add(doc.uuid);
  for (const uuid of selected) for (const relation of registry?.relationships || []) {
    if (relation.ownerUuid === uuid) selected.add(relation.dependentUuid);
  }
  if (!selected.size) return false;
  const reference = documents.find(({type}) => ['Tile', 'AmbientLight', 'AmbientSound'].includes(type))
    || documents.find(({type}) => type === 'Wall') || documents.find(({type}) => type === 'Region');
  const native = reference && changes[COMPOSITION_COLLECTIONS[reference.type]]?.find(patch => patch._id === reference.doc.id);
  if (!native) throw new Error('Cannot reposition Scene: the composition has no native position plan.');
  let origin, destination;
  if (reference.type === 'Wall') {
    origin = {x: reference.doc.c[0], y: reference.doc.c[1]};destination = {x: native.c[0], y: native.c[1]};
  } else if (reference.type === 'Region') {
    const projected = reference.doc.clone();projected.updateSource(native);
    origin = reference.doc.shapes[0].origin;destination = projected.shapes[0].origin;
  } else {origin = reference.doc;destination = native;}
  const delta = {x: destination.x - Math.round(origin.x * scaleX),
    y: destination.y - Math.round(origin.y * scaleY)};
  if (!(scaleX > 0 && scaleY > 0) || Math.abs(scaleX - scaleY) > 1e-9) {
    throw new Error('Cannot reposition Scene compositions with a non-uniform resize. Keep the Scene aspect ratio or resize without repositioning objects.');
  }
  const included = documents.filter(({doc}) => selected.has(doc.uuid));
  if (included.length !== selected.size) throw new Error('Cannot reposition Scene: a composition member is missing.');
  const snapshot = {sceneId: scene.id, grid: scene.toObject().grid, levels: scene.toObject().levels,
    registry: structuredClone(registry || {schemaVersion: 1, groups: {}, relationships: [], wallVisibilityStates: {}}),
    documents: included.map(({type, doc}) => ({type, source: doc.toObject()}))};
  const virtual = createCompositionScene(snapshot);
  if (scaleX !== 1) transformCompositionScene(virtual, {x: 0, y: 0}, {operation: 'scale', factor: scaleX});
  if (delta.x || delta.y) transformCompositionScene(virtual, {x: 0, y: 0}, {operation: 'move', delta});
  const grid = foundry.utils.mergeObject(scene.toObject().grid, changes.grid || {}, {inplace: false});
  if (changes['grid.size'] !== undefined) grid.size = changes['grid.size'];
  reprojectCompositionSceneGrid(virtual, grid);
  for (const [type, key] of Object.entries(COMPOSITION_COLLECTIONS)) {
    const patches = new Map((changes[key] || []).map(patch => [patch._id, patch]));
    for (const {doc} of included.filter(item => item.type === type)) {
      const target = virtual.getEmbeddedDocument(type, doc.id).toObject();
      const patch = foundry.utils.diffObject(doc.toObject(), target, {bidirectional: true});
      // Core rounds native positions and Region pivots even for a grid-only
      // reposition. The unchanged semantic pose must cancel those patches,
      // including clamped Tile positions, while retaining non-geometric data.
      const nativePatch = patches.get(doc.id);
      const nativeGeometry = type === 'Region' ? ['shapes'] : type === 'Wall' ? ['c']
        : type === 'Tile' ? ['x', 'y', 'width', 'height'] : ['x', 'y'];
      for (const key of nativeGeometry) if (nativePatch && Object.hasOwn(nativePatch, key)) patch[key] = target[key];
      if (!Object.keys(patch).length) continue;
      patches.set(doc.id, foundry.utils.mergeObject(patches.get(doc.id) || {_id: doc.id}, patch, {inplace: false}));
    }
    if (patches.size) changes[key] = [...patches.values()];
  }
  if (registry) foundry.utils.setProperty(changes, 'flags.fa-nexus.compositionRegistry',
    foundry.utils.diffObject(registry, virtual.getFlag('fa-nexus', 'compositionRegistry'), {bidirectional: true}));
  return true;
}
