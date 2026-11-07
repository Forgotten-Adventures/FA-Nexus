// Rebinds a copied Scene's composition registry, and the flattened sections on its
// Tiles, to the Scene that now holds them.
//
// Foundry's Scene Duplicate, compendium import and Adventure import keep every
// embedded document id and assign a new Scene id. The registry stores absolute
// document UUIDs, so an unconverted copy still names the Scene it came from:
// Scene Groups reject it as foreign and Building/Path ownership stops resolving.
// Flattened sections store their owning Tile the same way and lose their owner.
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { runFoundryCompositionRegistryTransaction } from './composition-registry-transaction.js';

const MODULE_ID = 'fa-nexus';
const COMPOSITION_REGISTRY_FLAG = 'compositionRegistry';

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function embeddedSceneId(uuid) {
  const parts = normalizeIdentity(uuid).split('.');
  return parts.length === 4 && parts[0] === 'Scene' ? parts[1] : '';
}

function registryUuids(registry) {
  return {
    members: Object.values(registry?.groups || {}).flatMap((group) => (
      Array.isArray(group?.directMemberUuids) ? group.directMemberUuids.map(normalizeIdentity) : []
    )),
    relationships: (Array.isArray(registry?.relationships) ? registry.relationships : []).map((relationship) => ({
      id: normalizeIdentity(relationship?.id),
      ownerUuid: normalizeIdentity(relationship?.ownerUuid),
      dependentUuid: normalizeIdentity(relationship?.dependentUuid)
    }))
  };
}

/**
 * Decide whether a stored registry belongs to another Scene and can be rebound exactly.
 * A rebind only replaces the Scene id inside each UUID; it never adds, drops or reorders
 * a group, member or relationship, so anything it cannot map one-to-one is refused.
 */
export function planCompositionRegistrySceneRebind(registry, sceneId) {
  const targetSceneId = normalizeIdentity(sceneId);
  if (!registry || typeof registry !== 'object' || Array.isArray(registry) || !targetSceneId) return { status: 'bound' };
  const before = registryUuids(registry);
  const sourceSceneIds = new Set([
    ...before.members,
    ...before.relationships.flatMap((relationship) => [relationship.ownerUuid, relationship.dependentUuid])
  ].map(embeddedSceneId).filter((id) => id && id !== targetSceneId));
  if (!sourceSceneIds.size) return { status: 'bound' };
  if (sourceSceneIds.size > 1) {
    return { status: 'refused', reason: 'multiple-source-scenes', sourceSceneIds: [...sourceSceneIds] };
  }

  const [sourceSceneId] = sourceSceneIds;
  const sourcePrefix = `Scene.${sourceSceneId}.`;
  const targetPrefix = `Scene.${targetSceneId}.`;
  const rebindUuid = (uuid) => (uuid.startsWith(sourcePrefix) ? `${targetPrefix}${uuid.slice(sourcePrefix.length)}` : uuid);
  const rebound = structuredClone(registry);
  for (const group of Object.values(rebound.groups || {})) {
    if (Array.isArray(group?.directMemberUuids)) {
      group.directMemberUuids = group.directMemberUuids.map((uuid) => rebindUuid(normalizeIdentity(uuid)));
    }
  }
  for (const relationship of Array.isArray(rebound.relationships) ? rebound.relationships : []) {
    if (!relationship || typeof relationship !== 'object') continue;
    relationship.ownerUuid = rebindUuid(normalizeIdentity(relationship.ownerUuid));
    relationship.dependentUuid = rebindUuid(normalizeIdentity(relationship.dependentUuid));
    // Generated relationship ids embed both UUIDs; keep them consistent with their fields.
    if (typeof relationship.id === 'string') relationship.id = relationship.id.replaceAll(sourcePrefix, targetPrefix);
  }

  // The copy may already own documents with the same ids under its own Scene id. Folding
  // two identities into one would change ownership, which is not an identity rebind.
  const after = registryUuids(rebound);
  const distinct = (values) => new Set(values).size;
  const collapsed = distinct(after.members) !== distinct(before.members)
    || distinct(after.relationships.map((entry) => entry.dependentUuid)) !== distinct(before.relationships.map((entry) => entry.dependentUuid))
    || distinct(after.relationships.map((entry) => entry.id)) !== distinct(before.relationships.map((entry) => entry.id));
  if (collapsed) return { status: 'refused', reason: 'conflicting-identities', sourceSceneIds: [sourceSceneId] };

  return {
    status: 'rebind',
    sourceSceneId,
    registry: rebound,
    reboundUuidCount: [
      ...before.members,
      ...before.relationships.flatMap((relationship) => [relationship.ownerUuid, relationship.dependentUuid])
    ].filter((uuid) => uuid.startsWith(sourcePrefix)).length
  };
}

const inFlight = new Map();

function readRegistry(scene) {
  return scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG) ?? null;
}

function canRebind(scene) {
  const user = globalThis.game?.user;
  return !!scene?.id && !scene.pack && user?.isGM === true && scene.canUserModify?.(user, 'update') === true;
}

/**
 * Persist the rebind for one world Scene. Other sessions may attempt the same rebind;
 * the registry transaction serializes them and the plan is recomputed under the lock.
 */
export function rebindCompositionRegistryToScene(scene, { reason = 'unspecified' } = {}) {
  if (!canRebind(scene)) return Promise.resolve({ status: 'skipped' });
  const initial = planCompositionRegistrySceneRebind(readRegistry(scene), scene.id);
  if (initial.status === 'bound') return Promise.resolve(initial);
  if (initial.status === 'refused') {
    Logger.error('CompositionRegistrySceneRebind.refused', {
      sceneId: scene.id, reason: initial.reason, sourceSceneIds: initial.sourceSceneIds, trigger: reason
    });
    return Promise.resolve(initial);
  }
  const existing = inFlight.get(scene.id);
  if (existing) return existing;
  const operation = runFoundryCompositionRegistryTransaction({ scene }, async () => {
    const plan = planCompositionRegistrySceneRebind(readRegistry(scene), scene.id);
    if (plan.status !== 'rebind') return plan;
    // Every changed value is an array element or a string, so a plain merge replaces them
    // completely and leaves all other registry content exactly as stored.
    await scene.update({ flags: { [MODULE_ID]: { [COMPOSITION_REGISTRY_FLAG]: plan.registry } } });
    const verified = planCompositionRegistrySceneRebind(readRegistry(scene), scene.id);
    if (verified.status !== 'bound') {
      throw new Error(`Composition registry of Scene ${scene.id} still references Scene ${plan.sourceSceneId} after rebinding.`);
    }
    Logger.info('CompositionRegistrySceneRebind.rebound', {
      sceneId: scene.id, sourceSceneId: plan.sourceSceneId, reboundUuidCount: plan.reboundUuidCount, trigger: reason
    });
    return { status: 'rebound', sourceSceneId: plan.sourceSceneId, reboundUuidCount: plan.reboundUuidCount };
  }).catch((error) => {
    Logger.error('CompositionRegistrySceneRebind.failed', {
      sceneId: scene.id, trigger: reason, error: String(error?.message || error)
    });
    globalThis.ui?.notifications?.error?.(
      `Scene Groups in "${scene.name}" still point at the Scene it was copied from and could not be updated. See the console for details.`
    );
    return { status: 'failed', error };
  }).finally(() => {
    inFlight.delete(scene.id);
  });
  inFlight.set(scene.id, operation);
  return operation;
}

function flattenedComposition(tile) {
  const composition = tile?.flags?.[MODULE_ID]?.flattened?.composition;
  return composition && typeof composition === 'object' && !Array.isArray(composition) ? composition : null;
}

/**
 * The pictures of a flattened section name their owning Tile, and the live counterparts
 * of the documents kept in their archive, by UUID. Plan the same exact Scene-id
 * replacement for them. Archive addresses (`archiveId`, `archiveSceneId`) name the Scene
 * the archive was made in; Deconstruct maps them and they never change.
 */
export function planFlattenedSectionSceneRebind(tiles, sceneId) {
  const targetSceneId = normalizeIdentity(sceneId);
  const sections = (Array.isArray(tiles) ? tiles : []).filter((tile) => flattenedComposition(tile));
  if (!targetSceneId || !sections.length) return { status: 'bound' };
  const liveUuids = (composition) => [
    normalizeIdentity(composition.ownerUuid),
    ...(Array.isArray(composition.identities) ? composition.identities.map((binding) => normalizeIdentity(binding?.currentId)) : [])
  ];
  const sourceSceneIds = new Set(sections.flatMap((tile) => liveUuids(flattenedComposition(tile)))
    .map(embeddedSceneId).filter((id) => id && id !== targetSceneId));
  if (!sourceSceneIds.size) return { status: 'bound' };
  if (sourceSceneIds.size > 1) {
    return { status: 'refused', reason: 'multiple-source-scenes', sourceSceneIds: [...sourceSceneIds] };
  }

  const [sourceSceneId] = sourceSceneIds;
  const sourcePrefix = `Scene.${sourceSceneId}.`;
  const targetPrefix = `Scene.${targetSceneId}.`;
  const rebindUuid = (uuid) => (uuid.startsWith(sourcePrefix) ? `${targetPrefix}${uuid.slice(sourcePrefix.length)}` : uuid);
  const tileIds = new Set((Array.isArray(tiles) ? tiles : []).map((tile) => normalizeIdentity(tile?._id)));
  const updates = [];
  let reboundUuidCount = 0;
  for (const tile of sections) {
    const composition = flattenedComposition(tile);
    const changed = liveUuids(composition).filter((uuid) => uuid.startsWith(sourcePrefix)).length;
    if (!changed) continue;
    const ownerUuid = rebindUuid(normalizeIdentity(composition.ownerUuid));
    // A copy keeps every document id, so the owner must be one of its own Tiles.
    if (embeddedSceneId(ownerUuid) !== targetSceneId || !tileIds.has(ownerUuid.split('.').pop())) {
      return { status: 'refused', reason: 'missing-owner', sourceSceneIds: [sourceSceneId], tileId: normalizeIdentity(tile._id) };
    }
    const next = { ownerUuid };
    if (Array.isArray(composition.identities)) {
      next.identities = composition.identities.map((binding) => (
        typeof binding?.currentId === 'string' ? { ...binding, currentId: rebindUuid(normalizeIdentity(binding.currentId)) } : binding
      ));
    }
    updates.push({ _id: tile._id, flags: { [MODULE_ID]: { flattened: { composition: next } } } });
    reboundUuidCount += changed;
  }
  return { status: 'rebind', sourceSceneId, updates, reboundUuidCount };
}

const sectionsInFlight = new Map();

function readTileSources(scene) {
  return scene.tiles.map((tile) => ({ _id: tile.id, flags: tile._source.flags }));
}

/**
 * Persist the rebind of flattened sections for one world Scene. Without it a section has
 * no owner in the copy: it cannot be moved and Deconstruct cannot restore its sources.
 */
export function rebindFlattenedSectionsToScene(scene, { reason = 'unspecified' } = {}) {
  if (!canRebind(scene)) return Promise.resolve({ status: 'skipped' });
  const initial = planFlattenedSectionSceneRebind(readTileSources(scene), scene.id);
  if (initial.status === 'bound') return Promise.resolve(initial);
  if (initial.status === 'refused') {
    Logger.error('FlattenedSectionSceneRebind.refused', {
      sceneId: scene.id, reason: initial.reason, sourceSceneIds: initial.sourceSceneIds, tileId: initial.tileId, trigger: reason
    });
    return Promise.resolve(initial);
  }
  const existing = sectionsInFlight.get(scene.id);
  if (existing) return existing;
  const operation = runFoundryCompositionRegistryTransaction({ scene }, async () => {
    const plan = planFlattenedSectionSceneRebind(readTileSources(scene), scene.id);
    if (plan.status !== 'rebind') return plan;
    // Only the owner address and the identity list change; a plain merge replaces both
    // completely and leaves the rest of each Tile exactly as stored. This is not a step
    // of the GM's own work: on a viewed Scene it must not become something Ctrl+Z undoes.
    await scene.updateEmbeddedDocuments('Tile', plan.updates, { isUndo: true, faNexusSceneGroupCommand: true });
    const verified = planFlattenedSectionSceneRebind(readTileSources(scene), scene.id);
    if (verified.status !== 'bound') {
      throw new Error(`Flattened sections of Scene ${scene.id} still reference Scene ${plan.sourceSceneId} after rebinding.`);
    }
    Logger.info('FlattenedSectionSceneRebind.rebound', {
      sceneId: scene.id, sourceSceneId: plan.sourceSceneId, tiles: plan.updates.length, reboundUuidCount: plan.reboundUuidCount, trigger: reason
    });
    return { status: 'rebound', sourceSceneId: plan.sourceSceneId, tiles: plan.updates.length, reboundUuidCount: plan.reboundUuidCount };
  }).catch((error) => {
    Logger.error('FlattenedSectionSceneRebind.failed', {
      sceneId: scene.id, trigger: reason, error: String(error?.message || error)
    });
    globalThis.ui?.notifications?.error?.(
      `Flattened pictures in "${scene.name}" still point at the Scene it was copied from and could not be updated. The console (F12) has the details.`
    );
    return { status: 'failed', error };
  }).finally(() => {
    sectionsInFlight.delete(scene.id);
  });
  sectionsInFlight.set(scene.id, operation);
  return operation;
}

/** Both steps report their own failures and never reject. */
async function rebindCopiedSceneToItself(scene, options) {
  await rebindCompositionRegistryToScene(scene, options);
  await rebindFlattenedSectionsToScene(scene, options);
}

if (globalThis.Hooks?.on) {
  // The creating session converts a new copy at once, before anyone views it.
  Hooks.on('createScene', (scene, _options, userId) => {
    if (userId !== globalThis.game?.user?.id) return;
    void rebindCopiedSceneToItself(scene, { reason: 'create-scene' });
  });
  // Copies saved before this conversion existed, or made where it could not run,
  // are converted when a GM opens them.
  Hooks.on('canvasReady', (canvas) => {
    void rebindCopiedSceneToItself(canvas?.scene, { reason: 'canvas-ready' });
  });
  if (globalThis.canvas?.ready) void rebindCopiedSceneToItself(globalThis.canvas.scene, { reason: 'runtime-start' });
}
