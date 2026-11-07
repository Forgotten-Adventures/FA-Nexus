import { FoundryBuildingSceneAdapter } from './building-fill-scene-adapter.js';
import { isBuildingEditSessionActive } from '../building-edit-delete-guard.js';
import { runFoundryCompositionRegistryTransaction } from '../../composition/composition-registry-transaction.js';
import { applyBuildingFillOperations } from './building-fill-transaction.js';
import { buildBuildingPatchOperation } from './building-fill-document-operations.js';

const MODULE_ID = 'fa-nexus';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function identity(value) {
  return String(value || '').trim();
}

function documentId(record) {
  return identity(record?.source?._id || record?.source?.id);
}

function sourceFlag(source, key) {
  return source?.flags?.[MODULE_ID]?.[key] ?? null;
}

function generatedByBuilding(relationship, rootUuid, dependentUuid) {
  return identity(relationship?.type) === 'generated-by'
    && identity(relationship?.generator) === 'building'
    && identity(relationship?.ownerUuid) === rootUuid
    && identity(relationship?.dependentUuid) === dependentUuid;
}

const RETAINED_FILL_TEXTURE_STATE_KEYS = Object.freeze([
  'textureScale', 'textureRotation', 'textureOffset', 'texturePhase', 'textureRepeatTransform'
]);

export const RETAINED_FILL_AUTHORITIES = Object.freeze(['live-document', 'authored-semantic']);

// Retained Fill defaults answer one question: what does this Building rebuild its Fill from the
// next time Fill is enabled? WHICH input is authoritative depends on who is retiring the Fill,
// so the caller states it instead of one rule being silently applied to both:
//
// - 'live-document' (Make Fill Independent): the Building is RELEASING a Tile the user keeps and
//   may have re-textured natively moments earlier. The released Tile's live appearance is the
//   last true Fill this Building had, so it wins.
// - 'authored-semantic' (an Edit session choosing No Fill, or an island successor): the draft is
//   the authority. A user who replaces the Fill artwork and then chooses No Fill in the SAME
//   session has authored that artwork as the retained default; letting the retiring Tile win
//   would silently discard a real edit. The retiring Tile is then only a RECOVERY source for
//   defaults the semantic never authored, e.g. a legacy Building whose Fill artwork lived on the
//   document alone.
//
// Mask state is never retained under either authority: it is regenerated from the authored
// outline and the live root pose whenever a managed Fill is created again.
export function captureInactiveManagedFillSemantic(
  rootSemantic,
  fillSource,
  now = () => Date.now(),
  { retainedAuthority = 'live-document' } = {}
) {
  if (!RETAINED_FILL_AUTHORITIES.includes(retainedAuthority)) {
    throw new TypeError(`Retained Building Fill defaults require a known authority, not ${String(retainedAuthority)}.`);
  }
  const authoredWins = retainedAuthority === 'authored-semantic';
  const next = clone(rootSemantic);
  next.meta ||= {};
  next.meta.managedFill = { schemaVersion: 1, active: false };
  next.meta.fillTileId = null;
  const existingTexture = Object.fromEntries(Object.entries(clone(next.meta.fillTexture || {})).filter(([key]) => ![
    'fillTileId', 'fillTileUuid', 'fillUuid', 'mask', 'maskData', 'maskShapes', 'maskSrc'
  ].includes(key)));
  const fillFlag = sourceFlag(fillSource, 'buildingFill') || {};
  const maskedTiling = clone(sourceFlag(fillSource, 'maskedTiling') || {});
  const recovered = {
    ...(Object.hasOwn(fillFlag, 'fillTextureKey') ? { key: clone(fillFlag.fillTextureKey) } : {}),
    ...(identity(fillSource?.texture?.src) ? { src: fillSource.texture.src } : {})
  };
  for (const key of RETAINED_FILL_TEXTURE_STATE_KEYS) {
    if (Object.hasOwn(maskedTiling, key)) recovered[key] = clone(maskedTiling[key]);
  }
  next.meta.fillTexture = authoredWins
    ? { ...recovered, ...existingTexture }
    : { ...existingTexture, ...recovered };
  // The BAND the retiring Fill occupied is retained under BOTH authorities: no session command
  // authors a Fill elevation, so the Tile that is being released or retired is the only place
  // the ground band this Building was placed into still exists. Without it, re-enabling Fill
  // would rebuild it from a root-relative guess in the wall's foreground band instead.
  const retiredElevation = Number(fillSource?.elevation);
  const retiredSort = Number(fillSource?.sort);
  if (Number.isFinite(retiredElevation)) next.meta.fillElevation = retiredElevation;
  if (Number.isFinite(retiredSort)) next.meta.fillSort = retiredSort;
  delete next.meta.fillTileUuid;
  delete next.meta.fillUuid;
  delete next.meta.fillMask;
  next.fill ||= {};
  delete next.fill.fillTileId;
  delete next.fill.fillTileUuid;
  delete next.fill.fillUuid;
  delete next.fill.mask;
  delete next.fill.maskData;
  delete next.fill.maskShapes;
  delete next.fill.maskSrc;
  const hsbc = sourceFlag(fillSource, 'hsbc');
  const keepAuthored = (field) => authoredWins && Object.hasOwn(next.fill, field);
  if (!keepAuthored('hsbc') && hsbc && typeof hsbc === 'object' && !Array.isArray(hsbc)) {
    next.fill.hsbc = clone(hsbc);
  }
  if (!keepAuthored('alpha') && Object.hasOwn(fillSource || {}, 'alpha')) {
    next.fill.alpha = fillSource.alpha;
  }
  next.updatedAt = Number(now());
  return next;
}

function blocked(reason, details = {}) {
  return { status: 'blocked', reason, ...details };
}

export function inspectManagedFillAggregate({ aggregate, sceneId, rootTileId, activeSession = false } = {}) {
  const normalizedSceneId = identity(sceneId);
  const normalizedRootId = identity(rootTileId);
  if (!normalizedSceneId || !normalizedRootId) return blocked('reference-required');
  if (activeSession) return blocked('active-edit-session');
  if (identity(aggregate?.sceneId) !== normalizedSceneId) return blocked('scene-unavailable');
  const root = aggregate?.root;
  const rootSource = root?.source;
  const rootUuid = identity(root?.uuid);
  const semantic = sourceFlag(rootSource, 'building');
  if (!rootSource || documentId(root) !== normalizedRootId || !rootUuid || !semantic || typeof semantic !== 'object') {
    return blocked('committed-building-unavailable');
  }
  if (semantic?.meta?.managedFill?.active === false) return blocked('managed-fill-unavailable');
  const registry = aggregate?.registry;
  if (!registry || !registry.groups || !Array.isArray(registry.relationships)) return blocked('registry-unavailable');
  const rootGroups = Object.values(registry.groups).filter((group) => (
    Array.isArray(group?.directMemberUuids) && group.directMemberUuids.map(identity).includes(rootUuid)
  ));
  if (rootGroups.length !== 1) return blocked('root-group-ambiguous', { groupIds: rootGroups.map((group) => identity(group?.id)) });
  const flaggedFills = (aggregate?.documents || []).filter((record) => (
    identity(record?.documentName) === 'Tile'
      && identity(sourceFlag(record?.source, 'buildingFill')?.wallTileId) === normalizedRootId
      && identity(record?.uuid)
  ));
  const ownedFills = flaggedFills.filter((fill) => registry.relationships.filter((relationship) => (
    generatedByBuilding(relationship, rootUuid, identity(fill.uuid))
  )).length === 1);
  if (flaggedFills.length !== 1 || ownedFills.length !== 1) {
    const reason = flaggedFills.length > 1
      ? 'managed-fill-ambiguous'
      : (flaggedFills.length === 1 ? 'managed-fill-ownership-ambiguous' : 'managed-fill-unavailable');
    return blocked(reason, {
      fillUuids: flaggedFills.map((fill) => identity(fill.uuid)),
      ownedFillUuids: ownedFills.map((fill) => identity(fill.uuid))
    });
  }
  const fill = ownedFills[0];
  const fillUuid = identity(fill.uuid);
  const fillId = documentId(fill);
  const semanticFillId = identity(semantic?.meta?.fillTileId);
  if (semantic?.meta?.managedFill?.active === true && !semanticFillId) {
    return blocked('managed-fill-identity-mismatch', { fillUuid, fillId, semanticFillId: null });
  }
  if (semanticFillId && semanticFillId !== fillId) {
    return blocked('managed-fill-identity-mismatch', { fillUuid, fillId, semanticFillId });
  }
  const incoming = registry.relationships.filter((relationship) => (
    identity(relationship?.dependentUuid) === fillUuid
  ));
  if (incoming.length !== 1 || !generatedByBuilding(incoming[0], rootUuid, fillUuid)) {
    return blocked('managed-fill-ownership-ambiguous', {
      fillUuid,
      relationshipIds: incoming.map((relationship) => identity(relationship?.id))
    });
  }
  const directGroupIds = Object.values(registry.groups).filter((group) => (
    Array.isArray(group?.directMemberUuids) && group.directMemberUuids.map(identity).includes(fillUuid)
  )).map((group) => identity(group?.id));
  if (directGroupIds.length) return blocked('managed-fill-already-direct', { fillUuid, groupIds: directGroupIds });
  const ownership = registry.relationships.filter((relationship) => generatedByBuilding(relationship, rootUuid, identity(fill.uuid)));
  return {
    status: 'ready', sceneId: normalizedSceneId, rootTileId: normalizedRootId,
    root: clone(root), rootUuid, semantic: clone(semantic), fill: clone(fill), fillUuid: identity(fill.uuid),
    groupId: identity(rootGroups[0]?.id), ownership: clone(ownership), registry: clone(registry)
  };
}

export function planMakeFillIndependent({ inspection, now = () => Date.now() } = {}) {
  if (inspection?.status !== 'ready') throw new Error(`Make Fill Independent requires an eligible managed Fill (${identity(inspection?.reason) || 'unknown'}).`);
  const root = inspection.root;
  const fill = inspection.fill;
  const rootSource = root?.source;
  const fillSource = fill?.source;
  const rootSemantic = sourceFlag(rootSource, 'building');
  const fillFlag = sourceFlag(fillSource, 'buildingFill');
  if (!rootSource || !fillSource || !rootSemantic || !fillFlag) throw new Error('Make Fill Independent lost its exact Building Fill source.');
  const nextSemantic = captureInactiveManagedFillSemantic(rootSemantic, fillSource, now);
  const afterRegistry = clone(inspection.registry);
  const group = afterRegistry.groups?.[inspection.groupId];
  if (!group || !Array.isArray(group.directMemberUuids)) throw new Error('Make Fill Independent could not resolve the owning Scene Group.');
  group.directMemberUuids = [...new Set([...group.directMemberUuids.map(identity), inspection.fillUuid])];
  afterRegistry.relationships = afterRegistry.relationships.filter((relationship) => !generatedByBuilding(
    relationship, inspection.rootUuid, inspection.fillUuid
  ));
  if (afterRegistry.relationships.length !== inspection.registry.relationships.length - 1) {
    throw new Error('Make Fill Independent requires exactly one generated-by ownership relationship.');
  }
  const semanticPath = `flags.${MODULE_ID}.building`;
  const fillFlagPath = `flags.${MODULE_ID}.buildingFill`;
  return {
    operations: [
      buildBuildingPatchOperation(root, {
        beforePatch: { [semanticPath]: clone(rootSemantic) }, afterPatch: { [semanticPath]: clone(nextSemantic) },
        beforeValues: { [semanticPath]: clone(rootSemantic) }, afterValues: { [semanticPath]: clone(nextSemantic) }
      }, 'make-building-fill-independent'),
      buildBuildingPatchOperation(fill, {
        beforePatch: { [fillFlagPath]: clone(fillFlag) }, afterPatch: { [`flags.${MODULE_ID}.-=buildingFill`]: null },
        beforeValues: { [fillFlagPath]: clone(fillFlag) }, afterValues: { [fillFlagPath]: undefined }
      }, 'make-building-fill-independent'),
      {
        kind: 'replace-registry', documentName: 'Scene', id: inspection.sceneId, uuid: `Scene.${inspection.sceneId}`,
        reason: 'make-building-fill-independent', beforeRegistry: clone(inspection.registry), afterRegistry
      }
    ],
    semantic: nextSemantic,
    registry: afterRegistry
  };
}

export class BuildingFillOwnershipService {
  constructor({
    sceneAdapter,
    transactionRunner = async ({ operation }) => operation(),
    isActiveSession = () => false,
    now = () => Date.now()
  } = {}) {
    if (!sceneAdapter?.readAggregate) throw new TypeError('Building Fill ownership requires a Scene adapter with readAggregate.');
    if (typeof transactionRunner !== 'function') throw new TypeError('Building Fill ownership requires a shared transaction runner.');
    if (typeof isActiveSession !== 'function') throw new TypeError('Building Fill ownership requires an active-session predicate.');
    if (typeof now !== 'function') throw new TypeError('Building Fill ownership requires a clock.');
    this._scene = sceneAdapter;
    this._transactionRunner = transactionRunner;
    this._isActiveSession = isActiveSession;
    this._now = now;
  }

  async inspectManagedFill({ sceneId, rootTileId } = {}) {
    const activeSession = await this._isActiveSession({ sceneId: identity(sceneId), rootTileId: identity(rootTileId) });
    const aggregate = await this._scene.readAggregate({ sceneId, rootTileId });
    return inspectManagedFillAggregate({ aggregate, sceneId, rootTileId, activeSession: !!activeSession });
  }

  async makeFillIndependent({ sceneId, rootTileId, expectedFillUuid = null } = {}) {
    const reference = { sceneId: identity(sceneId), rootTileId: identity(rootTileId) };
    return this._transactionRunner({
      scene: this._scene,
      reference,
      operation: async () => {
        const inspection = await this.inspectManagedFill(reference);
        if (inspection.status !== 'ready') return inspection;
        const expected = identity(expectedFillUuid);
        if (expected && inspection.fillUuid !== expected) {
          return blocked('managed-fill-changed', {
            expectedFillUuid: expected,
            fillUuid: inspection.fillUuid
          });
        }
        const plan = planMakeFillIndependent({ inspection, now: this._now });
        const result = await applyBuildingFillOperations({
          scene: this._scene,
          reference: { sceneId: inspection.sceneId, rootTileId: inspection.rootTileId },
          operations: plan.operations
        });
        return { ...result, inspection, plan: { operations: clone(plan.operations) } };
      }
    });
  }
}

export function createFoundryBuildingFillOwnershipService({
  resolveScene = (sceneId) => {
    const active = globalThis.canvas?.scene;
    if (identity(active?.id) === identity(sceneId)) return active;
    return globalThis.game?.scenes?.get?.(sceneId) || null;
  },
  now = () => Date.now()
} = {}) {
  const sceneAdapter = new FoundryBuildingSceneAdapter({ resolveScene });
  return new BuildingFillOwnershipService({
    sceneAdapter,
    isActiveSession: isBuildingEditSessionActive,
    now,
    transactionRunner: async ({ reference, operation }) => {
      const scene = resolveScene(reference?.sceneId);
      if (!scene) throw new Error(`Foundry Scene ${identity(reference?.sceneId)} is unavailable for Fill ownership.`);
      return runFoundryCompositionRegistryTransaction({ scene }, operation);
    }
  });
}

export default BuildingFillOwnershipService;
