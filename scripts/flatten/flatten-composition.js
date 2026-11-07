import { SceneGroupWorkflow, pruneEmptySceneGroups } from '../composition/scene-group-workflow.js';
import { getSceneGroupInteractionIndex } from '../composition/scene-group-interaction-resolver.js';
import { captureCompositionMembers, remapCompositionReferences, COMPOSITION_COLLECTIONS } from '../composition/scene-group-snapshot.js';
import { createCompositionScene, transformCompositionScene, validateCompositionScene } from '../composition/scene-group-copy-runtime.js';
import { runFoundryCompositionRegistryTransaction } from '../composition/composition-registry-transaction.js';
import { readFlattenedTilePose } from './flatten-tile-transform.js';
import { preserveBuildingFingerprints } from '../composition/scene-group-building-fingerprints.js';
import { getSceneLayerManagerSections, updateSceneLayerManagerSections } from '../layers/model/section-metadata.js';

const clone = value => structuredClone(value);
const flagPath = 'flags.fa-nexus.compositionRegistry';
const writeOptions = { isUndo: true, render: false, faNexusFlattenCompositionTransaction: true,
  faNexusBuildingEditorDocumentWrite: true, faNexusPathGeneratedWallOwnership: true,
  faNexusPreserveLinkedTileCleanup: true, faNexusSkipGeneratedCleanup: true };
const serialize = document => { const source = document.toObject(); delete source._stats; return source; };
const uuidFor = (scene, item) => `Scene.${scene.id}.${item.type}.${item.source._id}`;
const resolve = (scene, uuid) => {
  const [kind, sceneId, type, id] = uuid.split('.');
  if (kind !== 'Scene' || sceneId !== scene.id || !COMPOSITION_COLLECTIONS[type]) throw new Error(`Invalid Flatten member ${uuid}.`);
  const doc = scene.getEmbeddedDocument(type, id);
  if (!doc) throw new Error(`Flatten member ${uuid} is missing.`);
  return doc;
};
const registryUpdate = (scene, registry) => registry == null ? { _id: scene.id, 'flags.fa-nexus.-=compositionRegistry': null }
  : { _id: scene.id, [flagPath]: foundry.utils.diffObject(scene.getFlag('fa-nexus', 'compositionRegistry') || {}, registry, { bidirectional: true }) };
const operation = (scene, action, documentName, values) => ({ action, documentName, parent: scene,
  [action === 'create' ? 'data' : action === 'delete' ? 'ids' : 'updates']: values, keepId: true, ...writeOptions });

/** Capture the whole selection as one section. Group membership is restoration
 * data, never a reason to create another raster image. */
export async function planFlattenComposition(scene, selectedTiles) {
  const { registry } = await new SceneGroupWorkflow().execute({ scene, user: game.user, action: { type: 'read' } });
  const index = getSceneGroupInteractionIndex(scene, registry);
  const members = [...new Set(selectedTiles.map(doc => index.compositionRootByUuid.get(doc.uuid) || doc.uuid))];
  for(const uuid of members) {
    const root = resolve(scene, uuid);
    if (root.documentName !== 'Tile') throw new Error('Select the complete owning composition before flattening its artwork.');
  }
  const sections = [];
  if (members.length) {
    const rootGroupId = foundry.utils.randomID();
    const tree = captureCompositionMembers(registry, members, uuid => {
      const doc = resolve(scene, uuid);
      return { type: doc.documentName, source: serialize(doc) };
    }, { groupId: rootGroupId, name: 'Flattened section' });
    tree.registry.groups[rootGroupId].pivot = { x: 0, y: 0 };
    const sourceMemberships = tree.registry.groups[rootGroupId].directMemberUuids.map(uuid => ({uuid,
      groupId:index.directOwnerByUuid.get(uuid) || null}));
    const chains = sourceMemberships.map(member => {
      const chain = [];
      for(let id=member.groupId;id;id=registry.groups[id]?.parentId) {
        if(chain.includes(id)) throw new Error('Cannot flatten cyclic Scene Group ownership.');
        chain.push(id);
      }
      return chain;
    });
    const groupId = chains[0]?.find(id => chains.every(chain => chain.includes(id))) || null;
    const ownerId = foundry.utils.randomID(), collapsed = clone(registry);
    const sourceUuids = new Set(tree.documents.map(item=>uuidFor(scene,item)));
    for(const group of Object.values(collapsed.groups)) group.directMemberUuids=group.directMemberUuids.filter(uuid=>!sourceUuids.has(uuid));
    if(groupId) collapsed.groups[groupId].directMemberUuids.push(`Scene.${scene.id}.Tile.${ownerId}`);
    pruneEmptySceneGroups(collapsed);
    const removedGroups = Object.values(registry.groups).filter(group=>!collapsed.groups[group.id]);
    const removedIds = new Set(removedGroups.map(group=>group.id));
    for(const group of removedGroups) tree.registry.groups[group.id]={...clone(group),
      pivot:clone(group.pivot || {x:0,y:0}),parentId:removedIds.has(group.parentId)?group.parentId:rootGroupId};
    tree.registry.groups[rootGroupId].directMemberUuids=sourceMemberships.filter(member=>!removedIds.has(member.groupId)).map(member=>member.uuid);
    // The Layer Manager Folder of each source Tile, for Deconstruct to put it back.
    const folders = getSceneLayerManagerSections(scene).memberships;
    const folderMemberships = tree.documents.filter(item => item.type === 'Tile' && folders[item.source._id])
      .map(item => ({ tileId: item.source._id, sectionId: folders[item.source._id] }));
    const snapshot = { kind: 'fa-nexus-prefab', schemaVersion: 1, placementKind: removedGroups.length?'group':'composite', sceneId: scene.id,
      rootGroupId, sourceMemberships, folderMemberships, flattenGroupId:groupId,removedGroups:removedGroups.map(({id,parentId})=>({id,parentId})),
      grid: clone(scene.toObject().grid), levels: scene.levels.map(l => l.toObject()), ...tree };
    await validateCompositionScene(createCompositionScene(snapshot));
    const tiles = tree.documents.filter(item => item.type === 'Tile').map(item => scene.tiles.get(item.source._id));
    // A hidden dependent must not disappear when its visible owner is replaced.
    // Preserve it as a live member rather than baking invisible pixels.
    const visuals = tiles.filter(t => !t.hidden && !t.flags?.['fa-nexus']?.layerHidden);
    if (visuals.length) sections.push({ groupId, members, snapshot, tiles: visuals,
      retained: tree.documents.filter(item => item.type !== 'Tile' || !visuals.some(t => t.id === item.source._id)),
      ownerId });
  }
  return { sceneId: scene.id, registrySource: clone(scene.getFlag('fa-nexus', 'compositionRegistry') ?? null), registry: clone(registry), sections };
}

export function getFlattenCompositionOwner(tile) {
  const uuid = tile?.flags?.['fa-nexus']?.flattened?.composition?.ownerUuid;
  return uuid ? resolve(tile.parent, uuid) : tile;
}

/** The Foundry Walls a flattened section keeps live (the walls of a flattened Building, of a fence), for any of its
 * pictures. They are the points the section is snapped by when it is moved with Foundry's own tools. */
export function collectFlattenCompositionWalls(tile) {
  const composition = tile?.flags?.['fa-nexus']?.flattened?.composition;
  const scene = tile?.parent;
  if (!composition?.ownerUuid || !scene) return [];
  const index = getSceneGroupInteractionIndex(scene, scene.getFlag('fa-nexus', 'compositionRegistry'));
  const members = new Set([composition.ownerUuid]);
  for (const uuid of members) for (const relation of index.relationshipsByOwnerUuid.get(uuid) || []) members.add(relation.dependentUuid);
  const walls = [];
  for (const uuid of members) {
    const [kind, sceneId, type, id] = uuid.split('.');
    if (kind !== 'Scene' || sceneId !== scene.id || type !== 'Wall') continue;
    const wall = scene.walls.get(id);
    if (wall) walls.push(wall);
  }
  return walls;
}

/** The pictures a section's Flatten made that carry a mask painted afterwards ("Apply Mask"). Deconstruct deletes
 * them and the mask with them. A picture kept through this Flatten (it is in the archive) is not one of them. */
export function maskedFlattenPictures(tile, metadata) {
  return flattenSectionPictures(tile, metadata).filter(d => !!d.flags?.['fa-nexus']?.standardTileMask);
}

/** The pictures one Flatten made: the section's owner and every picture that names it. A picture kept through this
 * Flatten (it is in the archive) is not one of them. */
export function flattenSectionPictures(tile, metadata) {
  const owner = getFlattenCompositionOwner(tile), scene = owner?.parent;
  if (!scene) return [];
  const archived = new Set((metadata?.composition?.snapshot?.documents || [])
    .filter(item => item.type === 'Tile').map(item => item.source._id));
  return scene.tiles.filter(d => !archived.has(d.id)
    && (d === owner || d.flags?.['fa-nexus']?.flattened?.composition?.ownerUuid === owner.uuid));
}

/** The files those pictures are drawn from: one each, or one per chunk. Deconstruct leaves them on disk; they are
 * the fields the Generated Cleanup scan reads. */
export function flattenSectionPictureFiles(tile, metadata) {
  const files = new Set();
  for (const picture of flattenSectionPictures(tile, metadata)) {
    const flattened = picture.flags?.['fa-nexus']?.flattened;
    if (flattened?.filePath) files.add(flattened.filePath);
    for (const chunk of Array.isArray(flattened?.chunks) ? flattened.chunks : []) if (chunk?.src) files.add(chunk.src);
  }
  return [...files];
}

/** Only runtime addressing and the original pose live in Scene flags. Source
 * documents are archived inside the generated WebP and loaded for Deconstruct. */
export function runtimeFlattenMetadata(metadata) {
  const next = clone(metadata);
  if (next.composition) delete next.composition.snapshot;
  next.tiles = [];
  return next;
}

export function collectFlattenArchiveReferences(snapshot) {
  const references = new Map();
  const add = (path, category) => { if (typeof path === 'string' && path) references.set(path, { path, category }); };
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'maskSrc') add(child, 'mask');
      else if (key === 'filePath') add(child, 'flattened');
      else if (key === 'chunks' && Array.isArray(child)) child.forEach(chunk => add(chunk.src, 'flattened'));
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(snapshot.documents);
  return [...references.values()];
}

export function flattenArchiveIdentities(snapshot) {
  const ids = new Set([...Object.keys(snapshot.registry.groups), ...snapshot.registry.relationships.map(r => r.id)]);
  for(const member of snapshot.sourceMemberships || []) if(member.groupId) ids.add(member.groupId);
  if(snapshot.flattenGroupId) ids.add(snapshot.flattenGroupId);
  for(const group of snapshot.removedGroups || []) if(group.parentId) ids.add(group.parentId);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['buildingId', 'generationId', 'maskSlotId', 'groupId'].includes(key) && typeof child === 'string') ids.add(child);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(snapshot.documents);
  const bindings = [...snapshot.documents.map(item => ({ archiveId: `Scene.${snapshot.sceneId}.${item.type}.${item.source._id}`,
    currentId: `Scene.${snapshot.sceneId}.${item.type}.${item.source._id}` })),
    ...snapshot.levels.map(level => ({ archiveId: `Scene.${snapshot.sceneId}.Level.${level._id}`, currentId: `Scene.${snapshot.sceneId}.Level.${level._id}` })),
    ...[...ids].map(id => ({ archiveId: id, currentId: id }))];
  // Nested flattened sources also address documents kept in their own archive.
  // Carry those identities through when the new combined section is copied.
  for(const item of snapshot.documents) for(const binding of item.source.flags?.['fa-nexus']?.flattened?.composition?.identities || []) {
    bindings.push({archiveId:binding.currentId,currentId:binding.currentId});
  }
  return [...new Map(bindings.map(binding=>[binding.archiveId,binding])).values()];
}

function assertUnchanged(scene, plan) {
  if (scene.id !== plan.sceneId || JSON.stringify(scene.getFlag('fa-nexus', 'compositionRegistry') ?? null) !== JSON.stringify(plan.registrySource)) {
    throw new Error('Scene Groups changed during Flatten. Nothing was replaced; try again.');
  }
  for (const section of plan.sections) for (const item of section.snapshot.documents) {
    if (JSON.stringify(serialize(resolve(scene, uuidFor(scene, item)))) !== JSON.stringify(item.source)) {
      throw new Error('A source document changed during Flatten. Nothing was replaced; try again.');
    }
  }
}

async function applyReplacement(scene, { creates, deletes, updates, registry }) {
  // Foundry reports some constituent batch failures through notifications and
  // returns partial results. Verify durable effects instead of assuming that a
  // resolved batch promise means the replacement completed.
  const expectedUpdates = updates.map(item => ({ type: item.type, source: serialize(
    scene.getEmbeddedDocument(item.type, item.source._id).clone(item.source, { keepId: true })) }));
  const createdIds = creates.map(item => [item.type, item.source._id]);
  const deletedIds = deletes.map(item => [item.type, item.source._id]);
  const operations = [];
  for (const type of Object.keys(COMPOSITION_COLLECTIONS)) {
    const data = creates.filter(item => item.type === type).map(item => item.source);
    if (data.length) operations.push(operation(scene, 'create', type, data));
    const changes = updates.filter(item => item.type === type).map(item => item.source);
    if (changes.length) operations.push(operation(scene, 'update', type, changes));
  }
  operations.push({ action: 'update', documentName: 'Scene', updates: [registryUpdate(scene, registry)], ...writeOptions });
  for (const type of Object.keys(COMPOSITION_COLLECTIONS)) {
    const ids = deletes.filter(item => item.type === type).map(item => item.source._id);
    if (ids.length) operations.push(operation(scene, 'delete', type, ids));
  }
  await foundry.documents.modifyBatch(operations);
  const differs = (actual, expected) => Object.keys(foundry.utils.diffObject(actual, expected, { bidirectional: true })).length > 0;
  const incomplete = [
    ...createdIds.filter(([type,id]) => !scene.getEmbeddedDocument(type,id)).map(([type,id]) => `missing ${type} ${id}`),
    ...deletedIds.filter(([type,id]) => scene.getEmbeddedDocument(type,id)).map(([type,id]) => `undeleted ${type} ${id}`),
    ...expectedUpdates.filter(item => differs(serialize(scene.getEmbeddedDocument(item.type,item.source._id)),item.source)).map(item => `changed ${item.type} ${item.source._id}`),
    ...(differs(scene.getFlag('fa-nexus','compositionRegistry') || {}, registry || {}) ? ['ownership registry'] : [])
  ];
  if (incomplete.length) {
    throw new Error(`Flatten replacement was incomplete (${incomplete.join(', ')}). The affected documents will be restored.`);
  }
  scene.render(false);
}

// Foundry batches can fail after an earlier operation. Restore the precise
// affected documents and registry while still holding the composition mutex.
async function replaceWithRollback(scene, replacement) {
  const beforeRegistry = clone(scene.getFlag('fa-nexus', 'compositionRegistry'));
  const before = [...replacement.deletes, ...replacement.updates].map(item => ({ type: item.type,
    source: serialize(scene.getEmbeddedDocument(item.type, item.source._id)) }));
  try {
    await applyReplacement(scene, replacement);
  } catch (error) {
    try {
      const creates = before.filter(item => !scene.getEmbeddedDocument(item.type, item.source._id));
      const updates = before.filter(item => scene.getEmbeddedDocument(item.type, item.source._id)).map(item => ({ type: item.type,
        source: { _id: item.source._id, ...foundry.utils.diffObject(serialize(scene.getEmbeddedDocument(item.type, item.source._id)), item.source, { bidirectional: true }) } }));
      const deletes = replacement.creates.filter(item => scene.getEmbeddedDocument(item.type, item.source._id));
      await applyReplacement(scene, { creates, updates, deletes, registry: beforeRegistry });
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Flatten replacement and rollback failed. Preserve this Scene and inspect the errors before continuing.');
    }
    throw error;
  }
}

export async function commitFlattenComposition(scene, plan, entries) {
  return runFoundryCompositionRegistryTransaction({ scene }, async () => {
    assertUnchanged(scene, plan);
    const registry = clone(plan.registry), creates = [], deletes = [], updates = [];
    for (const section of plan.sections) {
      const bands = entries.filter(entry => entry.section === section);
      if (!bands.length || bands[0].source._id !== section.ownerId) throw new Error('Flatten is missing its primary band.');
      const ownerUuid = `Scene.${scene.id}.Tile.${section.ownerId}`;
      const sourceUuids = new Set(section.snapshot.documents.map(item => uuidFor(scene, item)));
      registry.relationships = registry.relationships.filter(r => !sourceUuids.has(r.ownerUuid) && !sourceUuids.has(r.dependentUuid));
      for(const group of Object.values(registry.groups)) group.directMemberUuids = group.directMemberUuids.filter(uuid => !sourceUuids.has(uuid));
      if(section.groupId) registry.groups[section.groupId].directMemberUuids.push(ownerUuid);
      for(const group of section.snapshot.removedGroups || []) delete registry.groups[group.id];
      const identities = new Map(section.tiles.flatMap(t => [[t.id, section.ownerId], [t.uuid, ownerUuid]]));
      const dependents = [...bands.slice(1).map(entry => `Scene.${scene.id}.Tile.${entry.source._id}`),
        ...section.retained.map(item => uuidFor(scene, item))];
      registry.relationships.push(...dependents.map(dependentUuid => ({ id: foundry.utils.randomID(), type: 'generated-by',
        generator: 'flatten', ownerUuid, dependentUuid })));
      for (const item of section.retained) {
        const source = remapCompositionReferences(item.source, identities);
        updates.push({ type: item.type, source: { _id: item.source._id,
          ...foundry.utils.diffObject(item.source, source, { bidirectional: true }) } });
      }
      creates.push(...bands.map(entry => ({ type: 'Tile', source: entry.source })));
      deletes.push(...section.snapshot.documents.filter(item => section.tiles.some(t => t.id === item.source._id)));
    }
    await replaceWithRollback(scene, { creates, deletes, updates, registry });
    return { createdDocs: creates.map(item => scene.tiles.get(item.source._id)), createdTileIds: creates.map(item => item.source._id),
      // For the closing message: the layers the pictures replace, and hidden group members kept as they are.
      replacedTileIds: deletes.map(item => item.source._id),
      hiddenLeftOutTileIds: plan.sections.flatMap(section => section.retained.filter(item => item.type === 'Tile').map(item => item.source._id)) };
  });
}

/** Apply the wrapper's affine pose to an isolated composition through the same
 * semantic adapters used by Scene Groups and Prefabs, including V2 aggregates. */
export function transformFlattenArchive(snapshot, originalPose, finalPose) {
  const scene = createCompositionScene(snapshot);
  const a = readFlattenedTilePose(originalPose), b = readFlattenedTilePose(finalPose);
  const sx = b.width / a.width, sy = b.height / a.height;
  if (Math.abs(sx - sy) > (0.5 / a.width + 0.5 / a.height + 1e-8)) throw new Error('Flattened compositions require uniform scaling.');
  const pivot = { x: a.x, y: a.y };
  if (Math.abs(sx - 1) > 1e-9) transformCompositionScene(scene, pivot, { operation: 'scale', factor: (sx + sy) / 2 });
  const flipX = Math.sign(a.texture.scaleX) !== Math.sign(b.texture.scaleX);
  const flipY = Math.sign(a.texture.scaleY) !== Math.sign(b.texture.scaleY);
  if (flipX || flipY) {
    if (a.rotation) transformCompositionScene(scene, pivot, { operation: 'rotate', angle: -a.rotation });
    transformCompositionScene(scene, pivot, { operation: 'reflect', flipX, flipY });
    if (a.rotation) transformCompositionScene(scene, pivot, { operation: 'rotate', angle: a.rotation });
  }
  // Uniform scale is independent of orientation. Unrotating and rerotating
  // every ordinary move/resize rounds native Wall endpoints twice, visibly
  // drifting an already rotated section between held and saved positions.
  const rotationDelta = b.rotation - a.rotation;
  if (rotationDelta) transformCompositionScene(scene, pivot, { operation: 'rotate', angle: rotationDelta });
  const delta = { x: b.x - a.x, y: b.y - a.y };
  if (delta.x || delta.y) transformCompositionScene(scene, pivot, { operation: 'move', delta });
  return scene;
}

export function planFlattenNativeTransform(document, finalPose) {
  const scene = document.parent;
  const composition = document.flags?.['fa-nexus']?.flattened?.composition;
  if (!composition) return null;
  if (composition.ownerUuid !== document.uuid) throw new Error('Transform the owning flattened section, rather than an individual band.');
  const registry = scene.getFlag('fa-nexus', 'compositionRegistry');
  const index = getSceneGroupInteractionIndex(scene, registry);
  const members = new Set([document.uuid]);
  for (const uuid of members) for (const relation of index.relationshipsByOwnerUuid.get(uuid) || []) members.add(relation.dependentUuid);
  const documents = [...members].map(uuid => resolve(scene, uuid));
  const snapshot = { sceneId: scene.id, grid: clone(scene.toObject().grid), levels: scene.levels.map(l => l.toObject()),
    registry: { schemaVersion: 1, groups: {}, wallVisibilityStates: {}, relationships: registry.relationships.filter(r => members.has(r.ownerUuid)) },
    documents: documents.map(doc => ({ type: doc.documentName, source: serialize(doc) })) };
  const target = transformFlattenArchive(snapshot, document, finalPose);
  return { tileId: document.id, originalTileSource: serialize(document),
    originals: documents.slice(1).map(doc => ({ documentName: doc.documentName, source: serialize(doc) })),
    operations: [{ operation: document.rotation !== finalPose.rotation ? 'rotate' : document.width !== finalPose.width ? 'scale' : 'move' }],
    updates: documents.slice(1).map(doc => ({ type: doc.documentName,
      source: { _id: doc.id, ...foundry.utils.diffObject(serialize(doc), serialize(target.getEmbeddedDocument(doc.documentName, doc.id)), { bidirectional: true }) } })) };
}

export async function commitFlattenNativeTransform(document, plan) {
  return runFoundryCompositionRegistryTransaction({ scene: document.parent }, async () => {
    const scene = document.parent;
    try {
      for (const original of plan.originals) {
        const live = scene.getEmbeddedDocument(original.documentName, original.source._id);
        if (!live || JSON.stringify(serialize(live)) !== JSON.stringify(original.source)) throw new Error('A live Flatten member changed before the transform finished.');
      }
      const operations = Object.keys(COMPOSITION_COLLECTIONS).map(type => operation(scene, 'update', type,
        plan.updates.filter(item => item.type === type).map(item => item.source))).filter(op => op.updates.length);
      await foundry.documents.modifyBatch(operations.map(op => ({ ...op, faNexusSceneGroupCommand: true })));
      scene.render(false);
    } catch (error) {
      const rollback = [{ documentName: 'Tile', source: plan.originalTileSource }, ...plan.originals];
      try {
        const operations = Object.keys(COMPOSITION_COLLECTIONS).map(type => operation(scene, 'update', type,
          rollback.filter(item => item.documentName === type).map(item => ({ _id: item.source._id,
            ...foundry.utils.diffObject(serialize(scene.getEmbeddedDocument(type, item.source._id)), item.source, { bidirectional: true }) })))).filter(op => op.updates.length);
        await foundry.documents.modifyBatch(operations.map(op => ({ ...op, faNexusSceneGroupCommand: true })));
        scene.render(false);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Flatten transform rollback failed. Preserve this Scene and inspect the errors.');
      }
      throw error;
    }
  });
}

export async function deconstructFlattenComposition(tile, metadata) {
  const scene = tile.parent, composition = metadata.composition;
  if (composition?.version !== 1 || !composition.snapshot) throw new Error('The complete Flatten composition archive is missing.');
  const identities = new Map([[composition.archiveSceneId || composition.snapshot.sceneId, scene.id]]);
  for (const binding of composition.identities || []) {
    identities.set(binding.archiveId, binding.currentId);
    if (binding.archiveId.startsWith('Scene.')) identities.set(binding.archiveId.split('.').at(-1), binding.currentId.split('.').at(-1));
  }
  const archive = remapCompositionReferences(composition.snapshot, identities);
  preserveBuildingFingerprints(composition.snapshot.documents, archive.documents);
  const virtual = transformFlattenArchive(archive, composition.sourcePose, tile);
  await validateCompositionScene(virtual);
  const restored = await runFoundryCompositionRegistryTransaction({ scene }, async () => {
    const { registry: current } = await new SceneGroupWorkflow({ runRegistryTransaction: (_scene, operation) => operation() })
      .execute({ scene, user: game.user, action: { type: 'read' } });
    const registry = clone(current);
    const relationships = registry.relationships.filter(r => r.ownerUuid === tile.uuid && r.generator === 'flatten');
    // A flattened picture that was hidden when this section was made was kept as a live member and now names
    // this owner too. It is in the archive; the pictures this Flatten made are not.
    const archivedTileIds = new Set(archive.documents.filter(item => item.type === 'Tile').map(item => item.source._id));
    const bands = [tile, ...relationships.map(r => resolve(scene, r.dependentUuid)).filter(d =>
      d.documentName === 'Tile' && !archivedTileIds.has(d.id)
      && d.flags?.['fa-nexus']?.flattened?.composition?.ownerUuid === tile.uuid)];
    const originals = new Set(composition.sourceTileIds);
    const creates = [], updates = [];
    for (const item of archive.documents) {
      const source = serialize(virtual.getEmbeddedDocument(item.type, item.source._id));
      if (item.type === 'Tile' && originals.has(item.source._id)) {
        if (scene.tiles.has(source._id)) throw new Error(`Cannot restore Flatten: source Tile ${source._id} already exists.`);
        creates.push({ type: item.type, source });
      } else {
        const live = scene.getEmbeddedDocument(item.type, item.source._id);
        if (!live) throw new Error(`Cannot restore Flatten: live ${item.type} ${item.source._id} is missing.`);
        // Current geometry and native state (especially Wall.ds) remain live.
        // Only restore archived ownership fields that Flatten remapped.
        const flags = clone(live.flags?.['fa-nexus'] || {}), archivedFlags = source.flags?.['fa-nexus'] || {};
        for (const key of ['buildingGenerated', 'buildingWall', 'buildingRegion', 'buildingFill', 'buildingSills', 'pathWall',
          'buildingSeamlessSecretDoor', 'windowShadow', 'doorShadow']) {
          if (archivedFlags[key]) flags[key] = clone(archivedFlags[key]);
        }
        // A hidden Building Root stays live while its visible Fill/Sills can be
        // replaced. Flatten remaps these references along with dependent owners.
        // Restore only the references, preserving the live Root's other state.
        if (flags.building?.runtime && archivedFlags.building?.runtime?.expectedGeneratedDocuments) {
          flags.building.runtime.expectedGeneratedDocuments = clone(archivedFlags.building.runtime.expectedGeneratedDocuments);
        }
        // A kept picture of an earlier flattened section goes back to the owner it had: that owner is
        // restored with this section. Its other flatten data (pose, bounds) stays as it is now.
        if (flags.flattened?.composition && archivedFlags.flattened?.composition?.ownerUuid) {
          flags.flattened.composition.ownerUuid = archivedFlags.flattened.composition.ownerUuid;
        }
        const projected = {};
        if (archivedFlags.buildingGenerated) {
          // Native Wall coordinates round after each edit; V2 projects from its
          // local source once. Rejoin that exact projection on restoration.
          for (const key of ['c', 'shapes', 'dir', 'animation', 'threshold']) if (source[key] !== undefined) projected[key] = clone(source[key]);
          if (source.flags?.core?.textureGridSize !== undefined) projected['flags.core.textureGridSize'] = source.flags.core.textureGridSize;
        }
        updates.push({ type: item.type, source: { _id: source._id, 'flags.fa-nexus':
          foundry.utils.diffObject(live.flags?.['fa-nexus'] || {}, flags, { bidirectional: true }), ...projected } });
      }
    }
    const bandUuids = new Set(bands.map(d => d.uuid));
    const restoredRoots = archive.sourceMemberships?.map(member=>member.uuid) || archive.registry.groups[archive.rootGroupId].directMemberUuids;
    const currentGroupId = Object.values(registry.groups).find(group => group.directMemberUuids.includes(tile.uuid))?.id || null;
    for(const group of Object.values(registry.groups)) group.directMemberUuids = group.directMemberUuids.filter(uuid => uuid !== tile.uuid);
    if(currentGroupId === (archive.flattenGroupId || null)) {
      const removedIds = new Set((archive.removedGroups || []).map(group=>group.id));
      for(const group of archive.removedGroups || []) if(!registry.groups[group.id]) {
        registry.groups[group.id]={...clone(virtual.flags['fa-nexus'].compositionRegistry.groups[group.id]),directMemberUuids:[],
          parentId:group.parentId && (registry.groups[group.parentId] || removedIds.has(group.parentId)) ? group.parentId : currentGroupId};
      }
    }
    for(const uuid of restoredRoots) {
      let targetGroupId = currentGroupId;
      const original = archive.sourceMemberships?.find(member => member.uuid === uuid);
      if(original && currentGroupId === (archive.flattenGroupId || null)) {
        if(original.groupId === null || registry.groups[original.groupId]) targetGroupId = original.groupId;
      }
      if(targetGroupId) registry.groups[targetGroupId].directMemberUuids.push(uuid);
    }
    registry.relationships = registry.relationships.filter(r => !bandUuids.has(r.ownerUuid) && !bandUuids.has(r.dependentUuid));
    registry.relationships.push(...clone(virtual.flags['fa-nexus'].compositionRegistry.relationships));
    await replaceWithRollback(scene, { creates, updates, deletes: bands.map(doc => ({ type: 'Tile', source: serialize(doc) })), registry });
    return creates.map(item => scene.tiles.get(item.source._id));
  });
  // Each restored layer returns to the Folder it was in, where that Folder still exists.
  const folders = (archive.folderMemberships || []).filter(entry => scene.tiles.has(entry.tileId));
  if (folders.length) {
    await updateSceneLayerManagerSections(scene, metadata => {
      let changed = false;
      for (const { tileId, sectionId } of folders) {
        if (!metadata.sections[sectionId] || metadata.memberships[tileId] === sectionId) continue;
        metadata.memberships[tileId] = sectionId;
        changed = true;
      }
      return changed ? metadata : undefined;
    });
  }
  return restored;
}
