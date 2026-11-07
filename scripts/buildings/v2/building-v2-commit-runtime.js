import { compileBuildingV2FillMaskSource, materializeBuildingV2FillMask, projectBuildingV2FillMaskToManagedTile, representativeBuildingV2Fill } from './building-v2-fill-mask-runtime.js';
import { validateBuildingV2OpeningProjection, buildingV2HasFullyOpenedArtwork, validateBuildingV2DoorWall, validateBuildingV2WindowWall, materializeBuildingV2DoorWall } from './building-v2-opening-runtime.js';
import { deriveBuildingV2SpatialPose, createBuildingV2SpatialTransform } from './building-v2-spatial-transform.js';
import { materializeBuildingV2DoorShadowForRoot } from './building-v2-door-shadow.js';
import { materializeBuildingV2WindowSills } from './building-v2-window.js';
import { createBuildingV053MigrationPreflightCapture, BUILDING_V053_EXPECTED_PROVENANCE } from './building-v2-v053-migration-preflight.js';

const MODULE_ID = 'fa-nexus';
const COMPOSITION_REGISTRY_FLAG = 'compositionRegistry';
const COMMIT_PLAN_VERSION = 1;

// Foundry 14.370 names a Tile created without a name after its texture file (TileDocument#_preCreate). A rollback
// recreates a Tile from its exact recorded source, such as a released 0.5.3 Tile retired by a migration Commit, so
// one recorded without a name must stay unnamed; otherwise the rollback is not exact and reports durable residue.
// Only the Building Commit rollback's own writes are touched.
globalThis.Hooks?.on?.('preCreateTile', (document, data, options) => {
  const recorded = data?.name;
  if (!options?.faNexusBuildingV2CommitRollback || recorded || document?._source?.name === recorded) return;
  document.updateSource(recorded === undefined ? { '-=name': null } : { name: recorded });
});

function executeAtomicDocumentBatch(foundry, operations) {
  const atomicOperations = operations.map((operation) => ({
    ...operation,
    // Foundry's native Canvas history is isolated per document layer. A Building Commit spans
    // Root/Fill Tiles, Walls, and sometimes the Scene registry, so recording those operations
    // independently would allow Ctrl/Cmd+Z to restore only one part of the aggregate.
    isUndo: true,
    faNexusBuildingEditorDocumentWrite: true
  }));
  return foundry.documents.modifyBatch(atomicOperations);
}

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function readFlag(document, key) {
  try {
    const value = document?.getFlag?.(MODULE_ID, key);
    if (value !== undefined) return value;
  } catch (_) {}
  return document?.flags?.[MODULE_ID]?.[key] ?? document?._source?.flags?.[MODULE_ID]?.[key];
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

function fingerprint(value) {
  const input = JSON.stringify(canonicalValue(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function isNativePortal(source) {
  return [1, 2].includes(source?.door)
    && !!sourcePortalId(source);
}

function sourcePortalId(source) {
  const flags = source?.flags?.[MODULE_ID];
  return flags?.buildingGenerated?.role === 'portal' ? flags.buildingGenerated.semanticId
    : flags?.buildingDoor?.gapId || flags?.buildingWindow?.gapId || null;
}

function isBuildingWindow(source) {
  const owner = source?.flags?.[MODULE_ID]?.buildingGenerated;
  return owner?.role === 'portal'
    && !!owner.windowSetup && typeof owner.windowSetup === 'object' && !Array.isArray(owner.windowSetup);
}

function isStaticBuildingWindow(source) {
  return isBuildingWindow(source)
    && source?.door === 0
    && source.flags[MODULE_ID].buildingGenerated.windowSetup.animated === false;
}

function portalStateIsValid(source) {
  return !isNativePortal(source) || [0, 1, 2].includes(source.ds);
}

function wallSourcesMatch(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((source, index) => {
    const target = expected[index];
    if (!portalStateIsValid(source)) return false;
    if (!isNativePortal(source) || !isNativePortal(target)) return sameValue(source, target);
    const left = clone(source), right = clone(target);
    delete left.ds; delete right.ds;
    return sameValue(left, right);
  });
}

function buildWallUpdate(source, current, intents = []) {
  const currentSource = documentSource(current);
  const compatibleWindow = isBuildingWindow(source) && isBuildingWindow(currentSource);
  const update = buildExactObjectUpdate(source, currentSource, [`flags.${MODULE_ID}`, 'flags.core']);
  if (currentSource?.doorSound !== undefined && source.doorSound === undefined) update['-=doorSound'] = null;
  const intent = intents.find(entry => entry.portalId === source.flags?.[MODULE_ID]?.buildingGenerated?.semanticId);
  if (isNativePortal(source) && isNativePortal(currentSource) && !intent) delete update.ds;
  if (isStaticBuildingWindow(source)) {
    // WallData.animation is nullable in Foundry v14. An absent planner field is
    // not enough to clear a prior animated Window through Foundry's merge update.
    update.animation = null;
    if (Object.prototype.hasOwnProperty.call(currentSource?.flags?.[MODULE_ID] || {}, 'windowShadow')
      && !Object.prototype.hasOwnProperty.call(source?.flags?.[MODULE_ID] || {}, 'windowShadow')) {
      update[`flags.${MODULE_ID}.-=windowShadow`] = null;
    }
  }
  if (compatibleWindow
    && Object.prototype.hasOwnProperty.call(currentSource?.flags?.[MODULE_ID] || {}, 'buildingWindow')
    && !Object.prototype.hasOwnProperty.call(source?.flags?.[MODULE_ID] || {}, 'buildingWindow')) {
    update[`flags.${MODULE_ID}.-=buildingWindow`] = null;
  }
  return update;
}

function dottedValue(source, path) {
  return String(path || '').split('.').reduce((value, key) => value?.[key], source);
}

function documentSource(document) {
  // Match the captured durable snapshot: prepared positions may be clamped and
  // Region values may contain boxed Colors or unbounded elevation infinities.
  return document?.toObject?.() || document?._source || document || {};
}

function matchesOwnedFields(document, expected, paths) {
  const source = documentSource(document);
  return (typeof expected?.name !== 'string' || source?.name === expected.name)
    && paths.every((path) => sameValue(dottedValue(source, path), dottedValue(expected, path)));
}

function collectionGet(collection, id) {
  return collection?.get?.(id) || Array.from(collection || []).find((entry) => String(entry?.id || entry?._id) === id) || null;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}

function requireDocumentId(value, label) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9]{16}$/.test(id)) throw new Error(`${label} must be a Foundry-valid 16-character document ID.`);
  return id;
}

function usableFillMask(mask) {
  if (mask?.maskType === 'composite') {
    const regions = mask.regions;
    return Number(mask.maskVersion) === 1 && Array.isArray(regions) && regions.length > 0
      && regions.some((region) => region.active === true)
      && new Set(regions.map((region) => region.regionId)).size === regions.length
      && regions.every((region) => typeof region.regionId === 'string' && region.regionId
        && typeof region.active === 'boolean' && usableFillMask(region.maskedTiling)
        && (!region.active || String(region.asset?.src || '').trim()));
  }
  const shapes = mask?.maskShapes?.shapes;
  return mask?.maskType === 'array' && Number(mask.maskShapes?.version) === 1
    && Array.isArray(shapes) && shapes.length > 0 && shapes.some((shape) => shape.operation === 'add')
    && shapes.every((shape) => shape.type === 'polygon' && ['add', 'subtract'].includes(shape.operation)
      && Array.isArray(shape.vertices) && shape.vertices.length >= 3
      && shape.vertices.every((vertex) => [vertex?.x, vertex?.y].every((value) => Number.isFinite(Number(value)))));
}

function managedFillArtworkReady(placeable) {
  const mesh = placeable?.mesh;
  const container = mesh?.faNexusMaskContainer || placeable?.faNexusMaskContainer;
  if (mesh?.faNexusMaskReady !== true || !container || container.destroyed) return false;
  const usablePair = (entry) => entry && !entry.destroyed && entry.faNexusTilingSprite
    && !entry.faNexusTilingSprite.destroyed && entry.faNexusMaskSprite && !entry.faNexusMaskSprite.destroyed;
  const mask = readFlag(placeable.document, 'maskedTiling');
  if (mask?.maskType !== 'composite') return !!usablePair(container);
  const expected = (mask.regions || []).filter((region) => region.active).map((region) => region.regionId).sort();
  const rendered = container.faNexusCompositeRegions;
  return expected.length > 0 && Array.isArray(rendered)
    && container.faNexusSourceFingerprint === mask.sourceFingerprint
    && sameValue(rendered.map((region) => region.regionId).sort(), expected)
    && rendered.every((region) => usablePair(region.container));
}

const BUILDING_SILLS_TEXTURE_SRC = 'modules/fa-nexus/images/transparent.png';
const BUILDING_SILLS_SOURCE = 'building-v2-window-sills';
const BUILDING_SILLS_FLAG_KEYS = Object.freeze([
  'version', 'source', 'wallTileId', 'buildingId', 'partsKey', 'parts'
]);
const MANAGED_SILLS_PRESENTATION_PATHS = Object.freeze([
  'elevation', 'sort', 'hidden', 'locked', 'levels'
]);
const MANAGED_SILLS_PLACEMENT_PATHS = Object.freeze([
  'elevation', 'sort', 'levels', `flags.${MODULE_ID}.placementLevelId`
]);

function managedSillsArtworkReady(placeable) {
  const container = placeable?.faNexusBuildingCompositeContainer
    || placeable?.mesh?.faNexusBuildingCompositeContainer;
  return !!container && !container.destroyed && Array.isArray(container.children)
    && container.children.length > 0;
}

function requireBuildingSillsFlag(source, { rootTileId, buildingId, requirePlacement = true } = {}) {
  const flag = source?.flags?.[MODULE_ID]?.buildingSills;
  if (!flag || Object.keys(flag).sort().join('|') !== [...BUILDING_SILLS_FLAG_KEYS].sort().join('|')
    || Number(flag.version) !== 1 || flag.source !== BUILDING_SILLS_SOURCE
    || flag.wallTileId !== rootTileId || flag.buildingId !== buildingId
    || !Array.isArray(flag.parts) || !flag.parts.length || flag.partsKey !== fingerprint(flag.parts)) {
    throw new Error('Building V2 managed Sills requires one exact versioned buildingSills payload with non-empty parts.');
  }
  const elevation = Number(source?.elevation);
  const sort = Number(source?.sort);
  if (!Number.isFinite(elevation) || !Number.isFinite(sort)
    || flag.parts.some((part) => !Number.isFinite(Number(part?.elevation)) || !Number.isFinite(Number(part?.sort))
      || (requirePlacement && (Number(part.elevation) !== elevation || Number(part.sort) !== sort)))) {
    throw new Error('Building V2 managed Sills requires exact released Tile and part placement/order fields.');
  }
  return flag;
}

function requireCompositeFillAuthority(plan, scene) {
  const building = plan.root?.flags?.[MODULE_ID]?.building;
  if (!building?.authoring?.fill?.default) return;
  const fill = representativeBuildingV2Fill(building.authoring.fill);
  if (!fill.active) {
    if (plan.fill != null || building.runtime?.fillProjection != null) throw new Error('Inactive composite Fill cannot own a managed projection.');
    return;
  }
  const source = compileBuildingV2FillMaskSource(building.authoring);
  const projection = building.runtime?.fillProjection;
  const expected = { baseSrc: fill.asset.src, textureScale: 1, textureRotation: 0,
    ...projectBuildingV2FillMaskToManagedTile({
      materialization: materializeBuildingV2FillMask(source, { sceneGridSize: scene.grid?.size }),
      building, rootSource: plan.root, textureBasis: fill.textureBasis, appearance: fill.appearance
    }) };
  if (!sameValue(building.fill, building.authoring.fill) || Number(projection?.version) !== 2
    || projection?.active !== true || !sameValue(projection.maskSource, source)
    || projection.maskSourceFingerprint !== source.fingerprint
    || !sameValue(projection.asset, fill.asset) || !sameValue(projection.appearance, fill.appearance)
    || !sameValue(projection.textureBasis, fill.textureBasis)
    || !sameValue(plan.fill?.flags?.[MODULE_ID]?.maskedTiling, expected)
    || plan.fill?.texture?.src !== fill.asset.src
    || plan.fill?.flags?.[MODULE_ID]?.buildingFill?.fillTextureKey !== fill.asset.key
    || Number(plan.fill?.alpha) !== 1 || !sameValue(plan.fill?.flags?.[MODULE_ID]?.hsbc, fill.appearance.hsbc)) {
    throw new Error('Building V2 composite Fill must exactly match its compact authoring projection.');
  }
}

function requireManagedFill(plan, { sceneId, rootTileId, rootUuid, wallIds }) {
  const expectedFillEntries = (Array.isArray(plan.expected?.generatedDocuments)
    ? plan.expected.generatedDocuments : []).filter((entry) => entry?.role === 'fill');
  if (plan.fill == null) {
    if (expectedFillEntries.length) {
      throw new Error('Building V2 no-Fill commit cannot declare an expected managed Fill document.');
    }
    return { fillId: null, fillUuid: null };
  }
  const fill = plan.fill;
  const fillId = requireDocumentId(fill?._id, 'managed Fill Tile ID');
  if (fillId === rootTileId || wallIds.includes(fillId)) {
    throw new Error('Building V2 managed Fill identity must be unique from its Root and native Walls.');
  }
  const textureSrc = String(fill?.texture?.src || '').trim();
  if (!textureSrc) throw new Error('Building V2 managed Fill requires retained artwork texture.');
  for (const path of ['x', 'y', 'width', 'height', 'rotation', 'texture.anchorX', 'texture.anchorY']) {
    if (!Number.isFinite(Number(dottedValue(fill, path)))) {
      throw new Error(`Building V2 managed Fill requires a finite pose value at ${path}.`);
    }
    if (!sameValue(dottedValue(fill, path), dottedValue(plan.root, path))) {
      throw new Error(`Building V2 managed Fill must match its Root pose at ${path}.`);
    }
  }
  const owner = fill?.flags?.[MODULE_ID]?.buildingGenerated;
  if (Number(owner?.version) !== 1
    || owner?.role !== 'fill'
    || owner?.buildingId !== plan.buildingId
    || owner?.rootTileId !== rootTileId
    || owner?.generationId !== plan.generationId) {
    throw new Error('Building V2 managed Fill requires exact Building generated-by owner flags.');
  }
  const fillBacklink = fill?.flags?.[MODULE_ID]?.buildingFill;
  if (Number(fillBacklink?.version) !== 1 || fillBacklink?.wallTileId !== rootTileId) {
    throw new Error('Building V2 managed Fill requires an exact Root backlink.');
  }
  const maskedTiling = fill?.flags?.[MODULE_ID]?.maskedTiling;
  if (!usableFillMask(maskedTiling) || String(maskedTiling?.baseSrc || '').trim() !== textureSrc) {
    throw new Error('Building V2 managed Fill requires a usable maskedTiling mask and matching baseSrc.');
  }
  if (expectedFillEntries.length !== 1
    || expectedFillEntries[0]?.documentName !== 'Tile'
    || expectedFillEntries[0]?.documentId !== fillId) {
    throw new Error('Building V2 managed Fill requires one exact expected generated-document entry.');
  }
  return { fillId, fillUuid: `Scene.${sceneId}.Tile.${fillId}` };
}

function requireManagedSills(plan, { sceneId, rootTileId, rootUuid, excludedIds }) {
  const expectedSillEntries = (Array.isArray(plan.expected?.generatedDocuments)
    ? plan.expected.generatedDocuments : []).filter((entry) => entry?.role === 'sill');
  const runtimeSillParts = plan.root?.flags?.[MODULE_ID]?.building?.runtime?.sills ?? [];
  if (!Array.isArray(runtimeSillParts)) {
    throw new Error('Building V2 managed Sills requires an exact runtime parts projection array.');
  }
  if (plan.sills == null) {
    if (expectedSillEntries.length || runtimeSillParts.length) {
      throw new Error('Building V2 no-Sills commit cannot declare an expected managed Sills document.');
    }
    return { sillsId: null, sillsUuid: null };
  }
  const sills = plan.sills;
  const sillsId = requireDocumentId(sills?._id, 'managed Sills Tile ID');
  if (excludedIds.includes(sillsId)) {
    throw new Error('Building V2 managed Sills identity must be unique from its Root, Fill, native Walls, and Regions.');
  }
  if (String(sills?.texture?.src || '') !== BUILDING_SILLS_TEXTURE_SRC || Number(sills?.alpha) !== 1) {
    throw new Error('Building V2 managed Sills requires the shared transparent texture and full Tile alpha.');
  }
  for (const path of ['x', 'y', 'width', 'height', 'rotation', 'texture.anchorX', 'texture.anchorY']) {
    if (!Number.isFinite(Number(dottedValue(sills, path)))
      || !sameValue(dottedValue(sills, path), dottedValue(plan.root, path))) {
      throw new Error(`Building V2 managed Sills must match its Root pose at ${path}.`);
    }
  }
  const owner = sills?.flags?.[MODULE_ID]?.buildingGenerated;
  if (Number(owner?.version) !== 1 || owner?.role !== 'sill'
    || owner?.buildingId !== plan.buildingId || owner?.rootTileId !== rootTileId
    || owner?.generationId !== plan.generationId || owner?.semanticId !== null
    || Number(owner?.fragmentOrdinal) !== 0) {
    throw new Error('Building V2 managed Sills requires exact Building generated-by owner flags.');
  }
  const sillsFlag = requireBuildingSillsFlag(sills, { rootTileId, buildingId: plan.buildingId });
  const expectedParts = materializeBuildingV2WindowSills(runtimeSillParts, {
    rootSource: plan.root, building: plan.root.flags[MODULE_ID].building,
    elevation: Number(sills.elevation), sort: Number(sills.sort)
  });
  if (!sameValue(sillsFlag.parts, expectedParts)) {
    throw new Error('Building V2 managed Sills Tile parts must exactly materialize the Building-local Root runtime projection.');
  }
  if (expectedSillEntries.length !== 1 || expectedSillEntries[0]?.documentName !== 'Tile'
    || expectedSillEntries[0]?.documentId !== sillsId || expectedSillEntries[0]?.semanticId !== null
    || Number(expectedSillEntries[0]?.fragmentOrdinal) !== 0) {
    throw new Error('Building V2 managed Sills requires one exact expected generated-document entry.');
  }
  return { sillsId, sillsUuid: `Scene.${sceneId}.Tile.${sillsId}` };
}

function requireMigrationBaseline(plan) {
  const migration = plan.migration;
  if (migration == null) return null;
  const aggregate = migration.aggregate;
  const root = aggregate?.root;
  const legacy = root?.flags?.[MODULE_ID]?.building;
  if (migration.version !== 1 || !sameValue(migration.source, BUILDING_V053_EXPECTED_PROVENANCE)
    || Number(legacy?.version) !== 1 || legacy?.schemaVersion != null || legacy?.meta?.version !== '0.0.111'
    || !sameValue(plan.preconditions?.root, root)
    || !Array.isArray(aggregate?.linked?.walls) || !Array.isArray(aggregate?.linked?.tiles)) {
    throw new Error('Building v0.5.3 Commit requires the exact supported released source baseline.');
  }
  const linked = aggregate.linked;
  const exact = entry => !entry.ownerConflict && (entry.tileMatch || entry.groupMatch);
  const fill = linked.tiles.find(entry => exact(entry) && entry.flags?.buildingFill)?.source || null;
  const sills = linked.tiles.find(entry => exact(entry) && entry.flags?.buildingComposite?.role === 'sill')?.source || null;
  const regions = linked.regions.filter(exact).map(entry => entry.source);
  const walls = linked.walls.filter(exact).map(entry => entry.source);
  if (!sameValue(plan.preconditions.fill ?? null, fill) || !sameValue(plan.preconditions.sills ?? null, sills)
    || !sameValue(plan.preconditions.regions || [], regions)
    || !(plan.preconditions.walls || []).every(source => walls.some(wall => wallSourcesMatch([source], [wall])))) {
    throw new Error('Building v0.5.3 Commit baseline outputs disagree with exact captured ownership.');
  }
  const retained = new Set([root._id, fill?._id, sills?._id].filter(Boolean));
  const retiredTiles = [...new Map([...linked.innerRoots.map(entry => entry.source), ...linked.tiles.map(entry => entry.source)]
    .filter(source => !retained.has(source._id)).map(source => [source._id, source])).values()];
  return { ...migration, retiredTiles };
}

function requireMigrationPreconditions(scene, validated) {
  if (!validated.migration) return;
  const current = createBuildingV053MigrationPreflightCapture({ getCanvas: () => ({ scene }) })({
    sceneId: scene.id, rootTileId: validated.migration.aggregate.root._id
  });
  const omitLiveState = aggregate => {
    const result = clone(aggregate);
    for (const wall of result.linked.walls) if (isNativePortal(wall.source)) delete wall.source.ds;
    return result;
  };
  if (current.status !== 'captured' || current.facts.missing.length || current.facts.ambiguous.length
    || !sameValue(omitLiveState(current.aggregate), omitLiveState(validated.migration.aggregate))) {
    throw commitError('Building v0.5.3 ownership or source changed after Open.', { code: 'stale-existing-building', phase: 'preconditions' });
  }
}

function migrationTileOperations(scene, validated, rollback = false) {
  const sources = validated.migration?.retiredTiles || [];
  if (!sources.length) return [];
  const options = { documentName: 'Tile', parent: scene, faNexusPreserveLinkedTileCleanup: true,
    faNexusBuildingEditorDocumentWrite: true, ...(rollback ? { faNexusBuildingV2CommitRollback: true } : {}) };
  if (!rollback) return [{ ...options, action: 'delete', ids: sources.map(source => source._id) }];
  const missing = sources.filter(source => !collectionGet(scene.tiles, source._id));
  return missing.length ? [{ ...options, action: 'create', data: clone(missing), keepId: true }] : [];
}

function migrationTilesMatch(scene, validated, baseline = false) {
  return (validated.migration?.retiredTiles || []).every(source => {
    const actual = collectionGet(scene.tiles, source._id);
    return baseline ? actual && sameValue(documentSource(actual), source) : !actual;
  });
}

function requireManagedRegions(plan, { sceneId, rootTileId, rootUuid, excludedIds }) {
  const regions = plan.regions ?? [];
  const baselineRegions = plan.kind === 'existing-edit' ? (plan.preconditions?.regions ?? []) : [];
  if (!Array.isArray(regions) || regions.length > 1
    || !Array.isArray(baselineRegions) || baselineRegions.length > 1) {
    throw new Error('Building V2 requires at most one Surface Region per Building.');
  }
  const regionIds = regions.map((region) => requireDocumentId(region?._id, 'Surface Region ID'));
  const baselineRegionIds = baselineRegions.map((region) => requireDocumentId(region?._id, 'baseline Surface Region ID'));
  if ([...regionIds, ...baselineRegionIds].some((id) => excludedIds.includes(id))) {
    throw new Error('Building V2 Surface Region identities must be unique from other outputs.');
  }
  const expected = (plan.expected?.generatedDocuments || []).filter((entry) => entry?.role === 'surface-region');
  if (!sameValue(expected, regions.map((region) => ({
    documentName: 'Region', documentId: region._id, role: 'surface-region', semanticId: null, fragmentOrdinal: 0
  })))) throw new Error('Building V2 Surface Region requires exact expected generated-document entries.');
  const runtimeRegions = plan.root?.flags?.[MODULE_ID]?.building?.runtime?.regions || [];
  if (!Array.isArray(runtimeRegions) || regions.length !== runtimeRegions.length) {
    throw new Error('Building V2 Surface Region sources must match the compiled runtime projection.');
  }
  for (const [sources, generationId] of [
    [regions, plan.generationId],
    [baselineRegions, plan.preconditions?.root?.flags?.[MODULE_ID]?.building?.runtime?.generationId]
  ]) for (const region of sources) {
    const owner = region?.flags?.[MODULE_ID]?.buildingGenerated;
    if (plan.migration && sources === baselineRegions) continue; // Exact released ownership is validated by requireMigrationBaseline.
    if (Number(owner?.version) !== 1 || owner?.role !== 'surface-region'
      || owner?.buildingId !== plan.buildingId || owner?.rootTileId !== rootTileId
      || owner?.generationId !== generationId || !Array.isArray(region.shapes) || !region.shapes.length) {
      throw new Error('Building V2 Surface Region requires exact ownership and nonempty shapes.');
    }
  }
  if (regionIds.length && baselineRegionIds.length && regionIds[0] !== baselineRegionIds[0]) {
    throw new Error('Building V2 existing Commit must retain its compatible Surface Region identity.');
  }
  const baselineRelationships = normalizeRegistry(plan.preconditions?.compositionRegistry).relationships.filter((entry) => (
    entry?.type === 'generated-by' && entry?.generator === 'building' && entry?.ownerUuid === rootUuid
    && String(entry?.dependentUuid || '').startsWith(`Scene.${sceneId}.Region.`)
  ));
  if (!plan.migration && (baselineRelationships.length !== baselineRegions.length
    || (baselineRegions.length && baselineRelationships[0].dependentUuid !== `Scene.${sceneId}.Region.${baselineRegionIds[0]}`))) {
    throw new Error('Building V2 baseline Surface Region requires exact generated-by ownership.');
  }
  if (!plan.migration && regionIds.length && baselineRegionIds.length) {
    const relationship = (plan.relationships || []).find((entry) => entry.dependentUuid === `Scene.${sceneId}.Region.${regionIds[0]}`);
    if (relationship?.id !== baselineRelationships[0]?.id) {
      throw new Error('Building V2 existing Commit must retain its Surface Region relationship identity.');
    }
  }
  const plannedRegionRelationships = (plan.compositionRegistry?.relationships || []).filter((entry) => (
    entry?.type === 'generated-by' && entry?.generator === 'building' && entry?.ownerUuid === rootUuid
    && String(entry?.dependentUuid || '').startsWith(`Scene.${sceneId}.Region.`)
  ));
  if (plannedRegionRelationships.length !== regions.length
    || (regions.length && plannedRegionRelationships[0].dependentUuid !== `Scene.${sceneId}.Region.${regionIds[0]}`)) {
    throw new Error('Building V2 Surface Region registry must retire obsolete ownership exactly.');
  }
  return { regions, regionIds, baselineRegions, baselineRegionIds };
}

function managedRegionsForRoot(scene, validated) {
  return collectionValues(scene?.regions).filter((document) => {
    const owner = generatedOwner(document);
    return (owner?.role === 'surface-region' && owner?.buildingId === validated.plan.buildingId
      && owner?.rootTileId === validated.rootTileId)
      || (validated.migration && readFlag(document, 'buildingRegion')?.wallTileId === validated.rootTileId);
  });
}

function matchesRegionSource(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length
    && expected.every((value, index) => matchesRegionSource(actual[index], value));
  if (expected && typeof expected === 'object') return !!actual && typeof actual === 'object'
    && Object.entries(expected).every(([key, value]) => key === '_stats' || matchesRegionSource(actual[key], value));
  return sameValue(actual, expected);
}

function regionStateMatches(scene, validated, baseline = false) {
  const components = validated.components || [validated];
  const sources = baseline ? validated.baselineRegions : validated.regions;
  const owned = components.flatMap((component) => managedRegionsForRoot(scene, component));
  if (!sameValue(owned.map((region) => String(region.id || region._id)).sort(), sources.map((region) => region._id).sort())) return false;
  if (!sources.every((source) => {
    const document = collectionGet(scene?.regions, source._id);
    return document && sameValue(generatedOwner(document), generatedOwner(source))
      && (baseline ? sameValue(documentSource(document), source)
      : matchesRegionSource(documentSource(document), source));
  })) return false;
  const absent = (baseline ? validated.regions : validated.baselineRegions).filter((source) => !sources.some((entry) => entry._id === source._id));
  return absent.every((source) => !collectionGet(scene?.regions, source._id));
}

function requireRegionPreconditions(scene, validated) {
  requireMigrationPreconditions(scene, validated);
  if (!regionStateMatches(scene, validated, true)) {
    throw commitError('Building V2 Surface Region baseline or identity changed after planning.', {
      code: 'stale-existing-building', phase: 'preconditions'
    });
  }
}

function buildRegionSourceUpdate(target, current, rollback) {
  const update = { _id: target._id };
  const writeChangedValue = (desired, previous, path) => {
    if (sameValue(desired, previous)) return;
    if (desired === undefined) {
      const parts = path.split('.');
      const key = parts.pop();
      update[[...parts, `-=${key}`].join('.')] = null;
    } else if (desired && previous && typeof desired === 'object' && typeof previous === 'object'
      && !Array.isArray(desired) && !Array.isArray(previous)) {
      for (const key of new Set([...Object.keys(desired), ...Object.keys(previous)])) {
        writeChangedValue(desired[key], previous[key], `${path}.${key}`);
      }
    } else update[path] = clone(desired);
  };
  // Normal Commit owns only geometry and generator flags. Resending Region behaviors recreates
  // their embedded documents in Foundry, losing metadata even when the data appears unchanged.
  const paths = rollback
    ? [...new Set([...Object.keys(target), ...Object.keys(current)])].filter((key) => key !== '_id')
    : ['shapes', `flags.${MODULE_ID}.buildingGenerated`, `flags.${MODULE_ID}.buildingRegion`];
  for (const path of paths) writeChangedValue(dottedValue(target, path), dottedValue(current, path), path);
  return update;
}

function buildRegionOperations(scene, validated, rollback = false) {
  const target = rollback ? validated.baselineRegions : validated.regions;
  const prior = rollback ? validated.regions : validated.baselineRegions;
  const operations = [];
  const options = { documentName: 'Region', parent: scene, faNexusBuildingEditorDocumentWrite: true,
    ...(rollback ? { faNexusBuildingV2CommitRollback: true } : {}) };
  for (const source of target) {
    const live = collectionGet(scene?.regions, source._id);
    if (live) {
      const update = buildRegionSourceUpdate(source, documentSource(live), rollback);
      if (Object.keys(update).length > 1) operations.push({ ...options, action: 'update', diff: false, updates: [update] });
    } else operations.push({ ...options, action: 'create', data: [clone(source)], keepId: true });
  }
  for (const source of prior) {
    if (target.some((entry) => entry._id === source._id)) continue;
    const live = collectionGet(scene?.regions, source._id);
    if (live && (!rollback || sameValue(generatedOwner(live), generatedOwner(source)))) {
      operations.push({ ...options, action: 'delete', ids: [source._id] });
    }
  }
  return operations;
}

function requireSiblingTileSortTransitions(plan, { excludedTileIds = [], label = 'Building V2' } = {}) {
  const updates = Array.isArray(plan.siblingTileUpdates) ? plan.siblingTileUpdates.map((update) => ({
    _id: requireDocumentId(update?._id, `${label} sibling Tile update ID`),
    sort: Number(update?.sort)
  })) : [];
  const preconditions = Array.isArray(plan.preconditions?.siblingTiles)
    ? plan.preconditions.siblingTiles.map((entry) => ({
        _id: requireDocumentId(entry?._id, `${label} sibling Tile precondition ID`),
        sort: Number(entry?.sort)
      }))
    : [];
  const updateIds = updates.map((entry) => entry._id);
  const preconditionIds = preconditions.map((entry) => entry._id);
  const excluded = new Set(excludedTileIds.map((id) => String(id || '').trim()).filter(Boolean));
  if (updates.some((entry) => !Number.isFinite(entry.sort))
    || preconditions.some((entry) => !Number.isFinite(entry.sort))
    || new Set(updateIds).size !== updateIds.length
    || new Set(preconditionIds).size !== preconditionIds.length
    || updateIds.some((id) => excluded.has(id))
    || !sameValue([...updateIds].sort(), [...preconditionIds].sort())) {
    throw new Error(`${label} sibling sort updates require unique exact non-owned Tile preconditions.`);
  }
  return { siblingTileUpdates: updates, siblingTilePreconditions: preconditions };
}

function requirePortalStateIntents(plan) {
  const intents = plan.portalStateIntents ?? [];
  if (!Array.isArray(intents)) throw new Error('Building V2 Portal live-state intents must be an array.');
  const components = plan.kind === 'multi-building' ? plan.components || [] : [plan];
  const walls = components.flatMap(component => component.walls || []);
  const ids = new Set();
  for (const intent of intents) {
    if (!intent || Object.keys(intent).some(key => !['portalId', 'documentId', 'baseline', 'state'].includes(key))
      || typeof intent.portalId !== 'string' || !intent.portalId || ids.has(intent.portalId)
      || ![0, 1, 2].includes(intent.baseline) || ![0, 1, 2].includes(intent.state)) {
      throw new Error('Building V2 requires unique exact Portal live-state intents.');
    }
    const prior = plan.preconditions?.walls?.find(wall => wall._id === intent.documentId);
    const targets = walls.filter(wall => wall.flags?.[MODULE_ID]?.buildingGenerated?.semanticId === intent.portalId);
    // The source and the result are both native Portals. Their door type may differ: a conversion between native
    // Portal kinds (Door, Seamless Secret Door, animated Window) keeps the Wall document and its live state.
    if (!isNativePortal(prior) || sourcePortalId(prior) !== intent.portalId
      || targets.length !== 1 || !isNativePortal(targets[0])
      || targets[0].ds !== intent.state) {
      throw new Error('Building V2 Portal live-state intent must name its exact compatible native source and result.');
    }
    ids.add(intent.portalId);
  }
  return intents;
}

function assertPortalStateBaselines(plan, scene) {
  for (const intent of requirePortalStateIntents(plan)) {
    const wall = documentSource(collectionGet(scene?.walls, intent.documentId));
    const prior = plan.preconditions.walls.find(entry => entry._id === intent.documentId);
    if (!wall || !wallSourcesMatch([wall], [prior]) || wall.ds !== intent.baseline) {
      throw commitError(`Portal ${intent.portalId} Live State changed. Resolve the conflict before Commit.`, {
        code: 'portal-live-state-conflict', phase: 'preconditions'
      });
    }
  }
}

export function refreshBuildingV2PortalLiveState(plan, scene) {
  const refreshed = clone(plan);
  const baseline = refreshed.preconditions?.walls || [];
  const componentPlans = refreshed.kind === 'multi-building' ? refreshed.components || [] : [refreshed];
  const desired = refreshed.kind === 'multi-building'
    ? (refreshed.components || []).flatMap(component => component.walls || []) : refreshed.walls || [];
  const intents = requirePortalStateIntents(refreshed);
  // A durable Commit whose local handoff failed is a retry, not a second state
  // command. Do not reapply its intention over subsequent gameplay changes.
  const alreadyApplied = intents.length && componentPlans.every(component => {
    const root = documentSource(collectionGet(scene?.tiles, component.rootTileId));
    return !!component.generationId && root?.flags?.[MODULE_ID]?.building?.runtime?.generationId === component.generationId;
  }) && desired.every(target => documentSource(collectionGet(scene?.walls, target._id))
    ?.flags?.[MODULE_ID]?.buildingGenerated?.generationId === target.flags?.[MODULE_ID]?.buildingGenerated?.generationId);
  if (alreadyApplied) refreshed.portalStateIntents = [];
  else assertPortalStateBaselines(refreshed, scene);
  const livePortalKind = (wall, prior = false) => {
    const owner = wall?.flags?.[MODULE_ID]?.buildingGenerated;
    if (owner?.role !== 'portal') return null;
    const component = componentPlans.find((entry) => entry?.buildingId === owner.buildingId
      && entry?.rootTileId === owner.rootTileId);
    const root = prior ? refreshed.preconditions?.root || component?.preconditions?.root || component?.root : component?.root;
    const occupation = root?.flags?.[MODULE_ID]?.building?.authoring?.portalsById?.[owner.semanticId];
    if (wall.door === 1 && (!occupation || occupation.kind === 'door')) return 'portal';
    if (wall.door === 2 && ['window', 'seamlessSecretDoor'].includes(occupation?.kind)) return 'portal';
    return null;
  };
  for (const prior of baseline) {
    const kind = livePortalKind(prior, true);
    if (!kind) continue;
    const current = documentSource(collectionGet(scene?.walls, prior._id));
    if (!current || ![0, 1, 2].includes(current.ds)) continue;
    const withoutState = value => { const copy = clone(value); delete copy.ds; return copy; };
    if (!sameValue(withoutState(prior), withoutState(current))) continue;
    prior.ds = current.ds;
    const target = desired.find(wall => wall._id === prior._id && livePortalKind(wall) === kind);
    if (target && !refreshed.portalStateIntents?.some(intent => intent.portalId === target.flags?.[MODULE_ID]?.buildingGenerated?.semanticId)) target.ds = current.ds;
  }
  return refreshed;
}

function requirePlan(plan, { sceneGridSize, partitionRootIds = [], partitionSourceRootId = null } = {}) {
  if (!plan || Number(plan.version) !== COMMIT_PLAN_VERSION) {
    throw new Error(`Building V2 commit runtime requires plan version ${COMMIT_PLAN_VERSION}.`);
  }
  const migration = requireMigrationBaseline(plan);
  const sceneId = String(plan.sceneId || '').trim();
  if (!sceneId) throw new Error('Building V2 commit plan requires a Scene identity.');
  const rootTileId = requireDocumentId(plan.rootTileId, 'Building V2 Root Tile ID');
  if (String(plan.root?._id || '') !== rootTileId) throw new Error('Building V2 commit Root source identity mismatch.');
  if (!plan.root?.texture?.src) throw new Error('Building V2 commit Root requires a valid texture source.');
  if (![4, 5].includes(Number(plan.root?.flags?.[MODULE_ID]?.building?.schemaVersion))) {
    throw new Error('Building V2 commit Root requires durable schema version 4 or 5.');
  }
  const openingAdmission = validateBuildingV2OpeningProjection(plan.root?.flags?.[MODULE_ID]?.building);
  if (!Array.isArray(plan.walls) || (plan.walls.length < 1 && !openingAdmission.openingCount)) {
    throw new Error('Building V2 commit requires at least one native Wall source.');
  }
  const wallIds = plan.walls.map((wall) => requireDocumentId(wall?._id, 'Building V2 native Wall ID'));
  const building = plan.root.flags[MODULE_ID].building;
  for (const occupation of Object.values(building.authoring?.portalsById || {}).filter(entry => ['door', 'seamlessSecretDoor'].includes(entry.kind))) {
    const expected = (building.runtime.expectedGeneratedDocuments || []).filter(entry => entry.documentName === 'Wall'
      && entry.role === 'portal' && entry.semanticId === occupation.id && entry.fragmentOrdinal === 0);
    const walls = plan.walls.filter(wall => wall.flags?.[MODULE_ID]?.buildingGenerated?.semanticId === occupation.id);
    if (expected.length !== 1 || walls.length !== 1 || expected[0].documentId !== walls[0]._id
      || walls[0].flags[MODULE_ID].buildingGenerated.role !== 'portal'
      || walls[0].flags[MODULE_ID].buildingGenerated.buildingId !== plan.buildingId
      || walls[0].flags[MODULE_ID].buildingGenerated.rootTileId !== rootTileId
      || walls[0].flags[MODULE_ID].buildingGenerated.generationId !== plan.generationId
      || walls[0].flags[MODULE_ID].buildingGenerated.fragmentOrdinal !== 0) {
      throw new Error('Building V2 Door Commit requires exact generated Portal Wall ownership.');
    }
    const projection = building.runtime.nativeWallProjection.find(entry => entry.portalId === occupation.id);
    const pose = deriveBuildingV2SpatialPose(plan.root, building);
    validateBuildingV2DoorWall(occupation, projection, walls[0], { scale: pose.scale, reflected: pose.flipX !== pose.flipY, sceneGridSize });
    const transform = createBuildingV2SpatialTransform(pose);
    if (occupation.kind === 'seamlessSecretDoor') validateBuildingV2DoorWall(occupation, projection, walls[0], {
      scale: pose.scale, reflected: pose.flipX !== pose.flipY, worldEndpoints: projection.localEndpoints.map(point => transform.localToWorld(point))
    });
    const native = materializeBuildingV2DoorWall(projection.door, {
      a: transform.localToWorld(projection.localEndpoints[0]), b: transform.localToWorld(projection.localEndpoints[1]),
      dir: projection.resolvedBehavior?.dir || 0, scale: pose.scale, reflected: pose.flipX !== pose.flipY, sceneGridSize
    });
    if (!sameValue(walls[0].c, native.c) || walls[0].dir !== native.dir) {
      throw new Error('Building V2 Door Commit native hinge/coordinates differ from the Root projection.');
    }
    if (projection.door.shadow) {
      const shadow = materializeBuildingV2DoorShadowForRoot(projection.door.shadow, {
        rootSource: plan.root,
        building,
        localEndpoints: projection.localEndpoints
      });
      if (!sameValue(walls[0].flags?.[MODULE_ID]?.buildingGenerated?.doorShadowNormal, shadow.normal)) {
        throw new Error('Building V2 Door Commit shadow normal differs from the Root projection.');
      }
    }
  }
  if (new Set([rootTileId, ...wallIds]).size !== wallIds.length + 1) {
    throw new Error('Building V2 commit document identities must be unique.');
  }
  const rootUuid = `Scene.${sceneId}.Tile.${rootTileId}`;
  const { fillId, fillUuid } = requireManagedFill(plan, { sceneId, rootTileId, rootUuid, wallIds });
  const regionTransition = requireManagedRegions(plan, { sceneId, rootTileId, rootUuid, excludedIds: [rootTileId, fillId, ...wallIds] });
  const { sillsId, sillsUuid } = requireManagedSills(plan, {
    sceneId, rootTileId, rootUuid, excludedIds: [rootTileId, fillId, ...wallIds, ...regionTransition.regionIds]
  });
  const expectedRelationshipCount = wallIds.length + (fillId ? 1 : 0) + (sillsId ? 1 : 0)
    + regionTransition.regionIds.length;
  if (!Array.isArray(plan.relationships) || plan.relationships.length !== expectedRelationshipCount) {
    throw new Error('Building V2 commit requires one generated-by relationship per managed output source.');
  }
  const composition = requireCompositionRegistry(plan.compositionRegistry);
  const baselineRegistry = normalizeRegistry(plan.preconditions?.compositionRegistry);
  const expectedGroups = clone(baselineRegistry.groups);
  if (partitionSourceRootId) {
    const sourceUuid = `Scene.${sceneId}.Tile.${partitionSourceRootId}`;
    const sourceGroups = Object.values(expectedGroups).filter(group => group.directMemberUuids.includes(sourceUuid));
    if (sourceGroups.length > 1) throw new Error('Building V2 partition source has duplicate Scene Group membership.');
    if (sourceGroups.length) {
      const members = sourceGroups[0].directMemberUuids;
      members.splice(members.indexOf(sourceUuid) + 1, 0, ...partitionRootIds
        .filter(id => id !== partitionSourceRootId).map(id => `Scene.${sceneId}.Tile.${id}`));
    }
  }
  if (!sameValue(composition.groups, expectedGroups)) {
    throw new Error('Building V2 Commit must preserve explicit Scene Groups; partition Roots inherit the source membership.');
  }
  const baselineFill = String(plan.kind || '') === 'existing-edit'
    ? (plan.preconditions?.fill ?? null)
    : null;
  const baselineSills = String(plan.kind || '') === 'existing-edit'
    ? (plan.preconditions?.sills ?? null)
    : null;
  const baselineFillId = baselineFill == null
    ? null
    : requireDocumentId(baselineFill?._id, 'Building V2 baseline managed Fill Tile ID');
  if (baselineFillId === rootTileId || wallIds.includes(baselineFillId)) {
    throw new Error('Building V2 baseline managed Fill identity must be unique from its Root and native Walls.');
  }
  if (baselineFill && !migration) {
    const baselineOwner = baselineFill?.flags?.[MODULE_ID]?.buildingGenerated;
    const baselineBacklink = baselineFill?.flags?.[MODULE_ID]?.buildingFill;
    const baselineMaskedTiling = baselineFill?.flags?.[MODULE_ID]?.maskedTiling;
    const priorGenerationId = plan.preconditions?.root?.flags?.[MODULE_ID]?.building?.runtime?.generationId;
    if (baselineOwner?.role !== 'fill'
      || baselineOwner?.buildingId !== plan.buildingId
      || baselineOwner?.rootTileId !== rootTileId
      || baselineOwner?.generationId !== priorGenerationId
      || Number(baselineBacklink?.version) !== 1
      || baselineBacklink?.wallTileId !== rootTileId
      || !String(baselineFill?.texture?.src || '').trim()
      || !usableFillMask(baselineMaskedTiling)
      || String(baselineMaskedTiling?.baseSrc || '').trim() !== String(baselineFill?.texture?.src || '').trim()) {
      throw new Error('Building V2 existing Commit requires an exact compatible baseline managed Fill source.');
    }
    for (const path of ['x', 'y', 'width', 'height', 'rotation', 'texture.anchorX', 'texture.anchorY']) {
      if (!Number.isFinite(Number(dottedValue(baselineFill, path)))
        || !sameValue(dottedValue(baselineFill, path), dottedValue(plan.preconditions?.root, path))) {
        throw new Error('Building V2 existing Commit baseline managed Fill must match its baseline Root pose.');
      }
    }
  }
  if (fillId && baselineFillId && fillId !== baselineFillId) {
    throw new Error('Building V2 existing Commit must preserve the managed Fill Tile identity.');
  }
  const baselineSillsId = baselineSills == null
    ? null
    : requireDocumentId(baselineSills?._id, 'Building V2 baseline managed Sills Tile ID');
  if (baselineSillsId && [rootTileId, fillId, baselineFillId, ...wallIds, ...regionTransition.regionIds].includes(baselineSillsId)) {
    throw new Error('Building V2 baseline managed Sills identity must be unique from every other managed output.');
  }
  if (baselineSills && !migration) {
    const baselineOwner = baselineSills?.flags?.[MODULE_ID]?.buildingGenerated;
    const priorGenerationId = plan.preconditions?.root?.flags?.[MODULE_ID]?.building?.runtime?.generationId;
    if (Number(baselineOwner?.version) !== 1 || baselineOwner?.role !== 'sill'
      || baselineOwner?.buildingId !== plan.buildingId || baselineOwner?.rootTileId !== rootTileId
      || baselineOwner?.generationId !== priorGenerationId || baselineOwner?.semanticId !== null
      || Number(baselineOwner?.fragmentOrdinal) !== 0
      || String(baselineSills?.texture?.src || '') !== BUILDING_SILLS_TEXTURE_SRC
      || Number(baselineSills?.alpha) !== 1) {
      throw new Error('Building V2 existing Commit requires an exact compatible baseline managed Sills source.');
    }
    requireBuildingSillsFlag(baselineSills, {
      rootTileId, buildingId: plan.buildingId, requirePlacement: false
    });
    for (const path of ['x', 'y', 'width', 'height', 'rotation', 'texture.anchorX', 'texture.anchorY']) {
      if (!Number.isFinite(Number(dottedValue(baselineSills, path)))
        || !sameValue(dottedValue(baselineSills, path), dottedValue(plan.preconditions?.root, path))) {
        throw new Error('Building V2 existing Commit baseline managed Sills must match its baseline Root pose.');
      }
    }
  }
  for (const occupation of Object.values(building.authoring?.portalsById || {}).filter(entry => entry.kind === 'window')) {
    const expected = (building.runtime.expectedGeneratedDocuments || []).filter(entry => entry.documentName === 'Wall'
      && entry.role === 'portal' && entry.semanticId === occupation.id && entry.fragmentOrdinal === 0);
    const walls = plan.walls.filter(wall => wall.flags?.[MODULE_ID]?.buildingGenerated?.semanticId === occupation.id);
    if (expected.length !== 1 || walls.length !== 1 || expected[0].documentId !== walls[0]._id
      || walls[0].flags[MODULE_ID].buildingGenerated.role !== 'portal'
      || walls[0].flags[MODULE_ID].buildingGenerated.buildingId !== plan.buildingId
      || walls[0].flags[MODULE_ID].buildingGenerated.rootTileId !== rootTileId
      || walls[0].flags[MODULE_ID].buildingGenerated.generationId !== plan.generationId
      || walls[0].flags[MODULE_ID].buildingGenerated.fragmentOrdinal !== 0) {
      throw new Error('Building V2 Window Commit requires exact generated Portal Wall ownership.');
    }
    const projection = building.runtime.nativeWallProjection.find(entry => entry.portalId === occupation.id);
    validateBuildingV2WindowWall(occupation, projection);
    const pose = deriveBuildingV2SpatialPose(plan.root, building);
    const transform = createBuildingV2SpatialTransform(pose);
    const worldEndpoints = projection.localEndpoints.map((point) => transform.localToWorld(point));
    const liveProjection = clone(projection);
    liveProjection.door.state = walls[0].ds;
    validateBuildingV2WindowWall(occupation, liveProjection, walls[0], {
      scale: pose.scale, reflected: pose.flipX !== pose.flipY, sceneGridSize, worldEndpoints
    });
  }
  if (sillsId && baselineSillsId && sillsId !== baselineSillsId) {
    throw new Error('Building V2 existing Commit must preserve the managed Sills Tile identity.');
  }
  if (plan.sillsPlacement != null) {
    const placement = plan.sillsPlacement;
    if (!sillsId || Object.keys(placement).sort().join('|') !== 'elevation|levels|placementLevelId|sort'
      || !sameValue(placement, { elevation: plan.sills.elevation, sort: plan.sills.sort,
        levels: plan.sills.levels, placementLevelId: plan.sills.flags?.[MODULE_ID]?.placementLevelId })) {
      throw new Error('Building V2 Sills placement must match the exact planned Tile placement.');
    }
  }
  if (sillsId && baselineSills) {
    for (const path of [...MANAGED_SILLS_PRESENTATION_PATHS, `flags.${MODULE_ID}.placementLevelId`]) {
      if (plan.sillsPlacement && MANAGED_SILLS_PLACEMENT_PATHS.includes(path)) continue;
      if (!sameValue(dottedValue(plan.sills, path), dottedValue(baselineSills, path))) {
        throw new Error(`Building V2 existing Commit must preserve document-owned managed Sills presentation at ${path}.`);
      }
    }
  }
  const baselineFillUuid = baselineFillId ? `Scene.${sceneId}.Tile.${baselineFillId}` : null;
  const baselineFillRelationships = baselineRegistry.relationships.filter((relationship) => (
    relationship?.type === 'generated-by'
    && relationship?.generator === 'building'
    && relationship?.ownerUuid === rootUuid
    && relationship?.dependentUuid === baselineFillUuid
  ));
  const baselineSillsUuid = baselineSillsId ? `Scene.${sceneId}.Tile.${baselineSillsId}` : null;
  const baselineSillsRelationships = baselineRegistry.relationships.filter((relationship) => (
    relationship?.dependentUuid === baselineSillsUuid
  ));
  const baselineOwnedTileRelationships = baselineRegistry.relationships.filter((relationship) => (
    relationship?.type === 'generated-by'
    && relationship?.generator === 'building'
    && relationship?.ownerUuid === rootUuid
    && String(relationship?.dependentUuid || '').startsWith(`Scene.${sceneId}.Tile.`)
  ));
  const baselineManagedTileCount = (baselineFillId ? 1 : 0) + (baselineSillsId ? 1 : 0);
  if (!migration && ((baselineFillId && baselineFillRelationships.length !== 1)
    || (baselineSillsId && (baselineSillsRelationships.length !== 1
      || baselineSillsRelationships[0]?.type !== 'generated-by'
      || baselineSillsRelationships[0]?.generator !== 'building'
      || baselineSillsRelationships[0]?.ownerUuid !== rootUuid))
    || baselineOwnedTileRelationships.length !== baselineManagedTileCount)) {
    throw new Error('Building V2 existing Commit baseline managed Tiles require exact generated-by relationships.');
  }
  const expectedDependents = new Set([
    ...wallIds.map((wallId) => `Scene.${sceneId}.Wall.${wallId}`),
    ...(fillUuid ? [fillUuid] : []),
    ...(sillsUuid ? [sillsUuid] : []),
    ...regionTransition.regionIds.map((id) => `Scene.${sceneId}.Region.${id}`)
  ]);
  const relationshipIds = new Set();
  const relationshipDependents = new Set();
  for (const relationship of plan.relationships) {
    const relationshipId = String(relationship?.id || '').trim();
    if (!relationshipId || relationshipIds.has(relationshipId)
      || relationship?.type !== 'generated-by'
      || relationship?.generator !== 'building'
      || relationship?.ownerUuid !== rootUuid
      || !expectedDependents.has(relationship?.dependentUuid)
      || relationshipDependents.has(relationship?.dependentUuid)) {
      throw new Error('Building V2 commit relationships must be unique canonical Building generated-by ownership records.');
    }
    relationshipIds.add(relationshipId);
    relationshipDependents.add(relationship.dependentUuid);
  }
  const registryRelationships = composition.relationships;
  if (!plan.relationships.every((relationship) => registryRelationships.some((entry) => sameValue(entry, relationship)))) {
    throw new Error('Building V2 commit registry after-state must contain every exact planned relationship.');
  }
  const plannedFillRelationship = fillUuid
    ? plan.relationships.find((relationship) => relationship?.dependentUuid === fillUuid)
    : null;
  if (!migration && fillId && baselineFillId
    && plannedFillRelationship?.id !== baselineFillRelationships[0]?.id) {
    throw new Error('Building V2 existing Commit must preserve the managed Fill generated-by relationship identity.');
  }
  const plannedSillsRelationship = sillsUuid
    ? plan.relationships.find((relationship) => relationship?.dependentUuid === sillsUuid)
    : null;
  if (!migration && sillsId && baselineSillsId
    && plannedSillsRelationship?.id !== baselineSillsRelationships[0]?.id) {
    throw new Error('Building V2 existing Commit must preserve the managed Sills generated-by relationship identity.');
  }
  const baselineWalls = plan.kind === 'existing-edit' && Array.isArray(plan.preconditions?.walls)
    ? plan.preconditions.walls
    : [];
  const baselineWallIds = baselineWalls.map((wall) => requireDocumentId(wall?._id, 'Building V2 baseline native Wall ID'));
  const baselineWallIdSet = new Set(baselineWallIds);
  const wallIdSet = new Set(wallIds);
  const siblingTransitions = requireSiblingTileSortTransitions(plan, {
    excludedTileIds: [rootTileId, fillId, baselineFillId, sillsId, baselineSillsId],
    label: 'Building V2 commit'
  });
  return {
    plan, migration, sceneId, rootTileId, wallIds, fillId, baselineFill, baselineFillId,
    sillsId, baselineSills, baselineSillsId, baselineWallIds,
    ...siblingTransitions, ...regionTransition,
    createdFillId: fillId && !baselineFillId ? fillId : null,
    updatedFillId: fillId && baselineFillId ? fillId : null,
    deletedFillId: !fillId && baselineFillId ? baselineFillId : null,
    createdSillsId: sillsId && !baselineSillsId ? sillsId : null,
    updatedSillsId: sillsId && baselineSillsId ? sillsId : null,
    deletedSillsId: !sillsId && baselineSillsId ? baselineSillsId : null,
    createdWallIds: wallIds.filter((id) => !baselineWallIdSet.has(id)),
    updatedWallIds: wallIds.filter((id) => baselineWallIdSet.has(id)),
    deletedWallIds: baselineWallIds.filter((id) => !wallIdSet.has(id))
  };
}

function requireMultiPlan(plan, { sceneGridSize } = {}) {
  if (!plan || Number(plan.version) !== COMMIT_PLAN_VERSION || plan.kind !== 'multi-building') {
    throw new Error(`Building V2 multi-Building commit runtime requires plan version ${COMMIT_PLAN_VERSION}.`);
  }
  const migration = requireMigrationBaseline(plan);
  const sceneId = String(plan.sceneId || '').trim();
  if (!sceneId) throw new Error('Building V2 multi-Building commit plan requires a Scene identity.');
  if (!Array.isArray(plan.components) || plan.components.length < 2) {
    throw new Error('Building V2 multi-Building commit requires at least two component plans.');
  }
  if (!['fresh-partition', 'existing-partition'].includes(plan.mode)) {
    throw new Error('Building V2 multi-Building commit requires an explicit fresh or existing partition mode.');
  }
  const components = plan.components.map((component) => requirePlan({
    ...clone(component),
    sceneId,
    portalStateIntents: (plan.portalStateIntents || []).filter(intent => component.walls.some(wall => wall.flags?.[MODULE_ID]?.buildingGenerated?.semanticId === intent.portalId)),
    compositionRegistry: clone(plan.compositionRegistry),
    shadowTileUpdates: clone(plan.shadowTileUpdates || [])
  }, { sceneGridSize, partitionRootIds: plan.components.map(component => component.rootTileId),
    partitionSourceRootId: plan.mode === 'existing-partition' ? plan.preconditions?.root?._id : null }));
  const rootIds = components.map((entry) => entry.rootTileId);
  const wallIds = components.flatMap((entry) => entry.wallIds);
  const fillIds = components.map((entry) => entry.fillId).filter(Boolean);
  const sillsIds = components.map((entry) => entry.sillsId).filter(Boolean);
  const regions = components.flatMap((entry) => entry.regions);
  const regionIds = regions.map((region) => region._id);
  const baselineRegions = plan.mode === 'existing-partition' ? (plan.preconditions?.regions ?? []) : [];
  if (!Array.isArray(baselineRegions) || baselineRegions.length > 1
    || !sameValue(components.flatMap((entry) => entry.baselineRegions), baselineRegions)) {
    throw new Error('Building V2 partition requires exact Surface Region baseline on its identity successor.');
  }
  if (new Set(rootIds).size !== rootIds.length || new Set(wallIds).size !== wallIds.length
    || new Set([...rootIds, ...wallIds, ...fillIds, ...sillsIds, ...regionIds]).size
      !== rootIds.length + wallIds.length + fillIds.length + sillsIds.length + regionIds.length) {
    throw new Error('Building V2 multi-Building document identities must be unique across every component.');
  }
  if (baselineRegions.some((region) => [...rootIds, ...wallIds, ...fillIds, ...sillsIds].includes(region._id))) {
    throw new Error('Building V2 baseline Region identity must remain unique across every component.');
  }
  const focusRootTileId = requireDocumentId(plan.focusRootTileId, 'Building V2 post-Commit focus Root ID');
  if (!rootIds.includes(focusRootTileId)) {
    throw new Error('Building V2 multi-Building focus Root must identify one planned component Root.');
  }
  const relationships = plan.components.flatMap((component) => component.relationships || []);
  const relationshipIds = relationships.map((relationship) => String(relationship?.id || '').trim());
  if (new Set(relationshipIds).size !== relationshipIds.length) {
    throw new Error('Building V2 multi-Building relationship identities must be unique across every component.');
  }
  const registryRelationships = plan.compositionRegistry?.relationships || [];
  if (!relationships.every((relationship) => registryRelationships.some((entry) => sameValue(entry, relationship)))) {
    throw new Error('Building V2 multi-Building registry after-state must contain every planned generated-by relationship.');
  }
  const baselineRoot = plan.mode === 'existing-partition' ? plan.preconditions?.root : null;
  const baselineWalls = plan.mode === 'existing-partition' && Array.isArray(plan.preconditions?.walls)
    ? plan.preconditions.walls
    : [];
  const baselineFill = plan.mode === 'existing-partition'
    ? (plan.preconditions?.fill ?? null)
    : null;
  const baselineSills = plan.mode === 'existing-partition'
    ? (plan.preconditions?.sills ?? null)
    : null;
  if (plan.mode === 'existing-partition' && !baselineRoot) {
    throw new Error('Building V2 existing partition requires the exact source Root precondition.');
  }
  const baselineRootId = baselineRoot ? requireDocumentId(baselineRoot._id, 'Building V2 source Root ID') : null;
  if (baselineRootId && components.filter((component) => component.rootTileId === baselineRootId).length !== 1) {
    throw new Error('Building V2 existing partition must retain its source Root in exactly one component plan.');
  }
  const baselineWallIds = baselineWalls.map((wall) => requireDocumentId(wall?._id, 'Building V2 source native Wall ID'));
  const baselineFillId = baselineFill
    ? requireDocumentId(baselineFill?._id, 'Building V2 source managed Fill Tile ID')
    : null;
  const baselineSillsId = baselineSills
    ? requireDocumentId(baselineSills?._id, 'Building V2 source managed Sills Tile ID')
    : null;
  const sourceComponent = baselineRootId
    ? components.find((component) => component.rootTileId === baselineRootId)
    : null;
  if (plan.mode === 'existing-partition'
    && (!sourceComponent || !sameValue(sourceComponent.baselineFill, baselineFill)
      || !sameValue(sourceComponent.baselineSills, baselineSills))) {
    throw new Error('Building V2 existing partition requires exact source managed Tile preconditions on its identity successor.');
  }
  if (baselineFillId && (rootIds.includes(baselineFillId) || wallIds.includes(baselineFillId))) {
    throw new Error('Building V2 existing partition baseline Fill identity must remain unique from every Root and Wall.');
  }
  if (baselineSillsId && [...rootIds, ...wallIds, ...fillIds, baselineFillId].includes(baselineSillsId)) {
    throw new Error('Building V2 existing partition baseline Sills identity must remain unique from every managed output.');
  }
  const desiredWallIdSet = new Set(wallIds);
  const baselineWallIdSet = new Set(baselineWallIds);
  const retainedFillId = baselineFillId && fillIds.includes(baselineFillId) ? baselineFillId : null;
  const newFillIds = fillIds.filter((id) => id !== baselineFillId);
  const deletedFillId = baselineFillId && !retainedFillId ? baselineFillId : null;
  const retainedSillsId = baselineSillsId && sillsIds.includes(baselineSillsId) ? baselineSillsId : null;
  const newSillsIds = sillsIds.filter((id) => id !== baselineSillsId);
  const deletedSillsId = baselineSillsId && !retainedSillsId ? baselineSillsId : null;
  const newRootIds = rootIds.filter((id) => id !== baselineRootId);
  const siblingTileUpdates = Array.isArray(plan.siblingTileUpdates) ? plan.siblingTileUpdates.map((update) => ({
    _id: requireDocumentId(update?._id, 'Building V2 sibling Tile update ID'),
    sort: Number(update?.sort)
  })) : [];
  const siblingTilePreconditions = Array.isArray(plan.preconditions?.siblingTiles)
    ? plan.preconditions.siblingTiles.map((entry) => ({
        _id: requireDocumentId(entry?._id, 'Building V2 sibling Tile precondition ID'),
        sort: Number(entry?.sort)
      }))
    : [];
  const siblingUpdateIds = siblingTileUpdates.map((entry) => entry._id);
  const siblingPreconditionIds = siblingTilePreconditions.map((entry) => entry._id);
  if (siblingTileUpdates.some((entry) => !Number.isFinite(entry.sort))
    || siblingTilePreconditions.some((entry) => !Number.isFinite(entry.sort))
    || new Set(siblingUpdateIds).size !== siblingUpdateIds.length
    || new Set(siblingPreconditionIds).size !== siblingPreconditionIds.length
    || siblingUpdateIds.some((id) => rootIds.includes(id) || fillIds.includes(id) || sillsIds.includes(id)
      || id === baselineFillId || id === baselineSillsId)
    || !sameValue([...siblingUpdateIds].sort(), [...siblingPreconditionIds].sort())) {
    throw new Error('Building V2 multi-Building sibling sort updates require unique exact non-Root preconditions.');
  }
  return {
    plan, migration, sceneId, components, rootIds, wallIds, fillIds, sillsIds, focusRootTileId,
    baselineRoot, baselineRootId, baselineWalls, baselineWallIds, baselineFill, baselineFillId,
    baselineSills, baselineSillsId, retainedFillId, newFillIds, deletedFillId,
    retainedSillsId, newSillsIds, deletedSillsId, regions, regionIds, baselineRegions,
    siblingTileUpdates, siblingTilePreconditions,
    newRootIds,
    createdWallIds: wallIds.filter((id) => !baselineWallIdSet.has(id)),
    updatedWallIds: wallIds.filter((id) => baselineWallIdSet.has(id)),
    deletedWallIds: baselineWallIds.filter((id) => !desiredWallIdSet.has(id))
  };
}

/** A Building's Fill and Sills are written by their Building's plan alone. The
 * drop-shadow settings shared by the shadowed Tiles of one Elevation are not
 * written to them a second time by the same plan. */
function isBuildingGeneratedTile(document) {
  const flags = document?.flags?.[MODULE_ID] || document?._source?.flags?.[MODULE_ID] || {};
  return !!(flags.buildingGenerated || flags.buildingFill || flags.buildingSills || flags.buildingComposite);
}

function shadowTileSnapshot(document) {
  const flags = document?.flags?.[MODULE_ID] || document?._source?.flags?.[MODULE_ID] || {};
  return {
    id: String(document?.id || document?._id || ''),
    elevation: Number(document?.elevation ?? document?._source?.elevation ?? 0) || 0,
    shadowAlpha: readFlag(document, 'shadowAlpha'),
    shadowBlur: readFlag(document, 'shadowBlur'),
    hasShadowAlpha: Object.prototype.hasOwnProperty.call(flags, 'shadowAlpha'),
    hasShadowBlur: Object.prototype.hasOwnProperty.call(flags, 'shadowBlur')
  };
}

function normalizeRegistry(registry) {
  const source = registry && typeof registry === 'object' ? clone(registry) : {};
  return {
    schemaVersion: 1,
    groups: source.groups && typeof source.groups === 'object' ? source.groups : {},
    relationships: Array.isArray(source.relationships) ? source.relationships : [],
    wallVisibilityStates: source.wallVisibilityStates && typeof source.wallVisibilityStates === 'object'
      ? source.wallVisibilityStates
      : {}
  };
}

function requireCompositionRegistry(registry) {
  if (!registry || typeof registry !== 'object' || Array.isArray(registry)
    || Number(registry.schemaVersion) !== 1
    || !registry.groups || typeof registry.groups !== 'object' || Array.isArray(registry.groups)
    || !Array.isArray(registry.relationships)
    || !registry.wallVisibilityStates || typeof registry.wallVisibilityStates !== 'object'
    || Array.isArray(registry.wallVisibilityStates)) {
    throw new Error('Building V2 commit requires one valid schema-v1 composition registry after-state.');
  }
  const directOwnerByUuid = new Map();
  for (const [groupKey, group] of Object.entries(registry.groups)) {
    const groupId = String(group?.id || '').trim();
    const parentId = group?.parentId == null ? null : String(group.parentId || '').trim();
    if (!groupId || groupId !== groupKey || !String(group?.name || '').trim()
      || !Array.isArray(group?.directMemberUuids)
      || ![group?.pivot?.x, group?.pivot?.y, group?.frameAngle].every((value) => Number.isFinite(Number(value)))
      || !['automatic', 'custom'].includes(group?.pivotMode)
      || (group?.parentId != null && !parentId) || parentId === groupId) {
      throw new Error(`Building V2 commit contains an invalid Scene Group record (${groupKey}).`);
    }
    for (const rawUuid of group.directMemberUuids) {
      const uuid = String(rawUuid || '').trim();
      if (!uuid || directOwnerByUuid.has(uuid)) {
        throw new Error('Building V2 commit registry cannot contain duplicate direct Scene Group membership.');
      }
      directOwnerByUuid.set(uuid, groupId);
    }
  }
  for (const group of Object.values(registry.groups)) {
    const parentId = group.parentId == null ? null : String(group.parentId || '').trim();
    if (parentId && !registry.groups[parentId]) {
      throw new Error('Building V2 commit Scene Group parent does not exist.');
    }
    const visited = new Set([String(group.id)]);
    let ancestorId = parentId;
    while (ancestorId) {
      if (visited.has(ancestorId)) throw new Error('Building V2 commit Scene Group ancestry cannot contain a cycle.');
      visited.add(ancestorId);
      ancestorId = registry.groups[ancestorId]?.parentId || null;
    }
  }
  const relationshipIds = new Set();
  const incomingByDependent = new Set();
  const dependentsByOwner = new Map();
  for (const relationship of registry.relationships) {
    const id = String(relationship?.id || '').trim();
    const type = String(relationship?.type || '').trim();
    const ownerUuid = String(relationship?.ownerUuid || '').trim();
    const dependentUuid = String(relationship?.dependentUuid || '').trim();
    if (!id || relationshipIds.has(id) || !['attached-to', 'generated-by'].includes(type)
      || !ownerUuid || !dependentUuid || ownerUuid === dependentUuid
      || incomingByDependent.has(dependentUuid)) {
      throw new Error('Building V2 commit contains invalid or duplicate composition relationship ownership.');
    }
    if (directOwnerByUuid.has(dependentUuid)) {
      throw new Error('Building V2 commit relationship-dependent cannot also be a direct Scene Group member.');
    }
    relationshipIds.add(id);
    incomingByDependent.add(dependentUuid);
    const dependents = dependentsByOwner.get(ownerUuid) || [];
    dependents.push(dependentUuid);
    dependentsByOwner.set(ownerUuid, dependents);
  }
  const visitState = new Map();
  const visit = (ownerUuid) => {
    const state = visitState.get(ownerUuid) || 0;
    if (state === 2) return;
    if (state === 1) throw new Error('Building V2 commit composition relationships cannot contain a cycle.');
    visitState.set(ownerUuid, 1);
    for (const dependentUuid of dependentsByOwner.get(ownerUuid) || []) visit(dependentUuid);
    visitState.set(ownerUuid, 2);
  };
  for (const ownerUuid of dependentsByOwner.keys()) visit(ownerUuid);
  return { groups: registry.groups, relationships: registry.relationships, directOwnerByUuid };
}

function rootBuilding(document) {
  return readFlag(document, 'building') || null;
}

function generatedOwner(document) {
  return readFlag(document, 'buildingGenerated') || null;
}

const MANAGED_FILL_OWNED_PATHS = Object.freeze([
  'texture.src', 'texture.anchorX', 'texture.anchorY', 'texture.scaleX', 'texture.scaleY',
  'x', 'y', 'width', 'height', 'rotation', 'alpha', 'elevation', 'sort',
  'hidden', 'locked', 'levels', 'occlusion',
  `flags.${MODULE_ID}.buildingGenerated`, `flags.${MODULE_ID}.buildingFill`,
  `flags.${MODULE_ID}.maskedTiling`, `flags.${MODULE_ID}.hsbc`
]);

const MANAGED_SILLS_OWNED_PATHS = Object.freeze([
  'texture.src', 'texture.anchorX', 'texture.anchorY',
  'x', 'y', 'width', 'height', 'rotation', 'alpha',
  `flags.${MODULE_ID}.buildingGenerated`, `flags.${MODULE_ID}.buildingSills`
]);
const MANAGED_SILLS_AUDIT_PATHS = Object.freeze([
  ...MANAGED_SILLS_OWNED_PATHS, ...MANAGED_SILLS_PRESENTATION_PATHS
]);

function managedFillsForRoot(scene, validated) {
  return collectionValues(scene?.tiles).filter((document) => {
    const owner = generatedOwner(document);
    return (owner?.role === 'fill'
      && owner?.buildingId === validated.plan.buildingId
      && owner?.rootTileId === validated.rootTileId)
      || (validated.migration && readFlag(document, 'buildingFill')?.wallTileId === validated.rootTileId);
  });
}

function managedSillsForRoot(scene, validated) {
  return collectionValues(scene?.tiles).filter((document) => {
    const owner = generatedOwner(document);
    const backlink = readFlag(document, 'buildingSills');
    return (owner?.role === 'sill' && (owner?.buildingId === validated.plan.buildingId
      || owner?.rootTileId === validated.rootTileId))
      || (backlink && (backlink?.buildingId === validated.plan.buildingId
        || backlink?.wallTileId === validated.rootTileId))
      || (validated.migration && readFlag(document, 'buildingComposite')?.role === 'sill'
        && readFlag(document, 'buildingComposite')?.wallTileId === validated.rootTileId);
  });
}

function hasExactSiblingTileSortPreconditions(scene, validated) {
  return validated.siblingTilePreconditions.every((entry) => {
    const document = collectionGet(scene?.tiles, entry._id);
    return !!document && Number(document?.sort ?? document?._source?.sort) === entry.sort;
  });
}

function wallAuditPaths(expected) {
  const paths = [
    'move', 'sight', 'light', 'sound', 'dir', 'threshold', 'door', 'ds', 'levels',
    'flags.core.elevation', `flags.${MODULE_ID}.buildingGenerated`, `flags.${MODULE_ID}.buildingWall`
  ];
  if (isNativePortal(expected) || isStaticBuildingWindow(expected)) paths.push('animation');
  if (expected.doorSound !== undefined) paths.push('doorSound');
  if (isBuildingWindow(expected)) {
    paths.push(`flags.${MODULE_ID}.buildingWindow`, `flags.${MODULE_ID}.windowShadow`);
  }
  return paths.filter((path) => path !== 'ds' || !isNativePortal(expected));
}

function wallAuditFieldMatches(source, expected, path) {
  if (path === 'animation' && isStaticBuildingWindow(expected)) {
    return sameValue(source?.animation ?? null, expected?.animation ?? null);
  }
  return sameValue(dottedValue(source, path), dottedValue(expected, path));
}

function exactAppliedState(scene, validated) {
  if (!migrationTilesMatch(scene, validated)) return null;
  if (!regionStateMatches(scene, validated)) return null;
  const root = collectionGet(scene?.tiles, validated.rootTileId);
  if (!root) return null;
  const building = rootBuilding(root);
  if (building?.buildingId !== validated.plan.buildingId
    || building?.runtime?.generationId !== validated.plan.generationId
    || building?.runtime?.authoringFingerprint !== validated.plan.expected?.authoringFingerprint) return null;
  const rootPaths = [
    'texture.src', 'texture.anchorX', 'texture.anchorY',
    'x', 'y', 'width', 'height', 'rotation', 'alpha', 'elevation', 'sort',
    'hidden', 'locked', 'levels', 'occlusion',
    `flags.${MODULE_ID}.shadow`, `flags.${MODULE_ID}.shadowAlpha`, `flags.${MODULE_ID}.shadowBlur`,
    `flags.${MODULE_ID}.shadowDilation`, `flags.${MODULE_ID}.shadowOffsetDistance`,
    `flags.${MODULE_ID}.shadowOffsetAngle`, `flags.${MODULE_ID}.shadowOffsetX`,
    `flags.${MODULE_ID}.shadowOffsetY`, `flags.${MODULE_ID}.shadowOnly`
  ];
  if (!matchesOwnedFields(root, validated.plan.root, rootPaths)
    || !sameValue(building, validated.plan.root?.flags?.[MODULE_ID]?.building)) return null;
  const walls = validated.wallIds.map((id) => collectionGet(scene?.walls, id));
  if (walls.some((wall) => !wall)) return null;
  if (validated.deletedWallIds.some((id) => collectionGet(scene?.walls, id))) return null;
  for (let index = 0; index < walls.length; index += 1) {
    const expected = validated.plan.walls[index];
    const owner = generatedOwner(walls[index]);
    if (owner?.buildingId !== validated.plan.buildingId
      || owner?.rootTileId !== validated.rootTileId
      || owner?.generationId !== validated.plan.generationId
      || owner?.semanticId !== expected?.flags?.[MODULE_ID]?.buildingGenerated?.semanticId) return null;
    const coords = walls[index]?.c ?? walls[index]?._source?.c;
    if (!sameValue(Array.from(coords || []), expected.c)) return null;
    const source = documentSource(walls[index]);
    if (!portalStateIsValid(source)
      || (validated.plan.portalStateIntents || []).some(intent => intent.portalId === owner.semanticId && source.ds !== intent.state)
      || !wallAuditPaths(expected).every((path) => wallAuditFieldMatches(source, expected, path))) return null;
  }
  const fill = validated.fillId ? collectionGet(scene?.tiles, validated.fillId) : null;
  if (validated.fillId) {
    const expectedFill = validated.plan.fill;
    const owner = generatedOwner(fill);
    if (!fill
      || owner?.role !== 'fill'
      || owner?.buildingId !== validated.plan.buildingId
      || owner?.rootTileId !== validated.rootTileId
      || owner?.generationId !== validated.plan.generationId
      || !matchesOwnedFields(fill, expectedFill, MANAGED_FILL_OWNED_PATHS)) return null;
  }
  const ownedFills = managedFillsForRoot(scene, validated);
  if (ownedFills.length !== (validated.fillId ? 1 : 0)
    || (validated.fillId && String(ownedFills[0]?.id || ownedFills[0]?._id || '') !== validated.fillId)
    || (validated.deletedFillId && collectionGet(scene?.tiles, validated.deletedFillId))) return null;
  const sills = validated.sillsId ? collectionGet(scene?.tiles, validated.sillsId) : null;
  if (validated.sillsId) {
    const expectedSills = validated.plan.sills;
    const owner = generatedOwner(sills);
    if (!sills || owner?.role !== 'sill' || owner?.buildingId !== validated.plan.buildingId
      || owner?.rootTileId !== validated.rootTileId || owner?.generationId !== validated.plan.generationId
      || owner?.semanticId !== null || Number(owner?.fragmentOrdinal) !== 0
      || !matchesOwnedFields(sills, expectedSills, MANAGED_SILLS_AUDIT_PATHS)) return null;
  }
  const ownedSills = managedSillsForRoot(scene, validated);
  if (ownedSills.length !== (validated.sillsId ? 1 : 0)
    || (validated.sillsId && String(ownedSills[0]?.id || ownedSills[0]?._id || '') !== validated.sillsId)
    || (validated.deletedSillsId && collectionGet(scene?.tiles, validated.deletedSillsId))) return null;
  const registry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
    ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
    ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
  if (!sameValue(registry, normalizeRegistry(validated.plan.compositionRegistry))) return null;
  for (const update of validated.plan.shadowTileUpdates || []) {
    const document = collectionGet(scene?.tiles, String(update?._id || ''));
    if (!document) return null;
    const source = documentSource(document);
    for (const [path, value] of Object.entries(update)) {
      if (path === '_id') continue;
      if (!sameValue(dottedValue(source, path), value)) return null;
    }
  }
  for (const update of validated.siblingTileUpdates) {
    const document = collectionGet(scene?.tiles, update._id);
    if (!document || Number(document?.sort ?? document?._source?.sort) !== update.sort) return null;
  }
  return { root, walls, fill, sills, regions: validated.regionIds.map((id) => collectionGet(scene.regions, id)), registry };
}

function describeAppliedStateMismatch(scene, validated) {
  const mismatches = regionStateMatches(scene, validated) ? [] : ['Region:surface-region-state'];
  const root = collectionGet(scene?.tiles, validated.rootTileId);
  if (!root) return [`Tile.${validated.rootTileId}:missing`];
  const rootPaths = [
    'texture.src', 'texture.anchorX', 'texture.anchorY',
    'x', 'y', 'width', 'height', 'rotation', 'alpha', 'elevation', 'sort',
    'hidden', 'locked', 'levels', 'occlusion',
    `flags.${MODULE_ID}.shadow`, `flags.${MODULE_ID}.shadowAlpha`, `flags.${MODULE_ID}.shadowBlur`,
    `flags.${MODULE_ID}.shadowDilation`, `flags.${MODULE_ID}.shadowOffsetDistance`,
    `flags.${MODULE_ID}.shadowOffsetAngle`, `flags.${MODULE_ID}.shadowOffsetX`,
    `flags.${MODULE_ID}.shadowOffsetY`, `flags.${MODULE_ID}.shadowOnly`
  ];
  const rootSource = documentSource(root);
  if (typeof validated.plan.root?.name === 'string' && rootSource.name !== validated.plan.root.name) {
    mismatches.push(`Tile.${validated.rootTileId}.name`);
  }
  for (const path of rootPaths) {
    if (!sameValue(dottedValue(rootSource, path), dottedValue(validated.plan.root, path))) {
      mismatches.push(`Tile.${validated.rootTileId}.${path}`);
    }
  }
  if (!sameValue(rootBuilding(root), validated.plan.root?.flags?.[MODULE_ID]?.building)) {
    mismatches.push(`Tile.${validated.rootTileId}.flags.${MODULE_ID}.building`);
  }
  validated.wallIds.forEach((id, index) => {
    const wall = collectionGet(scene?.walls, id);
    if (!wall) {
      mismatches.push(`Wall.${id}:missing`);
      return;
    }
    const expected = validated.plan.walls[index];
    const source = documentSource(wall);
    if (!portalStateIsValid(source)) mismatches.push(`Wall.${id}.ds:invalid`);
    if (!sameValue(Array.from(wall?.c ?? wall?._source?.c ?? []), expected.c)) mismatches.push(`Wall.${id}.c`);
    for (const path of wallAuditPaths(expected)) {
      if (!wallAuditFieldMatches(source, expected, path)) mismatches.push(`Wall.${id}.${path}`);
    }
  });
  if (validated.fillId) {
    const fill = collectionGet(scene?.tiles, validated.fillId);
    if (!fill) mismatches.push(`Tile.${validated.fillId}:missing-managed-fill`);
    else {
      const source = documentSource(fill);
      if (typeof validated.plan.fill?.name === 'string' && source.name !== validated.plan.fill.name) {
        mismatches.push(`Tile.${validated.fillId}.name`);
      }
      for (const path of MANAGED_FILL_OWNED_PATHS) {
        if (!sameValue(dottedValue(source, path), dottedValue(validated.plan.fill, path))) {
          mismatches.push(`Tile.${validated.fillId}.${path}`);
        }
      }
    }
  }
  const ownedFillIds = managedFillsForRoot(scene, validated)
    .map((document) => String(document?.id || document?._id || ''));
  const expectedOwnedFillIds = validated.fillId ? [validated.fillId] : [];
  if (!sameValue(ownedFillIds.sort(), expectedOwnedFillIds)) {
    mismatches.push(`Tile:managed-fill-set(${ownedFillIds.join(',') || 'none'})`);
  }
  if (validated.deletedFillId && collectionGet(scene?.tiles, validated.deletedFillId)) {
    mismatches.push(`Tile.${validated.deletedFillId}:retired-managed-fill-present`);
  }
  if (validated.sillsId) {
    const sills = collectionGet(scene?.tiles, validated.sillsId);
    if (!sills) mismatches.push(`Tile.${validated.sillsId}:missing-managed-sills`);
    else {
      const source = documentSource(sills);
      if (typeof validated.plan.sills?.name === 'string' && source.name !== validated.plan.sills.name) {
        mismatches.push(`Tile.${validated.sillsId}.name`);
      }
      for (const path of MANAGED_SILLS_AUDIT_PATHS) {
        if (!sameValue(dottedValue(source, path), dottedValue(validated.plan.sills, path))) {
          mismatches.push(`Tile.${validated.sillsId}.${path}`);
        }
      }
    }
  }
  const ownedSillsIds = managedSillsForRoot(scene, validated)
    .map((document) => String(document?.id || document?._id || '')).sort();
  const expectedOwnedSillsIds = validated.sillsId ? [validated.sillsId] : [];
  if (!sameValue(ownedSillsIds, expectedOwnedSillsIds)) {
    mismatches.push(`Tile:managed-sills-set(${ownedSillsIds.join(',') || 'none'})`);
  }
  if (validated.deletedSillsId && collectionGet(scene?.tiles, validated.deletedSillsId)) {
    mismatches.push(`Tile.${validated.deletedSillsId}:retired-managed-sills-present`);
  }
  const registry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
    ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
    ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
  if (!sameValue(registry, normalizeRegistry(validated.plan.compositionRegistry))) {
    mismatches.push(`Scene.${validated.sceneId}.flags.${MODULE_ID}.${COMPOSITION_REGISTRY_FLAG}`);
  }
  for (const update of validated.plan.shadowTileUpdates || []) {
    const document = collectionGet(scene?.tiles, String(update?._id || ''));
    if (!document) {
      mismatches.push(`Tile.${update?._id || 'unknown'}:missing-shadow-target`);
      continue;
    }
    const source = documentSource(document);
    for (const [path, value] of Object.entries(update)) {
      if (path !== '_id' && !sameValue(dottedValue(source, path), value)) {
        mismatches.push(`Tile.${update._id}.${path}`);
      }
    }
  }
  for (const update of validated.siblingTileUpdates) {
    const document = collectionGet(scene?.tiles, update._id);
    if (!document) mismatches.push(`Tile.${update._id}:missing-sibling-sort-target`);
    else if (Number(document?.sort ?? document?._source?.sort) !== update.sort) {
      mismatches.push(`Tile.${update._id}.sort`);
    }
  }
  return mismatches;
}

function buildRollbackShadowUpdates(snapshots) {
  return (snapshots || []).map((snapshot) => {
    const update = { _id: snapshot.id };
    if (snapshot.hasShadowAlpha) update[`flags.${MODULE_ID}.shadowAlpha`] = snapshot.shadowAlpha;
    else update[`flags.${MODULE_ID}.-=shadowAlpha`] = null;
    if (snapshot.hasShadowBlur) update[`flags.${MODULE_ID}.shadowBlur`] = snapshot.shadowBlur;
    else update[`flags.${MODULE_ID}.-=shadowBlur`] = null;
    return update;
  });
}

function buildExactObjectUpdate(targetSource, priorSource, prefixes = []) {
  const update = clone(targetSource);
  // An optional native name introduced by Commit must disappear when restoring
  // an unnamed baseline, just like the owned fields restored below.
  if (targetSource.name === undefined && priorSource.name !== undefined) {
    delete update.name;
    update['-=name'] = null;
  }
  const writeMissingObjectDeletions = (target, prior, prefix) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || !prior || typeof prior !== 'object' || Array.isArray(prior)) return;
    for (const [key, priorValue] of Object.entries(prior)) {
      if (!Object.prototype.hasOwnProperty.call(target, key)) {
        update[`${prefix}.-=${key}`] = null;
        continue;
      }
      writeMissingObjectDeletions(target[key], priorValue, `${prefix}.${key}`);
    }
  };
  for (const prefix of prefixes) {
    writeMissingObjectDeletions(
      dottedValue(targetSource, prefix) || {},
      dottedValue(priorSource, prefix) || {},
      prefix
    );
  }
  return update;
}

function buildExactExistingRootUpdate(targetRoot, priorRoot) {
  return buildExactObjectUpdate(targetRoot, priorRoot, [`flags.${MODULE_ID}`]);
}

function buildExactManagedFillUpdate(targetFill, priorFill) {
  return buildExactObjectUpdate(targetFill, priorFill, [
    'texture', 'levels', 'occlusion', `flags.${MODULE_ID}`
  ]);
}

function buildExactManagedSillsUpdate(targetSills, priorSills) {
  return buildExactObjectUpdate(targetSills, priorSills, [
    'texture', `flags.${MODULE_ID}`
  ]);
}

function buildSceneRegistryUpdate(scene, plan, rollback = false) {
  const baseline = rollback && plan.migration?.aggregate;
  const registry = baseline ? baseline.compositionRegistry
    : rollback ? plan.preconditions.compositionRegistry : plan.compositionRegistry;
  const priorFlags = scene.flags || scene._source?.flags || {};
  if (registry == null) {
    const removeNamespace = baseline && !baseline.sceneModuleFlagsPresent
      && Object.keys(priorFlags[MODULE_ID] || {}).every(key => key === COMPOSITION_REGISTRY_FLAG);
    return { _id: scene.id, [removeNamespace ? `flags.-=${MODULE_ID}`
      : `flags.${MODULE_ID}.-=${COMPOSITION_REGISTRY_FLAG}`]: null };
  }
  return buildExactObjectUpdate({ _id: scene.id, flags: { [MODULE_ID]: { [COMPOSITION_REGISTRY_FLAG]: clone(registry) } } },
    { flags: priorFlags }, [`flags.${MODULE_ID}.${COMPOSITION_REGISTRY_FLAG}`]);
}

function commitError(message, details = {}) {
  const error = new Error(message);
  error.code = details.code || 'building-v2-commit-failed';
  error.phase = details.phase || 'unknown';
  error.rollback = details.rollback;
  error.residue = details.residue || [];
  error.cause = details.cause;
  return error;
}

export function createBuildingV2CommitRuntime({
  getCanvas = () => globalThis.canvas,
  getFoundry = () => globalThis.foundry,
  getHooks = () => globalThis.Hooks,
  getShadowManager = async () => {
    const { getAssetShadowManager } = await import('../../assets/asset-shadow-manager.js');
    return getAssetShadowManager();
  },
  renderCommittedRoot = async (placeable) => {
    const { applyBuildingTile } = await import('../building-tiles.js');
    return applyBuildingTile(placeable);
  },
  renderCommittedFill = async (placeable) => {
    const { applyMaskedTilingToTile } = await import('../../textures/texture-mask-runtime.js');
    return applyMaskedTilingToTile(placeable);
  },
  renderCommittedSills = async (placeable) => {
    const { applyBuildingCompositeTile } = await import('../building-tiles.js');
    return applyBuildingCompositeTile(placeable);
  }
} = {}) {
  const executeWithPortalDeletionCapture = async (foundry, operations, scene, validated) => {
    const intents = validated.plan.portalStateIntents || [];
    assertPortalStateBaselines(validated.plan, scene);
    const baseline = validated.baselineWalls || validated.plan.preconditions?.walls || [];
    const deletedPortals = baseline.filter(wall => validated.deletedWallIds.includes(wall._id) && isNativePortal(wall));
    if (!deletedPortals.length && !intents.length) return executeAtomicDocumentBatch(foundry, operations);
    const hooks = getHooks();
    if (typeof hooks?.on !== 'function' || typeof hooks?.off !== 'function') {
      throw new Error('Building V2 Portal deletion requires native deletion observation for exact live-state compensation.');
    }
    const byId = new Map(deletedPortals.map(wall => [wall._id, wall]));
    validated.deletedPortalLiveStates = new Map();
    validated.writtenPortalStates = new Set();
    let conflict = null;
    const preUpdateId = intents.length ? hooks.on('preUpdateWall', (document, changes, options) => {
      if (document.parent !== scene || options?.faNexusBuildingEditorDocumentWrite !== true) return;
      try { assertPortalStateBaselines(validated.plan, scene); }
      catch (error) { conflict = error; return false; }
    }) : null;
    const updateId = intents.length ? hooks.on('updateWall', (document, changes, options) => {
      if (document.parent !== scene || !Object.hasOwn(changes, 'ds')) return;
      const intent = intents.find(entry => entry.portalId === documentSource(document)?.flags?.[MODULE_ID]?.buildingGenerated?.semanticId);
      if (!intent) return;
      if (options?.faNexusBuildingEditorDocumentWrite === true && documentSource(document).ds === intent.state) {
        validated.writtenPortalStates.add(intent.portalId);
      } else validated.writtenPortalStates.delete(intent.portalId);
    }) : null;
    const hookId = hooks.on('deleteWall', (document, options) => {
      const baselineWall = byId.get(String(document.id || document._id));
      if (!baselineWall || document.parent !== scene || options?.faNexusBuildingEditorDocumentWrite !== true) return;
      const source = documentSource(document);
      if (!portalStateIsValid(source) || !wallSourcesMatch([source], [baselineWall])) return;
      validated.deletedPortalLiveStates.set(baselineWall._id, source.ds);
    });
    try {
      const result = await executeAtomicDocumentBatch(foundry, operations);
      if (conflict) throw conflict;
      return result;
    } finally {
      hooks.off('deleteWall', hookId);
      if (preUpdateId != null) hooks.off('preUpdateWall', preUpdateId);
      if (updateId != null) hooks.off('updateWall', updateId);
    }
  };

  // Compensation owns only state writes made by this transaction which have
  // not since been superseded by gameplay. Unedited live state stays untouched.
  const compensatingPortalIntents = (validated, scene) => (validated.plan.portalStateIntents || []).filter(intent => {
    const wall = documentSource(collectionGet(scene.walls, intent.documentId));
    return validated.writtenPortalStates?.has(intent.portalId) && wall?.ds === intent.state;
  });

  const portalRecreationSource = (wall, validated) => {
    if (!isNativePortal(wall)) return wall;
    if (!validated.deletedPortalLiveStates?.has(wall._id)) return null;
    return { ...clone(wall), ds: validated.deletedPortalLiveStates.get(wall._id) };
  };
  const beginLocalRootSuppression = (rootTileId) => {
    const hooks = getHooks?.();
    const apply = (documentOrPlaceable) => {
      const document = documentOrPlaceable?.document || documentOrPlaceable;
      if (String(document?.id || document?._id || '') !== rootTileId) return false;
      const placeable = documentOrPlaceable?.document
        ? documentOrPlaceable
        : document?.object || getCanvas()?.tiles?.get?.(rootTileId) || null;
      if (placeable) placeable.visible = false;
      return true;
    };
    const hookIds = [];
    if (typeof hooks?.on === 'function') {
      hookIds.push(['createTile', hooks.on('createTile', apply)]);
      hookIds.push(['drawTile', hooks.on('drawTile', apply)]);
      hookIds.push(['refreshTile', hooks.on('refreshTile', apply)]);
    }
    return {
      apply,
      release() {
        if (typeof hooks?.off !== 'function') return;
        for (const [hook, id] of hookIds) hooks.off(hook, id);
        hookIds.length = 0;
      }
    };
  };

  const capture = async ({ scene, elevation }) => {
    const shadowManager = await getShadowManager();
    if (!shadowManager || typeof shadowManager._collectShadowTilesAtElevation !== 'function') {
      throw new Error('Building V2 Commit requires the canonical Asset Shadow manager.');
    }
    const registry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
      ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
      ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
    const shadowTiles = shadowManager._collectShadowTilesAtElevation(Number(elevation))
      .filter((document) => !isBuildingGeneratedTile(document))
      .map((document) => shadowTileSnapshot(document))
      .sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze({
      sceneId: String(scene?.id || ''),
      compositionRegistry: clone(registry),
      shadowTiles: clone(shadowTiles),
      naming: {
        levels: collectionValues(scene?.levels).map(level => ({ id: String(level.id || level._id || ''), name: String(level.name || '') })),
        documentNames: [...collectionValues(scene?.tiles), ...collectionValues(scene?.regions)]
          .map(document => {
            const source = documentSource(document);
            return [source?.name, source?.flags?.[MODULE_ID]?.name, source?.flags?.[MODULE_ID]?.label, source?.label]
              .find(value => String(value || '').trim()) || '';
          }).filter(Boolean)
      }
    });
  };

  const assertPreconditions = async (scene, validated) => {
    requireRegionPreconditions(scene, validated);
    const plan = validated.plan;
    if (collectionGet(scene.tiles, validated.rootTileId)
      || (validated.fillId && collectionGet(scene.tiles, validated.fillId))
      || (validated.sillsId && collectionGet(scene.tiles, validated.sillsId))
      || validated.wallIds.some((id) => collectionGet(scene.walls, id))) {
      throw commitError('Building V2 Commit identities already exist but do not match the planned durable generation.', {
        code: 'identity-conflict',
        phase: 'preconditions'
      });
    }
    const current = await capture({ scene, elevation: Number(plan.root.elevation) });
    if (!sameValue(normalizeRegistry(current.compositionRegistry), normalizeRegistry(plan.preconditions?.compositionRegistry))) {
      throw commitError('Building V2 Commit composition registry changed after planning.', {
        code: 'stale-composition-registry',
        phase: 'preconditions'
      });
    }
    if (!sameValue(current.shadowTiles, (plan.preconditions?.shadowTiles || []).slice().sort((a, b) => a.id.localeCompare(b.id)))) {
      throw commitError('Building V2 Commit exact-elevation shadow Tiles changed after planning.', {
        code: 'stale-shadow-elevation',
        phase: 'preconditions'
      });
    }
    if (!hasExactSiblingTileSortPreconditions(scene, validated)) {
      throw commitError('Building V2 Commit sibling Tile order changed after placement.', {
        code: 'stale-sibling-order',
        phase: 'preconditions'
      });
    }
  };

  const rollback = async (scene, validated) => {
    const foundry = getFoundry();
    const plan = validated.plan;
    const operations = [];
    const liveRegistry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
      ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
      ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
    if (sameValue(liveRegistry, normalizeRegistry(plan.compositionRegistry))) {
      operations.push({
        action: 'update',
        documentName: 'Scene',
        updates: [buildSceneRegistryUpdate(scene, plan, true)]
      });
    }
    const wallIds = validated.wallIds.filter((id) => {
      const wall = collectionGet(scene.walls, id);
      return generatedOwner(wall)?.generationId === plan.generationId;
    });
    if (wallIds.length) operations.push({
      action: 'delete', documentName: 'Wall', ids: wallIds, parent: scene,
      faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    const fill = validated.fillId ? collectionGet(scene.tiles, validated.fillId) : null;
    if (fill && generatedOwner(fill)?.generationId === plan.generationId) operations.push({
      action: 'delete', documentName: 'Tile', ids: [validated.fillId], parent: scene,
      faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
      faNexusBuildingV2CommitRollback: true
    });
    const sills = validated.sillsId ? collectionGet(scene.tiles, validated.sillsId) : null;
    if (sills && generatedOwner(sills)?.generationId === plan.generationId) operations.push({
      action: 'delete', documentName: 'Tile', ids: [validated.sillsId], parent: scene,
      faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
      faNexusBuildingV2CommitRollback: true
    });
    const root = collectionGet(scene.tiles, validated.rootTileId);
    if (rootBuilding(root)?.runtime?.generationId === plan.generationId) operations.push({
      action: 'delete', documentName: 'Tile', ids: [validated.rootTileId], parent: scene,
      faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
      faNexusBuildingV2CommitRollback: true
    });
    const shadowUpdates = buildRollbackShadowUpdates((plan.preconditions?.shadowTiles || []).filter((snapshot) => {
      const document = collectionGet(scene.tiles, snapshot.id);
      const planned = (plan.shadowTileUpdates || []).find((update) => String(update?._id || '') === snapshot.id);
      return document && planned && Object.entries(planned).every(([path, value]) => (
        path === '_id' || sameValue(dottedValue(documentSource(document), path), value)
      ));
    }));
    if (shadowUpdates.length) operations.push({
      action: 'update', documentName: 'Tile', updates: shadowUpdates, parent: scene,
      diff: false, faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    if (validated.siblingTilePreconditions.length) operations.push({
      action: 'update', documentName: 'Tile', parent: scene,
      updates: clone(validated.siblingTilePreconditions), diff: false,
      faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    operations.push(...buildRegionOperations(scene, validated, true));
    if (operations.length) await executeAtomicDocumentBatch(foundry, operations);
    const residue = regionStateMatches(scene, validated, true) ? [] : ['Region:baseline'];
    if (!migrationTilesMatch(scene, validated, true)) residue.push('Tile:legacy-baseline');
    if (collectionGet(scene.tiles, validated.rootTileId)) residue.push(`Tile.${validated.rootTileId}`);
    if (validated.fillId && collectionGet(scene.tiles, validated.fillId)) residue.push(`Tile.${validated.fillId}`);
    if (validated.sillsId && collectionGet(scene.tiles, validated.sillsId)) residue.push(`Tile.${validated.sillsId}`);
    for (const id of validated.wallIds) if (collectionGet(scene.walls, id)) residue.push(`Wall.${id}`);
    const rolledRegistry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
      ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
      ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
    if (!sameValue(rolledRegistry, normalizeRegistry(plan.preconditions?.compositionRegistry))) {
      residue.push(`Scene.${scene.id}.compositionRegistry`);
    }
    for (const snapshot of plan.preconditions?.shadowTiles || []) {
      const document = collectionGet(scene.tiles, snapshot.id);
      const current = document ? shadowTileSnapshot(document) : null;
      if (!current || !sameValue(current, snapshot)) residue.push(`Tile.${snapshot.id}.shadowAlphaBlur`);
    }
    for (const entry of validated.siblingTilePreconditions) {
      const document = collectionGet(scene.tiles, entry._id);
      if (!document || Number(document?.sort ?? document?._source?.sort) !== entry.sort) {
        residue.push(`Tile.${entry._id}.sort`);
      }
    }
    return residue;
  };

  const prepareHandoff = async (scene, applied, validated, {
    rootSuppression, fillSuppression, sillsSuppression, shadowSuppression
  } = {}) => {
    const canvas = getCanvas();
    const root = applied.root;
    const placeable = root?.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.rootTileId) || null;
    if (!placeable) throw new Error(`Committed Building Root ${validated.rootTileId} has no live Tile placeable.`);
    const fillPlaceable = applied.fill
      ? (applied.fill.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.fillId) || null)
      : null;
    if (applied.fill && !fillPlaceable) {
      throw new Error(`Committed managed Fill ${validated.fillId} has no live Tile placeable.`);
    }
    const sillsPlaceable = applied.sills
      ? (applied.sills.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.sillsId) || null)
      : null;
    if (applied.sills && !sillsPlaceable) {
      throw new Error(`Committed managed Sills ${validated.sillsId} has no live Tile placeable.`);
    }
    placeable.visible = false;
    if (fillPlaceable) fillPlaceable.visible = false;
    if (sillsPlaceable) sillsPlaceable.visible = false;
    const shadowManager = await getShadowManager();
    rootSuppression?.apply?.(root);
    fillSuppression?.apply?.(applied.fill);
    sillsSuppression?.apply?.(applied.sills);
    try {
      const resumedShadow = shadowManager?.resumeTile?.(root) === true;
      if (!resumedShadow) shadowManager?._addTile?.(root, { deferRebuild: true });
      await renderCommittedRoot(placeable);
      const container = placeable.faNexusBuildingContainer || placeable.mesh?.faNexusBuildingContainer;
      if ((!container || !Array.isArray(container.children) || !container.children.length)
        && !buildingV2HasFullyOpenedArtwork(readFlag(root, 'building'))) {
        throw new Error(`Committed Building Root ${validated.rootTileId} public artwork is not ready.`);
      }
      if (fillPlaceable) {
        await renderCommittedFill(fillPlaceable);
        if (!managedFillArtworkReady(fillPlaceable)) {
          throw new Error(`Committed managed Fill ${validated.fillId} public masked artwork is not ready.`);
        }
      }
      if (sillsPlaceable) {
        const resumedSillsShadow = shadowManager?.resumeTile?.(applied.sills) === true;
        if (!resumedSillsShadow) shadowManager?._addTile?.(applied.sills, { deferRebuild: true });
        await renderCommittedSills(sillsPlaceable);
        if (!managedSillsArtworkReady(sillsPlaceable)) {
          throw new Error(`Committed managed Sills ${validated.sillsId} public composite artwork is not ready.`);
        }
      }
      await shadowSuppression?.commit?.();
      return {
        activate() {
          rootSuppression?.release?.();
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          placeable.visible = true;
          if (fillPlaceable) fillPlaceable.visible = true;
          if (sillsPlaceable) sillsPlaceable.visible = true;
          const tileLayer = getCanvas()?.tiles;
          tileLayer?.activate?.();
          tileLayer?.releaseAll?.();
          placeable.control?.({ releaseOthers: true });
          if (placeable.controlled !== true) {
            throw new Error(`Committed Building Root ${validated.rootTileId} could not become the sole native Tile selection.`);
          }
        },
        recover() {
          placeable.visible = false;
          if (fillPlaceable) fillPlaceable.visible = false;
          if (sillsPlaceable) sillsPlaceable.visible = false;
          try { shadowManager.suspendTile(root); } catch (_) {}
          if (applied.sills) shadowManager.suspendTile(applied.sills);
        }
      };
    } catch (error) {
      placeable.visible = false;
      if (fillPlaceable) fillPlaceable.visible = false;
      if (sillsPlaceable) sillsPlaceable.visible = false;
      rootSuppression?.release?.();
      fillSuppression?.release?.();
      sillsSuppression?.release?.();
      try { shadowSuppression?.abandon?.('building-v2-handoff-failed'); } catch (_) {}
      try { shadowManager.suspendTile(root); } catch (_) {}
      if (applied.sills) shadowManager.suspendTile(applied.sills);
      throw error;
    }
  };

  const exactAppliedMultiState = (scene, validated) => {
    if (!migrationTilesMatch(scene, validated)) return null;
    if (!regionStateMatches(scene, validated)) return null;
    const appliedComponents = validated.components.map((component) => exactAppliedState(scene, component));
    if (appliedComponents.some((component) => !component)) return null;
    if (validated.deletedWallIds.some((id) => collectionGet(scene?.walls, id))) return null;
    if (validated.deletedFillId && collectionGet(scene?.tiles, validated.deletedFillId)) return null;
    if (validated.deletedSillsId && collectionGet(scene?.tiles, validated.deletedSillsId)) return null;
    if (validated.siblingTileUpdates.some((update) => {
      const document = collectionGet(scene?.tiles, update._id);
      return !document || Number(document?.sort ?? document?._source?.sort) !== update.sort;
    })) return null;
    return {
      components: appliedComponents,
      roots: appliedComponents.map((component) => component.root),
      walls: appliedComponents.flatMap((component) => component.walls),
      fills: appliedComponents.map((component) => component.fill).filter(Boolean),
      sills: appliedComponents.map((component) => component.sills).filter(Boolean)
    };
  };

  const assertMultiPreconditions = async (scene, validated) => {
    requireRegionPreconditions(scene, validated);
    const plan = validated.plan;
    if (plan.mode === 'existing-partition') {
      const currentRoot = collectionGet(scene.tiles, validated.baselineRootId);
      const currentWalls = validated.baselineWallIds.map((id) => collectionGet(scene.walls, id));
      const currentFill = validated.baselineFillId
        ? collectionGet(scene.tiles, validated.baselineFillId)
        : null;
      const currentSills = validated.baselineSillsId
        ? collectionGet(scene.tiles, validated.baselineSillsId)
        : null;
      if (!currentRoot || currentWalls.some((wall) => !wall)
        || validated.newRootIds.some((id) => collectionGet(scene.tiles, id))
        || validated.newFillIds.some((id) => collectionGet(scene.tiles, id))
        || validated.newSillsIds.some((id) => collectionGet(scene.tiles, id))
        || validated.createdWallIds.some((id) => collectionGet(scene.walls, id))
        || !sameValue(documentSource(currentRoot), validated.baselineRoot)
        || !wallSourcesMatch(currentWalls.map((wall) => documentSource(wall)), validated.baselineWalls)
        || (validated.baselineFillId
          ? (!currentFill || !sameValue(documentSource(currentFill), validated.baselineFill))
          : currentFill != null)
        || (validated.baselineSillsId
          ? (!currentSills || !sameValue(documentSource(currentSills), validated.baselineSills))
          : currentSills != null)) {
        throw commitError('Building V2 existing partition baseline changed after open.', {
          code: 'stale-existing-building', phase: 'preconditions'
        });
      }
    } else if (validated.rootIds.some((id) => collectionGet(scene.tiles, id))
      || validated.fillIds.some((id) => collectionGet(scene.tiles, id))
      || validated.sillsIds.some((id) => collectionGet(scene.tiles, id))
      || validated.wallIds.some((id) => collectionGet(scene.walls, id))) {
      throw commitError('Building V2 partition identities already exist but do not match the planned durable generations.', {
        code: 'identity-conflict', phase: 'preconditions'
      });
    }
    if (validated.siblingTilePreconditions.some((entry) => {
      const document = collectionGet(scene.tiles, entry._id);
      return !document || Number(document?.sort ?? document?._source?.sort) !== entry.sort;
    })) {
      throw commitError('Building V2 partition sibling Tile ordering changed after planning.', {
        code: 'stale-sibling-order', phase: 'preconditions'
      });
    }
    const current = await capture({
      scene,
      elevation: Number(validated.components[0]?.plan?.root?.elevation)
    });
    if (!sameValue(normalizeRegistry(current.compositionRegistry), normalizeRegistry(plan.preconditions?.compositionRegistry))) {
      throw commitError('Building V2 partition composition registry changed after planning.', {
        code: 'stale-composition-registry', phase: 'preconditions'
      });
    }
    if (!sameValue(current.shadowTiles, (plan.preconditions?.shadowTiles || []).slice().sort((a, b) => a.id.localeCompare(b.id)))) {
      throw commitError('Building V2 partition exact-elevation shadow Tiles changed after planning.', {
        code: 'stale-shadow-elevation', phase: 'preconditions'
      });
    }
  };

  const rollbackMulti = async (scene, validated) => {
    const foundry = getFoundry();
    const plan = validated.plan;
    const operations = [];
    if (plan.mode === 'existing-partition') {
      const sourceComponent = validated.components.find((component) => component.rootTileId === validated.baselineRootId);
      if (!sourceComponent) throw new Error('Building V2 existing partition rollback cannot identify its retained Root.');
      const liveSourceRoot = collectionGet(scene.tiles, validated.baselineRootId);
      if (liveSourceRoot) operations.push({
        action: 'update', documentName: 'Tile', parent: scene,
        updates: [buildExactExistingRootUpdate(validated.baselineRoot, documentSource(liveSourceRoot))], diff: false,
        faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
      });
      const removableRoots = validated.newRootIds.filter((id) => {
        const root = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.rootTileId === id);
        return root && rootBuilding(root)?.runtime?.generationId === component?.plan?.generationId;
      });
      if (removableRoots.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableRoots,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
      const removableFills = validated.newFillIds.filter((id) => {
        const fill = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.fillId === id);
        return fill && generatedOwner(fill)?.generationId === component?.plan?.generationId;
      });
      if (removableFills.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableFills,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
      if (validated.baselineFillId) {
        const liveBaselineFill = collectionGet(scene.tiles, validated.baselineFillId);
        if (liveBaselineFill) operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: [buildExactManagedFillUpdate(
            validated.baselineFill,
            documentSource(liveBaselineFill)
          )],
          diff: false,
          faNexusBuildingEditorDocumentWrite: true,
          faNexusBuildingV2CommitRollback: true
        });
        else operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: [clone(validated.baselineFill)], keepId: true,
          faNexusBuildingEditorDocumentWrite: true,
          faNexusBuildingV2CommitRollback: true
        });
      }
      const removableSills = validated.newSillsIds.filter((id) => {
        const sills = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.sillsId === id);
        return sills && generatedOwner(sills)?.generationId === component?.plan?.generationId;
      });
      if (removableSills.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableSills,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
      if (validated.baselineSillsId) {
        const liveBaselineSills = collectionGet(scene.tiles, validated.baselineSillsId);
        if (liveBaselineSills) operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: [buildExactManagedSillsUpdate(validated.baselineSills, documentSource(liveBaselineSills))],
          diff: false, faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
        });
        else operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: [clone(validated.baselineSills)], keepId: true,
          faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
        });
      }
      const baselineById = new Map(validated.baselineWalls.map((wall) => [String(wall._id), wall]));
      const restoreWalls = validated.baselineWallIds.filter((id) => collectionGet(scene.walls, id)).map((id) => baselineById.get(id));
      const recreateWalls = validated.baselineWallIds.filter((id) => !collectionGet(scene.walls, id))
        .map(id => portalRecreationSource(baselineById.get(id), validated)).filter(Boolean);
      if (restoreWalls.length) operations.push({
        action: 'update', documentName: 'Wall', parent: scene, updates: restoreWalls.map(wall => buildWallUpdate(wall, collectionGet(scene.walls, wall._id), compensatingPortalIntents(validated, scene))), diff: false,
        faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
      });
      if (recreateWalls.length) operations.push({
        action: 'create', documentName: 'Wall', parent: scene, data: clone(recreateWalls), keepId: true,
        faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
      });
      const removableWalls = validated.createdWallIds.filter((id) => collectionGet(scene.walls, id));
      if (removableWalls.length) operations.push({
        action: 'delete', documentName: 'Wall', parent: scene, ids: removableWalls,
        faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
      });
    } else {
      const removableWalls = validated.wallIds.filter((id) => {
        const wall = collectionGet(scene.walls, id);
        const component = validated.components.find((entry) => entry.wallIds.includes(id));
        return wall && generatedOwner(wall)?.generationId === component?.plan?.generationId;
      });
      if (removableWalls.length) operations.push({
        action: 'delete', documentName: 'Wall', parent: scene, ids: removableWalls,
        faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
      });
      const removableFills = validated.fillIds.filter((id) => {
        const fill = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.fillId === id);
        return fill && generatedOwner(fill)?.generationId === component?.plan?.generationId;
      });
      if (removableFills.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableFills,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
      const removableSills = validated.sillsIds.filter((id) => {
        const sills = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.sillsId === id);
        return sills && generatedOwner(sills)?.generationId === component?.plan?.generationId;
      });
      if (removableSills.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableSills,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
      const removableRoots = validated.rootIds.filter((id) => {
        const root = collectionGet(scene.tiles, id);
        const component = validated.components.find((entry) => entry.rootTileId === id);
        return root && rootBuilding(root)?.runtime?.generationId === component?.plan?.generationId;
      });
      if (removableRoots.length) operations.push({
        action: 'delete', documentName: 'Tile', parent: scene, ids: removableRoots,
        faNexusPreserveLinkedTileCleanup: true, faNexusBuildingEditorDocumentWrite: true,
        faNexusBuildingV2CommitRollback: true
      });
    }
    if (validated.siblingTilePreconditions.length) operations.push({
      action: 'update', documentName: 'Tile', parent: scene,
      updates: clone(validated.siblingTilePreconditions), diff: false,
      faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    operations.push({
      action: 'update', documentName: 'Scene',
      updates: [buildSceneRegistryUpdate(scene, plan, true)],
      faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    const rootIdSet = new Set(validated.rootIds);
    const shadowUpdates = buildRollbackShadowUpdates((plan.preconditions?.shadowTiles || []).filter((snapshot) => (
      !rootIdSet.has(snapshot.id) && collectionGet(scene.tiles, snapshot.id)
    )));
    if (shadowUpdates.length) operations.push({
      action: 'update', documentName: 'Tile', parent: scene, updates: shadowUpdates, diff: false,
      faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
    });
    await executeAtomicDocumentBatch(foundry, [...operations, ...buildRegionOperations(scene, validated, true), ...migrationTileOperations(scene, validated, true)]);

    const residue = regionStateMatches(scene, validated, true) ? [] : ['Region:baseline'];
    if (plan.mode === 'existing-partition') {
      const restoredRoot = collectionGet(scene.tiles, validated.baselineRootId);
      const restoredWalls = validated.baselineWallIds.map((id) => collectionGet(scene.walls, id));
      if (!restoredRoot || !sameValue(documentSource(restoredRoot), validated.baselineRoot)) {
        residue.push(`Tile.${validated.baselineRootId}:baseline`);
      }
      if (restoredWalls.some((wall) => !wall)
        || !wallSourcesMatch(restoredWalls.map((wall) => documentSource(wall)), validated.baselineWalls)) {
        residue.push('Wall:existing-partition-baseline');
      }
      for (const id of validated.newRootIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      if (validated.baselineFillId) {
        const restoredFill = collectionGet(scene.tiles, validated.baselineFillId);
        if (!restoredFill || !sameValue(documentSource(restoredFill), validated.baselineFill)) {
          residue.push(`Tile.${validated.baselineFillId}:baseline`);
        }
      }
      for (const id of validated.newFillIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      if (validated.baselineSillsId) {
        const restoredSills = collectionGet(scene.tiles, validated.baselineSillsId);
        if (!restoredSills || !sameValue(documentSource(restoredSills), validated.baselineSills)) {
          residue.push(`Tile.${validated.baselineSillsId}:baseline`);
        }
      }
      for (const id of validated.newSillsIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      for (const id of validated.createdWallIds) if (collectionGet(scene.walls, id)) residue.push(`Wall.${id}`);
    } else {
      for (const id of validated.rootIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      for (const id of validated.fillIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      for (const id of validated.sillsIds) if (collectionGet(scene.tiles, id)) residue.push(`Tile.${id}`);
      for (const id of validated.wallIds) if (collectionGet(scene.walls, id)) residue.push(`Wall.${id}`);
    }
    const registry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
      ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
      ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
    if (!sameValue(registry, normalizeRegistry(plan.preconditions?.compositionRegistry))) {
      residue.push(`Scene.${scene.id}.compositionRegistry`);
    }
    for (const entry of validated.siblingTilePreconditions) {
      const document = collectionGet(scene.tiles, entry._id);
      if (!document || Number(document?.sort ?? document?._source?.sort) !== entry.sort) {
        residue.push(`Tile.${entry._id}.sort`);
      }
    }
    for (const snapshot of plan.preconditions?.shadowTiles || []) {
      const document = collectionGet(scene.tiles, snapshot.id);
      if (!document || !sameValue(shadowTileSnapshot(document), snapshot)) residue.push(`Tile.${snapshot.id}.shadowAlphaBlur`);
    }
    return residue;
  };

  const prepareMultiHandoff = async (applied, validated, {
    rootSuppressions, fillSuppressions, sillsSuppressions, shadowSuppression
  } = {}) => {
    const canvas = getCanvas();
    const shadowManager = await getShadowManager();
    const entries = applied.roots.map((root) => {
      const id = String(root?.id || root?._id || '');
      const placeable = root?.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === id) || null;
      if (!placeable) throw new Error(`Committed Building Root ${id} has no live Tile placeable.`);
      placeable.visible = false;
      rootSuppressions.get(id)?.apply?.(root);
      return { id, root, placeable };
    });
    const fillEntries = applied.components.filter((component) => component.fill).map((component) => {
      const fill = component.fill;
      const id = String(fill?.id || fill?._id || '');
      const placeable = fill?.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === id) || null;
      if (!placeable) throw new Error(`Committed managed Fill ${id} has no live Tile placeable.`);
      placeable.visible = false;
      fillSuppressions.get(id)?.apply?.(fill);
      return { id, fill, placeable };
    });
    const sillsEntries = applied.components.filter((component) => component.sills).map((component) => {
      const sills = component.sills;
      const id = String(sills?.id || sills?._id || '');
      const placeable = sills?.object || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === id) || null;
      if (!placeable) throw new Error(`Committed managed Sills ${id} has no live Tile placeable.`);
      placeable.visible = false;
      sillsSuppressions.get(id)?.apply?.(sills);
      return { id, sills, placeable };
    });
    try {
      for (const entry of entries) {
        const resumedShadow = shadowManager?.resumeTile?.(entry.root) === true;
        if (!resumedShadow) shadowManager?._addTile?.(entry.root, { deferRebuild: true });
        await renderCommittedRoot(entry.placeable);
        const container = entry.placeable.faNexusBuildingContainer || entry.placeable.mesh?.faNexusBuildingContainer;
        if ((!container || !Array.isArray(container.children) || !container.children.length)
          && !buildingV2HasFullyOpenedArtwork(readFlag(entry.root, 'building'))) {
          throw new Error(`Committed Building Root ${entry.id} public artwork is not ready.`);
        }
      }
      for (const entry of fillEntries) {
        await renderCommittedFill(entry.placeable);
        if (!managedFillArtworkReady(entry.placeable)) {
          throw new Error(`Committed managed Fill ${entry.id} public masked artwork is not ready.`);
        }
      }
      for (const entry of sillsEntries) {
        const resumedSillsShadow = shadowManager?.resumeTile?.(entry.sills) === true;
        if (!resumedSillsShadow) shadowManager?._addTile?.(entry.sills, { deferRebuild: true });
        await renderCommittedSills(entry.placeable);
        if (!managedSillsArtworkReady(entry.placeable)) {
          throw new Error(`Committed managed Sills ${entry.id} public composite artwork is not ready.`);
        }
      }
      await shadowSuppression?.commit?.();
      return {
        activate() {
          for (const suppression of rootSuppressions.values()) suppression.release?.();
          for (const suppression of fillSuppressions.values()) suppression.release?.();
          for (const suppression of sillsSuppressions.values()) suppression.release?.();
          for (const entry of entries) entry.placeable.visible = true;
          for (const entry of fillEntries) entry.placeable.visible = true;
          for (const entry of sillsEntries) entry.placeable.visible = true;
          const tileLayer = getCanvas()?.tiles;
          tileLayer?.activate?.();
          tileLayer?.releaseAll?.();
          const focus = entries.find((entry) => entry.id === validated.focusRootTileId)?.placeable;
          focus?.control?.({ releaseOthers: true });
          if (!focus || focus.controlled !== true
            || entries.some((entry) => entry.id !== validated.focusRootTileId && entry.placeable.controlled === true)) {
            throw new Error(`Committed Building Root ${validated.focusRootTileId} could not become the sole native Tile selection.`);
          }
        },
        recover() {
          for (const entry of entries) {
            entry.placeable.visible = false;
            try { shadowManager.suspendTile(entry.root); } catch (_) {}
          }
          for (const entry of fillEntries) entry.placeable.visible = false;
          for (const entry of sillsEntries) {
            entry.placeable.visible = false;
            shadowManager.suspendTile(entry.sills);
          }
        }
      };
    } catch (error) {
      for (const suppression of rootSuppressions.values()) suppression.release?.();
      for (const suppression of fillSuppressions.values()) suppression.release?.();
      for (const suppression of sillsSuppressions.values()) suppression.release?.();
      for (const entry of entries) {
        entry.placeable.visible = false;
        try { shadowManager.suspendTile(entry.root); } catch (_) {}
      }
      for (const entry of fillEntries) entry.placeable.visible = false;
      for (const entry of sillsEntries) {
        entry.placeable.visible = false;
        shadowManager.suspendTile(entry.sills);
      }
      try { shadowSuppression?.abandon?.('building-v2-handoff-failed'); } catch (_) {}
      throw error;
    }
  };

  const executeMulti = async (plan, validated, { swapLocalProjection }) => {
    const canvas = getCanvas();
    const scene = canvas?.scene;
    const foundry = getFoundry();
    const shadowManager = await getShadowManager();
    if (typeof shadowManager?.beginTransformPreviewSuppression !== 'function') {
      throw commitError('Building V2 partition Commit requires canonical Asset Shadow handoff suppression.', { phase: 'preconditions' });
    }
    let shadowSuppression;
    try {
      shadowSuppression = shadowManager.beginTransformPreviewSuppression({
        documents: validated.rootIds.map((id) => ({ id, documentName: 'Tile' })),
        source: 'building-v2-partition-commit'
      });
    } catch (error) {
      throw commitError('Building V2 partition Commit could not begin canonical Asset Shadow handoff suppression.', {
        phase: 'preconditions', cause: error
      });
    }
    const rootSuppressions = new Map(validated.rootIds.map((id) => [id, beginLocalRootSuppression(id)]));
    const fillSuppressions = new Map(validated.fillIds.map((id) => [id, beginLocalRootSuppression(id)]));
    const sillsSuppressions = new Map(validated.sillsIds.map((id) => [id, beginLocalRootSuppression(id)]));
    let applied = exactAppliedMultiState(scene, validated);
    if (applied) {
      applied.roots.forEach((root) => rootSuppressions.get(String(root.id || root._id))?.apply?.(root));
      applied.fills.forEach((fill) => fillSuppressions.get(String(fill.id || fill._id))?.apply?.(fill));
      applied.sills.forEach((sills) => sillsSuppressions.get(String(sills.id || sills._id))?.apply?.(sills));
    }
    if (!applied) {
      try {
        await assertMultiPreconditions(scene, validated);
      } catch (error) {
        for (const suppression of rootSuppressions.values()) suppression.release?.();
        for (const suppression of fillSuppressions.values()) suppression.release?.();
        for (const suppression of sillsSuppressions.values()) suppression.release?.();
        shadowSuppression.cancel?.();
        throw error;
      }
      const rootSourcesById = new Map(validated.components.map((component) => [component.rootTileId, component.plan.root]));
      const fillSourcesById = new Map(validated.components.filter((component) => component.fillId)
        .map((component) => [component.fillId, component.plan.fill]));
      const sillsSourcesById = new Map(validated.components.filter((component) => component.sillsId)
        .map((component) => [component.sillsId, component.plan.sills]));
      const wallSourcesById = new Map(validated.components.flatMap((component) => (
        component.plan.walls.map((wall) => [String(wall._id), wall])
      )));
      const operations = [];
      if (plan.mode === 'existing-partition') {
        const sourceTarget = rootSourcesById.get(validated.baselineRootId);
        operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: [buildExactExistingRootUpdate(sourceTarget, validated.baselineRoot)], diff: false,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.retainedFillId) operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: [buildExactManagedFillUpdate(
            fillSourcesById.get(validated.retainedFillId),
            validated.baselineFill
          )],
          diff: false,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.retainedSillsId) operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: [buildExactManagedSillsUpdate(
            sillsSourcesById.get(validated.retainedSillsId), validated.baselineSills
          )],
          diff: false, faNexusBuildingEditorDocumentWrite: true
        });
        const createdTileSources = [
          ...validated.newRootIds.map((id) => rootSourcesById.get(id)),
          ...validated.newFillIds.map((id) => fillSourcesById.get(id)),
          ...validated.newSillsIds.map((id) => sillsSourcesById.get(id))
        ];
        if (createdTileSources.length) operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: clone(createdTileSources), keepId: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.deletedFillId) operations.push({
          action: 'delete', documentName: 'Tile', parent: scene,
          ids: [validated.deletedFillId],
          faNexusPreserveLinkedTileCleanup: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.deletedSillsId) operations.push({
          action: 'delete', documentName: 'Tile', parent: scene,
          ids: [validated.deletedSillsId], faNexusPreserveLinkedTileCleanup: true,
          faNexusBuildingEditorDocumentWrite: true
        });
      } else {
        operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: clone([
            ...validated.rootIds.map((id) => rootSourcesById.get(id)),
            ...validated.fillIds.map((id) => fillSourcesById.get(id)),
            ...validated.sillsIds.map((id) => sillsSourcesById.get(id))
          ]), keepId: true,
          faNexusBuildingEditorDocumentWrite: true
        });
      }
      if (validated.updatedWallIds.length) operations.push({
        action: 'update', documentName: 'Wall', parent: scene,
        updates: validated.updatedWallIds.map(id => buildWallUpdate(wallSourcesById.get(id), collectionGet(scene.walls, id), plan.portalStateIntents)), diff: false,
        faNexusBuildingEditorDocumentWrite: true
      });
      if (validated.createdWallIds.length) operations.push({
        action: 'create', documentName: 'Wall', parent: scene,
        data: clone(validated.createdWallIds.map((id) => wallSourcesById.get(id))), keepId: true,
        faNexusBuildingEditorDocumentWrite: true
      });
      if (validated.deletedWallIds.length) operations.push({
        action: 'delete', documentName: 'Wall', parent: scene, ids: clone(validated.deletedWallIds),
        faNexusBuildingEditorDocumentWrite: true
      });
      if (validated.siblingTileUpdates.length) operations.push({
        action: 'update', documentName: 'Tile', parent: scene,
        updates: clone(validated.siblingTileUpdates), diff: false,
        faNexusBuildingEditorDocumentWrite: true
      });
      const rootIdSet = new Set(validated.rootIds);
      const shadowUpdates = (plan.shadowTileUpdates || []).filter((update) => !rootIdSet.has(String(update?._id || '')));
      if (shadowUpdates.length) operations.push({
        action: 'update', documentName: 'Tile', parent: scene, updates: clone(shadowUpdates), diff: false,
        faNexusBuildingEditorDocumentWrite: true
      });
      if (!sameValue(normalizeRegistry(plan.compositionRegistry), normalizeRegistry(plan.preconditions?.compositionRegistry))) {
        operations.push({
          action: 'update', documentName: 'Scene',
          updates: [buildSceneRegistryUpdate(scene, plan)],
          faNexusBuildingEditorDocumentWrite: true
        });
      }
      let writeError = null;
      try { await executeWithPortalDeletionCapture(foundry, [...operations, ...buildRegionOperations(scene, validated), ...migrationTileOperations(scene, validated)], scene, validated); }
      catch (error) { writeError = error; }
      applied = !writeError ? exactAppliedMultiState(scene, validated) : null;
      if (writeError || !applied) {
        const auditMismatch = !writeError
          ? validated.components.flatMap((component) => describeAppliedStateMismatch(scene, component)).slice(0, 16)
          : [];
        let residue = [];
        let rollbackError = null;
        try { residue = await rollbackMulti(scene, validated); }
        catch (error) { rollbackError = error; }
        for (const suppression of rootSuppressions.values()) suppression.release?.();
        for (const suppression of fillSuppressions.values()) suppression.release?.();
        for (const suppression of sillsSuppressions.values()) suppression.release?.();
        shadowSuppression.cancel?.();
        throw commitError(
          rollbackError || residue.length
            ? 'Building V2 partition Commit failed and rollback left durable residue.'
            : `Building V2 partition Commit failed and was rolled back completely.${auditMismatch.length
              ? ` Post-write audit mismatches: ${auditMismatch.join(', ')}.` : ''}`,
          {
            code: rollbackError || residue.length ? 'commit-rollback-incomplete' : 'commit-rolled-back',
            phase: writeError ? 'write' : 'post-write-audit',
            rollback: rollbackError || residue.length ? 'incomplete' : 'complete',
            residue, cause: writeError || rollbackError
          }
        );
      }
    }

    let prepared = null;
    try {
      prepared = await prepareMultiHandoff(applied, validated, {
        rootSuppressions, fillSuppressions, sillsSuppressions, shadowSuppression
      });
      await swapLocalProjection({
        roots: applied.roots,
        walls: applied.walls,
        fills: applied.fills,
        sills: applied.sills,
        focusRootTileId: validated.focusRootTileId,
        activateCommitted: () => prepared.activate()
      });
    } catch (error) {
      for (const suppression of rootSuppressions.values()) suppression.release?.();
      for (const suppression of fillSuppressions.values()) suppression.release?.();
      for (const suppression of sillsSuppressions.values()) suppression.release?.();
      try { prepared?.recover?.(); } catch (_) {}
      const failure = commitError(`Building V2 partition Commit is durable, but the local public handoff is not ready: ${String(error?.message || error)}`, {
        code: 'commit-applied-handoff-pending', phase: 'handoff', cause: error
      });
      failure.commitApplied = true;
      failure.receipt = {
        sceneId: validated.sceneId,
        rootTileIds: clone(validated.rootIds),
        focusRootTileId: validated.focusRootTileId,
        wallIds: clone(validated.wallIds),
        fillTileIds: clone(validated.fillIds),
        sillsTileIds: clone(validated.sillsIds)
      };
      throw failure;
    }
    return Object.freeze({
      status: 'ready', kind: 'multi-building', mode: plan.mode, sceneId: validated.sceneId,
      rootTileIds: Object.freeze(clone(validated.rootIds)), focusRootTileId: validated.focusRootTileId,
      wallIds: Object.freeze(clone(validated.wallIds)),
      fillTileIds: Object.freeze(clone(validated.fillIds)),
      sillsTileIds: Object.freeze(clone(validated.sillsIds)),
      components: Object.freeze(validated.components.map((component) => Object.freeze({
        componentId: component.plan.componentId,
        buildingId: component.plan.buildingId,
        rootTileId: component.rootTileId,
        generationId: component.plan.generationId,
        fillTileId: component.fillId,
        sillsTileId: component.sillsId,
        wallIds: Object.freeze(clone(component.wallIds))
      })))
    });
  };

  return Object.freeze({
    async capture({ sceneId, elevation } = {}) {
      const scene = getCanvas()?.scene;
      if (!scene || String(scene.id || '') !== String(sceneId || '')) {
        throw new Error('Building V2 Commit context requires the active leased Scene Canvas.');
      }
      return capture({ scene, elevation });
    },

    async execute(plan, { swapLocalProjection } = {}) {
      const scene = getCanvas()?.scene;
      plan = refreshBuildingV2PortalLiveState(plan, scene);
      const validationOptions = { sceneGridSize: scene?.grid?.size };
      const validated = plan?.kind === 'multi-building'
        ? requireMultiPlan(plan, validationOptions)
        : requirePlan(plan, validationOptions);
      if (typeof swapLocalProjection !== 'function') {
        throw new Error('Building V2 Commit requires a local projection handoff callback.');
      }
      const canvas = getCanvas();
      if (!scene || String(scene.id || '') !== validated.sceneId) {
        throw commitError('Building V2 Commit requires the active planned Scene Canvas.', { phase: 'preconditions' });
      }
      for (const component of plan.kind === 'multi-building' ? plan.components : [plan]) {
        requireCompositeFillAuthority(component, scene);
      }
      const foundry = getFoundry();
      if (typeof foundry?.documents?.modifyBatch !== 'function') {
        throw commitError('Building V2 Commit requires Foundry v14 documents.modifyBatch().', { phase: 'preconditions' });
      }

      if (plan.kind === 'multi-building') {
        return executeMulti(plan, validated, { swapLocalProjection });
      }

      if (plan.kind === 'existing-edit') {
        const fillSuppression = validated.fillId ? beginLocalRootSuppression(validated.fillId) : null;
        const sillsSuppression = validated.sillsId ? beginLocalRootSuppression(validated.sillsId) : null;
        const completeExistingHandoff = async (applied) => {
          const updatedRoot = applied.root;
          const rootPlaceable = updatedRoot.object
            || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.rootTileId)
            || null;
          if (!rootPlaceable) {
            fillSuppression?.release?.();
            sillsSuppression?.release?.();
            throw commitError('Building V2 existing Edit requires the live Root Tile placeable.', { phase: 'handoff' });
          }
          const fillPlaceable = applied.fill
            ? (applied.fill.object
              || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.fillId)
              || null)
            : null;
          if (applied.fill && !fillPlaceable) {
            fillSuppression?.release?.();
            sillsSuppression?.release?.();
            throw commitError('Building V2 existing Edit requires the live managed Fill Tile placeable.', { phase: 'handoff' });
          }
          const sillsPlaceable = applied.sills
            ? (applied.sills.object
              || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.sillsId)
              || null)
            : null;
          if (applied.sills && !sillsPlaceable) {
            fillSuppression?.release?.();
            sillsSuppression?.release?.();
            throw commitError('Building V2 existing Edit requires the live managed Sills Tile placeable.', { phase: 'handoff' });
          }
          rootPlaceable.visible = false;
          if (fillPlaceable) fillPlaceable.visible = false;
          if (sillsPlaceable) sillsPlaceable.visible = false;
          fillSuppression?.apply?.(applied.fill);
          sillsSuppression?.apply?.(applied.sills);
          try {
            const shadowManager = await getShadowManager();
            const resumedShadow = shadowManager?.resumeTile?.(updatedRoot) === true;
            if (!resumedShadow) shadowManager?._addTile?.(updatedRoot, { deferRebuild: true });
            await renderCommittedRoot(rootPlaceable);
            const container = rootPlaceable.faNexusBuildingContainer || rootPlaceable.mesh?.faNexusBuildingContainer;
            if ((!container || !Array.isArray(container.children) || !container.children.length)
              && !buildingV2HasFullyOpenedArtwork(readFlag(updatedRoot, 'building'))) {
              throw new Error(`Committed Building Root ${validated.rootTileId} public artwork is not ready.`);
            }
            if (fillPlaceable) {
              await renderCommittedFill(fillPlaceable);
              if (!managedFillArtworkReady(fillPlaceable)) {
                throw new Error(`Committed managed Fill ${validated.fillId} public masked artwork is not ready.`);
              }
            }
            if (sillsPlaceable) {
              const resumedSillsShadow = shadowManager?.resumeTile?.(applied.sills) === true;
              if (!resumedSillsShadow) shadowManager?._addTile?.(applied.sills, { deferRebuild: true });
              await renderCommittedSills(sillsPlaceable);
              if (!managedSillsArtworkReady(sillsPlaceable)) {
                throw new Error(`Committed managed Sills ${validated.sillsId} public composite artwork is not ready.`);
              }
            }
            await swapLocalProjection({
              root: updatedRoot,
              walls: applied.walls,
              fill: applied.fill,
              sills: applied.sills,
              activateCommitted: () => {
                fillSuppression?.release?.();
                sillsSuppression?.release?.();
                rootPlaceable.visible = true;
                if (fillPlaceable) fillPlaceable.visible = true;
                if (sillsPlaceable) sillsPlaceable.visible = true;
              }
            });
          } catch (error) {
            fillSuppression?.release?.();
            sillsSuppression?.release?.();
            const failure = commitError(`Building V2 existing Edit is durable, but the local public handoff is not ready: ${String(error?.message || error)}`, {
              code: 'commit-applied-handoff-pending', phase: 'handoff', cause: error
            });
            failure.commitApplied = true;
            failure.receipt = {
              sceneId: validated.sceneId, buildingId: plan.buildingId,
              rootTileId: validated.rootTileId, generationId: plan.generationId,
              wallIds: clone(validated.wallIds), fillTileId: validated.fillId,
              sillsTileId: validated.sillsId
            };
            throw failure;
          }
          return Object.freeze({
            status: 'ready', kind: 'existing-edit', sceneId: validated.sceneId,
            buildingId: plan.buildingId, rootTileId: validated.rootTileId,
            generationId: plan.generationId, fillTileId: validated.fillId,
            sillsTileId: validated.sillsId,
            wallIds: Object.freeze(clone(validated.wallIds))
          });
        };

        let applied = exactAppliedState(scene, validated);
        if (applied) return await completeExistingHandoff(applied);

        try { requireRegionPreconditions(scene, validated); }
        catch (error) { fillSuppression?.release?.(); sillsSuppression?.release?.(); throw error; }
        const currentRoot = collectionGet(scene.tiles, validated.rootTileId);
        const currentWalls = validated.baselineWallIds.map((id) => collectionGet(scene.walls, id));
        const createdWallCollision = validated.createdWallIds.some((id) => collectionGet(scene.walls, id));
        const currentBaselineFill = validated.baselineFillId
          ? collectionGet(scene.tiles, validated.baselineFillId)
          : null;
        const desiredFillCollision = validated.createdFillId
          ? collectionGet(scene.tiles, validated.createdFillId)
          : null;
        const currentBaselineSills = validated.baselineSillsId
          ? collectionGet(scene.tiles, validated.baselineSillsId)
          : null;
        const desiredSillsCollision = validated.createdSillsId
          ? collectionGet(scene.tiles, validated.createdSillsId)
          : null;
        const currentOwnedFills = managedFillsForRoot(scene, validated);
        const exactBaselineFillSet = validated.baselineFillId
          ? currentOwnedFills.length === 1
            && String(currentOwnedFills[0]?.id || currentOwnedFills[0]?._id || '') === validated.baselineFillId
          : currentOwnedFills.length === 0;
        const currentOwnedSills = managedSillsForRoot(scene, validated);
        const exactBaselineSillsSet = validated.baselineSillsId
          ? currentOwnedSills.length === 1
            && String(currentOwnedSills[0]?.id || currentOwnedSills[0]?._id || '') === validated.baselineSillsId
          : currentOwnedSills.length === 0;
        const currentRegistry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
          ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
          ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
        if (!currentRoot || currentWalls.some((wall) => !wall) || createdWallCollision
          || desiredFillCollision || desiredSillsCollision || !exactBaselineFillSet || !exactBaselineSillsSet
          || (validated.baselineFillId && !currentBaselineFill)
          || (validated.baselineSillsId && !currentBaselineSills)
          || !sameValue(documentSource(currentRoot), plan.preconditions?.root)
          || !wallSourcesMatch(currentWalls.map((wall) => documentSource(wall)), plan.preconditions?.walls || [])
          || !sameValue(currentBaselineFill ? documentSource(currentBaselineFill) : null, validated.baselineFill)
          || !sameValue(currentBaselineSills ? documentSource(currentBaselineSills) : null, validated.baselineSills)
          || !sameValue(currentRegistry, normalizeRegistry(plan.preconditions?.compositionRegistry))) {
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          throw commitError('Building V2 existing Edit baseline changed after open.', {
            code: 'stale-existing-building', phase: 'preconditions'
          });
        }
        const currentShadow = await capture({ scene, elevation: Number(plan.root.elevation) });
        if (!sameValue(currentShadow.shadowTiles, (plan.preconditions?.shadowTiles || []).slice().sort((a, b) => a.id.localeCompare(b.id)))) {
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          throw commitError('Building V2 existing Edit shadow elevation changed after open.', {
            code: 'stale-shadow-elevation', phase: 'preconditions'
          });
        }
        if (!hasExactSiblingTileSortPreconditions(scene, validated)) {
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          throw commitError('Building V2 existing Edit sibling Tile order changed after placement.', {
            code: 'stale-sibling-order', phase: 'preconditions'
          });
        }
        const rootPlaceable = currentRoot.object
          || canvas?.tiles?.placeables?.find?.((entry) => entry?.document?.id === validated.rootTileId)
          || null;
        if (!rootPlaceable) {
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          throw commitError('Building V2 existing Edit requires the live Root Tile placeable.', { phase: 'preconditions' });
        }
        rootPlaceable.visible = false;
        if (currentBaselineFill?.object) currentBaselineFill.object.visible = false;
        if (currentBaselineSills?.object) currentBaselineSills.object.visible = false;
        const shadowUpdates = (plan.shadowTileUpdates || []).filter((update) => String(update?._id || '') !== validated.rootTileId);
        const wallSourcesById = new Map(plan.walls.map((wall) => [String(wall._id), wall]));
        const tileUpdates = [
          buildExactExistingRootUpdate(plan.root, plan.preconditions.root),
          ...clone(shadowUpdates),
          ...clone(validated.siblingTileUpdates)
        ];
        if (validated.updatedFillId) {
          tileUpdates.push(buildExactManagedFillUpdate(plan.fill, validated.baselineFill));
        }
        if (validated.updatedSillsId) {
          tileUpdates.push(buildExactManagedSillsUpdate(plan.sills, validated.baselineSills));
        }
        const operations = [
          {
            action: 'update', documentName: 'Tile', parent: scene,
            updates: tileUpdates, diff: false,
            faNexusBuildingEditorDocumentWrite: true
          },
        ];
        if (validated.createdFillId) operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: [clone(plan.fill)], keepId: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.deletedFillId) operations.push({
          action: 'delete', documentName: 'Tile', parent: scene,
          ids: [validated.deletedFillId], faNexusPreserveLinkedTileCleanup: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.createdSillsId) operations.push({
          action: 'create', documentName: 'Tile', parent: scene,
          data: [clone(plan.sills)], keepId: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.deletedSillsId) operations.push({
          action: 'delete', documentName: 'Tile', parent: scene,
          ids: [validated.deletedSillsId], faNexusPreserveLinkedTileCleanup: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.updatedWallIds.length) operations.push({
            action: 'update', documentName: 'Wall', parent: scene,
            updates: validated.updatedWallIds.map(id => buildWallUpdate(wallSourcesById.get(id), collectionGet(scene.walls, id), plan.portalStateIntents)), diff: false,
            faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.createdWallIds.length) operations.push({
          action: 'create', documentName: 'Wall', parent: scene,
          data: clone(validated.createdWallIds.map((id) => wallSourcesById.get(id))), keepId: true,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (validated.deletedWallIds.length) operations.push({
          action: 'delete', documentName: 'Wall', parent: scene,
          ids: clone(validated.deletedWallIds),
          faNexusBuildingEditorDocumentWrite: true
        });
        if (!sameValue(normalizeRegistry(plan.compositionRegistry), normalizeRegistry(plan.preconditions?.compositionRegistry))) {
          operations.push({
            action: 'update', documentName: 'Scene',
            updates: [buildSceneRegistryUpdate(scene, plan)],
            faNexusBuildingEditorDocumentWrite: true
          });
        }
        let writeError = null;
        try { await executeWithPortalDeletionCapture(foundry, [...operations, ...buildRegionOperations(scene, validated), ...migrationTileOperations(scene, validated)], scene, validated); }
        catch (error) { writeError = error; }
        applied = !writeError ? exactAppliedState(scene, validated) : null;
        if (writeError || !applied) {
          const auditMismatch = !writeError ? describeAppliedStateMismatch(scene, validated) : [];
          const baselineWallsById = new Map((plan.preconditions.walls || []).map((wall) => [String(wall._id), wall]));
          const baselineWallsToUpdate = validated.baselineWallIds
            .filter((id) => collectionGet(scene.walls, id)).map((id) => baselineWallsById.get(id));
          const baselineWallsToCreate = validated.baselineWallIds
            .filter((id) => !collectionGet(scene.walls, id))
            .map(id => portalRecreationSource(baselineWallsById.get(id), validated)).filter(Boolean);
          const createdWallsToDelete = validated.createdWallIds.filter((id) => collectionGet(scene.walls, id));
          const liveBaselineFill = validated.baselineFillId
            ? collectionGet(scene.tiles, validated.baselineFillId)
            : null;
          const liveCreatedFill = validated.createdFillId
            ? collectionGet(scene.tiles, validated.createdFillId)
            : null;
          const liveBaselineSills = validated.baselineSillsId
            ? collectionGet(scene.tiles, validated.baselineSillsId)
            : null;
          const liveCreatedSills = validated.createdSillsId
            ? collectionGet(scene.tiles, validated.createdSillsId)
            : null;
          const rollbackOperations = [
            {
              action: 'update', documentName: 'Tile', parent: scene,
              updates: [buildExactExistingRootUpdate(plan.preconditions.root, documentSource(collectionGet(scene.tiles, validated.rootTileId))), ...buildRollbackShadowUpdates(
                (plan.preconditions.shadowTiles || []).filter((entry) => entry.id !== validated.rootTileId
                  && collectionGet(scene.tiles, entry.id))
              ), ...clone(validated.siblingTilePreconditions)], diff: false,
              faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
            },
          ];
          if (validated.baselineFillId && liveBaselineFill) rollbackOperations.push({
            action: 'update', documentName: 'Tile', parent: scene,
            updates: [buildExactManagedFillUpdate(validated.baselineFill, documentSource(liveBaselineFill))], diff: false,
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (validated.baselineFillId && !liveBaselineFill) rollbackOperations.push({
            action: 'create', documentName: 'Tile', parent: scene,
            data: [clone(validated.baselineFill)], keepId: true,
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (liveCreatedFill && generatedOwner(liveCreatedFill)?.generationId === plan.generationId) {
            rollbackOperations.push({
              action: 'delete', documentName: 'Tile', parent: scene,
              ids: [validated.createdFillId], faNexusPreserveLinkedTileCleanup: true,
              faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
            });
          }
          if (validated.baselineSillsId && liveBaselineSills) rollbackOperations.push({
            action: 'update', documentName: 'Tile', parent: scene,
            updates: [buildExactManagedSillsUpdate(validated.baselineSills, documentSource(liveBaselineSills))], diff: false,
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (validated.baselineSillsId && !liveBaselineSills) rollbackOperations.push({
            action: 'create', documentName: 'Tile', parent: scene,
            data: [clone(validated.baselineSills)], keepId: true,
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (liveCreatedSills && generatedOwner(liveCreatedSills)?.generationId === plan.generationId) {
            rollbackOperations.push({
              action: 'delete', documentName: 'Tile', parent: scene,
              ids: [validated.createdSillsId], faNexusPreserveLinkedTileCleanup: true,
              faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
            });
          }
          if (baselineWallsToUpdate.length) rollbackOperations.push({
              action: 'update', documentName: 'Wall', parent: scene,
              updates: baselineWallsToUpdate.map(wall => buildWallUpdate(wall, collectionGet(scene.walls, wall._id), compensatingPortalIntents(validated, scene))), diff: false,
              faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (baselineWallsToCreate.length) rollbackOperations.push({
            action: 'create', documentName: 'Wall', parent: scene,
            data: clone(baselineWallsToCreate), keepId: true,
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (createdWallsToDelete.length) rollbackOperations.push({
            action: 'delete', documentName: 'Wall', parent: scene,
            ids: clone(createdWallsToDelete),
            faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
          });
          if (!sameValue(normalizeRegistry(plan.compositionRegistry), normalizeRegistry(plan.preconditions?.compositionRegistry))) {
            rollbackOperations.push({
              action: 'update', documentName: 'Scene',
              updates: [buildSceneRegistryUpdate(scene, plan, true)],
              faNexusBuildingEditorDocumentWrite: true, faNexusBuildingV2CommitRollback: true
            });
          }
          let rollbackError = null;
          try { await executeAtomicDocumentBatch(foundry, [...rollbackOperations, ...buildRegionOperations(scene, validated, true), ...migrationTileOperations(scene, validated, true)]); }
          catch (error) { rollbackError = error; }
          const restoredRoot = collectionGet(scene.tiles, validated.rootTileId);
          const restoredWalls = validated.baselineWallIds.map((id) => collectionGet(scene.walls, id));
          const restoredFill = validated.baselineFillId
            ? collectionGet(scene.tiles, validated.baselineFillId)
            : null;
          const restoredSills = validated.baselineSillsId
            ? collectionGet(scene.tiles, validated.baselineSillsId)
            : null;
          const restoredRegistry = normalizeRegistry(scene?.getFlag?.(MODULE_ID, COMPOSITION_REGISTRY_FLAG)
            ?? scene?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]
            ?? scene?._source?.flags?.[MODULE_ID]?.[COMPOSITION_REGISTRY_FLAG]);
          const residue = (!migrationTilesMatch(scene, validated, true)
            || !regionStateMatches(scene, validated, true) || !restoredRoot || restoredWalls.some((wall) => !wall)
            || !sameValue(documentSource(restoredRoot), plan.preconditions.root)
            || !wallSourcesMatch(restoredWalls.map((wall) => documentSource(wall)), plan.preconditions.walls || [])
            || !sameValue(restoredFill ? documentSource(restoredFill) : null, validated.baselineFill)
            || !sameValue(restoredSills ? documentSource(restoredSills) : null, validated.baselineSills)
            || (validated.createdFillId && collectionGet(scene.tiles, validated.createdFillId))
            || (validated.createdSillsId && collectionGet(scene.tiles, validated.createdSillsId))
            || validated.createdWallIds.some((id) => collectionGet(scene.walls, id))
            || !sameValue(restoredRegistry, normalizeRegistry(plan.preconditions?.compositionRegistry)))
            ? ['existing-building-baseline'] : [];
          for (const entry of validated.siblingTilePreconditions) {
            const document = collectionGet(scene.tiles, entry._id);
            if (!document || Number(document?.sort ?? document?._source?.sort) !== entry.sort) {
              residue.push(`Tile.${entry._id}.sort`);
            }
          }
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          throw commitError(
            rollbackError || residue.length
              ? `Building V2 existing Edit failed and rollback left durable residue.${auditMismatch.length
                ? ` Post-write audit mismatches: ${auditMismatch.join(', ')}.`
                : ''}`
              : `Building V2 existing Edit failed and was rolled back completely.${auditMismatch.length
                ? ` Post-write audit mismatches: ${auditMismatch.join(', ')}.`
                : ''}`,
            {
              code: rollbackError || residue.length ? 'commit-rollback-incomplete' : 'commit-rolled-back',
              phase: writeError ? 'write' : 'post-write-audit',
              rollback: rollbackError || residue.length ? 'incomplete' : 'complete',
              residue, cause: writeError || rollbackError
            }
          );
        }
        return await completeExistingHandoff(applied);
      }

      const shadowManager = await getShadowManager();
      if (typeof shadowManager?.beginTransformPreviewSuppression !== 'function') {
        throw commitError('Building V2 Commit requires canonical Asset Shadow handoff suppression.', {
          phase: 'preconditions'
        });
      }
      let shadowSuppression;
      try {
        shadowSuppression = shadowManager.beginTransformPreviewSuppression({
          documents: [{ id: validated.rootTileId, documentName: 'Tile' }],
          source: 'building-v2-first-commit'
        });
      } catch (error) {
        throw commitError('Building V2 Commit could not begin canonical Asset Shadow handoff suppression.', {
          phase: 'preconditions', cause: error
        });
      }
      const rootSuppression = beginLocalRootSuppression(validated.rootTileId);
      const fillSuppression = validated.fillId ? beginLocalRootSuppression(validated.fillId) : null;
      const sillsSuppression = validated.sillsId ? beginLocalRootSuppression(validated.sillsId) : null;
      let applied = exactAppliedState(scene, validated);
      if (applied) {
        rootSuppression.apply(applied.root);
        fillSuppression?.apply?.(applied.fill);
        sillsSuppression?.apply?.(applied.sills);
      }
      if (!applied) {
        try {
          await assertPreconditions(scene, validated);
        } catch (error) {
          rootSuppression.release();
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          shadowSuppression.cancel?.();
          throw error;
        }
        const operations = [
          {
            action: 'create', documentName: 'Tile', parent: scene,
            data: clone([plan.root, ...(plan.fill ? [plan.fill] : []), ...(plan.sills ? [plan.sills] : [])]), keepId: true
          },
          { action: 'create', documentName: 'Wall', parent: scene, data: clone(plan.walls), keepId: true }
        ];
        if (validated.siblingTileUpdates.length) operations.push({
          action: 'update', documentName: 'Tile', parent: scene,
          updates: clone(validated.siblingTileUpdates), diff: false,
          faNexusBuildingEditorDocumentWrite: true
        });
        if (plan.shadowTileUpdates.length) operations.push({
          action: 'update', documentName: 'Tile', parent: scene, updates: clone(plan.shadowTileUpdates), diff: false
        });
        operations.push({
          action: 'update',
          documentName: 'Scene',
          updates: [buildSceneRegistryUpdate(scene, plan)]
        });
        let writeError = null;
        try {
          await executeAtomicDocumentBatch(foundry, [...operations, ...buildRegionOperations(scene, validated)]);
        } catch (error) {
          writeError = error;
        }
        applied = exactAppliedState(scene, validated);
        if (writeError || !applied) {
          const auditMismatch = !writeError && !applied
            ? describeAppliedStateMismatch(scene, validated).slice(0, 12)
            : [];
          let residue = [];
          let rollbackError = null;
          try { residue = await rollback(scene, validated); }
          catch (error) { rollbackError = error; }
          rootSuppression.release();
          fillSuppression?.release?.();
          sillsSuppression?.release?.();
          shadowSuppression.cancel?.();
          throw commitError(
            rollbackError || residue.length
              ? `Building V2 Commit failed and rollback left durable residue.${auditMismatch.length
                ? ` Post-write audit mismatches: ${auditMismatch.join(', ')}.` : ''}`
              : `Building V2 Commit failed and was rolled back completely.${auditMismatch.length
                ? ` Post-write audit mismatches: ${auditMismatch.join(', ')}.`
                : ''}`,
            {
              code: rollbackError || residue.length ? 'commit-rollback-incomplete' : 'commit-rolled-back',
              phase: writeError ? 'write' : 'post-write-audit',
              rollback: rollbackError || residue.length ? 'incomplete' : 'complete',
              residue,
              cause: writeError || rollbackError
            }
          );
        }
      }

      let prepared = null;
      try {
        prepared = await prepareHandoff(scene, applied, validated, {
          rootSuppression, fillSuppression, sillsSuppression, shadowSuppression
        });
        await swapLocalProjection({
          root: applied.root,
          walls: applied.walls,
          fill: applied.fill,
          sills: applied.sills,
          activateCommitted: () => prepared.activate()
        });
      } catch (error) {
        rootSuppression.release();
        fillSuppression?.release?.();
        sillsSuppression?.release?.();
        try { prepared?.recover?.(); } catch (_) {}
        const failure = commitError(`Building V2 Commit is durable, but the local public handoff is not ready: ${String(error?.message || error)}`, {
          code: 'commit-applied-handoff-pending',
          phase: 'handoff',
          cause: error
        });
        failure.commitApplied = true;
        failure.receipt = {
          sceneId: validated.sceneId,
          buildingId: plan.buildingId,
          rootTileId: validated.rootTileId,
          generationId: plan.generationId,
          wallIds: clone(validated.wallIds),
          fillTileId: validated.fillId,
          sillsTileId: validated.sillsId
        };
        throw failure;
      }

      return Object.freeze({
        status: 'ready',
        sceneId: validated.sceneId,
        buildingId: plan.buildingId,
        rootTileId: validated.rootTileId,
        generationId: plan.generationId,
        fillTileId: validated.fillId,
        sillsTileId: validated.sillsId,
        wallIds: Object.freeze(clone(validated.wallIds))
      });
    }
  });
}
