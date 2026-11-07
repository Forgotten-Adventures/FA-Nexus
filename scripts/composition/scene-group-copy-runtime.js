import { SceneGroupWorkflow, readSceneGroupMemberTransformState, buildSceneGroupMemberTransformTarget, resolveSceneGroupMoveDelta,
  transformSceneGroupRelationshipOffsets, getSceneGroupOrientedFrame, getSceneGroupFrame, transformSceneGroupFrame, buildRegistryHistoryDelta } from './scene-group-workflow.js';
import { captureSceneGroupCommandHistoryContext, recordSceneGroupCommand } from './scene-group-command-history.js';
import { readBuildingV2TransformManifest, validateBuildingV2TransformAggregate, buildBuildingV2GeneratedTransformTargets } from '../buildings/v2/building-v2-transform-aggregate.js';
import {projectBuildingV2PortalScalesForSceneGrid} from '../buildings/v2/building-v2-scene-grid-runtime.js';
import { runFoundryCompositionRegistryTransaction } from './composition-registry-transaction.js';
import { sceneGroupInteractionState } from './scene-group-interaction-state.js';
import { resolvePlacementSortAtElevation, sameElevation } from '../canvas/canvas-interaction-controller.js';
import { preserveBuildingFingerprints } from './scene-group-building-fingerprints.js';
import { offsetCompositionDocumentElevations } from './composition-elevation.js';
import { reflectCompositionMember, compositionReflectionBlocker } from './composition-reflection.js';
import { captureCompositionLayerFolders, mergeCompositionLayerFolders, removeCompositionLayerFolders, COMPOSITION_FOLDERS_FLAG } from './composition-layer-folders.js';
import { captureCompositionTree, captureCompositionMembers, compositionIdentityMap, remapCompositionReferences, validateCompositionSnapshot,
  COMPOSITION_COLLECTIONS, PREFAB_SCENE_ID } from './scene-group-snapshot.js';

const clone = value => structuredClone(value);
const randomId = () => foundry.utils.randomID();
// Relative placement uses a finite Level boundary. Foundry's prepared base may
// clamp an open-bottom Level to zero, which does not translate with its bounds.
const levelPlacementElevation = level => Number.isFinite(level.elevation?.bottom) ? level.elevation.bottom
  : (Number.isFinite(level.elevation?.top) ? level.elevation.top : 0);
const levelBottom = level => Number.isFinite(level.elevation?.bottom) ? level.elevation.bottom : -Infinity;
const levelTop = level => Number.isFinite(level.elevation?.top) ? level.elevation.top : Infinity;
const flagPath = 'flags.fa-nexus.compositionRegistry';
const registryUpdate = (scene, next) => ({ _id: scene.id, [flagPath]: foundry.utils.diffObject(
  scene.getFlag('fa-nexus', 'compositionRegistry') || {}, next, { bidirectional: true }) });
const writeOptions = { isUndo: true, faNexusBuildingEditorDocumentWrite: true, faNexusSceneGroupCommand: true,
  faNexusPreserveLinkedTileCleanup: true, faNexusSkipGeneratedCleanup: true };

async function removePlacementResidue(scene, plan, baseline) {
  const registry = clone(scene.getFlag('fa-nexus', 'compositionRegistry') || {});
  const groups = new Set(Object.keys(plan.registry.groups));
  const relationships = new Set(plan.registry.relationships.map(relation => relation.id));
  for (const id of groups) delete registry.groups?.[id];
  registry.relationships = (registry.relationships || []).filter(relation => !relationships.has(relation.id));
  for (const key of Object.keys(plan.registry.wallVisibilityStates || {})) delete registry.wallVisibilityStates?.[key];
  const operations = Object.keys(COMPOSITION_COLLECTIONS).map(type => ({ action: 'delete', documentName: type, parent: scene,
    ids: plan.documents.filter(item => item.type === type && scene.getEmbeddedDocument(type, item.source._id)).map(item => item.source._id), ...writeOptions }))
    .filter(operation => operation.ids.length);
  let update = registryUpdate(scene, registry);
  if (!baseline.hadRegistry && !Object.keys(registry.groups || {}).length && !registry.relationships.length
    && !Object.keys(registry.wallVisibilityStates || {}).length) {
    update = { _id: scene.id, 'flags.fa-nexus.-=compositionRegistry': null };
    if (!baseline.hadModuleFlags && Object.keys(scene.flags['fa-nexus'] || {}).every(key => key === 'compositionRegistry')) {
      update = { _id: scene.id, 'flags.-=fa-nexus': null };
    }
  }
  if (Object.keys(plan.layerFolders?.sections || {}).length) Object.assign(update,removeCompositionLayerFolders(scene,plan.layerFolders,baseline));
  operations.push({action:'update',documentName:'Scene',updates:[update],...writeOptions});
  await foundry.documents.modifyBatch(operations);
}

export function createCompositionScene(snapshot) {
  const data = { _id: snapshot.sceneId, name: 'Prefab planning', width: 100000, height: 100000,
    grid: clone(snapshot.grid), levels: clone(snapshot.levels), flags: { 'fa-nexus': { compositionRegistry: clone(snapshot.registry) } } };
  for (const [type, collection] of Object.entries(COMPOSITION_COLLECTIONS)) {
    data[collection] = snapshot.documents.filter(item => item.type === type).map(item => clone(item.source));
  }
  const scene = new CONFIG.Scene.documentClass(data);
  restorePlanningCoordinates(scene);
  return scene;
}

/** Reproject an isolated composition into a destination grid without resizing
 * its captured authoring or world pose. Native Portal scale has one shared
 * projection rule for live Scenes and archived composition restoration. */
export function reprojectCompositionSceneGrid(scene, grid) {
  const changes = {grid: clone(grid)};
  projectBuildingV2PortalScalesForSceneGrid(scene, changes);
  scene.updateSource(changes);
  restorePlanningCoordinates(scene);
}

export function reprojectCompositionSnapshotGrid(snapshot, grid) {
  const scene = createCompositionScene(snapshot);
  reprojectCompositionSceneGrid(scene, grid);
  return {...serializeScene(snapshot, scene), grid: clone(grid)};
}

// Prefab coordinates are signed offsets, not positions on a live Scene.
// Foundry prepares Tile/Light/Sound display coordinates by clamping them to
// Scene bounds. Semantic planning must read the unchanged stored coordinates.
function restorePlanningCoordinates(scene) {
  for (const doc of sceneDocuments(scene)) restoreCompositionCoordinates(doc);
}

/** Unpersisted composition members may lie beyond the Scene while planning or
 * staging. Keep both their pose and native derived shape at the stored position;
 * otherwise Tile/Light/Sound clamping separates them from unclamped Walls.
 * Never use this on committed Scene documents.
 */
export function restoreCompositionCoordinates(document) {
  const position = {};
  for (const key of ['x', 'y']) {
    const value = document._source[key];
    if (!Number.isFinite(value)) continue;
    document[key] = value;
    if (document.shape && document.shape[key] !== value) position[key] = value;
  }
  if (Object.keys(position).length) document.shape.updateSource(position);
}

const sceneDocuments = scene => Object.values(COMPOSITION_COLLECTIONS).flatMap(key => Array.from(scene[key] || []));
function virtualWorkflow(scene) {
  return new SceneGroupWorkflow({ resolveDocument: uuid => sceneDocuments(scene).find(doc => doc.uuid === uuid),
    readRegistry: () => scene.flags['fa-nexus'].compositionRegistry });
}

export async function validateCompositionScene(scene) {
  const result = await virtualWorkflow(scene).execute({ scene, user: game.user, action: { type: 'read' } });
  if (result.missingUuids?.length) throw new Error('A composition cannot be placed with missing document references.');
  const documents = sceneDocuments(scene);
  for (const root of documents) {
    const manifest = readBuildingV2TransformManifest(root);
    if (!manifest) continue;
    validateBuildingV2TransformAggregate(manifest, { registry: result.registry, sceneDocuments: documents,
      expectedDocuments: manifest.expected.map(entry => documents.find(doc => doc.uuid === entry.dependentUuid)) });
  }
  return result;
}

// Run existing semantic adapters on isolated documents. Never mutate the live
// Scene merely to calculate a copy, a thumbnail, or a placement preview.
export function transformCompositionScene(scene, pivot, transform, { targetSceneGridSize = null } = {}) {
  restorePlanningCoordinates(scene);
  const documents = sceneDocuments(scene);
  if (transform.operation === 'reflect') {
    const blocker = compositionReflectionBlocker(documents);
    if (blocker) throw new Error(blocker);
  }
  if (transform.operation === 'move') transform = {...transform,delta:resolveSceneGroupMoveDelta(documents,transform.delta)};
  const targets = new Map(documents.map(doc => [doc.uuid,
    transform.operation === 'reflect' ? reflectCompositionMember(doc,pivot,transform)
      : buildSceneGroupMemberTransformTarget(doc, readSceneGroupMemberTransformState(doc, transform.operation), pivot, transform)]));
  for (const root of documents) {
    const manifest = readBuildingV2TransformManifest(root);
    if (!manifest) continue;
    const target = targets.get(root.uuid);
    delete target['flags.fa-nexus'];
    const rootTarget = foundry.utils.mergeObject(root.toObject(), target, {inplace:false});
    for (const [uuid, update] of buildBuildingV2GeneratedTransformTargets(root, rootTarget,
      manifest.expected.map(entry => documents.find(doc => doc.uuid === entry.dependentUuid)), {targetSceneGridSize})) targets.set(uuid, update);
  }
  for (const doc of documents) doc.updateSource(targets.get(doc.uuid));
  const registry = clone(scene.flags['fa-nexus'].compositionRegistry);
  for (const group of Object.values(registry.groups)) {
    if (transform.operation === 'move') {
      group.pivot.x += transform.delta.x; group.pivot.y += transform.delta.y;
    } else if (transform.operation === 'scale') {
      group.pivot.x = pivot.x + (group.pivot.x - pivot.x) * transform.factor;
      group.pivot.y = pivot.y + (group.pivot.y - pivot.y) * transform.factor;
    } else if (transform.operation === 'reflect') {
      group.pivot.x = pivot.x + (group.pivot.x-pivot.x)*(transform.flipX?-1:1);
      group.pivot.y = pivot.y + (group.pivot.y-pivot.y)*(transform.flipY?-1:1);
    } else if (transform.operation === 'rotate') {
      const radians = transform.angle * Math.PI / 180, x = group.pivot.x - pivot.x, y = group.pivot.y - pivot.y;
      group.pivot = {x:pivot.x + x*Math.cos(radians)-y*Math.sin(radians), y:pivot.y + x*Math.sin(radians)+y*Math.cos(radians)};
    }
    transformSceneGroupFrame(group,pivot,transform);
  }
  if (transform.operation === 'scale' || transform.operation === 'rotate' || transform.operation === 'reflect') {
    const result = transformSceneGroupRelationshipOffsets(registry, new Set(documents.map(doc => doc.uuid)), transform);
    if (result.blockers.length) throw new Error(result.blockers.map(blocker => blocker.message).join(' '));
    registry.relationships = result.relationships;
  }
  scene.updateSource({ [flagPath]: registry });
  restorePlanningCoordinates(scene);
}

function serializeScene(snapshot, scene) {
  return { ...snapshot, registry: clone(scene.flags['fa-nexus'].compositionRegistry),
    documents: sceneDocuments(scene).map(doc => ({ type: doc.documentName, source: doc.toObject() })) };
}

export async function captureSceneGroup(scene, groupId, {memberUuids} = {}) {
  if (!game.user.isGM) throw new Error('Only a GM can copy or save Scene Groups.');
  const { registry } = await new SceneGroupWorkflow().execute({ scene, user: game.user, action: { type: 'read' } });
  const requested = new Set(Array.isArray(groupId) ? groupId : [groupId]);
  const roots = [...requested].filter(id => {
    let parent = registry.groups[id]?.parentId;
    while (parent) { if (requested.has(parent)) return false; parent = registry.groups[parent]?.parentId; }
    return true;
  });
  if (!roots.length && !memberUuids?.length) throw new Error('Select a Scene Group to copy.');
  const resolve = uuid => {
    const doc = sceneDocuments(scene).find(candidate => candidate.uuid === uuid);
    return doc && { type: doc.documentName, source: doc.toObject() };
  };
  if (memberUuids?.length) {
    groupId = randomId();
    roots.splice(0,roots.length,groupId);
  }
  const trees = memberUuids?.length
    ? [captureCompositionMembers(registry,memberUuids,resolve,{groupId,
      name:memberUuids.length===1 ? resolve(memberUuids[0])?.source.name || 'Building or Path' : 'Copied Tiles'})]
    : roots.map(id => captureCompositionTree(registry, id, resolve));
  const tree = trees[0];
  groupId = roots[0];
  if (trees.length > 1) {
    groupId = randomId();
    for (const other of trees.slice(1)) {
      Object.assign(tree.registry.groups, other.registry.groups);
      Object.assign(tree.registry.wallVisibilityStates, other.registry.wallVisibilityStates);
      tree.registry.relationships.push(...other.registry.relationships);
      tree.documents.push(...other.documents);
    }
    const frame = getSceneGroupOrientedFrame(tree.documents.map(item => scene.getEmbeddedDocument(item.type,item.source._id)),0);
    tree.registry.groups[groupId] = {id:groupId,name:'Scene Groups',parentId:null,directMemberUuids:[],
      pivot:frame.center,pivotMode:'automatic',frameAngle:0};
    for (const id of roots) tree.registry.groups[id].parentId = groupId;
  }
  const documents = tree.documents.map(item => scene.getEmbeddedDocument(item.type, item.source._id));
  const root = tree.registry.groups[groupId];
  const frame = getSceneGroupFrame(documents,root);
  const pivot = root.pivotMode === 'custom' ? root.pivot : frame.center;
  if (![pivot?.x, pivot?.y].every(Number.isFinite)) throw new Error('Scene Group has no valid placement pivot.');
  if (memberUuids?.length) root.pivot = clone(pivot);
  let snapshot = { kind: 'fa-nexus-prefab', schemaVersion: 1, placementKind: memberUuids?.length ? 'composite' : 'group', sceneId: scene.id, rootGroupId: groupId,
    name: root.name, baseLevelId: canvas.scene?.id === scene.id ? canvas.level?.id : scene.initialLevel?.id,
    grid: clone(scene.toObject().grid), levels: scene.levels.map(level => level.toObject()),
    layerFolders:captureCompositionLayerFolders(scene,documents), ...tree };
  const identities = compositionIdentityMap(snapshot, { sceneId: PREFAB_SCENE_ID, randomId,
    levelIds: new Map(snapshot.levels.map(level => [level._id, randomId()])) });
  const captured = snapshot;
  snapshot = remapCompositionReferences(snapshot, identities);
  preserveBuildingFingerprints(captured.documents, snapshot.documents);
  const virtual = createCompositionScene(snapshot);
  await validateCompositionScene(virtual);
  transformCompositionScene(virtual, null, { operation: 'move', delta: { x: -Math.round(pivot.x), y: -Math.round(pivot.y) } });
  await validateCompositionScene(virtual);
  snapshot = serializeScene(snapshot, virtual);
  return { snapshot, pivot, documents, sourceDocuments:tree.documents };
}

export function prefabGridScale(snapshot, scene, mode = 'grid') {
  if (mode === 'pixels') return 1;
  if (!snapshot.grid.type || snapshot.grid.type !== scene.grid.type || snapshot.grid.units !== scene.grid.units
    || snapshot.grid.distance !== scene.grid.distance) throw new Error('Choose Original pixel size for incompatible or gridless Scenes.');
  const factor = scene.grid.size / snapshot.grid.size;
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Invalid Prefab grid size.');
  return factor;
}

// Sort values belong to the destination stack, not the reusable snapshot.
// Stable ordering also preserves captured ties without relying on fresh IDs.
export function assignCompositionTileSorts(documents, scene) {
  const elevations = new Map();
  for (const item of documents) {
    if (item.type !== 'Tile') continue;
    const elevation = Number(item.source.elevation ?? 0);
    if (!Number.isFinite(elevation)) throw new Error('A copied Tile has an invalid elevation.');
    const key = [...elevations.keys()].find(value => sameElevation(value, elevation)) ?? elevation;
    if (!elevations.has(key)) elevations.set(key, []);
    elevations.get(key).push(item.source);
  }
  for (const [elevation, tiles] of elevations) {
    tiles.sort((left, right) => (Number(left.sort) || 0) - (Number(right.sort) || 0));
    const { placementSorts } = resolvePlacementSortAtElevation(elevation, { scene, count: tiles.length });
    if (placementSorts.length !== tiles.length || !placementSorts.every(Number.isSafeInteger)) {
      throw new Error('The destination Tile stack has no valid placement sort slots.');
    }
    tiles.forEach((tile, index) => { tile.sort = placementSorts[index]; });
  }
}

export async function planCompositionPlacement(snapshot, scene, { point, levelId, mode = 'grid', name = snapshot.name, scale = 1, rotation = 0, flipX = false, flipY = false } = {}) {
  validateCompositionSnapshot(snapshot);
  if (![point?.x, point?.y].every(Number.isFinite)) throw new Error('Choose a placement position.');
  const targetLevel = scene.levels.get(levelId);
  if (!targetLevel) throw new Error('Choose a destination Level.');
  const usedIds = new Set(snapshot.documents.flatMap(item => [...(item.source.levels || []), item.source.flags?.['fa-nexus']?.placementLevelId].filter(Boolean)));
  if (!usedIds.size && snapshot.baseLevelId) usedIds.add(snapshot.baseLevelId);
  const sourceLevels = snapshot.levels.filter(level => usedIds.has(level._id))
    .sort((a, b) => levelBottom(a) - levelBottom(b)
      || levelPlacementElevation(a) - levelPlacementElevation(b) || levelTop(a) - levelTop(b));
  const sourceBase = sourceLevels.length ? levelPlacementElevation(sourceLevels[0]) : Infinity;
  if (!Number.isFinite(sourceBase)) throw new Error('Prefab has no valid source Level.');
  const elevationDelta = levelPlacementElevation(targetLevel) - sourceBase;
  const levelIds = new Map();
  for (const level of sourceLevels) {
    const elevation = levelPlacementElevation(level) + elevationDelta;
    let candidates = level === sourceLevels[0] ? [targetLevel]
      : scene.levels.filter(candidate => sameElevation(levelPlacementElevation(candidate), elevation)
        && ![...levelIds.values()].includes(candidate.id));
    if (candidates.length > 1) {
      const matchingBounds = candidates.filter(candidate => levelBottom(candidate) === levelBottom(level) + elevationDelta
        && levelTop(candidate) === levelTop(level) + elevationDelta);
      if (matchingBounds.length) candidates = matchingBounds;
    }
    if (!candidates.length) throw new Error(`Destination needs a Level at elevation ${elevation} for ${level.name}.`);
    if (candidates.length !== 1) throw new Error(`Destination has ambiguous Levels at elevation ${elevation} for ${level.name}.`);
    const target = candidates[0];
    levelIds.set(level._id, target.id);
  }
  const identities = compositionIdentityMap(snapshot, { sceneId: scene.id, randomId, levelIds });
  let planned = remapCompositionReferences(snapshot, identities);
  preserveBuildingFingerprints(snapshot.documents, planned.documents);
  planned.levels = scene.levels.map(level => level.toObject());
  for (const folder of Object.values(planned.layerFolders?.sections || {})) {
    if (folder.elevationKey && Number.isFinite(Number(folder.elevationKey))) folder.elevationKey=(Number(folder.elevationKey)+elevationDelta).toFixed(4);
    else if (folder.elevationKey) {
      const match=/^(ground|foreground):([^:]+):(-?[\d.]+)$/.exec(folder.elevationKey);
      if(match)folder.elevationKey=`${match[1]}:${levelIds.get(match[2])||match[2]}:${(Number(match[3])+elevationDelta).toFixed(4)}`;
    }
  }
  offsetCompositionDocumentElevations(planned.documents, elevationDelta);
  // Assign before projection so generated Sill artwork receives the same sort.
  assignCompositionTileSorts(planned.documents, scene);
  const virtual = createCompositionScene(planned);
  const targetGrid = clone(scene.toObject().grid);
  planned.grid = targetGrid;
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(rotation)) throw new Error('Invalid placement transform.');
  // Every intermediate Portal projection must use the virtual Scene's grid.
  // Switch the captured composition once before compound placement transforms.
  reprojectCompositionSceneGrid(virtual, targetGrid);
  if (flipX || flipY) transformCompositionScene(virtual,{x:0,y:0},{operation:'reflect',flipX,flipY},{targetSceneGridSize:targetGrid.size});
  const factor = prefabGridScale(snapshot, scene, mode) * scale;
  if (factor !== 1) {
    transformCompositionScene(virtual, { x: 0, y: 0 }, { operation: 'scale', factor }, {targetSceneGridSize:targetGrid.size});
  }
  if (rotation) transformCompositionScene(virtual, {x:0,y:0}, {operation:'rotate',angle:rotation}, {targetSceneGridSize:targetGrid.size});
  transformCompositionScene(virtual, null, { operation: 'move', delta: { x: Math.round(point.x), y: Math.round(point.y) } }, {targetSceneGridSize:targetGrid.size});
  const distanceRatio = (scene.grid.distance / scene.grid.size) / (snapshot.grid.distance / snapshot.grid.size);
  for (const doc of sceneDocuments(virtual)) {
    if (doc.documentName === 'AmbientLight') doc.updateSource({ 'config.dim': doc.config.dim * distanceRatio, 'config.bright': doc.config.bright * distanceRatio });
    if (doc.documentName === 'AmbientSound') doc.updateSource({ radius: doc.radius * distanceRatio });
    if (doc.documentName === 'Wall' && !doc.flags?.['fa-nexus']?.buildingGenerated) {
      const update = {};
      for (const field of ['light', 'sight', 'sound']) if (Number.isFinite(doc.threshold[field])) update[`threshold.${field}`] = doc.threshold[field] * distanceRatio;
      doc.updateSource(update);
    }
  }
  const root = virtual.flags['fa-nexus'].compositionRegistry.groups[planned.rootGroupId];
  root.name = String(name || snapshot.name).trim();
  if (snapshot.id) root.provenance = { prefabId: snapshot.id, revision: snapshot.revision, hash: snapshot.hash,
    source: 'local', placedAt: Date.now(), userId: game.user.id };
  else if (root.provenance) Object.assign(root.provenance, {placedAt:Date.now(), userId:game.user.id});
  restorePlanningCoordinates(virtual);
  await validateCompositionScene(virtual);
  return serializeScene(planned, virtual);
}

export async function placeComposition(snapshot, scene, options) {
  if (!game.user.isGM || !scene.canUserModify(game.user, 'update')) throw new Error('You cannot place a group in this Scene.');
  return runFoundryCompositionRegistryTransaction({ scene }, async () => {
    // Replan after acquiring the lock: the Scene may have changed during preview
    // or while another placement was committing.
    const plan = await planCompositionPlacement(snapshot, scene, options);
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    const workflow = new SceneGroupWorkflow();
    const baseline = {hadRegistry:scene.getFlag('fa-nexus','compositionRegistry') != null, hadModuleFlags:Object.hasOwn(scene.flags,'fa-nexus'),hadFolders:scene.getFlag('fa-nexus','layerManagerSections') != null};
    const { registry } = await workflow.execute({ scene, user: game.user, action: { type: 'read' } });
    if (snapshot.placementKind === 'composite') {
      delete plan.registry.groups[plan.rootGroupId];
    }
    const next = { ...clone(registry), groups: { ...registry.groups, ...plan.registry.groups },
      relationships: [...registry.relationships, ...plan.registry.relationships],
      wallVisibilityStates: { ...registry.wallVisibilityStates, ...plan.registry.wallVisibilityStates } };
    const operations = Object.keys(COMPOSITION_COLLECTIONS).map(type => ({ action: 'create', documentName: type,
      parent: scene, data: plan.documents.filter(item => item.type === type).map(item => item.source), keepId: true, ...writeOptions }))
      .filter(operation => operation.data.length);
    const sceneUpdate=registryUpdate(scene,next);
    if(Object.keys(plan.layerFolders?.sections||{}).length)sceneUpdate[COMPOSITION_FOLDERS_FLAG]=mergeCompositionLayerFolders(scene,plan.layerFolders);
    operations.push({ action: 'update', documentName: 'Scene', updates: [sceneUpdate], ...writeOptions });
    try {
      await foundry.documents.modifyBatch(operations);
      await workflow.execute({ scene, user: game.user, action: { type: 'read' } });
      for (const item of plan.documents) if (!scene.getEmbeddedDocument(item.type, item.source._id)) throw new Error('A copied group member was not created.');
      recordSceneGroupCommand(scene, { groupId: plan.rootGroupId, operation: 'create', actionType: 'place-group',
        plans: plan.documents.map(item => ({ uuid: `Scene.${scene.id}.${item.type}.${item.source._id}`, id: item.source._id,
          documentName: item.type, original: null, target: scene.getEmbeddedDocument(item.type, item.source._id).toObject() })),
        registryDelta: buildRegistryHistoryDelta(registry, next),layerFolders:plan.layerFolders,hadFolders:baseline.hadFolders,
        hadRegistry:baseline.hadRegistry,hadModuleFlags:baseline.hadModuleFlags
      }, historyContext);
    } catch (cause) {
      try { await removePlacementResidue(scene, plan, baseline); }
      catch (rollbackError) {
        const residue = plan.documents.filter(item => scene.getEmbeddedDocument(item.type, item.source._id))
          .map(item => `Scene.${scene.id}.${item.type}.${item.source._id}`);
        if (Object.keys(plan.registry.groups).some(id => scene.getFlag('fa-nexus', 'compositionRegistry')?.groups?.[id])) residue.push(scene.uuid);
        throw Object.assign(new Error(`Placement failed and cleanup could not finish: ${rollbackError.message}`, { cause }), {
          residue, cleanup: () => runFoundryCompositionRegistryTransaction({scene}, () => removePlacementResidue(scene, plan, baseline))
        });
      }
      throw cause;
    }
    const groupId = snapshot.placementKind === 'composite' ? null : plan.rootGroupId;
    if (canvas.scene?.id === scene.id) {
      if (groupId) sceneGroupInteractionState.selectGroup(scene, groupId);
      else {
        sceneGroupInteractionState.clear(scene, 'place-composite');
        const dependents = new Set(plan.registry.relationships.map(relation=>relation.dependentUuid));
        canvas.tiles.releaseAll();
        for (const item of plan.documents) if (item.type === 'Tile' && !dependents.has(`Scene.${scene.id}.Tile.${item.source._id}`)) {
          scene.tiles.get(item.source._id)?.object?.control({releaseOthers:false});
        }
      }
    }
    return { groupId, documentUuids: plan.documents.map(item => `Scene.${scene.id}.${item.type}.${item.source._id}`) };
  });
}
