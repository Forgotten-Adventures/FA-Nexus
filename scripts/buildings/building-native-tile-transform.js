import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { captureNativeTileTransformHistoryContext, installNativeTileTransformHistory } from '../canvas/native-tile-transform-history.js';
import { waitForStableNativePreview } from './building-native-preview-readiness.js';
import {
  resizeSemanticTileFlags,
  transformSemanticTileFlags,
  translateSemanticTileFlags
} from '../composition/scene-group-tile-transform.js';
import {
  buildSceneGroupMemberTransformTarget,
  readSceneGroupMemberTransformState
} from '../composition/scene-group-workflow.js';
import {
  NATIVE_TILE_TRANSFORM_BUSY,
  hasPendingNativeTileTransformTransaction,
  rejectNativeTileTransformReservation,
  releaseNativeTileTransformReservation,
  reserveNativeTileTransformTransaction,
  trackNativeTileTransformTransaction
} from '../canvas/native-tile-transform-transactions.js';
import {
  readNativeTileGestureRoute,
  rememberNativeTileGestureRoute
} from '../canvas/native-tile-gesture-route.js';
import { beginLocalWallPerceptionPreview } from '../canvas/local-wall-perception-preview.js';
import {
  adjustHandleDragForGrid,
  registerGridReferenceSource,
  snapBodyDragByGridReference,
  turnRotationOnlyChangeAboutGridPivot,
  wallEndPoints
} from '../canvas/grid-reference-snap.js';
import { doorTransformPreviewRuntime } from '../portals/door-transform-preview-runtime.js';
import {
  buildBuildingV2GeneratedTransformTargets,
  collectBuildingV2SceneTransformDependents
} from './v2/building-v2-transform-aggregate.js';
import {
  isBuildingManagedFillDocument,
  isBuildingManagedFillPresentationUpdate,
  isBuildingManagedSillsDocument,
  isBuildingManagedSillsPresentationUpdate,
  normalizeBuildingManagedFillTileConfigPresentationUpdate
} from './building-generated-document-runtime.js';

const MODULE_ID = 'fa-nexus';
const POSE_FIELDS = ['x', 'y', 'width', 'height', 'rotation'];
const BUILDING_FLAG_KEYS = [
  'building',
  'buildingFill',
  'buildingComposite',
  'buildingSills',
  'buildingDoorFrame',
  'buildingWindowFrame',
  'buildingWindowWindow',
  'buildingWindowSill'
];
const PENDING_LINKED_TRANSFORMS = new Map();
const PENDING_NATIVE_PREVIEW_COMMITS = new WeakMap();
const BUILDING_NATIVE_PREVIEW_STATES = new WeakMap();
const BUILDING_NATIVE_PREVIEW_PATCH = Symbol.for('fa-nexus.building-native-preview');
const BUILDING_NATIVE_BODY_PREVIEW_PATCH = Symbol.for('fa-nexus.building-native-body-preview');

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function sameTransformState(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && left.length !== right.length) return false;
  const keys = Object.keys(left);
  // Foundry reorders schema/flag object fields while saving. Compare their
  // contents, retaining exact values, field presence and array index order.
  return keys.length === Object.keys(right).length
    && keys.every(key => hasOwn(right, key) && sameTransformState(left[key], right[key]));
}

function readChange(changes, path, fallback) {
  if (hasOwn(changes, path)) return changes[path];
  const value = String(path).split('.').reduce((entry, key) => entry?.[key], changes);
  return value === undefined ? fallback : value;
}

function tileSnapshot(document) {
  const source = document?._source || document || {};
  return {
    x: finite(source.x ?? document?.x),
    y: finite(source.y ?? document?.y),
    width: finite(source.width ?? document?.width),
    height: finite(source.height ?? document?.height),
    rotation: finite(source.rotation ?? document?.rotation) ?? 0,
    anchorX: finite(source.texture?.anchorX ?? document?.texture?.anchorX) ?? 0.5,
    anchorY: finite(source.texture?.anchorY ?? document?.texture?.anchorY) ?? 0.5
  };
}

function finalTileSnapshot(original, changes) {
  return {
    x: finite(readChange(changes, 'x', original.x)),
    y: finite(readChange(changes, 'y', original.y)),
    width: finite(readChange(changes, 'width', original.width)),
    height: finite(readChange(changes, 'height', original.height)),
    rotation: finite(readChange(changes, 'rotation', original.rotation)) ?? 0,
    anchorX: finite(readChange(changes, 'texture.anchorX', original.anchorX)) ?? 0.5,
    anchorY: finite(readChange(changes, 'texture.anchorY', original.anchorY)) ?? 0.5
  };
}

function validateTileGeometry(tile, label) {
  if (POSE_FIELDS.slice(0, 4).some((field) => finite(tile?.[field]) == null)) {
    throw new Error(`Native Building transform requires finite ${label} Tile geometry.`);
  }
  if (!(tile.width > 0) || !(tile.height > 0)) {
    throw new Error(`Native Building transform requires positive ${label} Tile dimensions.`);
  }
}

function changedPose(original, final) {
  return POSE_FIELDS.some((field) => Number(original[field]) !== Number(final[field]))
    || Number(original.anchorX) !== Number(final.anchorX)
    || Number(original.anchorY) !== Number(final.anchorY);
}

function readBuildingFlags(document) {
  const source = document?._source?.flags?.[MODULE_ID] || document?.flags?.[MODULE_ID] || null;
  if (!source || typeof source !== 'object') return null;
  return BUILDING_FLAG_KEYS.some((key) => source[key]) ? structuredClone(source) : null;
}

function readFaNexusFlag(document, key) {
  const direct = document?.getFlag?.(MODULE_ID, key);
  if (direct !== undefined) return direct;
  return document?._source?.flags?.[MODULE_ID]?.[key]
    ?? document?.flags?.[MODULE_ID]?.[key]
    ?? null;
}

function stringSet(values = []) {
  return new Set(values.flat(Infinity).map((value) => String(value || '').trim()).filter(Boolean));
}

function documentSource(document) {
  return typeof document?.toObject === 'function'
    // Prepared Region elevations use infinities for unbounded limits, while
    // updateSource requires their persisted null representation on restoration.
    ? document.toObject()
    : structuredClone(document?._source || document);
}

export function collectBuildingLinkedDocuments(document) {
  const scene = document?.parent;
  if (!scene) return [];
  const building = readFaNexusFlag(document, 'building') || {};
  if ([4, 5].includes(Number(building.schemaVersion))) {
    return collectBuildingV2SceneTransformDependents(document, building);
  }
  const meta = building.meta || {};
  const fill = readFaNexusFlag(document, 'buildingFill') || {};
  const composite = readFaNexusFlag(document, 'buildingComposite') || {};
  const typed = [
    readFaNexusFlag(document, 'buildingDoorFrame'),
    readFaNexusFlag(document, 'buildingWindowFrame'),
    readFaNexusFlag(document, 'buildingWindowWindow'),
    readFaNexusFlag(document, 'buildingWindowSill')
  ].filter(Boolean);
  const wallGroupIds = stringSet([
    meta.wallGroupId,
    meta.wallGroupIds,
    meta.outerWallGroupIds,
    meta.innerWallGroupIds,
    composite.wallGroupId,
    composite.wallGroupIds,
    composite.outerWallGroupIds,
    composite.innerWallGroupIds,
    typed.map((entry) => [entry?.wallGroupId, entry?.wallGroupIds, entry?.groupId])
  ]);
  const tileIds = stringSet([
    fill.wallTileId,
    fill.backgroundTileId,
    fill.sillTileId,
    meta.fillTileId,
    meta.sillsTileId,
    meta.backgroundTileId,
    composite.backgroundTileId,
    composite.sillTileId,
    (composite.parts || []).flatMap((part) => [part?.tileId, part?.id]),
    typed.map((entry) => [
      entry?.wallTileId,
      entry?.backgroundTileId,
      entry?.sillTileId,
      entry?.tileId
    ])
  ]);
  const wallIds = stringSet([meta.wallIds]);
  const regionIds = stringSet([meta.regionIds]);
  for (const ownerTileId of [...tileIds]) {
    const ownerTile = scene.tiles?.get?.(ownerTileId)
      || Array.from(scene.tiles || []).find((tile) => String(tile?.id || '') === ownerTileId)
      || null;
    const ownerMeta = readFaNexusFlag(ownerTile, 'building')?.meta || null;
    if (!ownerMeta) continue;
    for (const groupId of stringSet([
      ownerMeta.wallGroupId,
      ownerMeta.wallGroupIds,
      ownerMeta.outerWallGroupIds,
      ownerMeta.innerWallGroupIds
    ])) wallGroupIds.add(groupId);
    for (const wallId of stringSet([ownerMeta.wallIds])) wallIds.add(wallId);
    for (const regionId of stringSet([ownerMeta.regionIds])) regionIds.add(regionId);
    for (const linkedTileId of stringSet([
      ownerMeta.fillTileId,
      ownerMeta.sillsTileId,
      ownerMeta.backgroundTileId,
      ownerMeta.sillTileId
    ])) tileIds.add(linkedTileId);
  }
  const foregroundId = String(document?.id || '');
  const linked = [];

  for (const tile of Array.from(scene.tiles || [])) {
    if (!tile?.id || String(tile.id) === foregroundId) continue;
    const tileComposite = readFaNexusFlag(tile, 'buildingComposite') || {};
    const tileFill = readFaNexusFlag(tile, 'buildingFill') || {};
    const tileSills = readFaNexusFlag(tile, 'buildingSills') || {};
    const typed = [
      readFaNexusFlag(tile, 'buildingDoorFrame'),
      readFaNexusFlag(tile, 'buildingWindowFrame'),
      readFaNexusFlag(tile, 'buildingWindowWindow'),
      readFaNexusFlag(tile, 'buildingWindowSill')
    ].filter(Boolean);
    const tileBuildingMeta = readFaNexusFlag(tile, 'building')?.meta || {};
    const candidateGroups = stringSet([
      tileComposite.wallGroupId,
      tileComposite.wallGroupIds,
      typed.map((entry) => [entry?.wallGroupId, entry?.groupId]),
      tileBuildingMeta.parentWallGroupId,
      tileBuildingMeta.wallGroupId,
      tileBuildingMeta.wallGroupIds,
      tileBuildingMeta.outerWallGroupIds,
      tileBuildingMeta.innerWallGroupIds
    ]);
    if (
      tileIds.has(String(tile.id))
      || [tileFill.wallTileId, tileFill.backgroundTileId, tileFill.sillTileId, tileSills.wallTileId]
        .some((tileId) => String(tileId || '') === foregroundId)
      || [...candidateGroups].some((groupId) => wallGroupIds.has(groupId))
    ) linked.push(tile);
  }

  for (const wall of Array.from(scene.walls || [])) {
    const flag = readFaNexusFlag(wall, 'buildingWall');
    if (!flag || !wall?.id) continue;
    if (
      wallIds.has(String(wall.id))
      || String(flag.tileId || '') === foregroundId
      || wallGroupIds.has(String(flag.groupId || ''))
    ) linked.push(wall);
  }

  for (const region of Array.from(scene.regions || [])) {
    const flag = readFaNexusFlag(region, 'buildingRegion');
    if (!flag || !region?.id) continue;
    if (
      regionIds.has(String(region.id))
      || String(flag.wallTileId || '') === foregroundId
      || wallGroupIds.has(String(flag.wallGroupId || ''))
    ) linked.push(region);
  }
  return linked;
}

function linkedTransformOperations(result, axisAngle = result.originalTile.rotation) {
  const operations = [];
  if (result.scaleX !== 1 || result.scaleY !== 1) {
    operations.push({
      ...(Math.abs(result.scaleX - result.scaleY) <= 1e-9
        ? { operation: 'scale', factor: result.scaleFactor }
        : {
            operation: 'scale-axes',
            scaleX: result.scaleX,
            scaleY: result.scaleY,
            axisAngle
          }),
      pivot: { x: result.originalTile.x, y: result.originalTile.y }
    });
  }
  if (result.rotationDelta) {
    operations.push({
      operation: 'rotate',
      angle: result.rotationDelta,
      pivot: { x: result.originalTile.x, y: result.originalTile.y }
    });
  }
  if (result.delta.x || result.delta.y) {
    operations.push({ operation: 'move', delta: result.delta, pivot: null });
  }
  return operations;
}

function buildBuildingLinkedTransformTarget(document, original, pivot, operation) {
  const target = buildSceneGroupMemberTransformTarget(document, original, pivot, operation);
  const documentName = String(document?.documentName || document?.constructor?.documentName || '');
  if (documentName !== 'Tile' || operation.operation !== 'scale-axes') return target;
  const axis = Number(operation.axisAngle || 0) * (Math.PI / 180);
  const rotation = Number(original.rotation || 0) * (Math.PI / 180);
  const cosine = Math.cos(axis);
  const sine = Math.sin(axis);
  const applyLinear = (x, y) => {
    const localX = (x * cosine) + (y * sine);
    const localY = (-x * sine) + (y * cosine);
    return {
      x: (localX * operation.scaleX * cosine) - (localY * operation.scaleY * sine),
      y: (localX * operation.scaleX * sine) + (localY * operation.scaleY * cosine)
    };
  };
  const widthBasis = applyLinear(Math.cos(rotation), Math.sin(rotation));
  const heightBasis = applyLinear(-Math.sin(rotation), Math.cos(rotation));
  const widthFactor = Math.hypot(widthBasis.x, widthBasis.y);
  const heightFactor = Math.hypot(heightBasis.x, heightBasis.y);
  if (![widthFactor, heightFactor].every(Number.isFinite)
    || widthFactor <= 0
    || heightFactor <= 0) {
    throw new Error(
      `Native Building per-axis resize produced invalid linked Tile geometry for ${String(document?.id || '')}.`
    );
  }
  // A non-uniform transform can shear a differently rotated rectangle, while a
  // Foundry Tile can only persist an orthogonal width/height/rotation pose. Keep
  // the transformed width basis as the Tile orientation and preserve both basis
  // magnitudes. Semantic geometry is then refit to this representable Tile pose.
  target.width = Math.max(1, Math.round(Number(original.width) * widthFactor));
  target.height = Math.max(1, Math.round(Number(original.height) * heightFactor));
  target.rotation = ((Math.atan2(widthBasis.y, widthBasis.x) * (180 / Math.PI)) % 360 + 360) % 360;
  if (original['flags.fa-nexus']) {
    const anchorX = Number(document?.texture?.anchorX ?? 0.5);
    const anchorY = Number(document?.texture?.anchorY ?? 0.5);
    target['flags.fa-nexus'] = resizeSemanticTileFlags({
      flags: original['flags.fa-nexus'],
      originalTile: {
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        rotation: original.rotation,
        anchorX,
        anchorY
      },
      finalTile: {
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
        rotation: target.rotation,
        anchorX,
        anchorY
      }
    });
  }
  return target;
}

function buildBuildingTransformTarget(document, operations) {
  if (!operations.length) return null;
  let target = readSceneGroupMemberTransformState(
    document,
    operations[0].operation === 'scale-axes' ? 'scale' : operations[0].operation
  );
  for (const operation of operations) {
    target = buildBuildingLinkedTransformTarget(document, target, operation.pivot, operation);
  }
  return target;
}

function managedBuildingArtworkOwner(document) {
  const role = isBuildingManagedFillDocument(document)
    ? 'Fill'
    : (isBuildingManagedSillsDocument(document) ? 'Sills' : null);
  if (!role) return null;
  const owner = readFaNexusFlag(document, 'buildingGenerated');
  const ownerId = String(owner?.rootTileId || '').trim();
  return ownerId ? { ownerId, role } : null;
}

function resolveManagedBuildingArtworkRoot(document, layer) {
  const owner = managedBuildingArtworkOwner(document);
  if (!owner) return null;
  const rootDocument = document?.parent?.tiles?.get?.(owner.ownerId) || null;
  if (![4, 5].includes(Number(readFaNexusFlag(rootDocument, 'building')?.schemaVersion))) return null;
  const placeable = rootDocument?.object || layer?.get?.(owner.ownerId) || null;
  if (!placeable || (layer && placeable.layer !== layer)) return null;
  return { document: rootDocument, placeable, controls: placeable.controls || null, role: owner.role };
}

function rememberManagedBuildingArtworkGestureRoute(document, event, layer) {
  const route = resolveManagedBuildingArtworkRoot(document, layer);
  return rememberNativeTileGestureRoute(event, route);
}

function readBuildingNativeGestureControls(controls, event) {
  return readNativeTileGestureRoute(event)?.controls || controls;
}

function transferManagedBuildingArtworkControl(artwork, route) {
  if (!artwork || !route?.placeable) return false;
  if (artwork.controlled) artwork.release?.();
  if (!route.placeable.controlled) route.placeable.control?.({ releaseOthers: false });
  return route.placeable.controlled === true;
}

function hideBuildingV2NativeScaleHandle(controls) {
  const document = controls?.object?.document || controls?.document || null;
  const managedArtwork = !!managedBuildingArtworkOwner(document);
  const v2Root = [4, 5].includes(Number(readFaNexusFlag(document, 'building')?.schemaVersion));
  if (!managedArtwork && !v2Root) return false;
  const scale = Array.from(controls?.handles?.children || [])
    .find((handle) => String(handle?.name || '') === 'scale');
  if (!scale) return false;
  scale.visible = false;
  scale.eventMode = 'none';
  return true;
}

function releaseManagedArtworkControlsForRoot(rootDocument, layer) {
  const rootId = String(rootDocument?.id || '').trim();
  if (!rootId || ![4, 5].includes(Number(readFaNexusFlag(rootDocument, 'building')?.schemaVersion))) return 0;
  let released = 0;
  for (const placeable of Array.from(layer?.controlled || [])) {
    const document = placeable?.document || null;
    if (document === rootDocument || managedBuildingArtworkOwner(document)?.ownerId !== rootId) continue;
    placeable.release?.();
    released += 1;
  }
  return released;
}

/**
 * V2 generated Fill targets include texture anchors because they are part of
 * the Root spatial pose.  The generic rotate reader intentionally omits Tile
 * anchors, so add only the anchor fields which the exact target requires
 * before comparing the committed document.  This keeps the audit exact
 * without changing the Scene Group transform contract for other callers.
 */
function readBuildingV2ExactTransformState(document, expectedTarget) {
  const state = readSceneGroupMemberTransformState(document, 'rotate');
  for (const field of ['texture.anchorX', 'texture.anchorY']) {
    if (!hasOwn(expectedTarget, field)) continue;
    const anchor = Number(document?.texture?.[field.split('.').at(-1)]
      ?? document?._source?.texture?.[field.split('.').at(-1)]
      ?? 0.5);
    if (!Number.isFinite(anchor)) {
      throw new Error(`Building Editor V2 exact transform found an invalid ${field} on ${document?.uuid || document?.id || 'unknown document'}.`);
    }
    state[field] = anchor;
  }
  for (const field of Object.keys(expectedTarget)) {
    if (field in state || field === '_id') continue;
    const value = field.split('.').reduce((entry, key) => entry?.[key], document?._source || document);
    state[field] = value === undefined ? value : structuredClone(value);
  }
  return state;
}

function applyBuildingTransformTargetToChanges(changes, target) {
  if (!target) return;
  for (const field of POSE_FIELDS) {
    if (target[field] != null) changes[field] = target[field];
  }
  if (target['flags.fa-nexus']) {
    if (hasOwn(changes, `flags.${MODULE_ID}`)) {
      changes[`flags.${MODULE_ID}`] = structuredClone(target['flags.fa-nexus']);
    } else {
      changes.flags ||= {};
      changes.flags[MODULE_ID] = structuredClone(target['flags.fa-nexus']);
    }
  }
}

export function buildBuildingLinkedTransformPlan(document, result) {
  const documents = collectBuildingLinkedDocuments(document);
  if (!document.parent) return null;
  const building = readFaNexusFlag(document, 'building') || null;
  const isBuildingV2 = [4, 5].includes(Number(building?.schemaVersion));
  const authoritativeTile = [document, ...documents].find((entry) => (
    String(entry?.documentName || entry?.constructor?.documentName || '') === 'Tile'
      && !!entry?.getFlag?.(MODULE_ID, 'building')
  ));
  const authoritativeRotation = Number(authoritativeTile?.rotation);
  const operations = linkedTransformOperations(
    result,
    Number.isFinite(authoritativeRotation) ? authoritativeRotation : result.originalTile.rotation
  );
  for (const operation of operations) {
    for (const linkedDocument of documents) {
      const original = readSceneGroupMemberTransformState(
        linkedDocument,
        operation.operation === 'scale-axes' ? 'scale' : operation.operation
      );
      buildBuildingLinkedTransformTarget(
        linkedDocument,
        original,
        operation.pivot,
        operation
      );
    }
  }
  const generatedTargets = isBuildingV2
    ? buildBuildingV2GeneratedTransformTargets(document, result.finalTile, documents)
    : null;
  return {
    scene: document.parent,
    tileId: String(document.id || ''),
    originalTileSource: documentSource(document),
    documents,
    originals: documents.map((entry) => ({
      documentName: String(entry.documentName || entry.constructor?.documentName || ''),
      source: documentSource(entry)
    })),
    operations,
    generatedTargets,
    selectedTarget: isBuildingV2 ? null : buildBuildingTransformTarget(document, operations)
  };
}

function groupUpdates(plans) {
  const grouped = new Map();
  for (const plan of plans) {
    const updates = grouped.get(plan.documentName) || [];
    updates.push({ _id: plan.id, ...plan.target });
    grouped.set(plan.documentName, updates);
  }
  return grouped;
}

async function rollbackBuildingLinkedTransform(document, plan, cause) {
  const errors = [];
  for (const [documentName, updates] of groupUpdates(plan.originals.map((entry) => ({
    documentName: entry.documentName,
    id: entry.source?._id || entry.source?.id,
    target: entry.source
  })))) {
    try {
      await plan.scene.updateEmbeddedDocuments(documentName, structuredClone(updates), {
        isUndo: true,
        diff: false,
        faNexusSceneGroupCommand: true,
        faNexusBuildingNativeTransform: true
      });
    } catch (error) {
      errors.push(`${documentName}: ${error?.message || error}`);
    }
  }
  try {
    await document.update(structuredClone(plan.originalTileSource), {
      isUndo: true,
      diff: false,
      faNexusSceneGroupCommand: true,
      faNexusBuildingNativeTransform: true
    });
  } catch (error) {
    errors.push(`Tile: ${error?.message || error}`);
  }
  const suffix = errors.length ? ` Rollback errors: ${errors.join('; ')}` : '';
  throw new Error(
    `Native Building transform failed and was rolled back: ${cause?.message || cause}.${suffix}`,
    { cause }
  );
}

function restorePreviewedWallSourcesForAuthoritativeCommit(plan) {
  const handoff = plan?.previewHandoff;
  if (!handoff || handoff.finished) return;
  const plannedWalls = new Set((plan.documents || []).filter((document) => (
    String(document?.documentName || document?.constructor?.documentName || '') === 'Wall'
  )));
  for (const record of handoff.records || []) {
    const document = record?.document;
    if (!plannedWalls.has(document)) continue;
    if (!Array.isArray(record?.source?.c) || record.source.c.length !== 4) {
      throw new Error(`Native Building Wall ${String(document?.id || '')} preview handoff has no exact original coordinates.`);
    }
    // Preview updates the live local WallDocument source while its authoritative
    // Edge remains at the baseline. Restore only c before the real Scene update
    // so Foundry observes a coordinate change and rebuilds local perception.
    // Other staged dependents (especially Fill) stay at the target to preserve
    // the frame-continuous visual handoff.
    document.updateSource({ c: structuredClone(record.source.c) });
  }
}

// The released-format plan below transforms each linked document's CURRENT state, one
// operation at a time. A held preview has staged those local sources at their final target:
// read from the staged copies, every linked Tile and Region is transformed twice while the
// Root and the Walls (restored above) move once. Start from the exact pre-preview sources.
// The placeables keep their staged drawing until the authoritative update refreshes them.
function restorePreviewedLinkedSourcesForReleasedFormatCommit(plan) {
  const handoff = plan?.previewHandoff;
  if (!handoff || handoff.finished) return;
  const planned = new Set(plan.documents || []);
  for (const record of handoff.records || []) {
    if (!planned.has(record?.document)) continue;
    record.document.updateSource(exactPreviewSource(record.source));
  }
}

export async function commitBuildingLinkedTransform(document, plan) {
  try {
    restorePreviewedWallSourcesForAuthoritativeCommit(plan);
    if (plan.generatedTargets instanceof Map) {
      const plans = plan.documents.map((linkedDocument) => {
        const uuid = String(linkedDocument?.uuid || '');
        const exact = plan.generatedTargets.get(uuid);
        if (!exact) throw new Error(`Building Editor V2 transform has no exact target for ${uuid}.`);
        return {
          documentName: String(linkedDocument.documentName || linkedDocument.constructor?.documentName || ''),
          id: String(linkedDocument.id || ''),
          document: linkedDocument,
          target: {
            ...readBuildingV2ExactTransformState(linkedDocument, exact),
            ...structuredClone(exact)
          }
        };
      });
      for (const [documentName, updates] of groupUpdates(plans)) {
        await plan.scene.updateEmbeddedDocuments(documentName, structuredClone(updates), {
          isUndo: true,
          diff: false,
          faNexusSceneGroupCommand: true,
          faNexusBuildingNativeTransform: true,
          faNexusSceneGroupTransform: 'pose'
        });
      }
      for (const entry of plans) {
        const actual = readBuildingV2ExactTransformState(entry.document, entry.target);
        if (!sameTransformState(actual, entry.target)) {
          throw new Error(`${entry.documentName} ${entry.id} verification mismatched after exact V2 transform.`);
        }
      }
      return;
    }
    restorePreviewedLinkedSourcesForReleasedFormatCommit(plan);
    for (const operation of plan.operations) {
      const plans = plan.documents.map((linkedDocument) => {
        const stateOperation = operation.operation === 'scale-axes' ? 'scale' : operation.operation;
        const original = readSceneGroupMemberTransformState(linkedDocument, stateOperation);
        return {
          documentName: String(linkedDocument.documentName || linkedDocument.constructor?.documentName || ''),
          id: String(linkedDocument.id || ''),
          document: linkedDocument,
          target: buildBuildingLinkedTransformTarget(
            linkedDocument,
            original,
            operation.pivot,
            operation
          )
        };
      });
      for (const [documentName, updates] of groupUpdates(plans)) {
        await plan.scene.updateEmbeddedDocuments(documentName, structuredClone(updates), {
          isUndo: true,
          diff: false,
          faNexusSceneGroupCommand: true,
          faNexusBuildingNativeTransform: true,
          faNexusSceneGroupTransform: operation.operation
        });
      }
      for (const entry of plans) {
        // A move writes a linked Tile's semantic flags only when the translation changes
        // them (a door frame's do not), while the state read back always carries them.
        // Verify the fields this operation wrote.
        const current = readSceneGroupMemberTransformState(
          entry.document,
          operation.operation === 'scale-axes' ? 'scale' : operation.operation
        );
        const actual = Object.fromEntries(Object.keys(entry.target).map((key) => [key, current?.[key]]));
        if (!sameTransformState(actual, entry.target)) {
          throw new Error(
            `${entry.documentName} ${entry.id} verification mismatched after ${operation.operation}: ${JSON.stringify({
              expected: entry.target,
              actual
            })}.`
          );
        }
      }
    }
  } catch (error) {
    await rollbackBuildingLinkedTransform(document, plan, error);
  }
}

function hasExplicitBuildingChange(changes) {
  const flatNamespace = changes?.[`flags.${MODULE_ID}`];
  const nestedNamespace = changes?.flags?.[MODULE_ID];
  return BUILDING_FLAG_KEYS.some((key) => (
    hasOwn(changes, `flags.${MODULE_ID}.${key}`)
    || hasOwn(flatNamespace, key)
    || hasOwn(nestedNamespace, key)
    || hasOwn(nestedNamespace, `-=${key}`)
  ));
}

function writeBuildingFlags(changes, flags) {
  if (hasOwn(changes, `flags.${MODULE_ID}`)) {
    changes[`flags.${MODULE_ID}`] = {
      ...flags,
      ...(changes[`flags.${MODULE_ID}`] || {})
    };
    return;
  }
  changes.flags ||= {};
  changes.flags[MODULE_ID] = {
    ...flags,
    ...(changes.flags[MODULE_ID] || {})
  };
}

function resizeFactors(original, final) {
  const scaleX = final.width / original.width;
  const scaleY = final.height / original.height;
  if (![scaleX, scaleY].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Native Building geometry requires positive per-axis resize factors.');
  }
  return { scaleX, scaleY, scaleFactor: Math.sqrt(scaleX * scaleY) };
}

/**
 * The Root Tile sheet of a V2 Building sends Scale X/Y and Image like any Tile's (design E2). Their sign is the
 * Building's mirror state and their size is copied to its Fill and Sills; the Image is the outer wall texture that
 * the next Commit writes back. Saved from the sheet, the Root said "mirrored" while Walls, Fill, Sills and Region
 * stayed where they were, and the next move put every door in the wrong place. Changed values are refused with the
 * control that does it; unchanged ones (every Save sends them) pass.
 */
function refuseBuildingRootSheetOwnedTexture(document, changes) {
  const stored = document?._source?.texture || document?.texture || {};
  const sent = (key) => {
    if (Object.prototype.hasOwnProperty.call(changes, `texture.${key}`)) return { sent: true, value: changes[`texture.${key}`] };
    const texture = changes.texture;
    if (texture && typeof texture === 'object' && Object.prototype.hasOwnProperty.call(texture, key)) return { sent: true, value: texture[key] };
    return { sent: false };
  };
  const refuse = (message) => { throw Object.assign(new Error(message), { userRefusal: true }); };
  for (const key of ['scaleX', 'scaleY']) {
    const change = sent(key);
    if (change.sent && Number(change.value) !== Number(stored[key] ?? 1)) {
      refuse('A Building cannot be mirrored or stretched from its Tile sheet. To mirror it, open Scene Groups, right-click its group and choose Flip Horizontally or Flip Vertically.');
    }
  }
  const image = sent('src');
  if (image.sent && String(image.value ?? '') !== String(stored.src ?? '')) {
    refuse('The wall texture of a Building is chosen in the Building editor: Nexus Edit, then Outer Walls.');
  }
}

export function applyBuildingNativeTransformToChanges(document, changes = {}, options = {}) {
  if (!document || !changes || typeof changes !== 'object') {
    return { changed: false, reason: 'invalid-input' };
  }
  if (options?.faNexusSceneGroupCommand
    || options?.faNexusBuildingNativeTransform
    || options?.faNexusBuildingEditorDocumentWrite
    || options?.faNexusBuildingCurrentEdit
    || options?.faNexusBuildingV2CommitRollback) {
    return { changed: false, reason: 'managed-transform' };
  }
  const managedArtwork = managedBuildingArtworkOwner(document);
  if (managedArtwork) {
    normalizeBuildingManagedFillTileConfigPresentationUpdate(document, changes);
    const presentationUpdate = managedArtwork.role === 'Fill'
      ? isBuildingManagedFillPresentationUpdate(document, changes)
      : isBuildingManagedSillsPresentationUpdate(document, changes);
    if (presentationUpdate) {
      return {
        changed: false,
        reason: managedArtwork.role === 'Fill'
          ? 'managed-fill-presentation'
          : 'managed-sills-presentation'
      };
    }
    throw new Error(`A managed Building ${managedArtwork.role} cannot be transformed directly; transform its owning Root or Scene Group.`);
  }

  const sourceFlags = readBuildingFlags(document);
  if (!sourceFlags) return { changed: false, reason: 'not-building' };
  const isBuildingV2 = [4, 5].includes(Number(sourceFlags?.building?.schemaVersion));
  // Before any pose work: a Save that changes Scale X and X together must not go on to the linked move.
  if (isBuildingV2 && options?.faNexusTileConfigSubmit) refuseBuildingRootSheetOwnedTexture(document, changes);
  if (hasExplicitBuildingChange(changes) && !(isBuildingV2 && options?.faNexusTileConfigSubmit)) {
    return { changed: false, reason: 'explicit-building-update' };
  }

  const originalTile = tileSnapshot(document);
  let finalTile = finalTileSnapshot(originalTile, changes);
  validateTileGeometry(originalTile, 'original');
  validateTileGeometry(finalTile, 'final');
  // A turn that leaves the position alone (the wheel, the Rotation box of the Tile sheet) turns a Building about
  // the grid, as its rotate handle does (grid-reference-snap.js).
  if (turnRotationOnlyChangeAboutGridPivot(document, changes, options)) {
    finalTile = finalTileSnapshot(originalTile, changes);
  }
  if (!changedPose(originalTile, finalTile)) {
    return { changed: false, reason: 'pose-unchanged' };
  }

  let flags = sourceFlags;
  let scaleFactor = 1;
  let scaleX = 1;
  let scaleY = 1;
  const dimensionsChanged = (
    originalTile.width !== finalTile.width
    || originalTile.height !== finalTile.height
  );
  const anchorChanged = (
    originalTile.anchorX !== finalTile.anchorX
    || originalTile.anchorY !== finalTile.anchorY
  );
  const rotationDelta = finalTile.rotation - originalTile.rotation;
  if (isBuildingV2 && (dimensionsChanged || anchorChanged)) {
    // A refusal of something the user asked for, not a failure: the notice shows this sentence alone.
    throw Object.assign(new Error(
      'A Building cannot be resized or re-anchored on its own. To scale it, select its Scene Group and drag a corner handle of the group frame.'
    ), { userRefusal: true });
  }
  if (dimensionsChanged) {
    ({ scaleX, scaleY, scaleFactor } = resizeFactors(originalTile, finalTile));
    flags = resizeSemanticTileFlags({
      flags,
      originalTile,
      finalTile
    });
  }

  if (rotationDelta) {
    flags = transformSemanticTileFlags({
      flags,
      pivot: { x: originalTile.x, y: originalTile.y },
      transform: { operation: 'rotate', angle: rotationDelta },
      targetTile: { ...originalTile, rotation: finalTile.rotation }
    });
  }

  const delta = {
    x: finalTile.x - originalTile.x,
    y: finalTile.y - originalTile.y
  };
  if (delta.x || delta.y) {
    flags = translateSemanticTileFlags({ flags, delta, targetTile: finalTile });
  }

  if (!isBuildingV2) writeBuildingFlags(changes, flags);
  return {
    changed: true,
    reason: 'native-building-transform',
    tileId: String(document?.id || ''),
    originalTile,
    finalTile,
    scaleFactor,
    scaleX,
    scaleY,
    rotationDelta,
    delta
  };
}

function setLinkedPreviewRenderFlags(document) {
  const flags = {
    Tile: { refreshTransform: true },
    Wall: { refreshLine: true },
    Region: { refreshShapes: true }
  }[String(document?.documentName || document?.constructor?.documentName || '')];
  if (flags) document?.object?.renderFlags?.set?.(flags);
  document?.object?.applyRenderFlags?.();
  doorTransformPreviewRuntime.sync(document);
}

async function refreshLinkedBuildingPreviewDocuments(documents) {
  const tiles = documents.filter((document) => (
    String(document?.documentName || document?.constructor?.documentName || '') === 'Tile'
  ));
  for (const document of documents) setLinkedPreviewRenderFlags(document);
  if (!tiles.length) return;
  const [buildingTiles, textureMaskRuntime] = await Promise.all([
    import('./building-tiles.js'),
    import('../textures/texture-mask-runtime.js')
  ]);
  for (const document of tiles) {
    const tile = document.object;
    if (!tile) continue;
    try {
      if (document.getFlag?.(MODULE_ID, 'maskedTiling')) {
        await textureMaskRuntime.applyMaskedTilingToTile(tile);
      }
      if (document.getFlag?.(MODULE_ID, 'standardTileMask')) {
        await textureMaskRuntime.applyStandardTileMaskToTile(tile);
      }
      await buildingTiles.applyBuildingTile(tile);
      await buildingTiles.applyDoorFrameTile(tile);
      await buildingTiles.applyBuildingCompositeTile(tile);
    } catch (error) {
      throw new Error(
        `Native Building linked preview renderer failed for Tile ${String(document.id || '')}: ${String(error?.message || error)}`,
        { cause: error }
      );
    }
  }
}

function restoreBuildingNativeLinkedPreviewSources(state) {
  return restoreBuildingNativeLinkedPreviewRecords(state?.linkedRecords || []);
}

// updateSource merges objects. A key that a staged preview target added to the flags (a first
// `maskWorld.tile.rotation` on released-format data, say) would survive a merged restore,
// enter the next plan's "original" snapshot and be written back by Undo, after which earlier
// commands no longer match and cannot be undone. The flags are restored as a whole.
function exactPreviewSource(source) {
  const exact = structuredClone(source);
  if (!exact?.flags) return exact;
  const ForcedReplacement = globalThis.foundry?.data?.operators?.ForcedReplacement;
  if (typeof ForcedReplacement?.create !== 'function') {
    throw new Error('Foundry ForcedReplacement is unavailable for exact Building preview restoration.');
  }
  exact.flags = ForcedReplacement.create(exact.flags);
  return exact;
}

function restoreBuildingNativeLinkedPreviewRecords(records = []) {
  const documents = records.map((record) => record.document);
  const failures = [];
  for (const record of records) {
    try {
      record.document.updateSource(exactPreviewSource(record.source));
      setLinkedPreviewRenderFlags(record.document);
    } catch (error) {
      failures.push(new Error(
        `Could not restore ${String(record.document?.documentName || 'Document')} ${String(record.document?.id || '')}: ${String(error?.message || error)}`,
        { cause: error }
      ));
    }
  }
  if (failures.length) {
    const error = new AggregateError(failures, 'Native Building linked preview source restoration failed.');
    error.documents = documents;
    throw error;
  }
  return documents;
}

function completeBuildingNativePreviewHandoff(handoff, { restore = false } = {}) {
  if (!handoff || handoff.finished) return [];
  handoff.finished = true;
  const records = handoff.records || [];
  const documents = records.map((record) => record.document);
  try {
    if (restore) {
      const failures = [];
      try {
        restoreBuildingNativeLinkedPreviewRecords(records);
      } catch (error) {
        failures.push(error);
      }
      try {
        handoff.perceptionPreview?.cancel?.();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Native Building preview handoff restoration failed.');
      }
    } else {
      handoff.perceptionPreview?.complete?.();
    }
    return documents;
  } finally {
    handoff.records = [];
    handoff.perceptionPreview = null;
  }
}

async function settleAbandonedBuildingNativePreviewCommit(document, pending) {
  const handoff = pending?.handoff;
  if (!handoff) return false;
  const waitForFrame = () => new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(resolve);
    else if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(resolve, 16);
    else resolve();
  });
  for (let frame = 0; frame < 30 && !handoff.claimed && !handoff.started && !handoff.finished; frame += 1) {
    await waitForFrame();
  }
  if (handoff.claimed || handoff.started || handoff.finished) return false;
  if (PENDING_NATIVE_PREVIEW_COMMITS.get(document) === pending) {
    PENDING_NATIVE_PREVIEW_COMMITS.delete(document);
  }
  if (handoff.token && PENDING_LINKED_TRANSFORMS.delete(handoff.token)) {
    releaseNativeTileTransformReservation(document, handoff.token);
  }
  const documents = completeBuildingNativePreviewHandoff(handoff, { restore: true });
  await refreshLinkedBuildingPreviewDocuments(documents);
  return true;
}

function prepareBuildingNativeLinkedPreviewCommit(preview, { commit = false } = {}) {
  const state = BUILDING_NATIVE_PREVIEW_STATES.get(preview);
  if (!state) return [];
  state.ending = true;
  const documents = (state.linkedRecords || []).map((record) => record.document);
  let restorationError = null;
  const records = state.linkedRecords || [];
  if (!commit) {
    const failures = [];
    try {
      restoreBuildingNativeLinkedPreviewRecords(records);
    } catch (error) {
      failures.push(error);
    }
    try {
      state.wallPerceptionPreview?.cancel?.();
    } catch (error) {
      failures.push(error);
    }
    state.wallPerceptionPreview = null;
    if (failures.length) {
      restorationError = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Native Building preview restoration failed.');
    }
  }
  try {
    state.linkedRecords = [];
    BUILDING_NATIVE_PREVIEW_STATES.delete(preview);
  } catch (error) {
    restorationError ||= error;
  }
  if (restorationError) throw restorationError;
  if (state.failure) {
    let failure = state.failure;
    try {
      state.wallPerceptionPreview?.cancel?.();
    } catch (error) {
      failure = new AggregateError([failure, error], 'Native Building preview failure restoration failed.');
    } finally {
      state.wallPerceptionPreview = null;
    }
    failure.documents ||= documents;
    throw failure;
  }
  if (commit && state.lastPlan && state.lastResult && state.originalDocument) {
    const selectedRecord = {
      document: state.originalDocument,
      source: documentSource(state.originalDocument)
    };
    const handoff = {
      records: [...records, selectedRecord],
      perceptionPreview: state.wallPerceptionPreview,
      claimed: false,
      started: false,
      finished: false,
      token: null
    };
    state.wallPerceptionPreview = null;
    PENDING_NATIVE_PREVIEW_COMMITS.set(state.originalDocument, {
      plan: state.lastPlan,
      result: state.lastResult,
      handoff
    });
  } else if (commit && records.length) {
    const failures = [];
    try {
      restoreBuildingNativeLinkedPreviewRecords(records);
    } catch (error) {
      failures.push(error);
    }
    try {
      state.wallPerceptionPreview?.cancel?.();
    } catch (error) {
      failures.push(error);
    }
    state.wallPerceptionPreview = null;
    if (failures.length) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, 'Native Building no-op preview restoration failed.');
    }
  }
  return documents;
}

function stageBuildingNativeSelectedPreviewHandoff(document, pending) {
  const handoff = pending?.handoff;
  const finalTile = pending?.result?.finalTile;
  if (!handoff || !finalTile || !document) return false;
  const record = (handoff.records || []).find((entry) => entry?.document === document);
  if (!record) {
    throw new Error(`Native Building Root ${String(document?.id || '')} preview handoff has no exact original source.`);
  }
  const target = {};
  for (const field of POSE_FIELDS) {
    if (finalTile[field] != null) target[field] = finalTile[field];
  }
  document.updateSource(target);
  setLinkedPreviewRenderFlags(document);
  return true;
}

function applyBuildingNativeLinkedPreviewSources(state, plan) {
  if (!plan?.documents?.length) return restoreBuildingNativeLinkedPreviewSources(state);
  try {
    if (!state.linkedRecords?.length) {
      state.linkedRecords = plan.documents.map((document) => ({
        document,
        source: documentSource(document)
      }));
      state.wallPerceptionPreview = beginLocalWallPerceptionPreview(plan.documents, {
        source: `building-native:${String(state.originalDocument?.id || '')}`
      });
      if (state.wallPerceptionPreview?.supported === false) {
        Logger.warn?.('BuildingTiles.nativeTransform.wallPerceptionPreviewUnavailable', {
          tileId: String(state.originalDocument?.id || ''),
          reason: state.wallPerceptionPreview.reason,
          regionIds: state.wallPerceptionPreview.blockedRegionIds
        });
      }
    }
    const originalDocuments = restoreBuildingNativeLinkedPreviewSources(state);
    const recordsById = new Map(state.linkedRecords.map((record) => [
      `${String(record.document?.documentName || record.document?.constructor?.documentName || '')}:${String(record.document?.id || '')}`,
      record
    ]));
    for (const document of plan.documents) {
      const key = `${String(document?.documentName || document?.constructor?.documentName || '')}:${String(document?.id || '')}`;
      if (!recordsById.has(key)) {
        throw new Error(`Native Building preview linkage changed while held: ${key}.`);
      }
      const exact = plan.generatedTargets instanceof Map
        ? plan.generatedTargets.get(String(document?.uuid || ''))
        : null;
      const target = exact
        ? { ...readSceneGroupMemberTransformState(document, 'rotate'), ...structuredClone(exact) }
        : buildBuildingTransformTarget(document, plan.operations);
      document.updateSource(target);
      setLinkedPreviewRenderFlags(document);
    }
    // Wall restriction geometry must enter the active Level Edge collections in
    // the same pointer turn as the Root preview pose. The renderer refresh below
    // may await texture and mask work; deferring perception until after it makes
    // lighting visibly trail a directly dragged Building even though the final
    // held state is correct.
    state.wallPerceptionPreview?.apply?.();
    return originalDocuments;
  } catch (error) {
    throw new Error(
      `Native Building linked preview plan failed: ${String(error?.message || error)}`,
      { cause: error }
    );
  }
}

function startBuildingNativeTransformPreview(preview, state) {
  if (state.running) return state.running;
  const pending = preview.document;
  state.running = (async () => {
    let changed = false;
    while (!preview.destroyed && !state.ending && state.applied < state.requested) {
      const frame = state.latestFrame;
      if (!frame) break;
      if (frame.requested !== state.requested) break;
      try {
        if (frame.changed) {
          for (let frameNumber = 0; !preview.mesh && frameNumber < 30; frameNumber += 1) {
            if (preview.destroyed || state.ending) break;
            await new Promise((resolve) => {
              if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(resolve);
              else if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(resolve, 16);
              else resolve();
            });
          }
          if (!preview.mesh && !preview.destroyed && !state.ending) {
            throw new Error('Native Building preview Tile mesh was not ready after 30 animation frames.');
          }
          if (preview.destroyed || state.ending) break;
          const [buildingTiles, textureMaskRuntime] = await Promise.all([
            import('./building-tiles.js'),
            import('../textures/texture-mask-runtime.js')
          ]);
          if (state.ending || frame.requested !== state.requested) {
            state.applied = frame.requested;
            continue;
          }
          if (pending.getFlag?.(MODULE_ID, 'maskedTiling')) {
            await textureMaskRuntime.applyMaskedTilingToTile(preview);
          }
          if (pending.getFlag?.(MODULE_ID, 'standardTileMask')) {
            await textureMaskRuntime.applyStandardTileMaskToTile(preview);
          }
          await buildingTiles.applyBuildingTile(preview);
          await buildingTiles.applyDoorFrameTile(preview);
          await buildingTiles.applyBuildingCompositeTile(preview);
          if (!state.ending && frame.requested === state.requested) {
            await refreshLinkedBuildingPreviewDocuments(frame.linkedDocuments);
          }
          changed = true;
        } else if (!state.ending && frame.requested === state.requested) {
          await refreshLinkedBuildingPreviewDocuments(frame.linkedDocuments);
          state.wallPerceptionPreview?.restore?.();
        }
        state.applied = frame.requested;
        if (preview.faNexusBuildingLinkedPreviewDiagnostics) {
          preview.faNexusBuildingLinkedPreviewDiagnostics.applied = frame.requested;
        }
      } catch (error) {
        if (state.ending || preview.destroyed) break;
        if (frame.requested !== state.requested) {
          state.applied = frame.requested;
          continue;
        }
        let failure = new Error(
          `Native Building preview rendering failed: ${String(error?.message || error)}`,
          { cause: error }
        );
        const restoreFailures = [];
        try {
          restoreBuildingNativeLinkedPreviewSources(state);
        } catch (restoreError) {
          restoreFailures.push(restoreError);
        }
        try {
          state.wallPerceptionPreview?.cancel?.();
        } catch (restoreError) {
          restoreFailures.push(restoreError);
        }
        state.wallPerceptionPreview = null;
        if (restoreFailures.length) {
          failure = new AggregateError(
            [failure, ...restoreFailures],
            'Native Building preview rendering and restoration failed.'
          );
        }
        state.lastPlan = null;
        state.lastResult = null;
        state.failure = failure;
        if (preview.faNexusBuildingLinkedPreviewDiagnostics) {
          preview.faNexusBuildingLinkedPreviewDiagnostics.failure = String(failure.message || failure);
        }
        throw failure;
      }
    }
    return changed;
  })().finally(() => {
    state.running = null;
    if (preview.destroyed) BUILDING_NATIVE_PREVIEW_STATES.delete(preview);
  });
  return state.running;
}

export async function syncBuildingNativeTransformPreview(originalDocument, preview) {
  if (!originalDocument || !preview?.document) return false;
  const state = BUILDING_NATIVE_PREVIEW_STATES.get(preview) || {
    requested: 0,
    applied: 0,
    running: null,
    originalDocument,
    linkedRecords: [],
    wallPerceptionPreview: null,
    ending: false,
    lastPlan: null,
    lastResult: null,
    latestFrame: null,
    failure: null
  };
  if (state.failure) throw state.failure;
  state.originalDocument = originalDocument;
  const requested = state.requested + 1;
  BUILDING_NATIVE_PREVIEW_STATES.set(preview, state);
  const pending = preview.document;
  const changes = {
    x: Number(pending.x),
    y: Number(pending.y),
    width: Number(pending.width),
    height: Number(pending.height),
    rotation: Number(pending.rotation) || 0,
    texture: {
      anchorX: Number(pending.texture?.anchorX ?? 0.5),
      anchorY: Number(pending.texture?.anchorY ?? 0.5)
    }
  };
  const result = applyBuildingNativeTransformToChanges(state.originalDocument, changes, {});
  let linkedPlan = null;
  let linkedDocuments = [];
  try {
    if (result.changed) {
      if (state.linkedRecords?.length) restoreBuildingNativeLinkedPreviewSources(state);
      try {
        linkedPlan = buildBuildingLinkedTransformPlan(state.originalDocument, result);
      } catch (error) {
        throw new Error(`Native Building preview planning failed: ${String(error?.message || error)}`, { cause: error });
      }
      if (linkedPlan?.selectedTarget) {
        applyBuildingTransformTargetToChanges(changes, linkedPlan.selectedTarget);
      }
      try {
        pending.updateSource(changes);
        preview.renderFlags?.set?.({ refreshTransform: true });
        preview.applyRenderFlags?.();
        linkedDocuments = applyBuildingNativeLinkedPreviewSources(state, linkedPlan);
      } catch (error) {
        throw new Error(`Native Building selected preview source failed: ${String(error?.message || error)}`, { cause: error });
      }
      state.lastPlan = linkedPlan;
      state.lastResult = result;
      preview.faNexusBuildingSemanticNativePreview = true;
      preview.faNexusBuildingLinkedPreviewDiagnostics = {
        requested,
        applied: state.applied,
        ending: state.ending,
        linkedDocumentCount: linkedPlan?.documents?.length || 0,
        operations: structuredClone(linkedPlan?.operations || []),
        selectedTarget: structuredClone(linkedPlan?.selectedTarget || null)
      };
    } else {
      linkedDocuments = restoreBuildingNativeLinkedPreviewSources(state);
      state.lastPlan = null;
      state.lastResult = null;
      preview.faNexusBuildingLinkedPreviewDiagnostics = {
        requested,
        applied: state.applied,
        ending: state.ending,
        linkedDocumentCount: 0,
        operations: [],
        selectedTarget: null
      };
    }
  } catch (error) {
    try {
      restoreBuildingNativeLinkedPreviewSources(state);
    } catch (restoreError) {
      error = new AggregateError([error, restoreError], 'Native Building preview staging and restoration failed.');
    }
    state.lastPlan = null;
    state.lastResult = null;
    state.failure = error;
    throw error;
  }
  state.latestFrame = {
    requested,
    changed: result.changed,
    linkedDocuments
  };
  state.requested = requested;
  let completed = await startBuildingNativeTransformPreview(preview, state);
  while (!preview.destroyed && !state.ending && !state.running && state.applied < state.requested) {
    completed = await startBuildingNativeTransformPreview(preview, state);
  }
  return completed;
}

export async function waitForBuildingNativeTransformPreview(preview) {
  if (!BUILDING_NATIVE_PREVIEW_STATES.has(preview)) return false;
  await waitForStableNativePreview({
    getState: () => BUILDING_NATIVE_PREVIEW_STATES.get(preview) || null,
    waitForFrame: () => new Promise((resolve) => {
      if (typeof globalThis.requestAnimationFrame !== 'function') {
        throw new Error('Native Building preview readiness requires requestAnimationFrame.');
      }
      globalThis.requestAnimationFrame(resolve);
    })
  });
  return true;
}

function installBuildingNativePreviewPatch() {
  const prototype = globalThis?.canvas?.tiles?.placeables
    ?.find?.((tile) => tile?.controls?.constructor?.prototype?._updateDragPreview)
    ?.controls?.constructor?.prototype
    || null;
  if (!prototype || typeof prototype._updateDragPreview !== 'function') return false;
  if (prototype[BUILDING_NATIVE_PREVIEW_PATCH]) return true;
  const originalRefresh = prototype._refresh;
  if (typeof originalRefresh === 'function') {
    prototype._refresh = function faNexusBuildingNativeControlsRefresh(...args) {
      const result = originalRefresh.apply(this, args);
      hideBuildingV2NativeScaleHandle(this);
      return result;
    };
  }
  const originalCanDragStart = prototype._canDragStart;
  if (typeof originalCanDragStart === 'function') {
    prototype._canDragStart = function faNexusManagedBuildingFillCanDragStart(event, options) {
      const document = this?.object?.document || this?.document || null;
      const handleName = String(event?.interactionData?.handle?.name || '');
      const managedArtwork = managedBuildingArtworkOwner(document);
      if (managedArtwork) {
        if (handleName === 'scale') return false;
        const route = rememberManagedBuildingArtworkGestureRoute(document, event, this?.object?.layer || this?.layer);
        if (!route?.controls) {
          globalThis.ui?.notifications?.error?.(
            `This managed ${managedArtwork.role} cannot transform because its owning Building Root is unavailable.`
          );
          return false;
        }
        transferManagedBuildingArtworkControl(this?.object, route);
        if (refuseBusyBuildingGesture(route.controls?.object?.document || route.controls?.document, options)) return false;
        return originalCanDragStart.call(route.controls, event, options);
      }
      const isBuildingV2Root = [4, 5].includes(Number(readFaNexusFlag(document, 'building')?.schemaVersion));
      if (isBuildingV2Root && handleName === 'scale') {
        return false;
      }
      if (isBuildingV2Root && refuseBusyBuildingGesture(document, options)) return false;
      return originalCanDragStart.call(this, event, options);
    };
  }
  const originalDragStart = prototype._onDragStart;
  if (typeof originalDragStart === 'function') {
    prototype._onDragStart = function faNexusBuildingNativePreviewDragStart(event) {
      const controls = readBuildingNativeGestureControls(this, event);
      const sourceDocument = controls?.object?.document || controls?.document || null;
      releaseManagedArtworkControlsForRoot(sourceDocument, controls?.object?.layer || controls?.layer);
      return originalDragStart.call(controls, event);
    };
  }
  const original = prototype._updateDragPreview;
  prototype._updateDragPreview = function faNexusBuildingNativePreview(event) {
    const controls = readBuildingNativeGestureControls(this, event);
    // For every Nexus layer with grid reference points, not Buildings alone (grid-reference-snap.js).
    adjustHandleDragForGrid(controls, event);
    const result = original.call(controls, event);
    const sourceDocument = controls?.object?.document || controls?.document || null;
    const preview = event?.interactionData?.preview || null;
    if (readBuildingFlags(sourceDocument) && preview) {
      const previewPromise = syncBuildingNativeTransformPreview(sourceDocument, preview);
      preview.faNexusBuildingSemanticNativePreviewPromise = previewPromise;
      void previewPromise.catch((error) => {
        Logger.error?.('BuildingTiles.nativeTransform.previewFailed', {
          tileId: String(sourceDocument?.id || ''),
          error: String(error?.message || error)
        });
      });
    }
    return result;
  };
  const originalDrop = prototype._onDragDrop;
  if (typeof originalDrop === 'function') {
    prototype._onDragDrop = function faNexusBuildingNativePreviewDrop(event) {
      const controls = readBuildingNativeGestureControls(this, event);
      const preview = event?.interactionData?.preview || null;
      if (!BUILDING_NATIVE_PREVIEW_STATES.has(preview)) return originalDrop.call(controls, event);
      const document = controls?.object?.document || controls?.document || null;
      try {
        prepareBuildingNativeLinkedPreviewCommit(preview, { commit: true });
        const pending = PENDING_NATIVE_PREVIEW_COMMITS.get(document) || null;
        const result = originalDrop.call(controls, event);
        stageBuildingNativeSelectedPreviewHandoff(document, pending);
        controls?.layer?.clearPreviewContainer?.();
        void Promise.resolve(result).finally(() => {
          void settleAbandonedBuildingNativePreviewCommit(document, pending).catch((error) => {
            Logger.error?.('BuildingTiles.nativeTransform.previewHandoffRestoreFailed', {
              tileId: String(document?.id || ''),
              error: String(error?.message || error)
            });
            globalThis.ui?.notifications?.error?.(
              `Building transform preview could not finish its document handoff: ${String(error?.message || error)}`
            );
          });
        });
        return result;
      } catch (error) {
        const pending = PENDING_NATIVE_PREVIEW_COMMITS.get(document) || null;
        PENDING_NATIVE_PREVIEW_COMMITS.delete(document);
        const documents = completeBuildingNativePreviewHandoff(pending?.handoff, { restore: true });
        void refreshLinkedBuildingPreviewDocuments(documents).catch(() => {});
        controls?.layer?.clearPreviewContainer?.();
        const message = `Building transform preview could not be committed: ${String(error?.message || error)}`;
        Logger.error?.('BuildingTiles.nativeTransform.previewCommitFailed', {
          tileId: String(this?.document?.id || ''),
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(message);
        return undefined;
      }
    };
  }
  const originalCancel = prototype._onDragCancel;
  if (typeof originalCancel === 'function') {
    prototype._onDragCancel = function faNexusBuildingNativePreviewCancel(event) {
      const controls = readBuildingNativeGestureControls(this, event);
      const preview = event?.interactionData?.preview || null;
      if (!BUILDING_NATIVE_PREVIEW_STATES.has(preview)) return originalCancel.call(controls, event);
      const failures = [];
      let documents = [];
      try {
        documents = prepareBuildingNativeLinkedPreviewCommit(preview);
      } catch (error) {
        documents = error?.documents || [];
        failures.push(error);
      }
      let result;
      try {
        result = originalCancel.call(controls, event);
      } catch (error) {
        failures.push(error);
      }
      void refreshLinkedBuildingPreviewDocuments(documents).catch((error) => {
        failures.push(error);
      }).finally(() => {
        if (!failures.length) return;
        const error = failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Native Building preview cancellation failed.');
        Logger.error?.('BuildingTiles.nativeTransform.previewCancelFailed', {
          tileId: String(this?.document?.id || ''),
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(
          `Building transform preview could not be restored: ${String(error?.message || error)}`
        );
      });
      return result;
    };
  }
  Object.defineProperty(prototype, BUILDING_NATIVE_PREVIEW_PATCH, {
    value: true,
    configurable: false
  });
  return true;
}

function buildingNativeBodyPreviewEntries(event) {
  return Array.from(event?.interactionData?.clones || []).flatMap((preview) => {
    const document = preview?._original?.document || null;
    return document && BUILDING_NATIVE_PREVIEW_STATES.has(preview)
      ? [{ document, preview }]
      : [];
  });
}

function reportBuildingNativeBodyPreviewFailure(document, error) {
  Logger.error?.('BuildingTiles.nativeTransform.previewFailed', {
    tileId: String(document?.id || ''),
    error: String(error?.message || error)
  });
}

// A Building whose generated aggregate is no longer exact can be neither previewed
// nor committed. Refuse at Foundry's permission step, which cancels the gesture once.
// An exception at drag start instead leaves it half-started, blames the shadow
// preview and throws again on every later pointer move.
const BUILDING_TRANSFORM_BUSY_MESSAGE = 'This Building is still saving its last change. Try again in a moment.';

// A Building's change is saved in steps: Foundry confirms the Tile, then Nexus writes its Walls, Fill and Region, and
// until then the Walls stay at their previewed place. On a slow host (The Forge) a second gesture can start inside that
// window; it would preview against stale documents and fail on every frame. It is refused at its start instead.
function isBuildingTransformBusy(document) {
  if (!document) return false;
  return PENDING_NATIVE_PREVIEW_COMMITS.has(document) || hasPendingNativeTileTransformTransaction(document);
}

function refuseBusyBuildingGesture(document, options) {
  if (!isBuildingTransformBusy(document)) return false;
  if (options?.notify !== false) {
    Logger.warn?.('BuildingTiles.nativeTransform.busy', { tileId: String(document?.id || '') });
    globalThis.ui?.notifications?.warn?.(BUILDING_TRANSFORM_BUSY_MESSAGE);
  }
  return true;
}

function canStartBuildingNativeGesture(tile, options) {
  // Foundry repeats the question silently for each selected Tile while it builds
  // drag clones; the grabbed Tile has already answered for the whole selection.
  if (options?.notify === false) return true;
  const layer = tile?.layer;
  const selected = layer?.options?.controllableObjects ? Array.from(layer.controlled || []) : [];
  for (const candidate of new Set([tile, ...selected])) {
    const document = candidate?.document;
    if (![4, 5].includes(Number(readFaNexusFlag(document, 'building')?.schemaVersion))) continue;
    if (refuseBusyBuildingGesture(document, options)) return false;
    try {
      collectBuildingLinkedDocuments(document);
    } catch (error) {
      const message = String(error?.message || error);
      Logger.error?.('BuildingTiles.nativeTransform.startRefused', {
        tileId: String(document?.id || ''),
        error: message
      });
      globalThis.ui?.notifications?.error?.(`This Building cannot be transformed: ${message}`);
      return false;
    }
  }
  return true;
}

/**
 * The points a Building is snapped by when it is moved or turned with Foundry's own tools (grid-reference-snap.js):
 * the ends of its Foundry Walls. A Building's own floor or sills stand for the Building. A Building without
 * Walls keeps Foundry's point, its Tile position.
 */
function collectBuildingGridReferencePoints(document) {
  const owner = managedBuildingArtworkOwner(document);
  const root = owner ? (document?.parent?.tiles?.get?.(owner.ownerId) || null) : document;
  if (!readBuildingFlags(root)) return null;
  const walls = collectBuildingLinkedDocuments(root)
    .filter((linked) => String(linked?.documentName || linked?.constructor?.documentName || '') === 'Wall');
  const points = wallEndPoints(walls);
  return points.length ? points : [{ x: Number(root.x), y: Number(root.y) }];
}

registerGridReferenceSource(collectBuildingGridReferencePoints);

function installBuildingNativeBodyPreviewPatch() {
  const prototype = globalThis?.canvas?.tiles?.placeables
    ?.find?.((tile) => typeof tile?._updateDragPreviews === 'function')
    ?.constructor?.prototype
    || null;
  if (!prototype || typeof prototype._updateDragPreviews !== 'function') return false;
  if (prototype[BUILDING_NATIVE_BODY_PREVIEW_PATCH]) return true;

  const originalCanDragLeftStart = prototype._canDragLeftStart;
  if (typeof originalCanDragLeftStart === 'function') {
    prototype._canDragLeftStart = function faNexusManagedBuildingFillCanDragLeftStart(user, event, options) {
      const managedArtwork = managedBuildingArtworkOwner(this?.document);
      if (managedArtwork) {
        const route = rememberManagedBuildingArtworkGestureRoute(this.document, event, this.layer);
        if (!route) {
          if (options?.notify !== false) {
            globalThis.ui?.notifications?.error?.(
              `This managed ${managedArtwork.role} cannot transform because its owning Building Root is unavailable.`
            );
          }
          return false;
        }
        transferManagedBuildingArtworkControl(this, route);
        return originalCanDragLeftStart.call(route.placeable, user, event, options)
          && canStartBuildingNativeGesture(route.placeable, options);
      }
      return originalCanDragLeftStart.call(this, user, event, options)
        && canStartBuildingNativeGesture(this, options);
    };
  }

  const originalClickLeft = prototype._onClickLeft;
  if (typeof originalClickLeft === 'function') {
    prototype._onClickLeft = function faNexusManagedBuildingFillClickLeft(event) {
      const route = managedBuildingArtworkOwner(this?.document)
        ? rememberManagedBuildingArtworkGestureRoute(this.document, event, this.layer) : null;
      if (!route) return originalClickLeft.call(this, event);
      // A box-selected Fill represents its Root in the current selection. On
      // later grabs the Fill is unselected but its Root remains selected: run
      // Foundry's click semantics on that Root before it can release siblings.
      if (this.controlled) transferManagedBuildingArtworkControl(this, route);
      return originalClickLeft.call(route.placeable, event);
    };
  }

  const originalUnclickLeft = prototype._onUnclickLeft;
  if (typeof originalUnclickLeft === 'function') {
    prototype._onUnclickLeft = function faNexusManagedBuildingFillUnclickLeft(event) {
      const route = managedBuildingArtworkOwner(this?.document) ? readNativeTileGestureRoute(event) : null;
      return originalUnclickLeft.call(route?.placeable || this, event);
    };
  }

  const originalUpdateDragPreviews = prototype._updateDragPreviews;
  const originalBodyDragStart = prototype._onDragLeftStart;
  if (typeof originalBodyDragStart === 'function') {
    prototype._onDragLeftStart = function faNexusBuildingNativeBodyDragStart(event) {
      // Foundry snapshots controlled objects when it initializes drag clones.
      // A selected generated Fill is already moved by its Root's aggregate;
      // releasing it during preview updates is too late to remove its clone.
      const layer = this?.layer;
      for (const selected of Array.from(layer?.controlled || [])) {
        releaseManagedArtworkControlsForRoot(selected?.document, layer);
      }
      return originalBodyDragStart.call(this, event);
    };
  }
  prototype._updateDragPreviews = function faNexusBuildingNativeBodyPreview(event) {
    // For every Nexus layer with grid reference points, not Buildings alone (grid-reference-snap.js).
    snapBodyDragByGridReference(this, event);
    const result = originalUpdateDragPreviews.call(this, event);
    for (const preview of Array.from(event?.interactionData?.clones || [])) {
      const sourceDocument = preview?._original?.document || null;
      if (!readBuildingFlags(sourceDocument)) continue;
      const previewPromise = syncBuildingNativeTransformPreview(sourceDocument, preview);
      preview.faNexusBuildingSemanticNativePreviewPromise = previewPromise;
      void previewPromise.catch((error) => reportBuildingNativeBodyPreviewFailure(sourceDocument, error));
    }
    return result;
  };

  const originalDrop = prototype._onDragLeftDrop;
  if (typeof originalDrop === 'function') {
    prototype._onDragLeftDrop = function faNexusBuildingNativeBodyPreviewDrop(event) {
      const entries = buildingNativeBodyPreviewEntries(event);
      if (!entries.length) return originalDrop.call(this, event);
      const prepared = [];
      try {
        for (const entry of entries) {
          prepareBuildingNativeLinkedPreviewCommit(entry.preview, { commit: true });
          entry.pending = PENDING_NATIVE_PREVIEW_COMMITS.get(entry.document) || null;
          prepared.push(entry);
        }
        const result = originalDrop.call(this, event);
        for (const entry of prepared) stageBuildingNativeSelectedPreviewHandoff(entry.document, entry.pending);
        // Only Building Roots have adopted their final local pose. Foundry
        // keeps ordinary Tile clones until its private async save completes.
        for (const { preview } of prepared) {
          preview.parent?.removeChild(preview);
          preview._onDragEnd();
          preview.destroy({ children: true });
        }
        for (const entry of prepared) {
          void Promise.resolve(result).finally(() => {
            void settleAbandonedBuildingNativePreviewCommit(entry.document, entry.pending).catch((error) => {
              Logger.error?.('BuildingTiles.nativeTransform.previewHandoffRestoreFailed', {
                tileId: String(entry.document?.id || ''),
                error: String(error?.message || error)
              });
              globalThis.ui?.notifications?.error?.(
                `Building transform preview could not finish its document handoff: ${String(error?.message || error)}`
              );
            });
          });
        }
        return result;
      } catch (error) {
        const documents = [];
        for (const entry of prepared) {
          PENDING_NATIVE_PREVIEW_COMMITS.delete(entry.document);
          documents.push(...completeBuildingNativePreviewHandoff(entry.pending?.handoff, { restore: true }));
        }
        void refreshLinkedBuildingPreviewDocuments(documents).catch(() => {});
        this?.layer?.clearPreviewContainer?.();
        Logger.error?.('BuildingTiles.nativeTransform.previewCommitFailed', {
          tileId: String(this?.document?.id || ''),
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(
          `Building transform preview could not be committed: ${String(error?.message || error)}`
        );
        return undefined;
      }
    };
  }

  const originalCancel = prototype._onDragLeftCancel;
  if (typeof originalCancel === 'function') {
    prototype._onDragLeftCancel = function faNexusBuildingNativeBodyPreviewCancel(event) {
      const entries = buildingNativeBodyPreviewEntries(event);
      if (!entries.length) return originalCancel.call(this, event);
      const failures = [];
      const documents = [];
      for (const entry of entries) {
        try {
          documents.push(...prepareBuildingNativeLinkedPreviewCommit(entry.preview));
        } catch (error) {
          documents.push(...(error?.documents || []));
          failures.push(error);
        }
      }
      let result;
      try {
        result = originalCancel.call(this, event);
      } catch (error) {
        failures.push(error);
      }
      void refreshLinkedBuildingPreviewDocuments(documents).catch((error) => {
        failures.push(error);
      }).finally(() => {
        if (!failures.length) return;
        const error = failures.length === 1
          ? failures[0]
          : new AggregateError(failures, 'Native Building body preview cancellation failed.');
        Logger.error?.('BuildingTiles.nativeTransform.previewCancelFailed', {
          tileId: String(this?.document?.id || ''),
          error: String(error?.message || error)
        });
        globalThis.ui?.notifications?.error?.(
          `Building transform preview could not be restored: ${String(error?.message || error)}`
        );
      });
      return result;
    };
  }

  Object.defineProperty(prototype, BUILDING_NATIVE_BODY_PREVIEW_PATCH, {
    value: true,
    configurable: false
  });
  return true;
}

export function registerBuildingNativeTileTransformHooks() {
  if (!globalThis.Hooks?.on) {
    throw new Error('Foundry Hooks are unavailable for native Building Tile transforms.');
  }
  installNativeTileTransformHistory('faNexusBuildingNativeTransformTokens', token => PENDING_LINKED_TRANSFORMS.get(token));
  Hooks.on('preUpdateTile', (document, changes, options) => {
    let reservationToken = null;
    const previewCommit = PENDING_NATIVE_PREVIEW_COMMITS.get(document) || null;
    try {
      PENDING_NATIVE_PREVIEW_COMMITS.delete(document);
      if (previewCommit?.handoff) previewCommit.handoff.claimed = true;
      const result = previewCommit?.result
        || applyBuildingNativeTransformToChanges(document, changes, options);
      if (result.changed) {
        // A Building pose update is one cross-document aggregate even though Foundry's
        // Canvas history is split by Placeables layer. Mark the initiating Root write
        // before Scene history capture so Ctrl/Cmd+Z cannot restore only the Tile while
        // leaving its generated Walls and managed Fill at the committed generation.
        const historyContext = captureNativeTileTransformHistoryContext(document.parent, options);
        // The selected Root is adopted locally at native preview handoff so the
        // next real pointer gesture sees the exact released pose immediately.
        // Force the already-captured update through Foundry even when its
        // client-side dry-run observes that optimistic local source.
        options.diff = false;
        const linkedPlan = previewCommit?.plan || buildBuildingLinkedTransformPlan(document, result);
        if (linkedPlan) {
          linkedPlan.historyContext = historyContext;
          applyBuildingTransformTargetToChanges(changes, linkedPlan.selectedTarget);
          const token = globalThis.foundry?.utils?.randomID?.()
            || globalThis.crypto?.randomUUID?.();
          if (!token) throw new Error('Could not allocate a native Building linked transform transaction.');
          reserveNativeTileTransformTransaction(document, token, { family: 'building' });
          reservationToken = token;
          if (previewCommit?.handoff) {
            previewCommit.handoff.token = token;
            linkedPlan.previewHandoff = previewCommit.handoff;
          }
          // Foundry shares options across every document in a batch. Each Root
          // must claim only its own linked plan when updateTile fires.
          options.faNexusBuildingNativeTransformTokens ||= {};
          options.faNexusBuildingNativeTransformTokens[document.id] = token;
          PENDING_LINKED_TRANSFORMS.set(token, linkedPlan);
          globalThis.setTimeout?.(() => {
            const expiredPlan = PENDING_LINKED_TRANSFORMS.get(token);
            if (!expiredPlan) return;
            if (!PENDING_LINKED_TRANSFORMS.delete(token)) return;
            const error = new Error(
              `Native Building Tile ${String(document?.id || '')} transform timed out waiting for its authoritative update.`
            );
            const documents = completeBuildingNativePreviewHandoff(expiredPlan.previewHandoff, { restore: true });
            void refreshLinkedBuildingPreviewDocuments(documents).catch(() => {});
            rejectNativeTileTransformReservation(document, token, error);
            Logger.error?.('BuildingTiles.nativeTransform.reservationTimedOut', {
              tileId: String(document?.id || ''),
              error: error.message
            });
            globalThis.ui?.notifications?.error?.(error.message);
          }, 30000);
        }
        // The managed-write bypass belongs only to the linked writes below,
        // never to this initiating batch (which may contain more Roots/Tiles).
        Logger.debug?.('BuildingTiles.nativeTransform.planned', {
          tileId: result.tileId,
          original: result.originalTile,
          final: result.finalTile,
          scaleFactor: result.scaleFactor,
          rotationDelta: result.rotationDelta,
          delta: result.delta
        });
      }
      if (previewCommit?.handoff && !reservationToken) {
        const documents = completeBuildingNativePreviewHandoff(previewCommit.handoff, { restore: true });
        void refreshLinkedBuildingPreviewDocuments(documents).catch(() => {});
      }
      return true;
    } catch (error) {
      if (reservationToken) {
        PENDING_LINKED_TRANSFORMS.delete(reservationToken);
        releaseNativeTileTransformReservation(document, reservationToken);
      }
      const documents = completeBuildingNativePreviewHandoff(previewCommit?.handoff, { restore: true });
      void refreshLinkedBuildingPreviewDocuments(documents).catch(() => {});
      const message = String(error?.message || error);
      // A refused request (resize, mirror or stretch from the Tile sheet) is answered with its sentence; not a fault.
      Logger[error?.userRefusal ? 'warn' : 'error']?.('BuildingTiles.nativeTransform.failed', {
        tileId: String(document?.id || ''),
        changeKeys: Object.keys(changes || {}),
        error: message
      });
      if (error?.code === NATIVE_TILE_TRANSFORM_BUSY) globalThis.ui?.notifications?.warn?.(BUILDING_TRANSFORM_BUSY_MESSAGE);
      else if (error?.userRefusal) globalThis.ui?.notifications?.warn?.(message);
      else globalThis.ui?.notifications?.error?.(`Building transform was cancelled because its stored geometry could not be preserved: ${message}`);
      return false;
    }
  });
  Hooks.on('updateTile', (document, _changes, options) => {
    const token = options?.faNexusBuildingNativeTransformTokens?.[document.id];
    if (!token) return;
    const plan = PENDING_LINKED_TRANSFORMS.get(token);
    PENDING_LINKED_TRANSFORMS.delete(token);
    if (!plan) {
      releaseNativeTileTransformReservation(document, token);
      return;
    }
    if (plan.previewHandoff) plan.previewHandoff.started = true;
    const transaction = trackNativeTileTransformTransaction(
      document,
      commitBuildingLinkedTransform(document, plan),
      { family: 'building', reservationToken: token }
    );
    void transaction.finally(() => {
      completeBuildingNativePreviewHandoff(plan.previewHandoff);
    }).catch(() => {});
    void transaction.catch((error) => {
      const message = String(error?.message || error);
      Logger.error?.('BuildingTiles.nativeTransform.linkedCommitFailed', {
        tileId: String(document?.id || ''),
        error: message
      });
      globalThis.ui?.notifications?.error?.(message);
    });
  });
  installBuildingNativePreviewPatch();
  installBuildingNativeBodyPreviewPatch();
  Hooks.on('canvasReady', () => {
    installNativeTileTransformHistory('faNexusBuildingNativeTransformTokens', token => PENDING_LINKED_TRANSFORMS.get(token));
    installBuildingNativePreviewPatch();
    installBuildingNativeBodyPreviewPatch();
  });
  Hooks.on('drawTile', () => {
    installBuildingNativePreviewPatch();
    installBuildingNativeBodyPreviewPatch();
  });
}

if (globalThis.Hooks?.on) registerBuildingNativeTileTransformHooks();
