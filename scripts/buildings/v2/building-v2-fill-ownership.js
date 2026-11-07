import { fingerprintBuildingV2Authoring } from './building-v2-existing-edit-runtime.js';

export { fingerprintBuildingV2Authoring } from './building-v2-existing-edit-runtime.js';

const MODULE_ID = 'fa-nexus';

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function identity(value) {
  return String(value || '').trim();
}

function sourceFlag(source, key) {
  return source?.flags?.[MODULE_ID]?.[key] ?? null;
}

function documentId(record) {
  return identity(record?.source?._id || record?.source?.id);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function blocked(reason, details = {}) {
  return { status: 'blocked', reason, ...details };
}

function generatedByBuilding(relationship, rootUuid, dependentUuid) {
  return identity(relationship?.type) === 'generated-by'
    && identity(relationship?.generator) === 'building'
    && identity(relationship?.ownerUuid) === rootUuid
    && identity(relationship?.dependentUuid) === dependentUuid;
}

export function inspectBuildingV2ManagedFill({ aggregate, sceneId, rootTileId, activeSession = false } = {}) {
  const normalizedSceneId = identity(sceneId);
  const normalizedRootId = identity(rootTileId);
  if (!normalizedSceneId || !normalizedRootId) return blocked('reference-required');
  if (activeSession) return blocked('active-edit-session');
  if (identity(aggregate?.sceneId) !== normalizedSceneId) return blocked('scene-unavailable');
  const root = aggregate?.root;
  const rootSource = root?.source;
  const rootUuid = identity(root?.uuid);
  const building = sourceFlag(rootSource, 'building');
  if (!rootSource || documentId(root) !== normalizedRootId || !rootUuid
    || ![4, 5].includes(Number(building?.schemaVersion))) {
    return blocked('committed-building-unavailable');
  }
  if (building?.authoring?.fill?.default || Number(building?.runtime?.fillProjection?.version) === 2) {
    return blocked('composite-fill-cannot-be-detached');
  }
  if (building?.authoring?.fill?.active !== true) return blocked('managed-fill-unavailable');
  if (!sameValue(building.fill, building.authoring.fill)
    || building?.runtime?.fillProjection?.active !== true) {
    return blocked('managed-fill-state-mismatch');
  }
  const generationId = identity(building?.runtime?.generationId);
  const buildingId = identity(building?.buildingId);
  const expectedFills = (building?.runtime?.expectedGeneratedDocuments || []).filter((entry) => (
    identity(entry?.documentName) === 'Tile' && identity(entry?.role) === 'fill'
  ));
  if (!buildingId || !generationId || expectedFills.length !== 1) {
    return blocked('managed-fill-state-mismatch');
  }
  const expectedFillId = identity(expectedFills[0]?.documentId);
  const candidates = (aggregate?.documents || []).filter((record) => {
    if (identity(record?.documentName) !== 'Tile' || documentId(record) !== expectedFillId) return false;
    const owner = sourceFlag(record?.source, 'buildingGenerated');
    const backlink = sourceFlag(record?.source, 'buildingFill');
    return Number(owner?.version) === 1
      && identity(owner?.buildingId) === buildingId
      && identity(owner?.rootTileId) === normalizedRootId
      && identity(owner?.generationId) === generationId
      && identity(owner?.role) === 'fill'
      && owner?.semanticId == null
      && Number(owner?.fragmentOrdinal) === 0
      && Number(backlink?.version) === 1
      && identity(backlink?.wallTileId) === normalizedRootId
      && identity(backlink?.fillTextureKey) === identity(building.authoring.fill?.asset?.key);
  });
  if (!expectedFillId || candidates.length !== 1) {
    return blocked(candidates.length > 1 ? 'managed-fill-ambiguous' : 'managed-fill-unavailable');
  }
  const fill = candidates[0];
  const fillUuid = identity(fill.uuid);
  const registry = aggregate?.registry;
  if (!fillUuid || !registry?.groups || !Array.isArray(registry.relationships)) {
    return blocked('registry-unavailable');
  }
  const rootGroups = Object.values(registry.groups).filter((group) => (
    Array.isArray(group?.directMemberUuids) && group.directMemberUuids.map(identity).includes(rootUuid)
  ));
  if (rootGroups.length !== 1) {
    return blocked('root-group-ambiguous', { groupIds: rootGroups.map((group) => identity(group?.id)) });
  }
  const ownership = registry.relationships.filter((relationship) => (
    generatedByBuilding(relationship, rootUuid, fillUuid)
  ));
  const incoming = registry.relationships.filter((relationship) => identity(relationship?.dependentUuid) === fillUuid);
  if (ownership.length !== 1 || incoming.length !== 1) {
    return blocked('managed-fill-ownership-ambiguous');
  }
  const directGroups = Object.values(registry.groups).filter((group) => (
    Array.isArray(group?.directMemberUuids) && group.directMemberUuids.map(identity).includes(fillUuid)
  ));
  if (directGroups.length) return blocked('managed-fill-already-direct');
  return {
    status: 'ready',
    sceneId: normalizedSceneId,
    rootTileId: normalizedRootId,
    root: clone(root),
    rootUuid,
    building: clone(building),
    fill: clone(fill),
    fillUuid,
    groupId: identity(rootGroups[0]?.id),
    registry: clone(registry)
  };
}

export function planMakeBuildingV2FillIndependent({ inspection } = {}) {
  if (inspection?.status !== 'ready') {
    throw new Error(`Building V2 Fill detachment requires an eligible managed Fill (${identity(inspection?.reason) || 'unknown'}).`);
  }
  const rootSource = clone(inspection.root?.source);
  const fillSource = clone(inspection.fill?.source);
  const building = clone(inspection.building);
  if (!rootSource || !fillSource || ![4, 5].includes(Number(building?.schemaVersion))) {
    throw new Error('Building V2 Fill detachment lost its exact durable sources.');
  }
  if (building.authoring?.fill?.default || Number(building.runtime?.fillProjection?.version) === 2) {
    throw new Error('Composite Building Fill cannot be made independent.');
  }
  const inactiveFill = { ...clone(building.authoring.fill), active: false };
  building.authoring.fill = clone(inactiveFill);
  building.fill = clone(inactiveFill);
  building.runtime.fillProjection = null;
  building.runtime.expectedGeneratedDocuments = (building.runtime.expectedGeneratedDocuments || []).filter((entry) => (
    !(identity(entry?.documentName) === 'Tile' && identity(entry?.role) === 'fill')
  ));
  building.runtime.authoringFingerprint = fingerprintBuildingV2Authoring(building.authoring);
  rootSource.flags ||= {};
  rootSource.flags[MODULE_ID] ||= {};
  rootSource.flags[MODULE_ID].building = clone(building);
  fillSource.flags ||= {};
  fillSource.flags[MODULE_ID] ||= {};
  delete fillSource.flags[MODULE_ID].buildingGenerated;
  delete fillSource.flags[MODULE_ID].buildingFill;
  const registry = clone(inspection.registry);
  const group = registry.groups?.[inspection.groupId];
  if (!group || !Array.isArray(group.directMemberUuids)) {
    throw new Error('Building V2 Fill detachment lost the owning Scene Group.');
  }
  group.directMemberUuids = [...new Set([...group.directMemberUuids.map(identity), inspection.fillUuid])];
  const beforeRelationshipCount = registry.relationships.length;
  registry.relationships = registry.relationships.filter((relationship) => !generatedByBuilding(
    relationship, inspection.rootUuid, inspection.fillUuid
  ));
  if (registry.relationships.length !== beforeRelationshipCount - 1) {
    throw new Error('Building V2 Fill detachment requires exactly one generated-by relationship.');
  }
  return Object.freeze({
    sceneId: inspection.sceneId,
    rootTileId: inspection.rootTileId,
    fillTileId: documentId(inspection.fill),
    before: Object.freeze({
      root: clone(inspection.root.source),
      fill: clone(inspection.fill.source),
      registry: clone(inspection.registry)
    }),
    after: Object.freeze({ root: rootSource, fill: fillSource, registry })
  });
}

function sceneDocumentSource(scene, documentName, id) {
  const collection = documentName === 'Tile' ? scene?.tiles : null;
  const document = collection?.get?.(id) || scene?.getEmbeddedDocument?.(documentName, id) || null;
  return document?.toObject?.(true) || clone(document?._source || document);
}

function registrySource(scene) {
  return clone(scene?.getFlag?.(MODULE_ID, 'compositionRegistry')
    ?? scene?.flags?.[MODULE_ID]?.compositionRegistry
    ?? scene?._source?.flags?.[MODULE_ID]?.compositionRegistry
    ?? null);
}

function exactPlanState(scene, plan, side) {
  return sameValue(sceneDocumentSource(scene, 'Tile', plan.rootTileId), plan[side].root)
    && sameValue(sceneDocumentSource(scene, 'Tile', plan.fillTileId), plan[side].fill)
    && sameValue(registrySource(scene), plan[side].registry);
}

function batchFor(scene, plan, side, { rollback = false } = {}) {
  const fillUpdate = clone(plan[side].fill);
  if (side === 'after') {
    fillUpdate[`flags.${MODULE_ID}.-=buildingGenerated`] = null;
    fillUpdate[`flags.${MODULE_ID}.-=buildingFill`] = null;
  }
  return [{
    action: 'update', documentName: 'Tile', parent: scene, diff: false,
    updates: [clone(plan[side].root), fillUpdate],
    isUndo: true,
    faNexusBuildingEditorDocumentWrite: true,
    ...(rollback ? { faNexusBuildingV2FillDetachRollback: true } : {})
  }, {
    action: 'update', documentName: 'Scene',
    updates: [{ _id: scene.id, [`flags.${MODULE_ID}.compositionRegistry`]: clone(plan[side].registry) }],
    isUndo: true,
    faNexusBuildingEditorDocumentWrite: true,
    ...(rollback ? { faNexusBuildingV2FillDetachRollback: true } : {})
  }];
}

export async function applyBuildingV2FillOwnershipPlan({ foundry, scene, plan } = {}) {
  if (!foundry?.documents?.modifyBatch) {
    throw new Error('Building V2 Fill detachment requires Foundry v14 documents.modifyBatch().');
  }
  if (!scene || identity(scene.id) !== identity(plan?.sceneId)) {
    throw new Error('Building V2 Fill detachment requires the exact active Scene.');
  }
  if (!exactPlanState(scene, plan, 'before')) {
    return blocked('managed-fill-changed');
  }
  let writeError = null;
  try {
    await foundry.documents.modifyBatch(batchFor(scene, plan, 'after'));
  } catch (error) {
    writeError = error;
  }
  if (!writeError && exactPlanState(scene, plan, 'after')) {
    return { kind: 'committed', writeCount: 3 };
  }
  let rollbackError = null;
  try {
    if (!exactPlanState(scene, plan, 'before')) {
      await foundry.documents.modifyBatch(batchFor(scene, plan, 'before', { rollback: true }));
    }
  } catch (error) {
    rollbackError = error;
  }
  const restored = exactPlanState(scene, plan, 'before');
  const error = new Error(restored && !rollbackError
    ? 'Building V2 Fill detachment failed and was rolled back completely.'
    : 'Building V2 Fill detachment failed and rollback left durable residue.', { cause: writeError || rollbackError });
  error.code = restored && !rollbackError ? 'fill-detach-rolled-back' : 'fill-detach-rollback-incomplete';
  error.phase = writeError ? 'write' : 'post-write-audit';
  error.rollback = restored && !rollbackError ? 'complete' : 'incomplete';
  throw error;
}

export class BuildingV2FillOwnershipService {
  constructor({
    readAggregate,
    applyPlan,
    transactionRunner = async (_reference, operation) => operation(),
    isActiveSession = () => false
  } = {}) {
    if (typeof readAggregate !== 'function' || typeof applyPlan !== 'function') {
      throw new TypeError('Building V2 Fill ownership requires aggregate read and atomic apply capabilities.');
    }
    this._readAggregate = readAggregate;
    this._applyPlan = applyPlan;
    this._transactionRunner = transactionRunner;
    this._isActiveSession = isActiveSession;
  }

  async inspectManagedFill({ sceneId, rootTileId } = {}) {
    const reference = { sceneId: identity(sceneId), rootTileId: identity(rootTileId) };
    const [aggregate, activeSession] = await Promise.all([
      this._readAggregate(reference),
      this._isActiveSession(reference)
    ]);
    return inspectBuildingV2ManagedFill({ ...reference, aggregate, activeSession: !!activeSession });
  }

  async makeFillIndependent({ sceneId, rootTileId, expectedFillUuid = null } = {}) {
    const reference = { sceneId: identity(sceneId), rootTileId: identity(rootTileId) };
    return this._transactionRunner(reference, async () => {
      const inspection = await this.inspectManagedFill(reference);
      if (inspection.status !== 'ready') return inspection;
      const expected = identity(expectedFillUuid);
      if (expected && expected !== inspection.fillUuid) {
        return blocked('managed-fill-changed', { expectedFillUuid: expected, fillUuid: inspection.fillUuid });
      }
      return this._applyPlan(planMakeBuildingV2FillIndependent({ inspection }));
    });
  }
}
