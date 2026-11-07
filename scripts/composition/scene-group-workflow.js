import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forcedReplacement, forcedDeletion } from '../canvas/document-operators.js';
import { removeCompositionLayerFolders, COMPOSITION_FOLDERS_FLAG } from './composition-layer-folders.js';
import { reflectCompositionMember, compositionReflectionBlocker } from './composition-reflection.js';
import { isSceneMemberLocked, buildSceneMemberLockUpdate } from './scene-member-lock-state.js';
import { validateSceneGroupIcon, validateSceneGroupIconColor } from './scene-group-icons.js';
import { planSceneGroupCapture, planCaptureSubgroups, sameCaptureOwnership, capturePassesSelectionOptions } from './scene-group-capture-plan.js';
import { getSceneLayerManagerSections } from '../layers/model/section-metadata.js';
import { getRawLevelIds } from '../canvas/tile-level-membership.js';
import { transformBuildingV2SeamlessSurface } from '../buildings/v2/building-v2-seamless.js';
import {
  buildLayerHiddenUpdate,
  isLayerHidden
} from '../canvas/layer-hidden-state.js';
import { resolveTileDisplayName } from '../canvas/tile-display-name.js';
import {
  readSemanticTileFlags,
  resizeSemanticTileFlags,
  translateSemanticTileFlags,
  transformSemanticTileFlags
} from './scene-group-tile-transform.js';
import { transformFlattenedMetadataForTarget } from '../flatten/flatten-tile-transform.js';
import {
  beginSceneGroupCommand,
  captureSceneGroupCommandHistoryContext,
  cancelSceneGroupCommand,
  completeSceneGroupCommand,
  recordSceneGroupCommand
} from './scene-group-command-history.js';
import {
  DEFAULT_PORTAL_TEXTURE_GRID_SIZE,
  scalePortalTextureGridSize
} from '../portals/portal-texture-scale.js';
import {
  resolveNextSceneGroupName,
  resolveSceneGroupNameBase
} from './scene-group-naming.js';
import {
  SceneGroupGeneratedMemberReplacementError,
  planSceneGroupGeneratedMemberReplacement
} from './scene-group-generated-member-replacement.js';
import { planBuildingGeneratedDocumentAdoption } from '../buildings/ownership/building-generated-document-adoption.js';
import { runFoundryCompositionRegistryTransaction } from './composition-registry-transaction.js';
import {
  buildBuildingV2GeneratedTransformTargets,
  collectBuildingV2SceneDocuments,
  readBuildingV2TransformManifest,
  validateBuildingV2TransformAggregate
} from '../buildings/v2/building-v2-transform-aggregate.js';
import { createBuildingV2UniformScaleRootTarget, deriveBuildingV2SpatialPose } from '../buildings/v2/building-v2-spatial-transform.js';
import { materializeBuildingV2DoorShadowForChord, normalizeBuildingV2DoorShadow } from '../buildings/v2/building-v2-door-shadow.js';

export function pruneEmptySceneGroups(registry) {
  let removed = true;
  while (removed) {
    removed = false;
    const parentIds = new Set(Object.values(registry.groups).map(group => group.parentId).filter(Boolean));
    for (const group of Object.values(registry.groups)) {
      if (group.directMemberUuids.length || parentIds.has(group.id)) continue;
      delete registry.groups[group.id];
      removed = true;
    }
  }
  return registry;
}

export const COMPOSITION_REGISTRY_FLAG = 'compositionRegistry';
export const COMPOSITION_REGISTRY_SCHEMA_VERSION = 1;
export const SCENE_GROUP_PIVOT_MODES = Object.freeze({
  AUTOMATIC: 'automatic',
  CUSTOM: 'custom'
});
export const SUPPORTED_SCENE_GROUP_DOCUMENT_TYPES = Object.freeze([
  'Tile',
  'Wall',
  'AmbientLight',
  'AmbientSound',
  'Region'
]);
export const SCENE_GROUP_TRANSFORM_CAPABILITIES = Object.freeze({
  Tile: Object.freeze({
    rotate: Object.freeze(['position', 'visual-orientation']),
    scale: Object.freeze(['position', 'visual'])
  }),
  Wall: Object.freeze({
    rotate: Object.freeze(['geometry']),
    scale: Object.freeze(['geometry', 'effect-radius'])
  }),
  AmbientLight: Object.freeze({
    rotate: Object.freeze(['position', 'effect-orientation']),
    scale: Object.freeze(['position', 'effect-radius'])
  }),
  AmbientSound: Object.freeze({
    rotate: Object.freeze(['position', 'intrinsic-orientation-no-op']),
    scale: Object.freeze(['position', 'effect-radius'])
  }),
  Region: Object.freeze({
    rotate: Object.freeze(['geometry', 'shape-orientation-or-no-op']),
    scale: Object.freeze(['geometry'])
  })
});
const SUPPORTED_COMPOSITION_RELATIONSHIP_TYPES = new Set([
  'attached-to',
  'generated-by'
]);
const WALL_VISIBILITY_FIELDS = Object.freeze(['light', 'move', 'sight', 'sound', 'door', 'ds']);
const WALL_NONE_STATE = Object.freeze({
  light: 0,
  move: 0,
  sight: 0,
  sound: 0,
  door: 0
});

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createEmptyRegistry() {
  return {
    schemaVersion: COMPOSITION_REGISTRY_SCHEMA_VERSION,
    groups: {},
    relationships: [],
    wallVisibilityStates: {}
  };
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function documentType(document) {
  return normalizeIdentity(
    document?.documentName
      || document?.constructor?.metadata?.name
      || document?.constructor?.name?.replace(/Document$/, '')
  );
}

function nativeBoolean(document, field) {
  const sourceValue = document?._source?.[field];
  return typeof sourceValue === 'boolean' ? sourceValue : document?.[field] === true;
}

function wallVisibilityState(document) {
  const state = {};
  for (const field of WALL_VISIBILITY_FIELDS) {
    const value = Number(document?._source?.[field] ?? document?.[field]);
    if (!Number.isFinite(value)) {
      throw new SceneGroupWorkflowError('invalid-wall-visibility-state', 'preflight-documents', {
        identities: [normalizeIdentity(document?.uuid), field]
      });
    }
    state[field] = value;
  }
  return state;
}

function sameWallVisibilityState(document, expected) {
  try {
    const current = wallVisibilityState(document);
    return WALL_VISIBILITY_FIELDS.every((field) => (
      !Object.prototype.hasOwnProperty.call(expected || {}, field)
      || current[field] === expected[field]
    ));
  } catch (_error) {
    return false;
  }
}

function documentLabel(document) {
  const type = documentType(document) || 'Document';
  const name = normalizeIdentity(document?.name || document?.id || document?.uuid || type);
  return `${type} ${name}`;
}

function finiteCoordinate(value, document, field) {
  const coordinate = Number(value);
  if (Number.isFinite(coordinate)) return coordinate;
  throw new SceneGroupWorkflowError('invalid-member-position', 'preflight-move', {
    identities: [normalizeIdentity(document?.uuid), field],
    message: `Cannot move ${documentLabel(document)} because ${field} is not a finite native coordinate.`
  });
}

function serializeRegionShape(shape) {
  if (typeof shape?.toObject === 'function') return clone(shape.toObject());
  return clone(shape);
}

function translateRegionShapeFallback(shape, delta, document) {
  const translated = serializeRegionShape(shape);
  const type = normalizeIdentity(translated?.type).toLowerCase();
  const translateXY = () => {
    translated.x = finiteCoordinate(translated.x, document, `shapes.${type}.x`) + delta.x;
    translated.y = finiteCoordinate(translated.y, document, `shapes.${type}.y`) + delta.y;
  };
  if (['rectangle', 'circle', 'ellipse', 'cone', 'ring', 'line', 'token'].includes(type)) {
    translateXY();
    return translated;
  }
  if (type === 'polygon') {
    const points = Array.from(translated?.points || []).map(Number);
    if (points.length < 4 || points.length % 2 !== 0 || !points.every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('invalid-member-position', 'preflight-move', {
        identities: [normalizeIdentity(document?.uuid), 'shapes.polygon.points'],
        message: `Cannot move ${documentLabel(document)} because a Region polygon has invalid native points.`
      });
    }
    translated.points = points.map((coordinate, index) => coordinate + (index % 2 === 0 ? delta.x : delta.y));
    if (translated.origin) {
      translated.origin = {
        x: finiteCoordinate(translated.origin.x, document, 'shapes.polygon.origin.x') + delta.x,
        y: finiteCoordinate(translated.origin.y, document, 'shapes.polygon.origin.y') + delta.y
      };
    }
    return translated;
  }
  if (type === 'emanation' && translated.base) {
    translated.base = translateRegionShapeFallback(translated.base, delta, document);
    return translated;
  }
  throw new SceneGroupWorkflowError('region-shape-move-unsupported', 'preflight-move', {
    identities: [normalizeIdentity(document?.uuid), type || 'unknown-region-shape'],
    message: `Cannot move ${documentLabel(document)} because Region shape ${type || 'unknown'} has no native move adapter.`
  });
}

function translateRegionShape(shape, delta, document, nativeShape) {
  if (typeof nativeShape?.clone === 'function'
    && typeof nativeShape?.move === 'function'
    && typeof nativeShape?.toObject === 'function') {
    // The live model may already contain an earlier preview. Rehydrate the
    // captured geometry before applying this frame's absolute group delta.
    const translated = nativeShape.clone(shape);
    const originX = finiteCoordinate(translated?.origin?.x, document, `shapes.${shape?.type || 'unknown'}.origin.x`);
    const originY = finiteCoordinate(translated?.origin?.y, document, `shapes.${shape?.type || 'unknown'}.origin.y`);
    translated.move({ x: originX + delta.x, y: originY + delta.y }, { snap: false });
    return serializeRegionShape(translated);
  }
  return translateRegionShapeFallback(shape, delta, document);
}

function readDocumentMovePosition(document) {
  const type = documentType(document);
  const generated = document?._source?.flags?.['fa-nexus']?.buildingGenerated
    || document?.flags?.['fa-nexus']?.buildingGenerated;
  // The Building authority writes a complete generated pose even for a move.
  // Capture that same scope so rollback cannot delete uncaptured existing fields.
  if (generated?.version === 1 && ['Tile', 'Wall'].includes(type)) {
    return readDocumentTransformState(document, 'move');
  }
  if (type === 'Tile' || type === 'AmbientLight' || type === 'AmbientSound') {
    const position = {
      x: finiteCoordinate(document?._source?.x ?? document?.x, document, 'x'),
      y: finiteCoordinate(document?._source?.y ?? document?.y, document, 'y')
    };
    if (type === 'Tile') {
      const semanticFlags = readSemanticTileFlags(document);
      if (semanticFlags) position['flags.fa-nexus'] = semanticFlags;
    }
    return position;
  }
  if (type === 'Wall') {
    const coordinates = Array.from(document?.c || []).map(Number);
    if (coordinates.length !== 4 || !coordinates.every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('invalid-member-position', 'preflight-move', {
        identities: [normalizeIdentity(document?.uuid), 'c'],
        message: `Cannot move ${documentLabel(document)} because its native Wall coordinates are invalid.`
      });
    }
    const state = { c: coordinates };
    const flags = document?._source?.flags?.['fa-nexus'] || document?.flags?.['fa-nexus'];
    if (flags?.buildingSeamlessSecretDoor?.surfacePlan?.version === 2) {
      state['flags.fa-nexus.buildingSeamlessSecretDoor'] = clone(flags.buildingSeamlessSecretDoor);
    }
    return state;
  }
  if (type === 'Region') {
    const shapes = Array.from(document?.shapes || []);
    if (!shapes.length) {
      throw new SceneGroupWorkflowError('invalid-member-position', 'preflight-move', {
        identities: [normalizeIdentity(document?.uuid), 'shapes'],
        message: `Cannot move ${documentLabel(document)} because it has no native Region shapes.`
      });
    }
    return { shapes: shapes.map(serializeRegionShape) };
  }
  throw new SceneGroupWorkflowError('group-move-unsupported', 'preflight-move', {
    identities: [normalizeIdentity(document?.uuid), type || 'unknown'],
    message: `Cannot move ${documentLabel(document)} because its document type has no semantic move adapter.`
  });
}

function translateDocumentMovePosition(document, original, delta) {
  const type = documentType(document);
  if (type === 'Tile' || type === 'AmbientLight' || type === 'AmbientSound') {
    const target = { x: original.x + delta.x, y: original.y + delta.y };
    if (type === 'Tile' && original['flags.fa-nexus']) {
      const anchorX = Number(document?.texture?.anchorX);
      const anchorY = Number(document?.texture?.anchorY);
      const translatedFlags = translateSemanticTileFlags({
        flags: original['flags.fa-nexus'],
        delta,
        flattenedTransform: transformFlattenedMetadataForTarget,
        targetTile: {
          x: target.x,
          y: target.y,
          width: Number(original?.width ?? document?.width) || 0,
          height: Number(original?.height ?? document?.height) || 0,
          rotation: Number(original?.rotation ?? document?.rotation) || 0,
          anchorX: Number.isFinite(anchorX) ? anchorX : 0.5,
          anchorY: Number.isFinite(anchorY) ? anchorY : 0.5
        }
      });
      if (JSON.stringify(translatedFlags) !== JSON.stringify(original['flags.fa-nexus'])) {
        target['flags.fa-nexus'] = translatedFlags;
      }
    }
    return target;
  }
  if (type === 'Wall') {
    const target = {
      c: original.c.map((coordinate, index) => coordinate + (index % 2 === 0 ? delta.x : delta.y))
    };
    const seamless = original['flags.fa-nexus.buildingSeamlessSecretDoor'];
    if (seamless) {
      const plan = seamless.surfacePlan;
      target['flags.fa-nexus.buildingSeamlessSecretDoor'] = {...clone(seamless),
        surfacePlan: transformBuildingV2SeamlessSurface(plan, {
          a:{x:plan.span.start.x+delta.x,y:plan.span.start.y+delta.y},
          b:{x:plan.span.end.x+delta.x,y:plan.span.end.y+delta.y}
        })};
    }
    return target;
  }
  if (type === 'Region') {
    return { shapes: original.shapes.map((shape, index) => translateRegionShape(shape, delta, document, document.shapes?.[index])) };
  }
  throw new SceneGroupWorkflowError('group-move-unsupported', 'preflight-move', {
    identities: [normalizeIdentity(document?.uuid), type || 'unknown']
  });
}

function sameMovePosition(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const REGION_TRANSFORM_CAPABILITIES = Object.freeze({
  rectangle: Object.freeze({ rotate: 'position-and-orientation', scale: 'position-and-dimensions' }),
  circle: Object.freeze({ rotate: 'position-with-orientation-no-op', scale: 'position-and-radius' }),
  ellipse: Object.freeze({ rotate: 'position-and-orientation', scale: 'position-and-radii' }),
  cone: Object.freeze({ rotate: 'position-and-orientation', scale: 'position-and-radius' }),
  ring: Object.freeze({ rotate: 'position-with-orientation-no-op', scale: 'position-and-radii' }),
  line: Object.freeze({ rotate: 'position-and-orientation', scale: 'position-and-dimensions' }),
  polygon: Object.freeze({ rotate: 'all-points-and-explicit-origin', scale: 'all-points-and-explicit-origin' }),
  emanation: Object.freeze({ rotate: 'recursive-base', scale: 'recursive-base-and-radius' }),
  token: Object.freeze({ rotate: 'blocker', scale: 'blocker' }),
  grid: Object.freeze({ rotate: 'blocker', scale: 'blocker' })
});

function transformStage(operation) {
  return `preflight-${operation}`;
}

function finiteTransformValue(value, document, field, operation) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const uuid = normalizeIdentity(document?.uuid);
  throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(operation), {
    identities: [`${uuid}#${field}`],
    message: `${documentLabel(document)} has an invalid native ${field} value.`
  });
}

function nullableTransformValue(value, document, field, operation) {
  if (value == null) return null;
  return finiteTransformValue(value, document, field, operation);
}

function cleanTransformValue(value, { integer = false } = {}) {
  const cleaned = integer ? Math.round(value) : Math.round(value * 1e12) / 1e12;
  return Object.is(cleaned, -0) ? 0 : cleaned;
}

function normalizeTransformAngle(value) {
  const normalized = value % 360;
  const cleaned = cleanTransformValue(normalized < 0 ? normalized + 360 : normalized);
  return cleaned >= 360 ? 0 : cleaned;
}

function normalizeStoredGroupDefaults(registry) {
  const defaultedGroupIds = [];
  for (const group of Object.values(registry?.groups || {})) {
    let changed = false;
    if (!Object.prototype.hasOwnProperty.call(group, 'frameAngle')) {
      group.frameAngle = 0;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(group, 'pivotMode')) {
      group.pivotMode = SCENE_GROUP_PIVOT_MODES.AUTOMATIC;
      changed = true;
    }
    if (changed) defaultedGroupIds.push(normalizeIdentity(group?.id));
  }
  return defaultedGroupIds.filter(Boolean);
}

function transformPoint({ x, y }, pivot, transform, { integer = false } = {}) {
  if (transform.operation === 'reflect') return {
    x: cleanTransformValue(pivot.x + (x-pivot.x)*(transform.flipX ? -1 : 1), {integer}),
    y: cleanTransformValue(pivot.y + (y-pivot.y)*(transform.flipY ? -1 : 1), {integer})
  };
  if (transform.operation === 'scale-axes') {
    const angle = Number(transform.axisAngle || 0) * (Math.PI / 180);
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const dx = x - pivot.x;
    const dy = y - pivot.y;
    const localX = (dx * cosine) + (dy * sine);
    const localY = (-dx * sine) + (dy * cosine);
    return {
      x: cleanTransformValue(
        pivot.x + ((localX * transform.scaleX) * cosine) - ((localY * transform.scaleY) * sine),
        { integer }
      ),
      y: cleanTransformValue(
        pivot.y + ((localX * transform.scaleX) * sine) + ((localY * transform.scaleY) * cosine),
        { integer }
      )
    };
  }
  const scale = transform.operation === 'scale' ? transform.factor : 1;
  const angle = transform.operation === 'rotate' ? transform.angle * (Math.PI / 180) : 0;
  const dx = (x - pivot.x) * scale;
  const dy = (y - pivot.y) * scale;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: cleanTransformValue(pivot.x + (dx * cosine) - (dy * sine), { integer }),
    y: cleanTransformValue(pivot.y + (dx * sine) + (dy * cosine), { integer })
  };
}

function transformRegionShape(shape, pivot, transform, document, shapePath) {
  const target = serializeRegionShape(shape);
  const type = normalizeIdentity(target?.type).toLowerCase();
  const capabilityOperation = transform.operation === 'scale-axes' ? 'scale' : transform.operation;
  const capability = REGION_TRANSFORM_CAPABILITIES[type]?.[capabilityOperation];
  if (!capability || capability === 'blocker') {
    const identity = `${normalizeIdentity(document?.uuid)}#${shapePath}.${type || 'unknown'}`;
    throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
      identities: [identity],
      message: `${documentLabel(document)} Region shape ${shapePath} (${type || 'unknown'}) has no safe ${transform.operation} adapter.`
    });
  }

  const transformXY = () => {
    const point = transformPoint({
      x: finiteTransformValue(target.x, document, `${shapePath}.x`, transform.operation),
      y: finiteTransformValue(target.y, document, `${shapePath}.y`, transform.operation)
    }, pivot, transform);
    target.x = point.x;
    target.y = point.y;
  };
  const scaleField = (field) => {
    const factor = transform.operation === 'scale-axes'
      ? (['height', 'radiusY'].includes(field)
          ? transform.scaleY
          : (['width', 'radiusX', 'length'].includes(field)
              ? transform.scaleX
              : Math.sqrt(transform.scaleX * transform.scaleY)))
      : transform.factor;
    target[field] = cleanTransformValue(
      finiteTransformValue(target[field], document, `${shapePath}.${field}`, transform.operation) * factor
    );
  };
  const rotateField = () => {
    target.rotation = normalizeTransformAngle(
      finiteTransformValue(target.rotation ?? 0, document, `${shapePath}.rotation`, transform.operation)
        + transform.angle
    );
  };

  if (type === 'polygon') {
    const points = Array.from(target?.points || []).map(Number);
    if (points.length < 4 || points.length % 2 !== 0 || !points.every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
        identities: [`${normalizeIdentity(document?.uuid)}#${shapePath}.points`],
        message: `${documentLabel(document)} Region polygon ${shapePath} has invalid native points.`
      });
    }
    const transformedPoints = [];
    for (let index = 0; index < points.length; index += 2) {
      const point = transformPoint({ x: points[index], y: points[index + 1] }, pivot, transform);
      transformedPoints.push(point.x, point.y);
    }
    target.points = transformedPoints;
    if (target.origin) {
      target.origin = transformPoint({
        x: finiteTransformValue(target.origin.x, document, `${shapePath}.origin.x`, transform.operation),
        y: finiteTransformValue(target.origin.y, document, `${shapePath}.origin.y`, transform.operation)
      }, pivot, transform);
    }
    return target;
  }

  if (type === 'emanation') {
    if (!target.base) {
      throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
        identities: [`${normalizeIdentity(document?.uuid)}#${shapePath}.base`],
        message: `${documentLabel(document)} Region emanation ${shapePath} has no native base shape.`
      });
    }
    target.base = transformRegionShape(target.base, pivot, transform, document, `${shapePath}.base`);
    if (transform.operation === 'scale' || transform.operation === 'scale-axes') scaleField('radius');
    return target;
  }

  transformXY();
  if (transform.operation === 'rotate') {
    if (['rectangle', 'ellipse', 'cone', 'line'].includes(type)) rotateField();
    return target;
  }

  if (type === 'rectangle') {
    scaleField('width');
    scaleField('height');
  } else if (['circle', 'cone'].includes(type)) {
    scaleField('radius');
  } else if (type === 'ellipse') {
    scaleField('radiusX');
    scaleField('radiusY');
  } else if (type === 'ring') {
    scaleField('radius');
    scaleField('innerWidth');
    scaleField('outerWidth');
  } else if (type === 'line') {
    scaleField('length');
    scaleField('width');
  }
  return target;
}

function transformRegionShapes(document, original, pivot, transform) {
  // Each pointer sample is absolute relative to the gesture's captured state.
  // The live Region already contains the previous preview, just as for move.
  const shapes = Array.from(original?.shapes || []);
  if (!shapes.length) {
    throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
      identities: [`${normalizeIdentity(document?.uuid)}#shapes`],
      message: `${documentLabel(document)} has no native Region shapes.`
    });
  }
  const targets = [];
  const blockers = [];
  for (let index = 0; index < shapes.length; index += 1) {
    try {
      targets.push(transformRegionShape(shapes[index], pivot, transform, document, `shapes.${index}`));
    } catch (error) {
      blockers.push(error);
    }
  }
  if (blockers.length) {
    throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
      identities: blockers.flatMap((error) => error?.identities || []),
      cause: new AggregateError(blockers, `Region ${transform.operation} capability blockers.`),
      message: blockers.map((error) => error?.message || String(error)).join(' ')
    });
  }
  return targets;
}

function readDocumentTransformState(document, operation) {
  const type = documentType(document);
  // The durable pose owns preview baselines, rollback and command history.
  // Prepared Tile/Light/Sound coordinates can be clamped to Scene bounds.
  const number = (field, value = document?._source?.[field] ?? document?.[field]) => finiteTransformValue(value, document, field, operation);
  if (type === 'Tile') {
    const state = {
      x: number('x'),
      y: number('y'),
      width: number('width'),
      height: number('height'),
      rotation: number('rotation', document?.rotation ?? 0)
    };
    const semanticFlags = readSemanticTileFlags(document);
    if (semanticFlags) state['flags.fa-nexus'] = semanticFlags;
    // Reflection also changes ordinary asset shadows, without semantic geometry.
    const reflectionFlags = document?._source?.flags?.['fa-nexus'] || document?.flags?.['fa-nexus'];
    if (operation === 'reflect' && reflectionFlags) state['flags.fa-nexus'] = clone(reflectionFlags);
    const generated = semanticFlags?.buildingGenerated?.version === 1;
    if (operation === 'reflect' || generated || operation === 'scale' && [4, 5].includes(Number(semanticFlags?.building?.schemaVersion))) {
      state['texture.anchorX'] = number('texture.anchorX', document?.texture?.anchorX ?? 0.5);
      state['texture.anchorY'] = number('texture.anchorY', document?.texture?.anchorY ?? 0.5);
    }
    if (operation === 'reflect' || generated) {
      state['texture.scaleX'] = number('texture.scaleX', document?.texture?.scaleX ?? 1);
      state['texture.scaleY'] = number('texture.scaleY', document?.texture?.scaleY ?? 1);
    }
    return state;
  }
  if (type === 'Wall') {
    const c = Array.from(document?.c || []).map(Number);
    if (c.length !== 4 || !c.every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(operation), {
        identities: [`${normalizeIdentity(document?.uuid)}#c`],
        message: `${documentLabel(document)} has invalid native Wall endpoints.`
      });
    }
    const state = {
      c,
      'threshold.light': nullableTransformValue(document?.threshold?.light, document, 'threshold.light', operation),
      'threshold.sight': nullableTransformValue(document?.threshold?.sight, document, 'threshold.sight', operation),
      'threshold.sound': nullableTransformValue(document?.threshold?.sound, document, 'threshold.sound', operation)
    };
    const faFlags = document?._source?.flags?.['fa-nexus'] || document?.flags?.['fa-nexus'] || {};
    const isBuildingV2Generated = faFlags.buildingGenerated?.version === 1;
    if (isBuildingV2Generated) {
      state.dir = document.dir;
      if (document.animation) state.animation = clone(document.animation);
    } else if (operation === 'reflect') {
      state.dir = document.dir;
      if (document.animation) {
        state['animation.direction'] = document.animation.direction;
        state['animation.flip'] = document.animation.flip;
      }
    }
    const isBuildingV2GeneratedPortal = faFlags.buildingGenerated?.version === 1
      && faFlags.buildingGenerated.role === 'portal';
    if (isBuildingV2GeneratedPortal) {
      state['flags.fa-nexus.buildingGenerated.textureFlip'] = clone(faFlags.buildingGenerated.textureFlip);
      if (faFlags.buildingSeamlessSecretDoor?.surfacePlan?.version === 2) {
        // The Building adapter owns the complete derived surface pose. Include
        // it in the same exact snapshot as its Wall chord for audit/rollback.
        state['flags.fa-nexus.buildingSeamlessSecretDoor'] = clone(faFlags.buildingSeamlessSecretDoor);
      }
      // V2 exact targets carry the derived texture scale for every pose change,
      // including native rotation. Read it back for audit and rollback parity.
      state['flags.core.textureGridSize'] = finiteTransformValue(
        document?._source?.flags?.core?.textureGridSize ?? document?.flags?.core?.textureGridSize ?? DEFAULT_PORTAL_TEXTURE_GRID_SIZE,
        document, 'flags.core.textureGridSize', operation
      );
      if (faFlags.doorShadow != null || faFlags.buildingGenerated.doorShadowNormal != null) {
        normalizeBuildingV2DoorShadow({ ...faFlags.doorShadow, normal: faFlags.buildingGenerated.doorShadowNormal });
        // Include generated shadow fields in the same transient snapshot as
        // the chord so Cancel and failed group transactions restore them.
        state['flags.fa-nexus.doorShadow'] = clone(faFlags.doorShadow);
        state['flags.fa-nexus.buildingGenerated.doorShadowNormal'] = clone(faFlags.buildingGenerated.doorShadowNormal);
      }
    }
    const portalKey = faFlags.buildingDoor
      ? 'buildingDoor'
      : (faFlags.buildingWindow
        ? 'buildingWindow'
        : (faFlags.buildingSeamlessSecretDoor ? 'buildingSeamlessSecretDoor' : null));
    const hasAnimatedPortal = !!(
      portalKey
      && (document?.animation?.texture || document?._source?.animation?.texture)
    );
    if (operation === 'scale') {
      if (hasAnimatedPortal) {
        const textureGridSize = finiteTransformValue(
          document?._source?.flags?.core?.textureGridSize
            ?? document?.flags?.core?.textureGridSize
            ?? globalThis?.CONFIG?.Wall?.textureGridSize
            ?? DEFAULT_PORTAL_TEXTURE_GRID_SIZE,
          document,
          'flags.core.textureGridSize',
          operation
        );
        state['flags.core.textureGridSize'] = textureGridSize;
        if (portalKey === 'buildingSeamlessSecretDoor' && !isBuildingV2GeneratedPortal) {
          const surfacePlan = faFlags.buildingSeamlessSecretDoor?.surfacePlan || {};
          state['flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.textureGridSize'] = finiteTransformValue(
            surfacePlan.textureGridSize ?? textureGridSize,
            document,
            'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.textureGridSize',
            operation
          );
        } else if (!isBuildingV2GeneratedPortal) {
          state[`flags.fa-nexus.${portalKey}.widthScale`] = finiteTransformValue(
            faFlags[portalKey]?.widthScale ?? 1,
            document,
            `flags.fa-nexus.${portalKey}.widthScale`,
            operation
          );
        }
      }
    }
    if (hasAnimatedPortal && portalKey === 'buildingSeamlessSecretDoor' && !isBuildingV2GeneratedPortal) {
      const surfacePlan = faFlags.buildingSeamlessSecretDoor?.surfacePlan || {};
      state['flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.x'] = finiteTransformValue(
        surfacePlan.visualOffset?.x ?? 0,
        document,
        'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.x',
        operation
      );
      state['flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.y'] = finiteTransformValue(
        surfacePlan.visualOffset?.y ?? 0,
        document,
        'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.y',
        operation
      );
    }
    return state;
  }
  if (type === 'AmbientLight') {
    return {
      x: number('x'),
      y: number('y'),
      rotation: number('rotation', document?.rotation ?? 0),
      'config.dim': number('config.dim', document?.config?.dim),
      'config.bright': number('config.bright', document?.config?.bright)
    };
  }
  if (type === 'AmbientSound') {
    return { x: number('x'), y: number('y'), radius: number('radius') };
  }
  if (type === 'Region') return { shapes: Array.from(document?.shapes || []).map(serializeRegionShape) };
  throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(operation), {
    identities: [normalizeIdentity(document?.uuid), type || 'unknown'],
    message: `${documentLabel(document)} has no semantic ${operation} adapter.`
  });
}

function transformDocumentState(document, original, pivot, transform) {
  const type = documentType(document);
  const integerPoint = (x, y) => transformPoint({ x, y }, pivot, transform, { integer: true });
  if (type === 'Tile') {
    const target = { ...original, ...integerPoint(original.x, original.y) };
    if (transform.operation === 'rotate') {
      target.rotation = normalizeTransformAngle(original.rotation + transform.angle);
    } else if (transform.operation === 'scale-axes') {
      target.width = Math.max(1, cleanTransformValue(original.width * transform.scaleX, { integer: true }));
      target.height = Math.max(1, cleanTransformValue(original.height * transform.scaleY, { integer: true }));
    } else {
      target.width = Math.max(0, cleanTransformValue(original.width * transform.factor, { integer: true }));
      target.height = Math.max(0, cleanTransformValue(original.height * transform.factor, { integer: true }));
    }
    const v2Building = original['flags.fa-nexus']?.building;
    if (transform.operation === 'scale' && [4, 5].includes(Number(v2Building?.schemaVersion))) {
      const v2Target = createBuildingV2UniformScaleRootTarget({
        ...(document?._source || document || {}),
        x: original.x,
        y: original.y,
        width: original.width,
        height: original.height,
        rotation: original.rotation,
        texture: {
          ...(document?._source?.texture || document?.texture || {}),
          anchorX: original['texture.anchorX'],
          anchorY: original['texture.anchorY']
        }
      }, v2Building, { pivot, factor: transform.factor });
      Object.assign(target, {
        x: v2Target.x,
        y: v2Target.y,
        width: v2Target.width,
        height: v2Target.height,
        rotation: v2Target.rotation,
        'texture.anchorX': v2Target.anchorX,
        'texture.anchorY': v2Target.anchorY
      });
    }
    if (original['flags.fa-nexus']) {
      const anchorX = Number(target['texture.anchorX'] ?? document?.texture?.anchorX);
      const anchorY = Number(target['texture.anchorY'] ?? document?.texture?.anchorY);
      const targetTile = {
          x: target.x,
          y: target.y,
          width: target.width,
          height: target.height,
          rotation: target.rotation,
          anchorX: Number.isFinite(anchorX) ? anchorX : 0.5,
          anchorY: Number.isFinite(anchorY) ? anchorY : 0.5
        };
      const transformedFlags = transform.operation === 'scale-axes'
        ? resizeSemanticTileFlags({
            flags: original['flags.fa-nexus'],
            originalTile: {
              x: original.x,
              y: original.y,
              width: original.width,
              height: original.height,
              rotation: original.rotation,
              anchorX: Number(original['texture.anchorX'] ?? document?.texture?.anchorX ?? 0.5),
              anchorY: Number(original['texture.anchorY'] ?? document?.texture?.anchorY ?? 0.5)
            },
            finalTile: targetTile
          })
        : transformSemanticTileFlags({
            flags: original['flags.fa-nexus'],
            pivot,
            transform,
            flattenedTransform: transformFlattenedMetadataForTarget,
            targetTile
          });
      if (!sameTransformState(transformedFlags, original['flags.fa-nexus'])) {
        target['flags.fa-nexus'] = transformedFlags;
      }
    }
    return target;
  }
  if (type === 'Wall') {
    const c = [];
    for (let index = 0; index < original.c.length; index += 2) {
      const point = integerPoint(original.c[index], original.c[index + 1]);
      c.push(point.x, point.y);
    }
    const target = {
      ...original,
      c
    };
    const seamless = original['flags.fa-nexus.buildingSeamlessSecretDoor'];
    if (seamless?.surfacePlan?.version === 2) {
      const plan = seamless.surfacePlan;
      const scale = transform.operation === 'scale' ? transform.factor
        : transform.operation === 'scale-axes' ? Math.sqrt(transform.scaleX * transform.scaleY) : 1;
      target['flags.fa-nexus.buildingSeamlessSecretDoor'] = { ...clone(seamless),
        surfacePlan: transformBuildingV2SeamlessSurface(plan, {
          a: transformPoint(plan.span.start, pivot, transform),
          b: transformPoint(plan.span.end, pivot, transform), scale
        }) };
    }
    if (original['flags.fa-nexus.doorShadow'] != null) {
      const scale = transform.operation === 'scale' ? transform.factor
        : transform.operation === 'scale-axes' ? Math.sqrt(transform.scaleX * transform.scaleY) : 1;
      const shadow = materializeBuildingV2DoorShadowForChord({
        ...original['flags.fa-nexus.doorShadow'],
        normal: original['flags.fa-nexus.buildingGenerated.doorShadowNormal']
      }, {
        sourceA: { x: original.c[0], y: original.c[1] }, sourceB: { x: original.c[2], y: original.c[3] },
        targetA: { x: c[0], y: c[1] }, targetB: { x: c[2], y: c[3] }, scale
      });
      const { normal, ...appearance } = shadow;
      target['flags.fa-nexus.doorShadow'] = appearance;
      target['flags.fa-nexus.buildingGenerated.doorShadowNormal'] = normal;
    }
    if (transform.operation === 'scale' || transform.operation === 'scale-axes') {
      const factor = transform.operation === 'scale-axes'
        ? Math.sqrt(transform.scaleX * transform.scaleY)
        : transform.factor;
      for (const field of ['threshold.light', 'threshold.sight', 'threshold.sound']) {
        if (original[field] != null) target[field] = cleanTransformValue(original[field] * factor);
      }
      if (original['flags.core.textureGridSize'] != null) {
        target['flags.core.textureGridSize'] = cleanTransformValue(scalePortalTextureGridSize({
          textureGridSize: original['flags.core.textureGridSize'],
          factor
        }));
      }
      const seamlessTextureGridField = 'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.textureGridSize';
      if (original[seamlessTextureGridField] != null) {
        target[seamlessTextureGridField] = cleanTransformValue(scalePortalTextureGridSize({
          textureGridSize: original[seamlessTextureGridField],
          factor
        }));
      }
      for (const portalKey of ['buildingDoor', 'buildingWindow']) {
        const field = `flags.fa-nexus.${portalKey}.widthScale`;
        if (original[field] != null) {
          target[field] = cleanTransformValue(original[field] * factor);
        }
      }
    }
    const seamlessOffsetXField = 'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.x';
    const seamlessOffsetYField = 'flags.fa-nexus.buildingSeamlessSecretDoor.surfacePlan.visualOffset.y';
    if (original[seamlessOffsetXField] != null && original[seamlessOffsetYField] != null) {
      const transformedOffset = transformPoint({
        x: original[seamlessOffsetXField],
        y: original[seamlessOffsetYField]
      }, { x: 0, y: 0 }, transform);
      target[seamlessOffsetXField] = transformedOffset.x;
      target[seamlessOffsetYField] = transformedOffset.y;
    }
    return target;
  }
  if (type === 'AmbientLight') {
    const target = { ...original, ...integerPoint(original.x, original.y) };
    if (transform.operation === 'rotate') {
      target.rotation = normalizeTransformAngle(original.rotation + transform.angle);
    } else {
      target['config.dim'] = cleanTransformValue(original['config.dim'] * transform.factor);
      target['config.bright'] = cleanTransformValue(original['config.bright'] * transform.factor);
    }
    return target;
  }
  if (type === 'AmbientSound') {
    const target = { ...original, ...integerPoint(original.x, original.y) };
    if (transform.operation === 'scale') {
      target.radius = cleanTransformValue(original.radius * transform.factor);
    }
    return target;
  }
  if (type === 'Region') return { shapes: transformRegionShapes(document, original, pivot, transform) };
  throw new SceneGroupWorkflowError('group-transform-capability-blocked', transformStage(transform.operation), {
    identities: [normalizeIdentity(document?.uuid), type || 'unknown']
  });
}

function sameTransformState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Foundry merges flag objects. Restoring a snapshot must explicitly remove fields
// introduced by the command (for example a mask's first repeat transform).
export function buildSceneGroupTransformRestore(current, desired, nested = false) {
  if (nested && Object.keys(current).some(key=>!Object.hasOwn(desired,key)||desired[key]===undefined)) {
    return forcedReplacement(desired);
  }
  const update = clone(desired);
  for (const [key, value] of Object.entries(current)) {
    if (!Object.hasOwn(desired,key) || desired[key] === undefined) {
      update[key] = forcedDeletion();
    } else if (value && desired[key] && typeof value === 'object' && typeof desired[key] === 'object'
      && !Array.isArray(value) && !Array.isArray(desired[key])) {
      update[key] = buildSceneGroupTransformRestore(value,desired[key],true);
    }
  }
  return update;
}

function canonicalizeCommittedPlans(plans, documents, operation) {
  const documentsByUuid = new Map((documents || []).map((document) => [
    normalizeIdentity(document?.uuid),
    document
  ]));
  return plans.map((plan) => {
    const document = documentsByUuid.get(plan.uuid);
    if (!document) {
      throw new SceneGroupWorkflowError('group-history-document-missing', 'record-history', {
        identities: [plan.uuid],
        message: `Cannot record Scene Group ${operation} history because ${plan.uuid} is unavailable after commit.`
      });
    }
    return {
      ...clone(plan),
      target: readSceneGroupMemberTransformState(document, operation)
    };
  });
}

function relationshipMap(registry) {
  return new Map((registry?.relationships || []).map((relationship) => [
    normalizeIdentity(relationship?.id),
    relationship
  ]).filter(([id]) => id));
}

export function buildRegistryHistoryDelta(beforeRegistry, afterRegistry) {
  const groups = [];
  const groupIds = new Set([
    ...Object.keys(beforeRegistry?.groups || {}),
    ...Object.keys(afterRegistry?.groups || {})
  ]);
  for (const groupId of groupIds) {
    const before = beforeRegistry?.groups?.[groupId] ?? null;
    const after = afterRegistry?.groups?.[groupId] ?? null;
    if (!sameTransformState(before, after)) groups.push({ id: groupId, before: clone(before), after: clone(after) });
  }
  const beforeRelationships = relationshipMap(beforeRegistry);
  const afterRelationships = relationshipMap(afterRegistry);
  const relationships = [];
  for (const relationshipId of new Set([...beforeRelationships.keys(), ...afterRelationships.keys()])) {
    const before = beforeRelationships.get(relationshipId) ?? null;
    const after = afterRelationships.get(relationshipId) ?? null;
    if (!sameTransformState(before, after)) {
      relationships.push({ id: relationshipId, before: clone(before), after: clone(after) });
    }
  }
  const wallVisibilityStates = [];
  for (const id of new Set([...Object.keys(beforeRegistry.wallVisibilityStates || {}), ...Object.keys(afterRegistry.wallVisibilityStates || {})])) {
    const before = beforeRegistry.wallVisibilityStates?.[id] ?? null;
    const after = afterRegistry.wallVisibilityStates?.[id] ?? null;
    if (!sameTransformState(before, after)) wallVisibilityStates.push({ id, before: clone(before), after: clone(after) });
  }
  // History retains presentation order without adding another durable registry.
  const order = {
    groups: { before: Object.keys(beforeRegistry.groups), after: Object.keys(afterRegistry.groups) },
    relationships: { before: [...beforeRelationships.keys()], after: [...afterRelationships.keys()] }
  };
  for (const [key, value] of Object.entries(order)) {
    if (sameTransformState(value.before, value.after)) delete order[key];
  }
  return { groups, relationships, wallVisibilityStates, order };
}

function applyRegistryHistoryDelta(currentRegistry, delta, direction) {
  const fromKey = direction === 'undo' ? 'after' : 'before';
  const toKey = direction === 'undo' ? 'before' : 'after';
  const nextRegistry = clone(currentRegistry);
  for (const change of delta?.groups || []) {
    const current = currentRegistry?.groups?.[change.id] ?? null;
    if (!sameTransformState(current, change[fromKey])) {
      throw new SceneGroupWorkflowError('group-history-diverged', `preflight-${direction}`, {
        identities: [change.id],
        message: `Scene Group ${change.id} changed after this command and cannot be ${direction === 'undo' ? 'undone' : 'redone'} safely.`
      });
    }
    if (change[toKey] == null) delete nextRegistry.groups[change.id];
    else nextRegistry.groups[change.id] = clone(change[toKey]);
  }
  const currentRelationships = relationshipMap(currentRegistry);
  const nextRelationships = relationshipMap(nextRegistry);
  for (const change of delta?.relationships || []) {
    const current = currentRelationships.get(change.id) ?? null;
    if (!sameTransformState(current, change[fromKey])) {
      throw new SceneGroupWorkflowError('group-history-diverged', `preflight-${direction}`, {
        identities: [change.id],
        message: `Composition relationship ${change.id} changed after this command and cannot be ${direction === 'undo' ? 'undone' : 'redone'} safely.`
      });
    }
    if (change[toKey] == null) nextRelationships.delete(change.id);
    else nextRelationships.set(change.id, clone(change[toKey]));
  }
  if (delta?.relationships?.length) nextRegistry.relationships = [...nextRelationships.values()];
  for (const change of delta?.wallVisibilityStates || []) {
    if (!sameTransformState(currentRegistry.wallVisibilityStates?.[change.id] ?? null, change[fromKey])) {
      throw new SceneGroupWorkflowError('group-history-diverged', `preflight-${direction}`, { identities: [change.id] });
    }
    if (change[toKey] == null) delete nextRegistry.wallVisibilityStates[change.id];
    else nextRegistry.wallVisibilityStates[change.id] = clone(change[toKey]);
  }
  // Preserve unrelated records added since this command while restoring the
  // original relative order of surviving/restored records.
  const groupOrder = delta?.order?.groups?.[toKey];
  if (groupOrder) {
    const ids = [...new Set([...groupOrder, ...Object.keys(nextRegistry.groups)])];
    nextRegistry.groups = Object.fromEntries(ids.filter((id) => nextRegistry.groups[id]).map((id) => [id, nextRegistry.groups[id]]));
  }
  const relationshipOrder = delta?.order?.relationships?.[toKey];
  if (relationshipOrder) {
    const ids = [...new Set([...relationshipOrder, ...nextRelationships.keys()])];
    nextRegistry.relationships = ids.filter((id) => nextRelationships.has(id)).map((id) => nextRelationships.get(id));
  }
  return nextRegistry;
}

export function readSceneGroupMemberTransformState(document, operation) {
  if (operation === 'move') return readDocumentMovePosition(document);
  if (operation === 'rotate' || operation === 'scale' || operation === 'reflect') {
    return readDocumentTransformState(document, operation);
  }
  throw new SceneGroupWorkflowError('group-transform-operation-unsupported', 'preview-transform', {
    identities: [normalizeIdentity(document?.uuid), normalizeIdentity(operation)]
  });
}

export function resolveSceneGroupMoveDelta(documents, delta) {
  const x = Number(delta?.x);
  const y = Number(delta?.y);
  if (![x, y].every(Number.isFinite)) {
    throw new SceneGroupWorkflowError('group-move-delta-required', 'preview-transform');
  }
  // Foundry v14 persists these coordinates as integers. Resolve one shared
  // delta before preview or persistence, rather than letting document cleaning
  // round each Tile/Wall while Regions retain a different fractional move.
  const integerCoordinates = documents.some((document) => (
    ['Tile', 'Wall', 'AmbientLight', 'AmbientSound'].includes(documentType(document))
  ));
  return integerCoordinates ? { x: Math.round(x) || 0, y: Math.round(y) || 0 } : { x, y };
}

export function buildSceneGroupMemberTransformTarget(document, original, pivot, transform) {
  if (transform?.operation === 'reflect') return {...original, ...reflectCompositionMember(document,pivot,transform)};
  if (transform?.operation === 'move') {
    const delta = { x: Number(transform?.delta?.x), y: Number(transform?.delta?.y) };
    if (![delta.x, delta.y].every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('group-move-delta-required', 'preview-transform', {
        identities: [normalizeIdentity(document?.uuid)]
      });
    }
    return translateDocumentMovePosition(document, original, delta);
  }
  if (transform?.operation === 'rotate'
    || transform?.operation === 'scale'
    || transform?.operation === 'scale-axes') {
    return transformDocumentState(document, original, pivot, transform);
  }
  throw new SceneGroupWorkflowError('group-transform-operation-unsupported', 'preview-transform', {
    identities: [normalizeIdentity(document?.uuid), normalizeIdentity(transform?.operation)]
  });
}

export function transformSceneGroupRelationshipOffsets(registry, documentUuids, transform) {
  const transformed = clone(registry.relationships || []);
  const blockers = [];
  for (const relationship of transformed) {
    if (normalizeIdentity(relationship?.type) !== 'attached-to') continue;
    const ownerUuid = normalizeIdentity(relationship?.ownerUuid);
    const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
    if (!documentUuids.has(ownerUuid) || !documentUuids.has(dependentUuid)) continue;
    const relationshipId = normalizeIdentity(relationship?.id) || 'unknown-relationship';
    try {
      const offset = relationship?.offset;
      if (!offset) throw new Error('has no persisted spatial offset');
      const x = finiteTransformValue(offset.x, null, `relationships.${relationshipId}.offset.x`, transform.operation);
      const y = finiteTransformValue(offset.y, null, `relationships.${relationshipId}.offset.y`, transform.operation);
      const rotation = finiteTransformValue(
        offset.rotation ?? 0,
        null,
        `relationships.${relationshipId}.offset.rotation`,
        transform.operation
      );
      const point = transform.operation === 'rotate' || transform.operation === 'reflect'
        ? transformPoint({ x, y }, { x: 0, y: 0 }, transform)
        : {
            x: cleanTransformValue(x * transform.factor),
            y: cleanTransformValue(y * transform.factor)
          };
      relationship.offset = { ...offset, x: point.x, y: point.y,
        rotation: transform.operation === 'reflect' && transform.flipX !== transform.flipY ? -rotation : rotation };
    } catch (error) {
      blockers.push({
        identities: [relationshipId, ownerUuid, dependentUuid],
        message: `Relationship ${relationshipId} ${error?.message || error}.`
      });
    }
  }
  return { relationships: transformed, blockers };
}

function supportsGroupMemberState(document, field) {
  const type = documentType(document);
  if (field === 'locked') return SUPPORTED_SCENE_GROUP_DOCUMENT_TYPES.includes(type);
  if (type === 'Tile') return field === 'hidden' || field === 'locked';
  if (type === 'Wall') return field === 'hidden';
  const sourceValue = document?._source?.[field];
  return typeof sourceValue === 'boolean' || typeof document?.[field] === 'boolean';
}

function deriveGroupMemberState(documents, field, { enabled, disabled }, registry) {
  const values = documents.map((document) => {
    if (!supportsGroupMemberState(document, field)) return false;
    if (field === 'locked') return isSceneMemberLocked(document);
    if (field === 'hidden' && documentType(document) === 'Wall') {
      return !!registry?.wallVisibilityStates?.[normalizeIdentity(document?.id)];
    }
    if (field === 'hidden' && documentType(document) === 'Tile') return isLayerHidden(document);
    return nativeBoolean(document, field);
  });
  const state = values.every(Boolean)
    ? enabled
    : values.every((value) => !value)
      ? disabled
      : 'mixed';
  const blockers = documents
    .filter((document) => !supportsGroupMemberState(document, field))
    .map((document) => ({
      uuid: normalizeIdentity(document?.uuid),
      documentName: documentType(document),
      name: normalizeIdentity(document?.name || documentType(document))
    }));
  return { state, blockers };
}

function pointBounds(x, y) {
  const normalizedX = Number(x);
  const normalizedY = Number(y);
  if (![normalizedX, normalizedY].every(Number.isFinite)) return null;
  return { minX: normalizedX, minY: normalizedY, maxX: normalizedX, maxY: normalizedY };
}

function wallBounds(document) {
  const coordinates = Array.from(document?.c || []);
  if (coordinates.length !== 4 || !coordinates.every((value) => Number.isFinite(Number(value)))) return null;
  const [x1, y1, x2, y2] = coordinates.map(Number);
  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2)
  };
}

function regionShapeBounds(shape) {
  const type = normalizeIdentity(shape?.type).toLowerCase();
  if (type === 'rectangle') {
    const x = Number(shape?.x);
    const y = Number(shape?.y);
    const width = Number(shape?.width);
    const height = Number(shape?.height);
    if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
    return { minX: x, minY: y, maxX: x + width, maxY: y + height };
  }
  if (type === 'circle') {
    const x = Number(shape?.x);
    const y = Number(shape?.y);
    const radius = Number(shape?.radius);
    if (![x, y, radius].every(Number.isFinite) || radius < 0) return null;
    return { minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius };
  }
  if (type === 'ellipse') {
    const x = Number(shape?.x);
    const y = Number(shape?.y);
    const radiusX = Number(shape?.radiusX);
    const radiusY = Number(shape?.radiusY);
    if (![x, y, radiusX, radiusY].every(Number.isFinite) || radiusX < 0 || radiusY < 0) return null;
    return { minX: x - radiusX, minY: y - radiusY, maxX: x + radiusX, maxY: y + radiusY };
  }
  if (type === 'polygon') {
    const points = Array.from(shape?.points || []).map(Number);
    if (points.length < 4 || points.length % 2 !== 0 || !points.every(Number.isFinite)) return null;
    const xs = points.filter((_, index) => index % 2 === 0);
    const ys = points.filter((_, index) => index % 2 === 1);
    return {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys)
    };
  }
  return null;
}

function regionBounds(document) {
  const shapes = Array.from(document?.shapes || []);
  if (!shapes.length) return null;
  const bounds = shapes.map(regionShapeBounds).filter(Boolean);
  if (bounds.length !== shapes.length) return null;
  return bounds.reduce((aggregate, current) => ({
    minX: Math.min(aggregate.minX, current.minX),
    minY: Math.min(aggregate.minY, current.minY),
    maxX: Math.max(aggregate.maxX, current.maxX),
    maxY: Math.max(aggregate.maxY, current.maxY)
  }));
}

function rectangleBounds(bounds) {
  if (!bounds) return null;
  const x = Number(bounds.x ?? bounds.minX);
  const y = Number(bounds.y ?? bounds.minY);
  const width = Number(bounds.width ?? (Number(bounds.maxX) - x));
  const height = Number(bounds.height ?? (Number(bounds.maxY) - y));
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
  return { minX: x, minY: y, maxX: x + width, maxY: y + height };
}

function documentBounds(document) {
  const nativeShapeBounds = rectangleBounds(document?.shape?.bounds);
  if (nativeShapeBounds) return nativeShapeBounds;

  const placeableBounds = rectangleBounds(document?.object?.bounds);
  if (placeableBounds) return placeableBounds;

  const type = documentType(document);
  const adaptedBounds = type === 'Wall'
    ? wallBounds(document)
    : (type === 'AmbientLight' || type === 'AmbientSound')
        ? pointBounds(document?.x, document?.y)
        : type === 'Region'
          ? regionBounds(document)
          : null;
  if (adaptedBounds) return adaptedBounds;

  const x = Number(document?.x);
  const y = Number(document?.y);
  const width = Number(document?.width);
  const height = Number(document?.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 0 || height < 0) {
    throw new SceneGroupWorkflowError('invalid-member-bounds', 'validate-members', {
      identities: [normalizeIdentity(document?.uuid || document?.id)]
    });
  }

  const anchorX = Number(document?.texture?.anchorX ?? 0.5);
  const anchorY = Number(document?.texture?.anchorY ?? 0.5);
  const rotation = Number(document?.rotation || 0);
  if (![anchorX, anchorY, rotation].every(Number.isFinite)) {
    throw new SceneGroupWorkflowError('invalid-member-bounds', 'validate-members', {
      identities: [normalizeIdentity(document?.uuid || document?.id)]
    });
  }
  const radians = rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const localCorners = [
    [-anchorX * width, -anchorY * height],
    [(1 - anchorX) * width, -anchorY * height],
    [(1 - anchorX) * width, (1 - anchorY) * height],
    [-anchorX * width, (1 - anchorY) * height]
  ];
  const corners = localCorners.map(([localX, localY]) => ({
    x: x + (cos * localX) - (sin * localY),
    y: y + (sin * localX) + (cos * localY)
  }));
  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    minY: Math.min(...corners.map((corner) => corner.y)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    maxY: Math.max(...corners.map((corner) => corner.y))
  };
}

export function getSceneGroupDocumentBounds(document) {
  return documentBounds(document);
}

function boundsCorners(bounds) {
  return [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY }
  ];
}

function frameAxes(angle) {
  const radians = Number(angle) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: { x: cosine, y: sine },
    y: { x: -sine, y: cosine }
  };
}

function frameAlignedEllipsePoints(shape, frameAngle, document) {
  const x = Number(shape?.x);
  const y = Number(shape?.y);
  const radiusX = Number(shape?.type === 'circle' ? shape?.radius : shape?.radiusX);
  const radiusY = Number(shape?.type === 'circle' ? shape?.radius : shape?.radiusY);
  const rotation = Number(shape?.rotation || 0) * Math.PI / 180;
  if (![x, y, radiusX, radiusY, rotation].every(Number.isFinite) || radiusX < 0 || radiusY < 0) {
    throw new SceneGroupWorkflowError('invalid-member-bounds', 'resolve-frame', {
      identities: [normalizeIdentity(document?.uuid || document?.id)]
    });
  }
  const axes = frameAxes(frameAngle);
  const projectedRadius = (axis) => {
    const localX = (axis.x * Math.cos(rotation)) + (axis.y * Math.sin(rotation));
    const localY = (-axis.x * Math.sin(rotation)) + (axis.y * Math.cos(rotation));
    return Math.hypot(radiusX * localX, radiusY * localY);
  };
  const extentX = projectedRadius(axes.x);
  const extentY = projectedRadius(axes.y);
  return [
    { x: x - (axes.x.x * extentX), y: y - (axes.x.y * extentX) },
    { x: x + (axes.x.x * extentX), y: y + (axes.x.y * extentX) },
    { x: x - (axes.y.x * extentY), y: y - (axes.y.y * extentY) },
    { x: x + (axes.y.x * extentY), y: y + (axes.y.y * extentY) }
  ];
}

function polygonPoints(polygon) {
  const coordinates = Array.from(polygon?.points || []).map(Number);
  if (coordinates.length < 4 || coordinates.length % 2 !== 0 || !coordinates.every(Number.isFinite)) return [];
  const points = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    points.push({ x: coordinates[index], y: coordinates[index + 1] });
  }
  return points;
}

function shapeFramePoints(shape, frameAngle, document) {
  const type = normalizeIdentity(shape?.type).toLowerCase();
  if (type === 'circle' || type === 'ellipse') {
    return frameAlignedEllipsePoints(shape, frameAngle, document);
  }
  const points = Array.from(shape?.polygons || []).flatMap(polygonPoints);
  if (points.length) return points;
  if (type === 'polygon') {
    const directPoints = polygonPoints(shape);
    if (directPoints.length) return directPoints;
  }
  if (type === 'rectangle') {
    return tileFramePoints({
      x: shape?.x,
      y: shape?.y,
      width: shape?.width,
      height: shape?.height,
      rotation: shape?.rotation,
      texture: { anchorX: shape?.anchorX ?? 0, anchorY: shape?.anchorY ?? 0 }
    });
  }
  throw new SceneGroupWorkflowError('invalid-member-bounds', 'resolve-frame', {
    identities: [normalizeIdentity(document?.uuid || document?.id), type || 'unknown-shape'],
    message: `${documentLabel(document)} has no transform-stable ${type || 'unknown'} frame geometry.`
  });
}

function tileFramePoints(document) {
  const x = Number(document?._source?.x ?? document?.x);
  const y = Number(document?._source?.y ?? document?.y);
  const width = Number(document?.width);
  const height = Number(document?.height);
  const anchorX = Number(document?.texture?.anchorX ?? 0.5);
  const anchorY = Number(document?.texture?.anchorY ?? 0.5);
  const rotation = Number(document?.rotation || 0);
  if (![x, y, width, height, anchorX, anchorY, rotation].every(Number.isFinite)
    || width < 0 || height < 0) {
    throw new SceneGroupWorkflowError('invalid-member-bounds', 'validate-members', {
      identities: [normalizeIdentity(document?.uuid || document?.id)]
    });
  }
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    [-anchorX * width, -anchorY * height],
    [(1 - anchorX) * width, -anchorY * height],
    [(1 - anchorX) * width, (1 - anchorY) * height],
    [-anchorX * width, (1 - anchorY) * height]
  ].map(([localX, localY]) => ({
    x: x + (cosine * localX) - (sine * localY),
    y: y + (sine * localX) + (cosine * localY)
  }));
}

function documentFramePoints(document, frameAngle) {
  const type = documentType(document);
  if (type === 'Tile') return tileFramePoints(document);
  if (type === 'Wall') {
    const coordinates = Array.from(document?.c || []).map(Number);
    if (coordinates.length === 4 && coordinates.every(Number.isFinite)) {
      return [
        { x: coordinates[0], y: coordinates[1] },
        { x: coordinates[2], y: coordinates[3] }
      ];
    }
  }
  if (type === 'AmbientLight' || type === 'AmbientSound') {
    if (document?.shape) return shapeFramePoints(document.shape, frameAngle, document);
  }
  if (type === 'Region') {
    const shapes = Array.from(document?.shapes || []);
    if (shapes.length) return shapes.flatMap((shape) => shapeFramePoints(shape, frameAngle, document));
  }
  return boundsCorners(documentBounds(document));
}

export function getSceneGroupOrientedFrame(documents, angle = 0) {
  const members = Array.from(documents || []);
  if (!members.length) {
    throw new SceneGroupWorkflowError('empty-group-frame', 'resolve-frame');
  }
  const normalizedAngle = normalizeTransformAngle(Number(angle));
  if (!Number.isFinite(normalizedAngle)) {
    throw new SceneGroupWorkflowError('invalid-group-frame-angle', 'resolve-frame');
  }
  const radians = normalizedAngle * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const localPoints = members.flatMap((document) => documentFramePoints(document, normalizedAngle)).map((point) => ({
    x: (cosine * point.x) + (sine * point.y),
    y: (-sine * point.x) + (cosine * point.y)
  }));
  const minX = Math.min(...localPoints.map((point) => point.x));
  const minY = Math.min(...localPoints.map((point) => point.y));
  const maxX = Math.max(...localPoints.map((point) => point.x));
  const maxY = Math.max(...localPoints.map((point) => point.y));
  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  return {
    angle: normalizedAngle,
    center: {
      x: cleanTransformValue((cosine * localCenter.x) - (sine * localCenter.y)),
      y: cleanTransformValue((sine * localCenter.x) + (cosine * localCenter.y))
    },
    width: cleanTransformValue(maxX - minX),
    height: cleanTransformValue(maxY - minY)
  };
}

export function validateSceneGroupBounds(bounds) {
  if (!bounds || ![bounds.center?.x,bounds.center?.y,bounds.width,bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) throw new Error('Group bounds need a finite center and positive width and height.');
  return {center:{x:bounds.center.x,y:bounds.center.y},width:bounds.width,height:bounds.height};
}

export function getSceneGroupFrame(documents, group) {
  return group?.bounds
    ? {...validateSceneGroupBounds(group.bounds),angle:normalizeTransformAngle(Number(group.frameAngle)||0)}
    : getSceneGroupOrientedFrame(documents,group?.frameAngle||0);
}

export function transformSceneGroupFrame(group, pivot, transform) {
  if (group.bounds) {
    const bounds = validateSceneGroupBounds(group.bounds);
    bounds.center = transform.operation === 'move'
      ? {x:bounds.center.x+transform.delta.x,y:bounds.center.y+transform.delta.y}
      : transformPoint(bounds.center,pivot,transform);
    if (transform.operation === 'scale') { bounds.width *= transform.factor; bounds.height *= transform.factor; }
    group.bounds = bounds;
  }
  if (transform.operation === 'rotate') group.frameAngle = normalizeTransformAngle((Number(group.frameAngle)||0)+transform.angle);
  else if (transform.operation === 'reflect' && transform.flipX !== transform.flipY) group.frameAngle = normalizeTransformAngle(-(Number(group.frameAngle)||0));
}

function computePivot(documents) {
  return getSceneGroupOrientedFrame(documents, 0).center;
}

function defaultCreateGroupId() {
  const foundryId = globalThis.foundry?.utils?.randomID?.();
  if (foundryId) return foundryId;
  const platformId = globalThis.crypto?.randomUUID?.();
  if (platformId) return platformId;
  throw new SceneGroupWorkflowError('group-id-unavailable', 'plan-write');
}

async function defaultResolveDocument(uuid) {
  if (typeof globalThis.fromUuid === 'function') return await globalThis.fromUuid(uuid);
  if (typeof globalThis.fromUuidSync === 'function') return globalThis.fromUuidSync(uuid);
  throw new SceneGroupWorkflowError('document-resolver-unavailable', 'resolve-members', {
    identities: [uuid]
  });
}

async function defaultReadRegistry(scene) {
  if (!scene?.getFlag) throw new SceneGroupWorkflowError('scene-read-unavailable', 'read-registry');
  return scene.getFlag('fa-nexus', COMPOSITION_REGISTRY_FLAG);
}

async function defaultWriteRegistry(scene, registry, {removeEmpty = false, hadModuleFlags = true} = {}) {
  if (!scene?.getFlag || !scene?.update) {
    throw new SceneGroupWorkflowError('scene-write-unavailable', 'commit-registry');
  }
  const diffObject = globalThis.foundry?.utils?.diffObject;
  if (typeof diffObject !== 'function') {
    throw new SceneGroupWorkflowError('registry-diff-unavailable', 'commit-registry');
  }
  // Placement Undo restores absence only when this command introduced the
  // registry and no surviving content still needs it. Other module flags stay.
  if (removeEmpty && !Object.keys(registry.groups).length && !registry.relationships.length
    && !Object.keys(registry.wallVisibilityStates).length) {
    const path = !hadModuleFlags && Object.keys(scene.flags['fa-nexus'] || {}).every(key => key === COMPOSITION_REGISTRY_FLAG)
      ? 'flags.-=fa-nexus' : `flags.fa-nexus.-=${COMPOSITION_REGISTRY_FLAG}`;
    await scene.update({[path]: null});
    return registry;
  }
  const stored = scene.getFlag('fa-nexus', COMPOSITION_REGISTRY_FLAG) || {};
  const changes = diffObject(stored, registry, { bidirectional: true });
  if (!Object.keys(changes).length) return registry;
  await scene.update({
    flags: {
      'fa-nexus': {
        [COMPOSITION_REGISTRY_FLAG]: changes
      }
    }
  });
  return registry;
}

async function defaultRunRegistryTransaction({ scene } = {}, operation) {
  return runFoundryCompositionRegistryTransaction({ scene }, operation);
}

async function runRegistryTransactionDirect(_context, operation) {
  return operation();
}

async function defaultUpdateDocuments(scene, documentName, updates, options = {}) {
  if (!scene?.updateEmbeddedDocuments) {
    throw new SceneGroupWorkflowError('document-update-unavailable', 'update-documents', {
      identities: [documentName]
    });
  }
  return await scene.updateEmbeddedDocuments(documentName, updates, options);
}

async function defaultDeleteDocuments(scene, documentName, ids, options = {}) {
  if (!scene?.deleteEmbeddedDocuments) {
    throw new SceneGroupWorkflowError('document-delete-unavailable', 'delete-documents', {
      identities: [documentName]
    });
  }
  return await scene.deleteEmbeddedDocuments(documentName, ids, options);
}

async function defaultRestoreDocuments(scene, documentName, payloads, options = {}) {
  if (!scene?.createEmbeddedDocuments) {
    throw new SceneGroupWorkflowError('document-restore-unavailable', 'rollback-delete', {
      identities: [documentName]
    });
  }
  return await scene.createEmbeddedDocuments(documentName, payloads, { ...options, keepId: true });
}

function defaultSerializeDocument(document) {
  if (typeof document?.toObject !== 'function') {
    throw new SceneGroupWorkflowError('document-serialization-unavailable', 'preflight-delete', {
      identities: [normalizeIdentity(document?.uuid)]
    });
  }
  return document.toObject();
}

export class SceneGroupWorkflowError extends Error {
  constructor(code, stage, {
    identities = [],
    cause = null,
    message = '',
    rollback = null,
    residue = null,
    recovery = null,
    commitApplied = false
  } = {}) {
    const normalizedCode = normalizeIdentity(code) || 'scene-group-workflow-failed';
    const normalizedStage = normalizeIdentity(stage) || 'unknown';
    const affected = identities.map(normalizeIdentity).filter(Boolean);
    super(message || `${normalizedCode} during ${normalizedStage}${affected.length ? `: ${affected.join(', ')}` : ''}`, { cause });
    this.name = 'SceneGroupWorkflowError';
    this.code = normalizedCode;
    this.stage = normalizedStage;
    this.identities = affected;
    this.rollback = rollback ? clone(rollback) : null;
    this.residue = residue == null ? null : clone(residue);
    this.recovery = recovery == null ? null : String(recovery);
    this.commitApplied = commitApplied === true;
  }
}

// Resolve one translation boundary from the authoritative ownership trees. Both
// preview and commit use this UUID union; native selected Tiles never cut a group.
export function resolveSceneGroupMoveSelection(registry, { groupId, groupIds = [], documentUuids = [] } = {}) {
  const primaryGroupId = normalizeIdentity(groupId);
  const selectedIds = [...new Set([primaryGroupId, ...groupIds].map(normalizeIdentity).filter(Boolean))];
  if (!primaryGroupId || !registry?.groups?.[primaryGroupId]) {
    throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [primaryGroupId] });
  }
  for (const id of selectedIds) {
    if (!registry.groups[id]) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [id] });
    }
  }
  const selectedSet = new Set(selectedIds);
  const roots = selectedIds.filter((id) => {
    const visited = new Set([id]);
    let parentId = registry.groups[id].parentId;
    while (parentId) {
      if (visited.has(parentId)) throw new SceneGroupWorkflowError('group-cycle', 'resolve-move-selection');
      if (selectedSet.has(parentId)) return false;
      visited.add(parentId);
      parentId = registry.groups[parentId]?.parentId;
    }
    return true;
  });
  const affectedGroupIds = new Set(roots);
  const memberUuids = new Set();
  for (const id of affectedGroupIds) {
    for (const uuid of registry.groups[id].directMemberUuids) memberUuids.add(uuid);
    for (const group of Object.values(registry.groups)) {
      if (group.parentId === id) affectedGroupIds.add(group.id);
    }
  }
  const outgoing = new Map();
  const incoming = new Map();
  for (const relationship of registry.relationships || []) {
    const dependents = outgoing.get(relationship.ownerUuid) || [];
    dependents.push(relationship.dependentUuid);
    outgoing.set(relationship.ownerUuid, dependents);
    incoming.set(relationship.dependentUuid, relationship.ownerUuid);
  }
  const expand = (uuids) => {
    for (const uuid of uuids) {
      for (const dependent of outgoing.get(uuid) || []) uuids.add(dependent);
    }
    return uuids;
  };
  expand(memberUuids);
  const standaloneUuids = [...new Set(documentUuids.map(normalizeIdentity).filter(Boolean))];
  const allUuids = expand(new Set([...memberUuids, ...standaloneUuids]));
  const directOwners = new Map(Object.values(registry.groups).flatMap((group) => (
    group.directMemberUuids.map((uuid) => [uuid, group.id])
  )));
  for (const uuid of allUuids) {
    const owningGroupId = directOwners.get(uuid);
    if (owningGroupId && !affectedGroupIds.has(owningGroupId)) {
      throw new SceneGroupWorkflowError('move-selection-unselected-group', 'resolve-move-selection', {
        identities: [uuid, owningGroupId]
      });
    }
    const ownerUuid = incoming.get(uuid);
    if (ownerUuid && !allUuids.has(ownerUuid)) {
      throw new SceneGroupWorkflowError('move-selection-incomplete-composition', 'resolve-move-selection', {
        identities: [uuid, ownerUuid]
      });
    }
  }
  return {
    groupId: primaryGroupId,
    groupIds: roots,
    affectedGroupIds: [...affectedGroupIds],
    standaloneDocumentUuids: standaloneUuids.filter((uuid) => !memberUuids.has(uuid)),
    documentUuids: [...allUuids]
  };
}

export class SceneGroupWorkflow {
  constructor(options = {}) {
    const {
    readRegistry = defaultReadRegistry,
    writeRegistry = defaultWriteRegistry,
    resolveDocument = defaultResolveDocument,
    updateDocuments = defaultUpdateDocuments,
    deleteDocuments = defaultDeleteDocuments,
    restoreDocuments = defaultRestoreDocuments,
    serializeDocument = defaultSerializeDocument,
    createGroupId = defaultCreateGroupId,
    logger = Logger,
    recordCommand = recordSceneGroupCommand,
    supportedDocumentTypes = SUPPORTED_SCENE_GROUP_DOCUMENT_TYPES,
    runRegistryTransaction = null
    } = options;
    this._readRegistry = readRegistry;
    this._writeRegistry = writeRegistry;
    this._resolveDocument = resolveDocument;
    this._updateDocuments = updateDocuments;
    this._deleteDocuments = deleteDocuments;
    this._restoreDocuments = restoreDocuments;
    this._serializeDocument = serializeDocument;
    this._createGroupId = createGroupId;
    this._logger = logger;
    this._recordCommand = recordCommand;
    this._supportedDocumentTypes = new Set(supportedDocumentTypes);
    const usesFoundryRegistry = readRegistry === defaultReadRegistry && writeRegistry === defaultWriteRegistry;
    this._runRegistryTransaction = runRegistryTransaction
      || (usesFoundryRegistry ? defaultRunRegistryTransaction : runRegistryTransactionDirect);
  }

  async execute({ scene, user, action } = {}) {
    const actionType = normalizeIdentity(action?.type || 'read');
    try {
      const executeAction = async () => {
      const allowedMissingUuids = actionType === 'reconcile-native-deletion'
        ? new Set(Array.isArray(action?.memberUuids)
            ? action.memberUuids.map(normalizeIdentity).filter(Boolean)
            : [])
        : actionType === 'replace-generated-members'
          ? new Set(Array.isArray(action?.previousMemberUuids)
              ? action.previousMemberUuids.map(normalizeIdentity).filter(Boolean)
              : [])
        : actionType === 'adopt-generated-path-walls'
          ? new Set(Array.isArray(action?.previousDependentUuids)
              ? action.previousDependentUuids.map(normalizeIdentity).filter(Boolean)
              : [])
        : actionType === 'adopt-generated-building-documents'
          ? new Set(Array.isArray(action?.previousDependentUuids)
              ? action.previousDependentUuids.map(normalizeIdentity).filter(Boolean)
              : [])
        : null;
      const registry = await this._loadRegistry(scene, {
        allowMissingUuids: allowedMissingUuids,
        tolerateMissing: ['read', 'repair-missing-references', 'reconcile-native-deletion'].includes(actionType),
        allowMissingRelationshipDescendantsOf: actionType === 'reconcile-native-deletion'
          ? Array.from(allowedMissingUuids)
          : null
      });
      if (actionType === 'read') return await this._result(scene, registry, { tolerateMissing: true });
      if (actionType === 'repair-missing-references') {
        this._authorizeWrite(scene, user);
        const missing = await this._missingRegistryUuids(scene, registry);
        const repaired = this._repairMissingRegistry(registry, missing);
        await this._validateRegistry(scene, repaired);
        if (missing.size) await this._writeRegistry(scene, repaired);
        this._logger?.info?.('SceneGroupWorkflow.registry.missingReferencesRemoved', {
          sceneId: scene.id, missingUuids: [...missing]
        });
        return this._result(scene, repaired);
      }
      if (actionType === 'prepare-capture-area') return await this._prepareCaptureArea({ scene, user, action, registry });
      if (actionType === 'create-captured-group') return await this._createCapturedGroup({ scene, user, action, registry });
      if (actionType === 'create-layer-groups') return await this._createLayerGroups({scene, user, action, registry});
      if (actionType === 'prepare-create-group') {
        return await this._prepareCreateGroup({ scene, user, action, registry });
      }
      if (actionType === 'create-group') return await this._createGroup({ scene, user, action, registry });
      if (actionType === 'rename-group') return await this._renameGroup({ scene, user, action, registry });
      if (actionType === 'set-group-icon') {
        this._authorizeWrite(scene, user);
        const icon = validateSceneGroupIcon(action.icon);
        const iconColor = action.iconColor === undefined ? undefined : validateSceneGroupIconColor(action.iconColor);
        if (action.ownerUuid) {
          const [root] = await this._resolveStructureDocuments(registry, action.ownerUuid, scene);
          if (!root.canUserModify(user, 'update')) throw new Error('Cannot change this structure icon.');
          await this._updateDocuments(scene, 'Tile', [{ _id: root.id, 'flags.fa-nexus.sceneGroupIcon': icon,
            ...(iconColor === undefined ? {} : {'flags.fa-nexus.sceneGroupIconColor':iconColor}) }]);
          return this._result(scene, registry);
        }
        if (!registry.groups[action.groupId]) throw new Error('Scene Group no longer exists.');
        const next = clone(registry);
        if (icon) next.groups[action.groupId].icon = icon; else delete next.groups[action.groupId].icon;
        if (iconColor !== undefined) {
          if (iconColor) next.groups[action.groupId].iconColor = iconColor;
          else delete next.groups[action.groupId].iconColor;
        }
        await this._validateRegistry(scene, next);
        await this._writeRegistryEdit(scene, registry, next, { groupId: action.groupId, operation: 'icon', actionType });
        return this._result(scene, next);
      }
      if (actionType === 'reparent') return await this._reparent({ scene, user, action, registry });
      if (actionType === 'reparent-items') return await this._reparentItems({ scene, user, action, registry });
      if (actionType === 'ungroup') return await this._ungroup({ scene, user, action, registry });
      if (actionType === 'dissolve-group') return await this._dissolveGroup({ scene, user, action, registry });
      if (actionType === 'move-group') return await this._moveGroup({ scene, user, action, registry });
      if (actionType === 'undo-group-command') {
        return await this._applyGroupHistory({
          scene,
          user,
          action,
          registry,
          direction: 'undo'
        });
      }
      if (actionType === 'set-group-pivot') {
        return await this._setGroupPivot({ scene, user, action, registry });
      }
      if (actionType === 'set-group-bounds') return await this._setGroupBounds({scene,user,action,registry});
      if (['rotate-group', 'scale-group', 'reflect-group', 'reset-building-scale'].includes(actionType)) {
        return await this._transformGroup({ scene, user, actionType, action, registry });
      }
      if (actionType === 'rename-structure') {
        this._authorizeWrite(scene, user);
        const [root] = await this._resolveStructureDocuments(registry, action.ownerUuid, scene);
        const name = normalizeIdentity(action.name);
        if (!name || !root.canUserModify(user, 'update')) throw new Error('Cannot rename this structure.');
        await this._updateDocuments(scene, 'Tile', [{ _id: root.id, name }]);
        return this._result(scene, registry);
      }
      if (['hide-structure', 'show-structure', 'lock-structure', 'unlock-structure'].includes(actionType)) {
        return await this._setGroupMemberState({ scene, user,
          actionType: actionType.replace('-structure', '-group'), action, registry });
      }
      if (['hide-member', 'show-member', 'lock-member', 'unlock-member'].includes(actionType)) {
        return await this._setGroupMemberState({ scene, user,
          actionType: actionType.replace('-member', '-group'), action, registry });
      }
      if (['hide-group', 'show-group', 'lock-group', 'unlock-group'].includes(actionType)) {
        return await this._setGroupMemberState({ scene, user, actionType, action, registry });
      }
      if (actionType === 'prepare-delete-group') {
        return await this._prepareDeleteGroup({ scene, user, action, registry });
      }
      if (actionType === 'delete-group') {
        return await this._deleteGroup({ scene, user, action, registry });
      }
      if (actionType === 'reconcile-native-deletion') {
        return await this._reconcileNativeDeletion({ scene, user, action, registry });
      }
      if (actionType === 'restore-native-deletion') {
        return await this._restoreNativeDeletion({ scene, user, action, registry });
      }
      if (actionType === 'replace-generated-members') {
        return await this._replaceGeneratedMembers({ scene, user, action, registry });
      }
      if (actionType === 'adopt-generated-path-walls') {
        return await this._adoptGeneratedPathWalls({ scene, user, action, registry });
      }
      if (actionType === 'adopt-generated-building-documents') {
        return await this._adoptGeneratedBuildingDocuments({ scene, user, action, registry });
      }
      if (actionType === 'make-generated-independent') {
        return await this._makeGeneratedIndependent({ scene, user, action, registry });
      }
      if (actionType === 'select-group') {
        const groupId = normalizeIdentity(action?.groupId);
        if (!registry.groups[groupId]) {
          throw new SceneGroupWorkflowError('group-not-found', 'select-group', { identities: [groupId] });
        }
        return await this._result(scene, registry, { selectedGroupId: groupId });
      }
      throw new SceneGroupWorkflowError('unsupported-action', 'dispatch', { identities: [actionType] });
      };
      const readOnly = ['read', 'prepare-capture-area', 'prepare-create-group', 'prepare-delete-group', 'select-group'].includes(actionType);
      return readOnly
        ? await executeAction()
        : await this._runRegistryTransaction({ scene, user, action, actionType }, executeAction);
    } catch (error) {
      const failure = error instanceof SceneGroupWorkflowError
        ? error
        : new SceneGroupWorkflowError(error?.code || 'scene-group-workflow-failed', error?.phase || actionType, {
          cause: error,
          message: String(error?.message || error),
          rollback: error?.rollback,
          residue: error?.residue,
          recovery: error?.recovery,
          commitApplied: error?.commitApplied
        });
      this._logger?.error?.('SceneGroupWorkflow.execute.failed', {
        action: actionType,
        stage: failure.stage,
        code: failure.code,
        identities: failure.identities,
        rollback: failure.rollback,
        residue: failure.residue,
        recovery: failure.recovery,
        commitApplied: failure.commitApplied,
        error: failure.message
      });
      throw failure;
    }
  }

  async _loadRegistry(scene, {
    allowMissingUuids = null,
    tolerateMissing = false,
    allowMissingRelationshipDescendantsOf = null
  } = {}) {
    const stored = await this._readRegistry(scene);
    const registry = stored == null ? createEmptyRegistry() : clone(stored);
    if (registry.wallVisibilityStates == null) registry.wallVisibilityStates = {};
    const defaultedGroupIds = normalizeStoredGroupDefaults(registry);
    if (defaultedGroupIds.length) {
      this._logger?.info?.('SceneGroupWorkflow.registry.groupTransformDefaultsApplied', {
        sceneId: normalizeIdentity(scene?.id),
        groupIds: defaultedGroupIds
      });
    }
    if (Array.isArray(allowMissingRelationshipDescendantsOf) && allowMissingUuids) {
      const queue = allowMissingRelationshipDescendantsOf.map(normalizeIdentity).filter(Boolean);
      for (let index = 0; index < queue.length; index += 1) {
        const ownerUuid = queue[index];
        for (const relationship of registry.relationships || []) {
          if (normalizeIdentity(relationship?.ownerUuid) !== ownerUuid) continue;
          const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
          if (!dependentUuid || allowMissingUuids.has(dependentUuid)) continue;
          allowMissingUuids.add(dependentUuid);
          queue.push(dependentUuid);
        }
      }
    }
    if (tolerateMissing) allowMissingUuids = new Set([
      ...(allowMissingUuids || []), ...await this._missingRegistryUuids(scene, registry)
    ]);
    await this._validateRegistry(scene, registry, { allowMissingUuids });
    return registry;
  }

  async _missingRegistryUuids(scene, registry) {
    const uuids = new Set([
      ...Object.values(registry.groups || {}).flatMap(group => group.directMemberUuids || []),
      ...(Array.isArray(registry.relationships) ? registry.relationships : []).flatMap(r => [r.ownerUuid, r.dependentUuid])
    ]);
    const missing = new Set();
    for (const uuid of uuids) {
      // Only absent supported documents in this exact Scene are repairable.
      // Foreign references, schema errors and ownership conflicts still fail.
      const parts = String(uuid || '').split('.');
      if (parts.length === 4 && parts[0] === 'Scene' && parts[1] === scene.id
        && this._supportedDocumentTypes.has(parts[2]) && parts[3]
        && !await this._resolveDocument(uuid, scene)) missing.add(uuid);
    }
    return missing;
  }

  _repairMissingRegistry(registry, missing) {
    const next = clone(registry);
    const incoming = new Map(registry.relationships.map(r => [r.dependentUuid, r.ownerUuid]));
    const membership = new Map(Object.values(registry.groups).flatMap(g => g.directMemberUuids.map(uuid => [uuid, g.id])));
    for (const relation of registry.relationships) {
      if (!missing.has(relation.ownerUuid) || missing.has(relation.dependentUuid)) continue;
      let ancestor = relation.ownerUuid;
      const visited = new Set();
      while (!membership.has(ancestor) && incoming.has(ancestor) && !visited.has(ancestor)) {
        visited.add(ancestor); ancestor = incoming.get(ancestor);
      }
      const groupId = membership.get(ancestor);
      if (groupId) next.groups[groupId].directMemberUuids.push(relation.dependentUuid);
    }
    // Preserve every live descendant and its remaining ownership subtree. A
    // missing owner is not evidence that its live outputs should be destroyed.
    return this._registryAfterDocumentDeletion(next, missing).registry;
  }

  async _validateRegistry(scene, registry, { allowMissingUuids = null } = {}) {
    if (!registry || typeof registry !== 'object' || Array.isArray(registry)) {
      throw new SceneGroupWorkflowError('invalid-registry', 'validate-registry');
    }
    const schemaVersion = Number(registry.schemaVersion);
    if (schemaVersion !== COMPOSITION_REGISTRY_SCHEMA_VERSION) {
      const code = schemaVersion > COMPOSITION_REGISTRY_SCHEMA_VERSION
        ? 'unknown-future-schema-version'
        : 'unsupported-schema-version';
      throw new SceneGroupWorkflowError(code, 'validate-schema', {
        identities: [String(registry.schemaVersion ?? 'missing')]
      });
    }
    if (!registry.groups || typeof registry.groups !== 'object' || Array.isArray(registry.groups)) {
      throw new SceneGroupWorkflowError('invalid-groups-registry', 'validate-registry');
    }
    if (!Array.isArray(registry.relationships)) {
      throw new SceneGroupWorkflowError('invalid-relationships-registry', 'validate-registry');
    }
    if (!registry.wallVisibilityStates
      || typeof registry.wallVisibilityStates !== 'object'
      || Array.isArray(registry.wallVisibilityStates)) {
      throw new SceneGroupWorkflowError('invalid-wall-visibility-registry', 'validate-registry');
    }
    for (const [uuid, state] of Object.entries(registry.wallVisibilityStates)) {
      if (!normalizeIdentity(uuid)
        || !state
        || typeof state !== 'object'
        || Array.isArray(state)
        || !WALL_VISIBILITY_FIELDS.every((field) => Number.isFinite(Number(state[field])))) {
        throw new SceneGroupWorkflowError('invalid-wall-visibility-state', 'validate-registry', {
          identities: [normalizeIdentity(uuid) || 'missing-wall-uuid']
        });
      }
    }

    const memberships = new Map();
    const childrenByParent = new Map();
    for (const [groupKey, group] of Object.entries(registry.groups)) {
      const groupId = normalizeIdentity(group?.id);
      if (!groupId || groupId !== groupKey) {
        throw new SceneGroupWorkflowError('invalid-group-id', 'validate-groups', { identities: [groupKey] });
      }
      if (!normalizeIdentity(group?.name)) {
        throw new SceneGroupWorkflowError('invalid-group-name', 'validate-groups', { identities: [groupId] });
      }
      if (group.icon != null) validateSceneGroupIcon(group.icon);
      if (group.iconColor != null) validateSceneGroupIconColor(group.iconColor);
      if (group.bounds != null) validateSceneGroupBounds(group.bounds);
      if (!Array.isArray(group?.directMemberUuids)) {
        throw new SceneGroupWorkflowError('invalid-group-members', 'validate-groups', { identities: [groupId] });
      }
      if (![group?.pivot?.x, group?.pivot?.y].every((value) => Number.isFinite(Number(value)))) {
        throw new SceneGroupWorkflowError('invalid-group-pivot', 'validate-groups', { identities: [groupId] });
      }
      if (!Object.values(SCENE_GROUP_PIVOT_MODES).includes(group?.pivotMode)) {
        throw new SceneGroupWorkflowError('invalid-group-pivot-mode', 'validate-groups', { identities: [groupId] });
      }
      if (!Number.isFinite(Number(group?.frameAngle))) {
        throw new SceneGroupWorkflowError('invalid-group-frame-angle', 'validate-groups', { identities: [groupId] });
      }
      for (const rawUuid of group.directMemberUuids) {
        const uuid = normalizeIdentity(rawUuid);
        if (!uuid) {
          throw new SceneGroupWorkflowError('invalid-member-uuid', 'validate-members', { identities: [groupId] });
        }
        const owner = memberships.get(uuid);
        if (owner) {
          throw new SceneGroupWorkflowError('duplicate-direct-membership', 'validate-members', {
            identities: [uuid, owner, groupId]
          });
        }
        memberships.set(uuid, groupId);
        if (!allowMissingUuids?.has?.(uuid)) await this._requireSupportedDocument(uuid, scene);
      }

      const parentId = group?.parentId == null ? null : normalizeIdentity(group.parentId);
      if (group?.parentId != null && !parentId) {
        throw new SceneGroupWorkflowError('invalid-group-parent', 'validate-groups', { identities: [groupId] });
      }
      if (parentId === groupId) {
        throw new SceneGroupWorkflowError('group-cycle', 'validate-groups', { identities: [groupId] });
      }
      const siblings = childrenByParent.get(parentId) || [];
      siblings.push(groupId);
      childrenByParent.set(parentId, siblings);
    }

    for (const group of Object.values(registry.groups)) {
      const parentId = group.parentId == null ? null : normalizeIdentity(group.parentId);
      if (parentId && !registry.groups[parentId]) {
        throw new SceneGroupWorkflowError('group-parent-not-found', 'validate-groups', {
          identities: [group.id, parentId]
        });
      }
      if (!group.directMemberUuids.length && !(childrenByParent.get(group.id)?.length)) {
        throw new SceneGroupWorkflowError('empty-group', 'validate-groups', { identities: [group.id] });
      }
    }

    const validated = new Set();
    const validateAncestors = (groupId, path = []) => {
      if (validated.has(groupId)) return;
      const cycleIndex = path.indexOf(groupId);
      if (cycleIndex >= 0) {
        throw new SceneGroupWorkflowError('group-cycle', 'validate-groups', {
          identities: [...path.slice(cycleIndex), groupId]
        });
      }
      const parentId = registry.groups[groupId]?.parentId;
      if (parentId) validateAncestors(parentId, [...path, groupId]);
      validated.add(groupId);
    };
    for (const groupId of Object.keys(registry.groups)) {
      validateAncestors(groupId);
    }

    const relationshipIds = new Set();
    const incomingRelationshipByDependent = new Map();
    const dependentsByOwner = new Map();
    for (const relationship of registry.relationships) {
      const relationshipId = normalizeIdentity(relationship?.id);
      const relationshipType = normalizeIdentity(relationship?.type);
      const ownerUuid = normalizeIdentity(relationship?.ownerUuid);
      const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
      if (!relationshipId
        || !ownerUuid
        || !dependentUuid
        || ownerUuid === dependentUuid
        || !SUPPORTED_COMPOSITION_RELATIONSHIP_TYPES.has(relationshipType)) {
        throw new SceneGroupWorkflowError('invalid-composition-relationship', 'validate-relationships', {
          identities: [
            relationshipId || 'missing-id',
            relationshipType || 'missing-type',
            ownerUuid || 'missing-owner',
            dependentUuid || 'missing-dependent'
          ]
        });
      }
      if (relationshipIds.has(relationshipId)) {
        throw new SceneGroupWorkflowError('duplicate-composition-relationship', 'validate-relationships', {
          identities: [relationshipId]
        });
      }
      relationshipIds.add(relationshipId);
      const existingIncoming = incomingRelationshipByDependent.get(dependentUuid);
      if (existingIncoming) {
        throw new SceneGroupWorkflowError('duplicate-relationship-dependent', 'validate-relationships', {
          identities: [dependentUuid, existingIncoming, relationshipId]
        });
      }
      incomingRelationshipByDependent.set(dependentUuid, relationshipId);
      if (memberships.has(dependentUuid)) {
        throw new SceneGroupWorkflowError('relationship-dependent-direct-membership', 'validate-relationships', {
          identities: [dependentUuid, memberships.get(dependentUuid), relationshipId]
        });
      }
      if (!allowMissingUuids?.has?.(ownerUuid)) await this._requireSupportedDocument(ownerUuid, scene);
      if (!allowMissingUuids?.has?.(dependentUuid)) await this._requireSupportedDocument(dependentUuid, scene);
      const dependents = dependentsByOwner.get(ownerUuid) || [];
      dependents.push({ uuid: dependentUuid, relationshipId });
      dependentsByOwner.set(ownerUuid, dependents);
    }

    const relationshipVisitState = new Map();
    const validateRelationshipDescendants = (ownerUuid, path = []) => {
      const state = relationshipVisitState.get(ownerUuid) || 0;
      if (state === 2) return;
      if (state === 1) {
        const cycleIndex = path.indexOf(ownerUuid);
        throw new SceneGroupWorkflowError('composition-relationship-cycle', 'validate-relationships', {
          identities: [...path.slice(Math.max(0, cycleIndex)), ownerUuid]
        });
      }
      relationshipVisitState.set(ownerUuid, 1);
      for (const dependent of dependentsByOwner.get(ownerUuid) || []) {
        validateRelationshipDescendants(dependent.uuid, [...path, ownerUuid]);
      }
      relationshipVisitState.set(ownerUuid, 2);
    };
    for (const ownerUuid of dependentsByOwner.keys()) validateRelationshipDescendants(ownerUuid);
    return registry;
  }

  _collectGroupMemberUuids(registry, groupId) {
    const memberUuids = [];
    const visit = (currentId) => {
      const group = registry.groups[currentId];
      if (!group) return;
      memberUuids.push(...group.directMemberUuids);
      for (const child of Object.values(registry.groups)) {
        if (child.parentId === currentId) visit(child.id);
      }
    };
    visit(groupId);
    return memberUuids;
  }

  _collectGroupIds(registry, groupId) {
    const groupIds = [];
    const visit = (currentId) => {
      const group = registry.groups[currentId];
      if (!group) return;
      groupIds.push(currentId);
      for (const child of Object.values(registry.groups)) {
        if (child.parentId === currentId) visit(child.id);
      }
    };
    visit(groupId);
    return groupIds;
  }

  _collectRelationshipDescendants(registry, ownerUuids, { allowRootDependents = false } = {}) {
    const outgoingByOwner = new Map();
    for (const relationship of registry.relationships) {
      const ownerUuid = normalizeIdentity(relationship?.ownerUuid);
      if (!ownerUuid) {
        throw new SceneGroupWorkflowError('invalid-composition-relationship', 'resolve-relationships', {
          identities: [normalizeIdentity(relationship?.id) || 'missing-id', 'missing-owner']
        });
      }
      const outgoing = outgoingByOwner.get(ownerUuid) || [];
      outgoing.push(relationship);
      outgoingByOwner.set(ownerUuid, outgoing);
    }

    const roots = Array.from(new Set(ownerUuids.map(normalizeIdentity).filter(Boolean)));
    const rootSet = new Set(roots);
    const visitedDocuments = new Set(roots);
    const visitedRelationships = new Set();
    const descendants = [];
    const queue = roots.slice();
    while (queue.length) {
      const ownerUuid = queue.shift();
      for (const relationship of outgoingByOwner.get(ownerUuid) || []) {
        const relationshipId = normalizeIdentity(relationship?.id);
        const relationshipType = normalizeIdentity(relationship?.type);
        const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
        if (!relationshipId || !dependentUuid || !SUPPORTED_COMPOSITION_RELATIONSHIP_TYPES.has(relationshipType)) {
          throw new SceneGroupWorkflowError('invalid-composition-relationship', 'resolve-relationships', {
            identities: [relationshipId || 'missing-id', ownerUuid, dependentUuid || 'missing-dependent', relationshipType || 'missing-type']
          });
        }
        if (visitedRelationships.has(relationshipId)) {
          throw new SceneGroupWorkflowError('duplicate-composition-relationship', 'resolve-relationships', {
            identities: [relationshipId]
          });
        }
        if (visitedDocuments.has(dependentUuid)) {
          if (allowRootDependents && rootSet.has(dependentUuid)) continue;
          throw new SceneGroupWorkflowError('composition-relationship-tree-conflict', 'resolve-relationships', {
            identities: [relationshipId, ownerUuid, dependentUuid]
          });
        }
        visitedRelationships.add(relationshipId);
        visitedDocuments.add(dependentUuid);
        descendants.push({
          relationship,
          relationshipId,
          relationshipType,
          ownerUuid,
          dependentUuid
        });
        queue.push(dependentUuid);
      }
    }
    return descendants;
  }

  _collectEffectiveGroupMemberUuids(registry, groupId) {
    const directMemberUuids = this._collectGroupMemberUuids(registry, groupId);
    const relationshipDescendants = this._collectRelationshipDescendants(registry, directMemberUuids);
    return [
      ...directMemberUuids,
      ...relationshipDescendants.map((entry) => entry.dependentUuid)
    ];
  }

  async _requireSupportedDocument(uuid, scene) {
    const document = await this._resolveDocument(uuid, scene);
    if (!document) {
      throw new SceneGroupWorkflowError('missing-document', 'resolve-members', { identities: [uuid] });
    }
    const type = documentType(document);
    if (!this._supportedDocumentTypes.has(type)) {
      throw new SceneGroupWorkflowError('unsupported-document', 'validate-members', {
        identities: [uuid, type || 'unknown']
      });
    }
    const sceneId = normalizeIdentity(scene?.id);
    if (sceneId && !uuid.startsWith(`Scene.${sceneId}.`)) {
      throw new SceneGroupWorkflowError('foreign-scene-document', 'validate-members', { identities: [uuid, sceneId] });
    }
    return document;
  }

  async _resolveGroupDocuments(registry, groupId, scene) {
    if (!registry.groups[groupId]) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }
    const documents = [];
    for (const uuid of this._collectEffectiveGroupMemberUuids(registry, groupId)) {
      documents.push(await this._requireSupportedDocument(uuid, scene));
    }
    return documents;
  }

  async _validateBuildingV2TransformAggregates(scene, registry, documents) {
    const movedUuids = new Set(documents.map((document) => normalizeIdentity(document?.uuid)));
    for (const root of documents) {
      const manifest = readBuildingV2TransformManifest(root);
      if (!manifest) continue;
      let expectedDocuments;
      try {
        expectedDocuments = [];
        for (const entry of manifest.expected) {
          expectedDocuments.push(await this._requireSupportedDocument(entry.dependentUuid, scene));
        }
        validateBuildingV2TransformAggregate(manifest, {
          registry,
          expectedDocuments,
          sceneDocuments: collectBuildingV2SceneDocuments(scene)
        });
        if (expectedDocuments.some((document) => !movedUuids.has(normalizeIdentity(document?.uuid)))) {
          throw new Error('Building Editor V2 transform would omit a generated document from the Scene Group operation.');
        }
      } catch (cause) {
        if (cause instanceof SceneGroupWorkflowError) throw cause;
        throw new SceneGroupWorkflowError('building-v2-aggregate-invalid', 'preflight-transform', {
          identities: [manifest.rootUuid],
          cause,
          message: cause?.message || String(cause)
        });
      }
    }
  }

  _authorizeWrite(scene, user) {
    if (!user?.isGM) throw new SceneGroupWorkflowError('gm-required', 'authorize');
    if (!scene?.canUserModify?.(user, 'update') && typeof scene?.canUserModify === 'function') {
      throw new SceneGroupWorkflowError('scene-update-forbidden', 'authorize', {
        identities: [normalizeIdentity(scene?.id)]
      });
    }
  }

  _pruneEmptyGroups(registry) {
    return pruneEmptySceneGroups(registry);
  }

  _resolveCreateGroupStructure(action, registry) {
    const memberUuids = Array.isArray(action?.memberUuids)
      ? action.memberUuids.map(normalizeIdentity).filter(Boolean)
      : [];
    const groupIds = Array.isArray(action?.groupIds)
      ? action.groupIds.map(normalizeIdentity).filter(Boolean)
      : [];
    const allowParentChange = action?.allowParentChange === true;
    const parentSpecified = Object.prototype.hasOwnProperty.call(action || {}, 'parentGroupId');
    const requestedParentId = action?.parentGroupId == null ? null : normalizeIdentity(action.parentGroupId);
    if (parentSpecified && action?.parentGroupId != null && !requestedParentId) {
      throw new SceneGroupWorkflowError('invalid-group-parent', 'validate-input');
    }
    if (requestedParentId && !registry.groups[requestedParentId]) {
      throw new SceneGroupWorkflowError('group-parent-not-found', 'validate-input', {
        identities: [requestedParentId]
      });
    }
    if (!memberUuids.length && !groupIds.length) {
      throw new SceneGroupWorkflowError('group-members-required', 'validate-input');
    }
    const uniqueMembers = new Set(memberUuids);
    if (uniqueMembers.size !== memberUuids.length) {
      throw new SceneGroupWorkflowError('duplicate-direct-membership', 'validate-input', {
        identities: memberUuids
      });
    }
    const uniqueGroups = new Set(groupIds);
    if (uniqueGroups.size !== groupIds.length) {
      throw new SceneGroupWorkflowError('duplicate-group-selection', 'validate-input', {
        identities: groupIds
      });
    }
    if (allowParentChange && groupIds.length) {
      throw new SceneGroupWorkflowError('group-parent-change-unsupported', 'validate-input', {
        identities: groupIds,
        message: 'Automatic Scene Group relocation only supports direct document members.'
      });
    }

    const existingMemberships = new Map();
    for (const group of Object.values(registry.groups)) {
      for (const uuid of group.directMemberUuids) existingMemberships.set(uuid, group.id);
    }
    const selectedGroups = groupIds.map((groupId) => {
      const group = registry.groups[groupId];
      if (!group) {
        throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
      }
      return group;
    });
    const sourceParentIds = new Set([
      ...memberUuids.map((uuid) => existingMemberships.get(uuid) || null),
      ...selectedGroups.map((group) => group.parentId || null)
    ]);
    if (sourceParentIds.size > 1) {
      throw new SceneGroupWorkflowError('mixed-selection-depth', 'validate-input', {
        identities: [...memberUuids, ...groupIds],
        message: 'Create Group requires documents and child groups from the same structural parent.'
      });
    }
    const inferredParentId = sourceParentIds.values().next().value || null;
    const parentId = parentSpecified
      ? requestedParentId
      : inferredParentId;
    if (!allowParentChange && parentId !== inferredParentId) {
      throw new SceneGroupWorkflowError('mixed-selection-depth', 'validate-input', {
        identities: [...memberUuids, ...groupIds],
        message: 'Create Group requires documents and child groups from the same structural parent.'
      });
    }
    return {
      memberUuids,
      groupIds,
      selectedGroups,
      uniqueMembers,
      parentId
    };
  }

  async _prepareCreateGroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const structure = this._resolveCreateGroupStructure(action, registry);
    try {
      resolveSceneGroupNameBase(action?.namingIntent);
    } catch (cause) {
      throw new SceneGroupWorkflowError('invalid-group-naming-intent', 'validate-input', {
        cause,
        identities: [
          normalizeIdentity(action?.namingIntent?.kind),
          normalizeIdentity(action?.namingIntent?.documentType)
        ]
      });
    }
    return {
      parentGroupId: structure.parentId,
      namingIntent: clone(action.namingIntent),
      proposedName: resolveNextSceneGroupName({
        groups: registry.groups,
        parentGroupId: structure.parentId,
        namingIntent: action.namingIntent
      })
    };
  }

  async _prepareCaptureArea({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const documents = [];
    const labels = { Tile: 'Tiles', Wall: 'Walls', AmbientLight: 'Lights', AmbientSound: 'Sounds', Region: 'Regions' };
    const folders = getSceneLayerManagerSections(scene);
    const levelId = globalThis.canvas?.scene?.id === scene.id ? globalThis.canvas?.level?.id : null;
    const selectionOptions=action.selectionOptions||{};
    const matchingTiles=selectionOptions.matchingTileIds?new Set(selectionOptions.matchingTileIds):null;
    for (const type of this._supportedDocumentTypes) {
      let index = 0;
      for (const document of scene.getEmbeddedCollection(type)) {
        const levels = getRawLevelIds(document);
        const flags = document.flags?.['fa-nexus'] || {};
        if (flags.buildingCommitMutex) continue;
        const folderPath = [];
        let folderId = type === 'Tile' ? folders.memberships[document.id] : null;
        while (folderId) {
          const folder = folders.sections[folderId];
          folderPath.unshift({ id: folderId, name: folder.name });
          folderId = folder.parentId;
        }
        index++;
        documents.push({ uuid: document.uuid,
          captureExcluded:!capturePassesSelectionOptions({elevation:Number(document.elevation?.bottom??document.elevation)||0,
            locked:isSceneMemberLocked(document),hidden:type==='Wall'?!!registry.wallVisibilityStates?.[document.id]:isLayerHidden(document)||nativeBoolean(document,'hidden'),
            filtered:type==='Tile'?!!matchingTiles&&!matchingTiles.has(document.id):document.object?.isFilteredOut===true},selectionOptions),
          documentName: type, elevation: Number(document.elevation?.bottom ?? document.elevation) || 0, folderPath,
          label: type === 'Tile' ? resolveTileDisplayName(document) : (document.name || `${labels[type].replace(/s$/, '')} ${index}`),
          category: flags.building ? 'Buildings' : (flags.path || flags.pathV2) ? 'Paths' : labels[type],
          eligible: (!levelId || !levels.length || levels.includes(levelId)),
          bounds: ['AmbientLight', 'AmbientSound'].includes(type) ? pointBounds(document.x, document.y) : documentBounds(document)
        });
      }
    }
    return { candidates: planSceneGroupCapture({ area: action.area, documents, registry, memberUuids: action.memberUuids }) };
  }

  async _createCapturedGroup({ scene, user, action, registry }) {
    const prepared = await this._prepareCaptureArea({ scene, user,
      action: { ...action, memberUuids: action.candidates?.flatMap(candidate => candidate.memberUuids) }, registry });
    const keys = [...new Set(action.selectedKeys || [])];
    const name = normalizeIdentity(action.name);
    if (!name || !keys.length) throw new Error('A name and at least one capture item are required.');
    const selected = keys.map(key => {
      const current = prepared.candidates.find(candidate => candidate.key === key);
      const reviewed = action.candidates?.find(candidate => candidate.key === key);
      if (!sameCaptureOwnership(current, reviewed)) {
        throw new Error('The selected objects or their ownership changed. Draw the area again to review them.');
      }
      return current;
    });
    const next = clone(registry);
    const create = async (name, parentId, directMemberUuids, effectiveUuids) => {
      const id = normalizeIdentity(await this._createGroupId());
      if (!id || next.groups[id]) throw new Error('Scene Group ID conflict.');
      const documents = [];
      for (const uuid of effectiveUuids) documents.push(await this._requireSupportedDocument(uuid, scene));
      const group = { id, name, parentId, directMemberUuids, pivot: computePivot(documents), pivotMode: SCENE_GROUP_PIVOT_MODES.AUTOMATIC, frameAngle: 0 };
      next.groups[id] = group;
      return group;
    };
    const root = await create(name, null, [], selected.flatMap(candidate => candidate.memberUuids));
    const icon=validateSceneGroupIcon(action.icon||''),iconColor=validateSceneGroupIconColor(action.iconColor||'');
    if(icon)root.icon=icon;if(iconColor)root.iconColor=iconColor;
    const planned = planCaptureSubgroups(selected, action);
    const branches = new Map();
    for (const { candidate, path } of planned) {
      let parent = root, key = '';
      for (const part of path) {
        key += `/${JSON.stringify(part.key)}`;
        if (!branches.has(key)) branches.set(key, await create(part.name, parent.id, [], candidate.memberUuids));
        parent = branches.get(key);
      }
      parent.directMemberUuids.push(candidate.memberUuid);
    }
    for (const branch of branches.values()) {
      const documents = await this._resolveGroupDocuments(next, branch.id, scene);
      branch.pivot = computePivot(documents);
    }
    for (const candidate of selected) if (candidate.groupId) next.groups[candidate.groupId].parentId = root.id;
    await this._validateRegistry(scene, next);
    await this._writeRegistryEdit(scene, registry, next, { groupId: root.id, operation: 'create-group', actionType: 'create-captured-group' });
    return this._result(scene, next, { selectedGroupId: root.id });
  }

  async _createLayerGroups({scene, user, action, registry}) {
    this._authorizeWrite(scene, user);
    const tree = action.layerTree, parentId = action.parentGroupId || null;
    if (tree?.sceneId !== scene.id || !Array.isArray(tree.nodes) || !Array.isArray(tree.memberUuids)) throw new Error('Invalid Layer Manager folder drop.');
    if (parentId && !registry.groups[parentId]) throw new Error('The destination Scene Group no longer exists.');
    const seen = new Set();
    const inspect = node => {
      if (!normalizeIdentity(node.name) || !Array.isArray(node.memberUuids) || !Array.isArray(node.children)) throw new Error('Invalid dragged folder.');
      for (const uuid of node.memberUuids) {
        if (seen.has(uuid)) throw new Error('A dragged Tile appears in more than one folder.');
        seen.add(uuid);
      }
      for (const child of node.children) inspect(child);
    };
    const roots = clone(tree.nodes);
    if (tree.memberUuids.length) roots.push({name:'Tiles', memberUuids:[...tree.memberUuids], children:[]});
    for (const root of roots) inspect(root);
    if (!seen.size) throw new Error('The dragged folders contain no Tiles.');
    const owners = new Map(registry.relationships.map(link => [link.dependentUuid, link.ownerUuid]));
    for (const uuid of seen) {
      const doc = await this._requireSupportedDocument(uuid, scene);
      if (documentType(doc) !== 'Tile') throw new Error('Layer Manager folders must contain Tiles.');
      let owner = uuid;
      while (owners.has(owner)) owner = owners.get(owner);
      if (!seen.has(owner)) throw new Error('Include the owning Building or Path when dragging its generated Tiles.');
    }
    const next = clone(registry);
    const rootUuids = new Set([...seen].filter(uuid => !owners.has(uuid)));
    for (const group of Object.values(next.groups)) group.directMemberUuids = group.directMemberUuids.filter(uuid => !rootUuids.has(uuid));
    const createdIds = [];
    const create = async (node, parentId) => {
      const memberUuids = node.memberUuids.filter(uuid => rootUuids.has(uuid));
      const hasMembers = current => current.memberUuids.some(uuid => rootUuids.has(uuid)) || current.children.some(hasMembers);
      if (!hasMembers(node)) return;
      const id = normalizeIdentity(await this._createGroupId());
      if (!id || next.groups[id]) throw new Error('Scene Group ID conflict.');
      next.groups[id] = {id, name:node.name, parentId, directMemberUuids:memberUuids, pivot:{x:0,y:0}, pivotMode:SCENE_GROUP_PIVOT_MODES.AUTOMATIC, frameAngle:0};
      createdIds.push(id);
      for (const child of node.children) await create(child, id);
      next.groups[id].pivot = computePivot(await this._resolveGroupDocuments(next, id, scene));
    };
    for (const root of roots) await create(root, parentId);
    this._pruneEmptyGroups(next);
    await this._validateRegistry(scene, next);
    await this._writeRegistryEdit(scene, registry, next, { groupId: createdIds[0], operation: 'create-group', actionType: 'create-layer-groups' });
    return this._result(scene, next, {selectedGroupId:parentId || createdIds[0]});
  }

  async _createGroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const name = normalizeIdentity(action?.name);
    if (!name) throw new SceneGroupWorkflowError('group-name-required', 'validate-input');
    const {
      memberUuids,
      groupIds,
      uniqueMembers,
      parentId
    } = this._resolveCreateGroupStructure(action, registry);

    const documents = [];
    for (const uuid of memberUuids) documents.push(await this._requireSupportedDocument(uuid, scene));
    for (const groupId of groupIds) {
      for (const uuid of this._collectGroupMemberUuids(registry, groupId)) {
        documents.push(await this._requireSupportedDocument(uuid, scene));
      }
    }
    const groupId = normalizeIdentity(await this._createGroupId());
    if (!groupId || registry.groups[groupId]) {
      throw new SceneGroupWorkflowError('group-id-conflict', 'plan-write', { identities: [groupId] });
    }
    const group = {
      id: groupId,
      name,
      ...(action.icon?{icon:validateSceneGroupIcon(action.icon)}:{}),
      ...(action.iconColor?{iconColor:validateSceneGroupIconColor(action.iconColor)}:{}),
      parentId,
      directMemberUuids: memberUuids,
      pivot: computePivot(documents),
      pivotMode: SCENE_GROUP_PIVOT_MODES.AUTOMATIC,
      frameAngle: 0
    };
    const nextRegistry = clone(registry);
    if (memberUuids.length) {
      for (const existingGroup of Object.values(nextRegistry.groups)) {
        existingGroup.directMemberUuids = existingGroup.directMemberUuids
          .filter((uuid) => !uniqueMembers.has(uuid));
      }
    }
    nextRegistry.groups[groupId] = group;
    for (const childGroupId of groupIds) nextRegistry.groups[childGroupId].parentId = groupId;
    this._pruneEmptyGroups(nextRegistry);
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId, operation: 'create-group', actionType: 'create-group' });
    this._logger?.info?.('SceneGroupWorkflow.create.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      memberUuids,
      childGroupIds: groupIds,
      pivot: group.pivot
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _renameGroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const groupId = normalizeIdentity(action?.groupId);
    const group = registry.groups[groupId];
    if (!group) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }
    const name = normalizeIdentity(action?.name);
    if (!name) {
      throw new SceneGroupWorkflowError('group-name-required', 'validate-input', { identities: [groupId] });
    }
    if (name === group.name) return await this._result(scene, registry, { selectedGroupId: groupId });

    const nextRegistry = clone(registry);
    nextRegistry.groups[groupId].name = name;
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId, operation: 'rename', actionType: 'rename-group' });
    this._logger?.info?.('SceneGroupWorkflow.rename.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      previousName: group.name,
      name
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _reparent({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const groupId = normalizeIdentity(action?.groupId);
    const memberUuid = normalizeIdentity(action?.memberUuid);
    if ((!groupId && !memberUuid) || (groupId && memberUuid)) {
      throw new SceneGroupWorkflowError('reparent-source-required', 'validate-input', {
        identities: [groupId, memberUuid]
      });
    }
    const parentGroupId = action?.parentGroupId == null
      ? null
      : normalizeIdentity(action.parentGroupId);
    if (action?.parentGroupId != null && !parentGroupId) {
      throw new SceneGroupWorkflowError('invalid-group-parent', 'validate-input');
    }
    if (parentGroupId && !registry.groups[parentGroupId]) {
      throw new SceneGroupWorkflowError('group-parent-not-found', 'validate-input', {
        identities: [parentGroupId]
      });
    }

    const nextRegistry = clone(registry);
    let selectedGroupId = parentGroupId;
    if (groupId) {
      const group = registry.groups[groupId];
      if (!group) {
        throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
      }
      let ancestorId = parentGroupId;
      while (ancestorId) {
        if (ancestorId === groupId) {
          throw new SceneGroupWorkflowError('group-cycle', 'validate-input', {
            identities: [groupId, parentGroupId],
            message: 'A Scene Group cannot be moved into itself or one of its descendants.'
          });
        }
        ancestorId = registry.groups[ancestorId]?.parentId || null;
      }
      if ((group.parentId || null) === parentGroupId) return await this._result(scene, registry, { selectedGroupId: groupId });
      nextRegistry.groups[groupId].parentId = parentGroupId;
      selectedGroupId = groupId;
    } else {
      await this._requireSupportedDocument(memberUuid, scene);
      let previousParentId = null;
      for (const group of Object.values(nextRegistry.groups)) {
        const memberIndex = group.directMemberUuids.indexOf(memberUuid);
        if (memberIndex < 0) continue;
        previousParentId = group.id;
        group.directMemberUuids.splice(memberIndex, 1);
      }
      if (parentGroupId === previousParentId) {
        return await this._result(scene, registry, { selectedGroupId: parentGroupId });
      }
      if (parentGroupId) nextRegistry.groups[parentGroupId].directMemberUuids.push(memberUuid);
    }

    this._pruneEmptyGroups(nextRegistry);
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId: groupId || parentGroupId, operation: 'reparent', actionType: 'reparent' });
    this._logger?.info?.('SceneGroupWorkflow.reparent.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId: groupId || null,
      memberUuid: memberUuid || null,
      parentGroupId
    });
    return await this._result(scene, nextRegistry, {
      selectedGroupId: selectedGroupId && nextRegistry.groups[selectedGroupId] ? selectedGroupId : null
    });
  }

  async _reparentItems({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const memberUuids = Array.isArray(action?.memberUuids)
      ? action.memberUuids.map(normalizeIdentity).filter(Boolean)
      : [];
    const groupIds = Array.isArray(action?.groupIds)
      ? action.groupIds.map(normalizeIdentity).filter(Boolean)
      : [];
    if (!memberUuids.length && !groupIds.length) {
      throw new SceneGroupWorkflowError('reparent-source-required', 'validate-input');
    }
    if (new Set(memberUuids).size !== memberUuids.length) {
      throw new SceneGroupWorkflowError('duplicate-direct-membership', 'validate-input', {
        identities: memberUuids
      });
    }
    if (new Set(groupIds).size !== groupIds.length) {
      throw new SceneGroupWorkflowError('duplicate-group-selection', 'validate-input', {
        identities: groupIds
      });
    }
    const parentGroupId = action?.parentGroupId == null
      ? null
      : normalizeIdentity(action.parentGroupId);
    if (action?.parentGroupId != null && !parentGroupId) {
      throw new SceneGroupWorkflowError('invalid-group-parent', 'validate-input');
    }
    if (parentGroupId && !registry.groups[parentGroupId]) {
      throw new SceneGroupWorkflowError('group-parent-not-found', 'validate-input', {
        identities: [parentGroupId]
      });
    }

    for (const memberUuid of memberUuids) await this._requireSupportedDocument(memberUuid, scene);
    for (const groupId of groupIds) {
      if (!registry.groups[groupId]) {
        throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
      }
      let ancestorId = parentGroupId;
      while (ancestorId) {
        if (ancestorId === groupId) {
          throw new SceneGroupWorkflowError('group-cycle', 'validate-input', {
            identities: [groupId, parentGroupId],
            message: 'A Scene Group cannot be moved into itself or one of its descendants.'
          });
        }
        ancestorId = registry.groups[ancestorId]?.parentId || null;
      }
    }

    const nextRegistry = clone(registry);
    for (const memberUuid of memberUuids) {
      for (const group of Object.values(nextRegistry.groups)) {
        group.directMemberUuids = group.directMemberUuids.filter((uuid) => uuid !== memberUuid);
      }
      if (parentGroupId) nextRegistry.groups[parentGroupId].directMemberUuids.push(memberUuid);
    }
    for (const groupId of groupIds) nextRegistry.groups[groupId].parentId = parentGroupId;

    this._pruneEmptyGroups(nextRegistry);
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId: parentGroupId || groupIds[0], operation: 'reparent', actionType: 'reparent-items' });
    this._logger?.info?.('SceneGroupWorkflow.reparentItems.committed', {
      sceneId: normalizeIdentity(scene?.id),
      memberUuids,
      groupIds,
      parentGroupId
    });
    return await this._result(scene, nextRegistry, {
      selectedGroupId: parentGroupId && nextRegistry.groups[parentGroupId]
        ? parentGroupId
        : groupIds.find((groupId) => nextRegistry.groups[groupId]) || null
    });
  }

  async _ungroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const groupId = normalizeIdentity(action?.groupId);
    const group = registry.groups[groupId];
    if (!group) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }

    const nextRegistry = clone(registry);
    const parentId = group.parentId || null;
    if (parentId) {
      nextRegistry.groups[parentId].directMemberUuids.push(...group.directMemberUuids);
    }
    for (const child of Object.values(nextRegistry.groups)) {
      if (child.parentId === groupId) child.parentId = parentId;
    }
    delete nextRegistry.groups[groupId];
    this._pruneEmptyGroups(nextRegistry);
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId, operation: 'ungroup', actionType: 'ungroup' });
    this._logger?.info?.('SceneGroupWorkflow.ungroup.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      parentId,
      promotedMemberUuids: group.directMemberUuids
    });
    return await this._result(scene, nextRegistry, {
      selectedGroupId: parentId && nextRegistry.groups[parentId] ? parentId : null
    });
  }

  async _dissolveGroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const group = registry.groups[normalizeIdentity(action.groupId)];
    if (!group) throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [action.groupId] });
    const ids = [group.id];
    for (let i = 0; i < ids.length; i++) {
      for (const child of Object.values(registry.groups)) if (child.parentId === ids[i]) ids.push(child.id);
    }
    const next = clone(registry);
    const members = ids.flatMap(id => next.groups[id].directMemberUuids);
    if (group.parentId) next.groups[group.parentId].directMemberUuids.push(...members);
    for (const id of ids) delete next.groups[id];
    // Relationship trees (including generated Building/Path members) are not folders.
    await this._validateRegistry(scene, next);
    await this._writeRegistryEdit(scene, registry, next, { groupId: group.id, operation: 'dissolve', actionType: 'dissolve-group' });
    this._logger?.info?.('SceneGroupWorkflow.dissolve.committed', { sceneId: scene.id, groupIds: ids, parentId: group.parentId });
    return this._result(scene, next, { selectedGroupId: group.parentId || null });
  }

  async _resolveEffectiveGroupPivot(registry, groupId, scene, documents = null) {
    const group = registry.groups[groupId];
    if (!group) {
      throw new SceneGroupWorkflowError('group-not-found', 'resolve-pivot', { identities: [groupId] });
    }
    if (group.pivotMode === SCENE_GROUP_PIVOT_MODES.CUSTOM) {
      return {
        x: finiteTransformValue(group.pivot?.x, null, `groups.${groupId}.pivot.x`, 'pivot'),
        y: finiteTransformValue(group.pivot?.y, null, `groups.${groupId}.pivot.y`, 'pivot')
      };
    }
    const resolvedDocuments = documents || await this._resolveGroupDocuments(registry, groupId, scene);
    return getSceneGroupFrame(resolvedDocuments, group).center;
  }

  /**
   * Write a registry-only edit (name, icon, nesting, pivot, new group, ungroup, dissolve) and give it an entry in the
   * member layers' Undo history, as transforms have. Without one, the edit changes a group that an earlier command
   * recorded, and that command can then never be undone.
   */
  async _writeRegistryEdit(scene, before, after, { groupId, operation, actionType }) {
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    const registryDelta = buildRegistryHistoryDelta(before, after);
    await this._writeRegistry(scene, clone(after));
    if (!registryDelta.groups.length && !registryDelta.relationships.length) return null;
    const documentTypes = new Set();
    for (const change of registryDelta.groups) {
      const documents = await this._resolveGroupDocuments(change.before ? before : after, change.id, scene);
      for (const document of documents) documentTypes.add(documentType(document));
    }
    if (!documentTypes.size) return null;
    return this._recordCommand(scene, { groupId: normalizeIdentity(groupId) || registryDelta.groups[0].id, operation, actionType,
      plans: [], documentTypes: [...documentTypes], registryDelta }, historyContext);
  }

  async _setGroupBounds({scene,user,action,registry}) {
    this._authorizeWrite(scene,user);
    const groupId = normalizeIdentity(action.groupId), group = registry.groups[groupId];
    if (!group) throw new Error('Scene Group no longer exists.');
    const documents = await this._resolveGroupDocuments(registry,groupId,scene);
    const frame = getSceneGroupFrame(documents,group);
    if (action.expectedFrame && !sameTransformState(action.expectedFrame,frame)) throw new Error('The group moved while its bounds were being edited. Reopen Edit Bounds and try again.');
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    const next = clone(registry);
    if (action.bounds == null) delete next.groups[groupId].bounds;
    else next.groups[groupId].bounds = validateSceneGroupBounds(action.bounds);
    if (group.pivotMode !== SCENE_GROUP_PIVOT_MODES.CUSTOM) next.groups[groupId].pivot = getSceneGroupFrame(documents,next.groups[groupId]).center;
    await this._validateRegistry(scene,next);
    if (sameTransformState(next,registry)) return this._result(scene,registry,{selectedGroupId:groupId});
    await this._writeRegistry(scene,next);
    this._recordCommand(scene,{groupId,operation:'bounds',actionType:'set-group-bounds',plans:[],
      documentTypes:[...new Set(documents.map(documentType))],registryDelta:buildRegistryHistoryDelta(registry,next)},historyContext);
    return this._result(scene,next,{selectedGroupId:groupId});
  }

  async _setGroupPivot({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const groupId = normalizeIdentity(action?.groupId);
    const group = registry.groups[groupId];
    if (!group) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }
    const mode = normalizeIdentity(action?.mode);
    if (!Object.values(SCENE_GROUP_PIVOT_MODES).includes(mode)) {
      throw new SceneGroupWorkflowError('group-pivot-mode-required', 'validate-input', {
        identities: [groupId, mode || 'missing-mode']
      });
    }
    let pivot;
    if (mode === SCENE_GROUP_PIVOT_MODES.CUSTOM) {
      pivot = {
        x: Number(action?.pivot?.x),
        y: Number(action?.pivot?.y)
      };
      if (![pivot.x, pivot.y].every(Number.isFinite)) {
        throw new SceneGroupWorkflowError('group-pivot-required', 'validate-input', { identities: [groupId] });
      }
    } else {
      const documents = await this._resolveGroupDocuments(registry, groupId, scene);
      pivot = getSceneGroupFrame(documents, group).center;
    }

    const nextRegistry = clone(registry);
    nextRegistry.groups[groupId].pivot = pivot;
    nextRegistry.groups[groupId].pivotMode = mode;
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistryEdit(scene, registry, nextRegistry, { groupId, operation: 'pivot', actionType: 'set-group-pivot' });
    this._logger?.info?.('SceneGroupWorkflow.pivot.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      mode,
      pivot
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _auditMoveRollback({ scene, registry, groupIds, plans, attemptedTypes, rollback }) {
    const attempted = new Set(attemptedTypes);
    for (const plan of plans) {
      if (!attempted.has(plan.documentName)) continue;
      let actual = null;
      try {
        const current = await this._resolveDocument(plan.uuid, scene);
        if (current) actual = readDocumentMovePosition(current);
      } catch (error) {
        rollback.errors.push({
          stage: 'audit-rollback-documents',
          identities: [plan.uuid],
          message: String(error?.message || error)
        });
      }
      if (actual && sameMovePosition(actual, plan.original)) {
        rollback.restoredUuids.push(plan.uuid);
        continue;
      }
      rollback.residueUuids.push(plan.uuid);
      rollback.residue.push({
        uuid: plan.uuid,
        documentName: plan.documentName,
        name: plan.name,
        expected: clone(plan.original),
        actual: clone(actual)
      });
      if (!rollback.failedIdentities.includes(plan.uuid)) rollback.failedIdentities.push(plan.uuid);
    }

    if (!rollback.registryAttempted) return rollback;
    try {
      const currentRegistry = await this._readRegistry(scene);
      for (const groupId of groupIds) {
        const expected = registry.groups[groupId]?.pivot || null;
        const actual = currentRegistry?.groups?.[groupId]?.pivot || null;
        if (sameMovePosition(actual, expected)) continue;
        rollback.registryResidueGroupIds.push(groupId);
        rollback.registryResidueDetails.push({
          groupId,
          expected: clone(expected),
          actual: clone(actual)
        });
        if (!rollback.failedIdentities.includes(groupId)) rollback.failedIdentities.push(groupId);
      }
    } catch (error) {
      rollback.registryResidueGroupIds.push(...groupIds);
      rollback.errors.push({
        stage: 'audit-rollback-registry',
        identities: groupIds,
        message: String(error?.message || error)
      });
      for (const groupId of groupIds) {
        if (!rollback.failedIdentities.includes(groupId)) rollback.failedIdentities.push(groupId);
      }
    }
    rollback.registryResidue = rollback.registryResidueGroupIds.length > 0;
    rollback.registryRestored = !rollback.registryResidue;
    return rollback;
  }

  async _rollbackMove({ scene, registry, groupIds, plans, originalBatches, attemptedTypes, registryAttempted }) {
    const rollback = {
      stage: 'rollback-group-move',
      registryAttempted,
      registryRestored: !registryAttempted,
      registryResidue: false,
      registryResidueGroupIds: [],
      registryResidueDetails: [],
      restoredUuids: [],
      failedIdentities: [],
      residueUuids: [],
      residue: [],
      errors: []
    };
    if (registryAttempted) {
      try {
        await this._writeRegistry(scene, clone(registry));
      } catch (error) {
        rollback.registryRestored = false;
        rollback.errors.push({
          stage: 'rollback-group-pivots',
          identities: groupIds,
          message: String(error?.message || error)
        });
      }
    }
    for (const documentName of [...attemptedTypes].reverse()) {
      const updates = originalBatches.get(documentName) || [];
      if (!updates.length) continue;
      const identities = plans
        .filter((plan) => plan.documentName === documentName)
        .map((plan) => plan.uuid);
      try {
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupMove: true,
          faNexusSceneGroupRollback: true
        });
      } catch (error) {
        rollback.failedIdentities.push(...identities.filter((identity) => !rollback.failedIdentities.includes(identity)));
        rollback.errors.push({
          stage: `rollback-${documentName}`,
          identities,
          message: String(error?.message || error)
        });
      }
    }
    return await this._auditMoveRollback({
      scene,
      registry,
      groupIds,
      plans,
      attemptedTypes,
      rollback
    });
  }

  async _rollbackGroupHistory({
    scene,
    registry,
    rollbackBatches,
    attemptedTypes,
    registryAttempted,
    direction
  }) {
    const errors = [];
    if (registryAttempted) {
      try {
        await this._writeRegistry(scene, clone(registry));
      } catch (error) {
        errors.push({ stage: 'rollback-registry', message: String(error?.message || error) });
      }
    }
    for (const documentName of [...attemptedTypes].reverse()) {
      const updates = rollbackBatches.get(documentName) || [];
      if (!updates.length) continue;
      try {
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupHistory: direction,
          faNexusSceneGroupRollback: true
        });
      } catch (error) {
        errors.push({
          stage: `rollback-${documentName}`,
          identities: updates.map((update) => normalizeIdentity(update?._id)).filter(Boolean),
          message: String(error?.message || error)
        });
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async _applyGroupHistory({ scene, user, action, registry, direction }) {
    this._authorizeWrite(scene, user);
    const command = beginSceneGroupCommand(scene, { commandId: action?.commandId });
    if (!command) {
      throw new SceneGroupWorkflowError('group-history-unavailable', 'preflight-undo', {
        identities: [normalizeIdentity(action?.commandId)],
        message: 'This Scene Group undo command is no longer available.'
      });
    }
    const groupId = command.groupId;
    if (command.operation === 'delete') return this._restoreDeletedGroupCommand({ scene, user, command, registry });
    if (command.operation === 'create') return this._removeCreatedGroupCommand({ scene, command, registry });
    const expectedKey = 'target';
    const desiredKey = 'original';
    const batches = new Map();
    const rollbackBatches = new Map();
    const attemptedTypes = [];
    let registryAttempted = false;
    try {
      for (const plan of command.plans) {
        const document = await this._requireSupportedDocument(plan.uuid, scene);
        const current = readSceneGroupMemberTransformState(document, command.operation);
        if (!sameTransformState(current, plan[expectedKey])) {
          throw new SceneGroupWorkflowError('group-history-diverged', `preflight-${direction}`, {
            identities: [plan.uuid],
            message: `${documentLabel(document)} changed after this command and cannot be ${direction === 'undo' ? 'undone' : 'redone'} safely.`
          });
        }
        const documentName = documentType(document);
        const id = normalizeIdentity(document?.id);
        const updates = batches.get(documentName) || [];
        updates.push({ _id: id, ...buildSceneGroupTransformRestore(current,plan[desiredKey]) });
        batches.set(documentName, updates);
        const rollbackUpdates = rollbackBatches.get(documentName) || [];
        rollbackUpdates.push({ _id: id, ...buildSceneGroupTransformRestore(plan[desiredKey],plan[expectedKey]) });
        rollbackBatches.set(documentName, rollbackUpdates);
      }
      const nextRegistry = applyRegistryHistoryDelta(registry, command.registryDelta, direction);
      await this._validateRegistry(scene, nextRegistry);
      for (const [documentName, updates] of batches) {
        attemptedTypes.push(documentName);
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupHistory: direction,
          faNexusSceneGroupTransform: command.operation
        });
      }
      const registryChanged = !sameTransformState(registry, nextRegistry);
      if (registryChanged) {
        registryAttempted = true;
        await this._writeRegistry(scene, clone(nextRegistry));
      }
      completeSceneGroupCommand(scene, { commandId: command.id });
      this._logger?.info?.('SceneGroupWorkflow.history.committed', {
        sceneId: normalizeIdentity(scene?.id),
        groupId,
        commandId: command.id,
        direction,
        operation: command.operation,
        documentUuids: command.plans.map((plan) => plan.uuid)
      });
      return { commandId: command.id, groupId, documentUuids: command.plans.map((plan) => plan.uuid) };
    } catch (cause) {
      const rollback = attemptedTypes.length || registryAttempted
        ? await this._rollbackGroupHistory({
            scene,
            registry,
            rollbackBatches,
            attemptedTypes,
            registryAttempted,
            direction
          })
        : { ok: true, errors: [] };
      cancelSceneGroupCommand(scene, { commandId: command.id });
      if (cause instanceof SceneGroupWorkflowError && rollback.ok) throw cause;
      throw new SceneGroupWorkflowError('group-history-failed', `apply-${direction}`, {
        identities: [groupId, command.id],
        cause,
        rollback,
        message: rollback.ok
          ? `Failed to ${direction} the Scene Group command: ${cause?.message || cause}`
          : `Failed to ${direction} the Scene Group command and restore its prior state.`
      });
    }
  }

  async _moveGroup({ scene, user, action, registry }) {
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    this._authorizeWrite(scene, user);
    const selection = resolveSceneGroupMoveSelection(registry, action);
    if (Array.isArray(action.expectedDocumentUuids)) {
      const identities = (values) => JSON.stringify([...new Set(values)].sort());
      if (identities(action.expectedDocumentUuids) !== identities(selection.documentUuids)) {
        throw new SceneGroupWorkflowError('move-selection-changed', 'preflight-move', {
          message: 'Scene Group membership changed during the move. Select the intended objects and try again.'
        });
      }
    }
    const { groupId, affectedGroupIds: groupIds } = selection;
    const delta = {
      x: Number(action?.delta?.x),
      y: Number(action?.delta?.y)
    };
    if (![delta.x, delta.y].every(Number.isFinite)) {
      throw new SceneGroupWorkflowError('group-move-delta-required', 'validate-input', {
        identities: [groupId]
      });
    }

    const documents = [];
    const standaloneUuids = new Set((action.documentUuids || []).map(normalizeIdentity));
    for (const uuid of selection.documentUuids) {
      const document = await this._requireSupportedDocument(uuid, scene);
      if (standaloneUuids.has(uuid) && documentType(document) !== 'Tile') {
        throw new SceneGroupWorkflowError('move-selection-tile-required', 'validate-input', { identities: [uuid] });
      }
      documents.push(document);
    }
    Object.assign(delta, resolveSceneGroupMoveDelta(documents, delta));
    await this._validateBuildingV2TransformAggregates(scene, registry, documents);
    const forbidden = documents.filter((document) => (
      typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'update')
    ));
    if (forbidden.length) {
      const identities = forbidden.map((document) => normalizeIdentity(document?.uuid));
      throw new SceneGroupWorkflowError('document-update-forbidden', 'preflight-move', {
        identities,
        message: 'You cannot update every item in this group.'
      });
    }
    const locked = documents.filter(isSceneMemberLocked);
    if (locked.length) {
      const identities = locked.map((document) => normalizeIdentity(document?.uuid));
      throw new SceneGroupWorkflowError('document-move-locked', 'preflight-move', {
        identities,
        message: 'Unlock the locked group items before moving them.'
      });
    }

    const plans = documents.map((document) => {
      const original = readSceneGroupMemberTransformState(document, 'move');
      return {
        uuid: normalizeIdentity(document?.uuid),
        id: normalizeIdentity(document?.id),
        documentName: documentType(document),
        name: normalizeIdentity(document?.name || documentType(document)),
        original,
        target: buildSceneGroupMemberTransformTarget(document, original, null, { operation: 'move', delta })
      };
    });
    const plansByUuid = new Map(plans.map((plan) => [plan.uuid, plan]));
    for (const root of documents) {
      const manifest = readBuildingV2TransformManifest(root);
      if (!manifest) continue;
      const rootPlan = plansByUuid.get(manifest.rootUuid);
      const expectedDocuments = manifest.expected.map((entry) => (
        documents.find((document) => normalizeIdentity(document?.uuid) === entry.dependentUuid)
      ));
      try {
        if (!rootPlan) throw new Error(`Missing exact V2 Root transform target ${manifest.rootUuid}.`);
        rootPlan.update = clone(rootPlan.target);
        delete rootPlan.update['flags.fa-nexus'];
        const rootSource = root?._source || root || {};
        const targets = buildBuildingV2GeneratedTransformTargets(root, {
          x: rootPlan.target.x,
          y: rootPlan.target.y,
          width: Number(root?.width ?? rootSource.width),
          height: Number(root?.height ?? rootSource.height),
          rotation: Number(root?.rotation ?? rootSource.rotation ?? 0),
          'texture.anchorX': Number(root?.texture?.anchorX ?? rootSource.texture?.anchorX ?? 0.5),
          'texture.anchorY': Number(root?.texture?.anchorY ?? rootSource.texture?.anchorY ?? 0.5)
        }, expectedDocuments);
        for (const [uuid, target] of targets) {
          const dependentPlan = plansByUuid.get(uuid);
          if (!dependentPlan) throw new Error(`Missing exact V2 transform target ${uuid}.`);
          dependentPlan.target = { ...dependentPlan.original, ...clone(target) };
        }
      } catch (cause) {
        throw new SceneGroupWorkflowError('group-move-blocked', 'preflight-move', {
          identities: [manifest.rootUuid],
          cause,
          message: `Cannot move the complete Scene Group. ${String(cause?.message || cause)}`
        });
      }
    }
    const nextRegistry = clone(registry);
    for (const affectedGroupId of groupIds) {
      const pivot = await this._resolveEffectiveGroupPivot(
        registry,
        affectedGroupId,
        scene
      );
      nextRegistry.groups[affectedGroupId].pivot = {
        x: finiteCoordinate(pivot?.x, null, `groups.${affectedGroupId}.pivot.x`) + delta.x,
        y: finiteCoordinate(pivot?.y, null, `groups.${affectedGroupId}.pivot.y`) + delta.y
      };
      transformSceneGroupFrame(nextRegistry.groups[affectedGroupId],null,{operation:'move',delta});
    }
    await this._validateRegistry(scene, nextRegistry);
    if (delta.x === 0 && delta.y === 0) {
      return await this._result(scene, registry, { selectedGroupId: groupId });
    }

    const batches = new Map();
    const originalBatches = new Map();
    for (const plan of plans) {
      const updates = batches.get(plan.documentName) || [];
      updates.push({ _id: plan.id, ...clone(plan.update || plan.target) });
      batches.set(plan.documentName, updates);
      const originals = originalBatches.get(plan.documentName) || [];
      originals.push({ _id: plan.id, ...buildSceneGroupTransformRestore(plan.target,plan.original) });
      originalBatches.set(plan.documentName, originals);
    }

    const attemptedTypes = [];
    for (const [documentName, updates] of batches) {
      attemptedTypes.push(documentName);
      try {
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupMove: true
        });
      } catch (cause) {
        const rollback = await this._rollbackMove({
          scene,
          registry,
          groupIds,
          plans,
          originalBatches,
          attemptedTypes,
          registryAttempted: false
        });
        const identities = plans
          .filter((plan) => plan.documentName === documentName)
          .map((plan) => plan.uuid);
        throw new SceneGroupWorkflowError('group-move-failed', `update-${documentName}`, {
          identities,
          cause,
          rollback,
          message: `Failed to move the complete Scene Group during ${documentName}: ${cause?.message || cause}`
        });
      }
    }

    try {
      await this._writeRegistry(scene, clone(nextRegistry));
    } catch (cause) {
      const rollback = await this._rollbackMove({
        scene,
        registry,
        groupIds,
        plans,
        originalBatches,
        attemptedTypes,
        registryAttempted: true
      });
      throw new SceneGroupWorkflowError('group-move-failed', 'commit-group-pivots', {
        identities: groupIds,
        cause,
        rollback,
        message: `Failed to commit Scene Group pivots: ${cause?.message || cause}`
      });
    }

    this._logger?.info?.('SceneGroupWorkflow.move.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      groupIds,
      documentUuids: plans.map((plan) => plan.uuid),
      delta
    });
    const committedPlans = canonicalizeCommittedPlans(plans, documents, 'move');
    this._recordCommand(scene, {
      groupId,
      groupIds: selection.groupIds,
      documentUuids: selection.standaloneDocumentUuids,
      actionType: 'move-group',
      operation: 'move',
      plans: committedPlans,
      registryDelta: buildRegistryHistoryDelta(registry, nextRegistry)
    }, historyContext);
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _auditTransformRollback({ scene, registry, groupIds, plans, attemptedTypes, rollback, operation }) {
    const attempted = new Set(attemptedTypes);
    for (const plan of plans) {
      if (!attempted.has(plan.documentName)) continue;
      let actual = null;
      try {
        const current = await this._resolveDocument(plan.uuid, scene);
        if (current) actual = readDocumentTransformState(current, operation);
      } catch (error) {
        rollback.errors.push({
          stage: 'audit-rollback-documents',
          identities: [plan.uuid],
          message: String(error?.message || error)
        });
      }
      if (actual && sameTransformState(actual, plan.original)) {
        rollback.restoredUuids.push(plan.uuid);
        continue;
      }
      rollback.residueUuids.push(plan.uuid);
      rollback.residue.push({
        uuid: plan.uuid,
        documentName: plan.documentName,
        name: plan.name,
        expected: clone(plan.original),
        actual: clone(actual)
      });
      if (!rollback.failedIdentities.includes(plan.uuid)) rollback.failedIdentities.push(plan.uuid);
    }

    if (!rollback.registryAttempted) return rollback;
    try {
      const currentRegistry = await this._readRegistry(scene);
      for (const groupId of groupIds) {
        const expectedGroup = registry.groups[groupId] || null;
        const actualGroup = currentRegistry?.groups?.[groupId] || null;
        const expected = expectedGroup ? {
          pivot: expectedGroup.pivot,
          pivotMode: expectedGroup.pivotMode,
          frameAngle: expectedGroup.frameAngle,
          bounds: expectedGroup.bounds
        } : null;
        const actual = actualGroup ? {
          pivot: actualGroup.pivot,
          pivotMode: actualGroup.pivotMode,
          frameAngle: actualGroup.frameAngle,
          bounds: actualGroup.bounds
        } : null;
        if (sameTransformState(actual, expected)) continue;
        rollback.registryResidueGroupIds.push(groupId);
        rollback.registryResidueDetails.push({ groupId, expected: clone(expected), actual: clone(actual) });
        if (!rollback.failedIdentities.includes(groupId)) rollback.failedIdentities.push(groupId);
      }
      const expectedRelationships = new Map((registry.relationships || []).map((relationship) => (
        [normalizeIdentity(relationship?.id), relationship]
      )));
      const actualRelationships = new Map((currentRegistry.relationships || []).map((relationship) => (
        [normalizeIdentity(relationship?.id), relationship]
      )));
      for (const relationshipId of new Set([...expectedRelationships.keys(), ...actualRelationships.keys()])) {
        const expected = expectedRelationships.get(relationshipId) || null;
        const actual = actualRelationships.get(relationshipId) || null;
        if (sameTransformState(actual, expected)) continue;
        const identity = relationshipId || 'unknown-relationship';
        rollback.registryResidueRelationshipIds.push(identity);
        rollback.registryResidueRelationshipDetails.push({
          relationshipId: identity,
          expected: clone(expected),
          actual: clone(actual)
        });
        if (!rollback.failedIdentities.includes(identity)) rollback.failedIdentities.push(identity);
      }
    } catch (error) {
      rollback.registryResidueGroupIds.push(...groupIds);
      rollback.registryResidueRelationshipIds.push(
        ...(registry.relationships || []).map((relationship) => normalizeIdentity(relationship?.id)).filter(Boolean)
      );
      rollback.errors.push({
        stage: 'audit-rollback-registry',
        identities: groupIds,
        message: String(error?.message || error)
      });
      for (const groupId of groupIds) {
        if (!rollback.failedIdentities.includes(groupId)) rollback.failedIdentities.push(groupId);
      }
    }
    rollback.registryResidue = rollback.registryResidueGroupIds.length > 0
      || rollback.registryResidueRelationshipIds.length > 0;
    rollback.registryRestored = rollback.registryRestored && !rollback.registryResidue;
    return rollback;
  }

  async _rollbackTransform({
    scene,
    registry,
    groupIds,
    plans,
    originalBatches,
    attemptedTypes,
    registryAttempted,
    operation
  }) {
    const rollback = {
      stage: 'rollback-group-transform',
      operation,
      registryAttempted,
      registryRestored: !registryAttempted,
      registryResidue: false,
      registryResidueGroupIds: [],
      registryResidueDetails: [],
      registryResidueRelationshipIds: [],
      registryResidueRelationshipDetails: [],
      restoredUuids: [],
      failedIdentities: [],
      residueUuids: [],
      residue: [],
      errors: []
    };
    if (registryAttempted) {
      try {
        await this._writeRegistry(scene, clone(registry));
      } catch (error) {
        rollback.registryRestored = false;
        rollback.errors.push({
          stage: 'rollback-group-pivots',
          identities: groupIds,
          message: String(error?.message || error)
        });
      }
    }
    for (const documentName of [...attemptedTypes].reverse()) {
      const updates = originalBatches.get(documentName) || [];
      if (!updates.length) continue;
      const identities = plans
        .filter((plan) => plan.documentName === documentName)
        .map((plan) => plan.uuid);
      try {
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupTransform: operation,
          faNexusSceneGroupRollback: true
        });
      } catch (error) {
        rollback.failedIdentities.push(...identities.filter((identity) => !rollback.failedIdentities.includes(identity)));
        rollback.errors.push({
          stage: `rollback-${documentName}`,
          identities,
          message: String(error?.message || error)
        });
      }
    }
    return await this._auditTransformRollback({
      scene,
      registry,
      groupIds,
      plans,
      attemptedTypes,
      rollback,
      operation
    });
  }

  async _transformGroup({ scene, user, actionType, action, registry }) {
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    this._authorizeWrite(scene, user);
    const resetBuilding = actionType === 'reset-building-scale';
    const structureDocuments = resetBuilding
      ? await this._resolveStructureDocuments(registry, action.ownerUuid, scene) : null;
    const root = structureDocuments?.[0];
    const building = root?.flags?.['fa-nexus']?.building || root?._source?.flags?.['fa-nexus']?.building;
    if (resetBuilding && !readBuildingV2TransformManifest(root)) throw new Error('Scale reset requires a Building V2 Root Tile.');
    const groupId = resetBuilding ? root.uuid : normalizeIdentity(action?.groupId);
    const group = registry.groups[groupId];
    if (!group && !resetBuilding) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }
    const operation = actionType === 'reflect-group' ? 'reflect' : actionType === 'rotate-group' ? 'rotate' : 'scale';
    const transform = operation === 'reflect' ? {operation,flipX:action.axis==='horizontal',flipY:action.axis==='vertical'} : operation === 'rotate'
      ? { operation, angle: Number(action?.angle) }
      : { operation, factor: resetBuilding ? 1 / deriveBuildingV2SpatialPose(root._source || root, building).scale : Number(action?.factor) };
    if (operation === 'reflect' && !transform.flipX && !transform.flipY) throw new Error('Choose a horizontal or vertical reflection.');
    if (operation === 'rotate' && !Number.isFinite(transform.angle)) {
      throw new SceneGroupWorkflowError('group-rotation-angle-required', 'validate-input', { identities: [groupId] });
    }
    if (operation === 'scale' && (!Number.isFinite(transform.factor) || transform.factor <= 0)) {
      throw new SceneGroupWorkflowError('group-uniform-scale-factor-required', 'validate-input', {
        identities: [groupId],
        message: 'Uniform Scene Group scale factor must be a finite number greater than zero.'
      });
    }
    if ((operation === 'rotate' && transform.angle === 0)
      || (operation === 'scale' && transform.factor === 1)) {
      return await this._result(scene, registry, { selectedGroupId: groupId });
    }

    const documents = structureDocuments || await this._resolveGroupDocuments(registry, groupId, scene);
    if (operation === 'reflect') {
      const blocker = compositionReflectionBlocker(documents);
      if (blocker) throw new Error(blocker);
    }
    await this._validateBuildingV2TransformAggregates(scene, registry, documents);
    // Building reset preserves the Root's current anchor and orientation. Other
    // members of its containing Scene Group are outside this command.
    const pivot = resetBuilding ? { x: Number(root.x), y: Number(root.y) }
      : await this._resolveEffectiveGroupPivot(registry, groupId, scene, documents);
    const blockers = [];
    const locked = documents.filter(isSceneMemberLocked);
    if (locked.length) {
      throw new SceneGroupWorkflowError('document-transform-locked', 'preflight-transform', {
        identities: locked.map(document => normalizeIdentity(document.uuid)),
        message: 'Unlock the locked group items before transforming them.'
      });
    }
    for (const document of documents) {
      if (typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'update')) {
        blockers.push({
          identities: [normalizeIdentity(document?.uuid)],
          message: `Immutable: ${documentLabel(document)}.`
        });
      }
    }

    const plans = [];
    for (const document of documents) {
      try {
        const original = readSceneGroupMemberTransformState(document, operation);
        plans.push({
          uuid: normalizeIdentity(document?.uuid),
          id: normalizeIdentity(document?.id),
          documentName: documentType(document),
          name: normalizeIdentity(document?.name || documentType(document)),
          original,
          target: buildSceneGroupMemberTransformTarget(document, original, pivot, transform)
        });
      } catch (error) {
        blockers.push({
          identities: error?.identities || [normalizeIdentity(document?.uuid)],
          message: String(error?.message || error),
          cause: error
        });
      }
    }
    if (operation === 'rotate' || operation === 'scale' || operation === 'reflect') {
      const plansByUuid = new Map(plans.map((plan) => [plan.uuid, plan]));
      for (const root of documents) {
        const manifest = readBuildingV2TransformManifest(root);
        if (!manifest) continue;
        const rootPlan = plansByUuid.get(manifest.rootUuid);
        const expectedDocuments = manifest.expected.map((entry) => (
          documents.find((document) => normalizeIdentity(document?.uuid) === entry.dependentUuid)
        ));
        try {
          rootPlan.update = clone(rootPlan.target);
          delete rootPlan.update['flags.fa-nexus'];
          const targets = buildBuildingV2GeneratedTransformTargets(root, rootPlan?.target, expectedDocuments);
          for (const [uuid, target] of targets) {
            const dependentPlan = plansByUuid.get(uuid);
            if (!dependentPlan) {
              blockers.push({ identities: [uuid], message: `Missing exact V2 transform target ${uuid}.` });
              continue;
            }
            dependentPlan.target = { ...dependentPlan.original, ...clone(target) };
          }
        } catch (error) {
          blockers.push({
            identities: [manifest.rootUuid],
            message: String(error?.message || error),
            cause: error
          });
        }
      }
    }
    const relationshipTransform = transformSceneGroupRelationshipOffsets(
      registry,
      new Set(documents.map((document) => normalizeIdentity(document?.uuid))),
      transform
    );
    blockers.push(...relationshipTransform.blockers);
    if (blockers.length) {
      const identities = [...new Set(blockers.flatMap((blocker) => blocker.identities).filter(Boolean))];
      throw new SceneGroupWorkflowError('group-transform-blocked', transformStage(operation), {
        identities,
        cause: new AggregateError(blockers.map((blocker) => blocker.cause).filter(Boolean),
          `Scene Group ${operation} capability blockers.`),
        message: `Cannot ${operation} the complete Scene Group. ${blockers.map((blocker) => blocker.message).join(' ')}`
      });
    }

    const activePlans = plans.filter((plan) => !sameTransformState(plan.original, plan.target));
    const groupIds = resetBuilding ? [] : this._collectGroupIds(registry, groupId);
    const nextRegistry = clone(registry);
    nextRegistry.relationships = relationshipTransform.relationships;
    for (const affectedGroupId of groupIds) {
      const affectedPivot = await this._resolveEffectiveGroupPivot(
        registry,
        affectedGroupId,
        scene,
        affectedGroupId === groupId ? documents : null
      );
      nextRegistry.groups[affectedGroupId].pivot = transformPoint({
        x: finiteTransformValue(affectedPivot?.x, null, `groups.${affectedGroupId}.pivot.x`, operation),
        y: finiteTransformValue(affectedPivot?.y, null, `groups.${affectedGroupId}.pivot.y`, operation)
      }, pivot, transform);
      transformSceneGroupFrame(nextRegistry.groups[affectedGroupId],pivot,transform);
    }
    await this._validateRegistry(scene, nextRegistry);

    const registryChanged = !sameTransformState(nextRegistry, registry);
    if (!activePlans.length && !registryChanged) {
      return await this._result(scene, registry, { selectedGroupId: groupId });
    }
    const batches = new Map();
    const originalBatches = new Map();
    for (const plan of activePlans) {
      const updates = batches.get(plan.documentName) || [];
      updates.push({ _id: plan.id, ...clone(plan.update || plan.target) });
      batches.set(plan.documentName, updates);
      const originals = originalBatches.get(plan.documentName) || [];
      originals.push({ _id: plan.id, ...buildSceneGroupTransformRestore(plan.target,plan.original) });
      originalBatches.set(plan.documentName, originals);
    }

    const attemptedTypes = [];
    for (const [documentName, updates] of batches) {
      attemptedTypes.push(documentName);
      try {
        await this._updateDocuments(scene, documentName, clone(updates), {
          isUndo: true,
          faNexusSceneGroupCommand: true,
          faNexusSceneGroupTransform: operation
        });
      } catch (cause) {
        const rollback = await this._rollbackTransform({
          scene,
          registry,
          groupIds,
          plans: activePlans,
          originalBatches,
          attemptedTypes,
          registryAttempted: false,
          operation
        });
        const identities = activePlans
          .filter((plan) => plan.documentName === documentName)
          .map((plan) => plan.uuid);
        throw new SceneGroupWorkflowError('group-transform-failed', `update-${documentName}`, {
          identities,
          cause,
          rollback,
          message: `Failed to ${operation} the complete Scene Group during ${documentName}: ${cause?.message || cause}`
        });
      }
    }

    if (registryChanged) {
      try {
        await this._writeRegistry(scene, clone(nextRegistry));
      } catch (cause) {
        const rollback = await this._rollbackTransform({
          scene,
          registry,
          groupIds,
          plans: activePlans,
          originalBatches,
          attemptedTypes,
          registryAttempted: true,
          operation
        });
        throw new SceneGroupWorkflowError('group-transform-failed', 'commit-group-pivots', {
          identities: groupIds,
          cause,
          rollback,
          message: `Failed to commit transformed Scene Group pivots: ${cause?.message || cause}`
        });
      }
    }

    this._logger?.info?.('SceneGroupWorkflow.transform.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      groupIds,
      documentUuids: activePlans.map((plan) => plan.uuid),
      operation,
      angle: transform.angle ?? null,
      factor: transform.factor ?? null,
      pivot
    });
    const committedPlans = canonicalizeCommittedPlans(activePlans, documents, operation);
    this._recordCommand(scene, {
      groupId,
      actionType,
      operation,
      plans: committedPlans,
      registryDelta: buildRegistryHistoryDelta(registry, nextRegistry)
    }, historyContext);
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _resolveStructureDocuments(registry, ownerUuid, scene) {
    const uuid = normalizeIdentity(ownerUuid);
    const root = await this._requireSupportedDocument(uuid, scene);
    const flags = root.flags?.['fa-nexus'] || root._source?.flags?.['fa-nexus'] || {};
    const relationships = this._collectRelationshipDescendants(registry, [uuid]);
    if (documentType(root) !== 'Tile' || (!flags.building && !flags.flattened?.composition && !relationships.some((entry) => entry.relationship.generator === 'path-v2'))) {
      throw new Error('Structure commands require a Building, Path or flattened section owner Tile.');
    }
    const documents = [root];
    for (const relationship of relationships) documents.push(await this._requireSupportedDocument(relationship.dependentUuid, scene));
    return documents;
  }

  async _setGroupMemberState({ scene, user, actionType, action, registry }) {
    this._authorizeWrite(scene, user);
    const groupId = normalizeIdentity(action?.groupId);
    const documents = action.memberUuid
      ? [await this._requireSupportedDocument(action.memberUuid, scene)]
      : action.ownerUuid
        ? await this._resolveStructureDocuments(registry, action.ownerUuid, scene)
        : await this._resolveGroupDocuments(registry, groupId, scene);
    const visibilityCommand = actionType === 'hide-group' || actionType === 'show-group';
    const field = visibilityCommand ? 'hidden' : 'locked';
    const value = actionType === 'hide-group' || actionType === 'lock-group';
    const unsupported = documents.filter((document) => !supportsGroupMemberState(document, field));
    if (unsupported.length) {
      const identities = unsupported.flatMap((document) => [
        normalizeIdentity(document?.uuid),
        documentType(document)
      ]);
      throw new SceneGroupWorkflowError('group-command-unsupported', 'preflight-documents', {
        identities,
        message: `Cannot ${actionType.replace('-group', '')} the complete Scene Group. Unsupported: ${identities.join(', ')}.`
      });
    }
    const forbidden = documents.filter((document) => (
      typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'update')
    ));
    if (forbidden.length) {
      throw new SceneGroupWorkflowError('document-update-forbidden', 'preflight-documents', {
        identities: forbidden.map((document) => normalizeIdentity(document?.uuid))
      });
    }

    const nextRegistry = clone(registry);
    const batches = new Map();
    const originalBatches = new Map();
    const originalTileLayerHiddenStates = new Map();
    const originalLockStates = new Map();
    for (const document of documents) {
      const type = documentType(document);
      if (!visibilityCommand) {
        const current = isSceneMemberLocked(document);
        if (current === value) continue;
        batches.set(type, [...(batches.get(type) || []), buildSceneMemberLockUpdate(document, value)]);
        originalBatches.set(type, [...(originalBatches.get(type) || []), buildSceneMemberLockUpdate(document, current)]);
        originalLockStates.set(document.uuid, current);
        continue;
      }
      if (visibilityCommand && type === 'Wall') {
        const uuid = normalizeIdentity(document?.uuid);
        const wallId = normalizeIdentity(document?.id);
        const stored = registry.wallVisibilityStates[wallId] || null;
        if (value && stored) continue;
        if (!value && !stored) continue;
        const current = wallVisibilityState(document);
        const desired = value ? WALL_NONE_STATE : stored;
        if (value) nextRegistry.wallVisibilityStates[wallId] = current;
        else delete nextRegistry.wallVisibilityStates[wallId];
        if (sameWallVisibilityState(document, desired)) continue;
        const updates = batches.get(type) || [];
        updates.push({ _id: normalizeIdentity(document?.id), ...clone(desired) });
        batches.set(type, updates);
        const originals = originalBatches.get(type) || [];
        originals.push({ _id: normalizeIdentity(document?.id), ...current });
        originalBatches.set(type, originals);
        continue;
      }
      if (visibilityCommand && type === 'Tile') {
        const current = isLayerHidden(document);
        if (current === value) continue;
        const update = buildLayerHiddenUpdate(document, value);
        const original = buildLayerHiddenUpdate(document, current);
        if (!update || !original) {
          throw new SceneGroupWorkflowError('invalid-tile-visibility-state', 'preflight-documents', {
            identities: [normalizeIdentity(document?.uuid)]
          });
        }
        const updates = batches.get(type) || [];
        updates.push(update);
        batches.set(type, updates);
        originalTileLayerHiddenStates.set(normalizeIdentity(document?.id), current);
        const originals = originalBatches.get(type) || [];
        originals.push(original);
        originalBatches.set(type, originals);
        continue;
      }
      if (nativeBoolean(document, field) === value) continue;
      const updates = batches.get(type) || [];
      updates.push({ _id: normalizeIdentity(document?.id), [field]: value });
      batches.set(type, updates);
      const originals = originalBatches.get(type) || [];
      originals.push({ _id: normalizeIdentity(document?.id), [field]: nativeBoolean(document, field) });
      originalBatches.set(type, originals);
    }

    const registryChanged = JSON.stringify(nextRegistry.wallVisibilityStates)
      !== JSON.stringify(registry.wallVisibilityStates);
    const rollbackChanges = async ({ restoreRegistry }) => {
      const rollback = {
        stage: 'rollback-documents',
        restoredUuids: [],
        failedIdentities: [],
        residueUuids: [],
        errors: []
      };
      for (const [rollbackType, rollbackUpdates] of originalBatches) {
        const rollbackUuids = documents
          .filter((document) => documentType(document) === rollbackType
            && rollbackUpdates.some((update) => update._id === normalizeIdentity(document?.id)))
          .map((document) => normalizeIdentity(document?.uuid));
        try {
          await this._updateDocuments(scene, rollbackType, rollbackUpdates, {
            isUndo: true,
            faNexusSceneGroupCommand: true,
            faNexusSceneGroupRollback: true,
            sound: false
          });
          rollback.restoredUuids.push(...rollbackUuids);
        } catch (rollbackError) {
          rollback.failedIdentities.push(...rollbackUuids);
          rollback.errors.push({
            stage: 'rollback-documents',
            identities: rollbackUuids,
            message: String(rollbackError?.message || rollbackError)
          });
        }
      }
      if (restoreRegistry) {
        try {
          await this._writeRegistry(scene, clone(registry));
        } catch (rollbackError) {
          rollback.failedIdentities.push(normalizeIdentity(scene?.id));
          rollback.errors.push({
            stage: 'rollback-registry',
            identities: [normalizeIdentity(scene?.id)],
            message: String(rollbackError?.message || rollbackError)
          });
        }
      }
      for (const document of documents) {
        const original = originalBatches.get(documentType(document))
          ?.find((update) => update._id === normalizeIdentity(document?.id));
        if (!original) continue;
        const type = documentType(document);
        const restored = !visibilityCommand ? isSceneMemberLocked(document) === originalLockStates.get(document.uuid)
          : type === 'Wall'
          ? sameWallVisibilityState(document, original)
          : visibilityCommand && type === 'Tile'
            ? isLayerHidden(document) === originalTileLayerHiddenStates.get(normalizeIdentity(document?.id))
            : nativeBoolean(document, field) === original[field];
        if (!restored) rollback.residueUuids.push(normalizeIdentity(document?.uuid));
      }
      return rollback;
    };

    for (const [documentName, updates] of batches) {
      try {
        await this._updateDocuments(scene, documentName, updates, {
          // Hide, Show, Lock and Unlock are all-or-nothing across document types and
          // Wall visibility lives in the registry. A per-layer native Undo entry
          // could undo one type alone, or neutralize shown Walls whose authored
          // senses are no longer stored.
          isUndo: true,
          faNexusSceneGroupCommand: true,
          sound: false
        });
      } catch (cause) {
        const rollback = await rollbackChanges({ restoreRegistry: false });
        const failedUuids = documents
          .filter((document) => documentType(document) === documentName)
          .map((document) => normalizeIdentity(document?.uuid));
        throw new SceneGroupWorkflowError('group-command-failed', 'update-documents', {
          identities: failedUuids,
          cause,
          rollback,
          message: `Failed to ${actionType.replace('-group', '')} the complete Scene Group during ${documentName}: ${cause?.message || cause}`
        });
      }
    }
    if (registryChanged) {
      try {
        await this._validateRegistry(scene, nextRegistry);
        await this._writeRegistry(scene, clone(nextRegistry));
      } catch (cause) {
        const rollback = await rollbackChanges({ restoreRegistry: true });
        throw new SceneGroupWorkflowError('group-command-failed', 'commit-wall-visibility', {
          identities: [normalizeIdentity(scene?.id), groupId],
          cause,
          rollback,
          message: `Failed to commit reversible Wall visibility for the complete Scene Group: ${cause?.message || cause}`
        });
      }
    }
    this._logger?.info?.('SceneGroupWorkflow.memberState.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      action: actionType,
      documentUuids: documents.map((document) => normalizeIdentity(document?.uuid))
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: groupId });
  }

  async _buildDeletePlan({ scene, user, groupId, registry, memberUuids = null }) {
    const memberDocuments = memberUuids
      ? await Promise.all(memberUuids.map(uuid => this._requireSupportedDocument(uuid, scene))) : null;
    const rootGroup = memberDocuments
      ? {id: memberUuids[0], name: memberDocuments.length === 1 ? documentLabel(memberDocuments[0]) : `${memberDocuments.length} selected objects`}
      : registry.groups[groupId];
    if (!rootGroup) {
      throw new SceneGroupWorkflowError('group-not-found', 'validate-input', { identities: [groupId] });
    }
    const groups = [];
    const visit = (currentId) => {
      const group = registry.groups[currentId];
      groups.push(group);
      for (const child of Object.values(registry.groups)) {
        if (child.parentId === currentId) visit(child.id);
      }
    };
    if (!memberDocuments) visit(groupId);

    const directDocuments = [];
    const directSources = memberDocuments ? [{id:null,directMemberUuids:memberUuids}] : groups;
    for (const group of directSources) {
      for (const uuid of group.directMemberUuids) {
        const document = await this._requireSupportedDocument(uuid, scene);
        if (typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'delete')) {
          throw new SceneGroupWorkflowError('document-delete-forbidden', 'preflight-delete', {
            identities: [uuid]
          });
        }
        directDocuments.push({
          uuid,
          id: normalizeIdentity(document?.id),
          documentName: documentType(document),
          name: normalizeIdentity(document?.name || documentType(document)),
          ownerGroupId: group.id,
          snapshot: clone(this._serializeDocument(document))
        });
      }
    }
    const relationshipRecords = this._collectRelationshipDescendants(
      registry,
      directDocuments.map((document) => document.uuid)
    );
    const relationshipDescendants = [];
    for (const relationship of relationshipRecords) {
      const document = await this._requireSupportedDocument(relationship.dependentUuid, scene);
      if (typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'delete')) {
        throw new SceneGroupWorkflowError('document-delete-forbidden', 'preflight-delete', {
          identities: [relationship.dependentUuid]
        });
      }
      relationshipDescendants.push({
        uuid: relationship.dependentUuid,
        id: normalizeIdentity(document?.id),
        documentName: documentType(document),
        name: normalizeIdentity(document?.name || documentType(document)),
        relationshipId: relationship.relationshipId,
        relationshipType: relationship.relationshipType,
        ownerUuid: relationship.ownerUuid,
        snapshot: clone(this._serializeDocument(document))
      });
    }
    const documents = [...directDocuments, ...relationshipDescendants];
    const token = JSON.stringify({
      groupId,
      groupIds: groups.map((group) => group.id),
      documentUuids: documents.map((document) => document.uuid),
      relationshipIds: relationshipRecords.map((relationship) => relationship.relationshipId)
    });
    return {
      groupId,
      groups,
      documents,
      relationships: relationshipRecords,
      confirmation: {
        group: { id: rootGroup.id, name: rootGroup.name },
        directDocuments: directDocuments.map(({ uuid, documentName, name, ownerGroupId }) => ({
          uuid,
          documentName,
          name,
          ownerGroupId
        })),
        nestedGroups: groups.slice(1).map((group) => ({
          id: group.id,
          name: group.name,
          parentId: group.parentId
        })),
        relationshipDescendants: relationshipDescendants.map(({
          uuid,
          documentName,
          name,
          relationshipId,
          relationshipType,
          ownerUuid
        }) => ({
          uuid,
          documentName,
          name,
          relationshipId,
          relationshipType,
          ownerUuid
        })),
        token
      }
    };
  }

  async _buildDeleteSelectionPlan({ scene, user, action, registry }) {
    if (action.memberUuids?.length) {
      const selected = new Set(action.memberUuids.map(normalizeIdentity));
      const incoming = new Map(registry.relationships.map(relation => [relation.dependentUuid, relation.ownerUuid]));
      for (const uuid of selected) {
        const owner = incoming.get(uuid);
        if (owner && !selected.has(owner)) throw new Error('Select the owning Building or Path to delete its generated parts.');
      }
      const memberUuids = [...selected].filter(uuid => !incoming.has(uuid));
      return this._buildDeletePlan({scene,user,registry,groupId:memberUuids[0],memberUuids});
    }
    const requested = [...new Set((action.groupIds || [action.groupId]).map(normalizeIdentity).filter(Boolean))];
    if (!requested.length) throw new Error('Select at least one Scene Group to delete.');
    const selected = new Set(requested);
    const roots = requested.filter((id) => {
      if (!registry.groups[id]) throw new Error(`Scene Group not found: ${id}.`);
      let parent = registry.groups[id].parentId;
      while (parent) { if (selected.has(parent)) return false; parent = registry.groups[parent]?.parentId; }
      return true;
    });
    const plans = [];
    for (const groupId of roots) plans.push(await this._buildDeletePlan({ scene, user, groupId, registry }));
    const plan = { groupId: roots[0], groups: plans.flatMap((plan) => plan.groups),
      documents: plans.flatMap((plan) => plan.documents), relationships: plans.flatMap((plan) => plan.relationships) };
    plan.confirmation = {
      group: { id: roots[0], name: roots.length === 1 ? plans[0].confirmation.group.name : `${roots.length} Scene Groups` },
      directDocuments: plans.flatMap((plan) => plan.confirmation.directDocuments),
      nestedGroups: plans.flatMap((plan) => plan.confirmation.nestedGroups),
      relationshipDescendants: plans.flatMap((plan) => plan.confirmation.relationshipDescendants),
      token: JSON.stringify(plans.map((plan) => plan.confirmation.token))
    };
    return plan;
  }

  async _prepareDeleteGroup({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const plan = await this._buildDeleteSelectionPlan({ scene, user, action, registry });
    const groupId = plan.groupId;
    const result = await this._result(scene, registry, { selectedGroupId: groupId });
    return { ...result, confirmation: clone(plan.confirmation) };
  }

  async _rollbackDelete({ scene, plan, registry, restoreRegistry }) {
    const rollback = {
      stage: 'rollback-delete',
      restoredUuids: [],
      failedIdentities: [],
      residueUuids: [],
      registryRestored: !restoreRegistry,
      registryResidue: false,
      errors: []
    };
    const missingByType = new Map();
    for (const document of plan.documents) {
      let current = null;
      try {
        current = await this._resolveDocument(document.uuid, scene);
      } catch (error) {
        if (!rollback.failedIdentities.includes(document.uuid)) rollback.failedIdentities.push(document.uuid);
        rollback.errors.push({
          stage: 'rollback-resolve-before-restore',
          identities: [document.uuid],
          message: String(error?.message || error)
        });
      }
      if (current) continue;
      const missing = missingByType.get(document.documentName) || [];
      missing.push(document);
      missingByType.set(document.documentName, missing);
    }
    for (const [documentName, missing] of missingByType) {
      try {
        await this._restoreDocuments(
          scene,
          documentName,
          missing.map((document) => clone(document.snapshot)),
          { faNexusSceneGroupRollback: true }
        );
        rollback.restoredUuids.push(...missing.map((document) => document.uuid));
      } catch (error) {
        const identities = missing.map((document) => document.uuid);
        rollback.failedIdentities.push(...identities);
        rollback.errors.push({
          stage: 'rollback-documents',
          identities,
          message: String(error?.message || error)
        });
      }
    }
    if (restoreRegistry) {
      try {
        await this._writeRegistry(scene, clone(registry));
        rollback.registryRestored = true;
      } catch (error) {
        rollback.registryRestored = false;
        rollback.registryResidue = true;
        rollback.failedIdentities.push(normalizeIdentity(scene?.id));
        rollback.errors.push({
          stage: 'rollback-registry',
          identities: [normalizeIdentity(scene?.id)],
          message: String(error?.message || error)
        });
      }
    }
    for (const document of plan.documents) {
      let current = null;
      try {
        current = await this._resolveDocument(document.uuid, scene);
      } catch (error) {
        if (!rollback.failedIdentities.includes(document.uuid)) rollback.failedIdentities.push(document.uuid);
        rollback.errors.push({
          stage: 'rollback-resolve-residue',
          identities: [document.uuid],
          message: String(error?.message || error)
        });
      }
      if (!current) rollback.residueUuids.push(document.uuid);
    }
    return rollback;
  }

  async _deleteGroup({ scene, user, action, registry }) {
    const historyContext = captureSceneGroupCommandHistoryContext(scene);
    this._authorizeWrite(scene, user);
    const plan = await this._buildDeleteSelectionPlan({ scene, user, action, registry });
    const groupId = plan.groupId;
    if (action?.confirmed !== true) {
      throw new SceneGroupWorkflowError('delete-confirmation-required', 'confirm-delete', {
        identities: [groupId]
      });
    }
    if (normalizeIdentity(action?.confirmationToken) !== plan.confirmation.token) {
      throw new SceneGroupWorkflowError('delete-confirmation-stale', 'confirm-delete', {
        identities: [groupId]
      });
    }

    const nextRegistry = clone(registry);
    for (const group of plan.groups) delete nextRegistry.groups[group.id];
    const deletedUuids = new Set(plan.documents.map(document => document.uuid));
    for (const group of Object.values(nextRegistry.groups)) {
      group.directMemberUuids = group.directMemberUuids.filter(uuid => !deletedUuids.has(uuid));
    }
    const deletedRelationshipIds = new Set(
      plan.relationships.map((relationship) => relationship.relationshipId)
    );
    nextRegistry.relationships = nextRegistry.relationships.filter(
      (relationship) => !deletedRelationshipIds.has(normalizeIdentity(relationship?.id))
    );
    for (const document of plan.documents) delete nextRegistry.wallVisibilityStates[document.id];
    this._pruneEmptyGroups(nextRegistry);
    await this._validateRegistry(scene, nextRegistry);
    const batches = new Map();
    for (const document of plan.documents) {
      const ids = batches.get(document.documentName) || [];
      ids.push(document.id);
      batches.set(document.documentName, ids);
    }
    for (const [documentName, ids] of batches) {
      try {
        await this._deleteDocuments(scene, documentName, ids, {
          isUndo: true,
          faNexusSceneGroupDelete: true,
          faNexusPreserveLinkedTileCleanup: true
        });
      } catch (cause) {
        const rollback = await this._rollbackDelete({
          scene,
          plan,
          registry,
          restoreRegistry: false
        });
        const failedUuids = plan.documents
          .filter((document) => document.documentName === documentName)
          .map((document) => document.uuid);
        throw new SceneGroupWorkflowError('delete-transaction-failed', 'delete-documents', {
          identities: failedUuids,
          cause,
          rollback,
          message: `Failed to delete the complete Scene Group during ${documentName}: ${cause?.message || cause}`
        });
      }
    }
    try {
      await this._writeRegistry(scene, clone(nextRegistry));
    } catch (cause) {
      const rollback = await this._rollbackDelete({
        scene,
        plan,
        registry,
        restoreRegistry: true
      });
      throw new SceneGroupWorkflowError('delete-transaction-failed', 'commit-registry', {
        identities: [normalizeIdentity(scene?.id), ...plan.groups.map((group) => group.id)],
        cause,
        rollback,
        message: `Failed to commit Scene Group deletion: ${cause?.message || cause}`
      });
    }
    this._logger?.info?.('SceneGroupWorkflow.delete.committed', {
      sceneId: normalizeIdentity(scene?.id),
      groupId,
      groupIds: plan.groups.map((group) => group.id),
      documentUuids: plan.documents.map((document) => document.uuid)
    });
    this._recordCommand(scene, { groupId, operation: 'delete', actionType: 'delete-group',
      plans: plan.documents.map((document) => ({ uuid: document.uuid, id: document.id,
        documentName: document.documentName, original: document.snapshot, target: null })),
      registryDelta: buildRegistryHistoryDelta(registry, nextRegistry)
    }, historyContext);
    return await this._result(scene, nextRegistry);
  }

  async _removeCreatedGroupCommand({ scene, command, registry }) {
    let attempted = false;
    const foldersBefore=clone(scene.getFlag?.('fa-nexus','layerManagerSections'));
    let folderUpdate=null;
    const plan = { documents: command.plans.map(entry => ({ ...entry, snapshot: entry.target })) };
    try {
      const next = applyRegistryHistoryDelta(registry, command.registryDelta, 'undo');
      if(Object.keys(command.layerFolders?.sections||{}).length)folderUpdate=removeCompositionLayerFolders(scene,command.layerFolders,{hadFolders:command.hadFolders});
      for (const entry of command.plans) {
        const document = await this._requireSupportedDocument(entry.uuid, scene);
        const source = this._serializeDocument(document);
        const expected = clone(entry.target);
        delete source._stats;
        delete expected._stats;
        // Delete Undo recreates embedded Behaviors and their Foundry timestamps.
        // Compare their identities and settings, not regenerated document metadata.
        if (entry.documentName === 'Region') {
          for (const snapshot of [source, expected]) {
            for (const behavior of snapshot.behaviors || []) delete behavior._stats;
          }
        }
        if (!sameTransformState(source, expected)) {
          throw Object.assign(new Error('The placed group has changed. Undo its later edits before undoing placement.'), { staleSceneGroupHistory: true });
        }
      }
      await this._validateRegistry(scene, next);
      for (const type of new Set(command.plans.map(entry => entry.documentName))) {
        attempted = true;
        await this._deleteDocuments(scene, type, command.plans.filter(entry => entry.documentName === type).map(entry => entry.id), {
          isUndo: true, faNexusSceneGroupDelete: true, faNexusPreserveLinkedTileCleanup: true
        });
      }
      if(folderUpdate)await scene.update(folderUpdate,{isUndo:true,faNexusSceneGroupCommand:true});
      await this._writeRegistry(scene, next, {removeEmpty: command.hadRegistry === false, hadModuleFlags: command.hadModuleFlags});
      completeSceneGroupCommand(scene, { commandId: command.id });
      return { commandId: command.id, groupId: command.groupId, documentUuids: command.plans.map(entry => entry.uuid) };
    } catch (cause) {
      const rollback = attempted ? await this._rollbackDelete({ scene, plan, registry, restoreRegistry: true }) : { ok: true };
      if(attempted&&folderUpdate) {
        try{await scene.update({[COMPOSITION_FOLDERS_FLAG]:foldersBefore},{isUndo:true,faNexusSceneGroupCommand:true});}
        catch(error){rollback.ok=false;(rollback.errors||=[]).push({stage:'rollback-folders',message:String(error)});}
      }
      cancelSceneGroupCommand(scene, { commandId: command.id });
      throw new SceneGroupWorkflowError('group-create-undo-failed', 'undo-placement', {
        cause, rollback, message: `Could not undo placement: ${cause.message}`
      });
    }
  }

  async _restoreDeletedGroupCommand({ scene, user, command, registry }) {
    const attempted = [];
    let registryAttempted = false;
    try {
      const nextRegistry = applyRegistryHistoryDelta(registry, command.registryDelta, 'undo');
      for (const plan of command.plans) {
        if (await this._resolveDocument(plan.uuid, scene)) throw new Error(`Cannot restore ${plan.uuid}: its identity is already in use.`);
        const DocumentClass = globalThis.CONFIG?.[plan.documentName]?.documentClass;
        if (DocumentClass?.canUserCreate && !DocumentClass.canUserCreate(user)) throw new Error(`Cannot restore ${plan.documentName} documents.`);
      }
      await this._validateRegistry(scene, nextRegistry, { allowMissingUuids: new Set(command.plans.map((plan) => plan.uuid)) });
      for (const type of [...new Set(command.plans.map((plan) => plan.documentName))]) {
        const plans = command.plans.filter((plan) => plan.documentName === type);
        attempted.push(...plans);
        await this._restoreDocuments(scene, type, plans.map((plan) => clone(plan.original)), {
          isUndo: true, faNexusSceneGroupRestore: true, faNexusSceneGroupCommand: true
        });
      }
      await this._validateRegistry(scene, nextRegistry);
      registryAttempted = true;
      await this._writeRegistry(scene, clone(nextRegistry));
      completeSceneGroupCommand(scene, { commandId: command.id });
      return { commandId: command.id, groupId: command.groupId, documentUuids: command.plans.map((plan) => plan.uuid) };
    } catch (cause) {
      const errors = [];
      for (const type of [...new Set(attempted.map((plan) => plan.documentName))].reverse()) {
        try {
          const ids = [];
          for (const plan of attempted.filter((plan) => plan.documentName === type)) {
            if (await this._resolveDocument(plan.uuid, scene)) ids.push(plan.id);
          }
          if (ids.length) await this._deleteDocuments(scene, type, ids, { isUndo: true, faNexusSceneGroupDelete: true, faNexusPreserveLinkedTileCleanup: true });
        } catch (error) { errors.push({ stage: `rollback-${type}`, message: String(error.message || error) }); }
      }
      if (registryAttempted) {
        try { await this._writeRegistry(scene, clone(registry)); }
        catch (error) { errors.push({ stage: 'rollback-registry', message: String(error.message || error) }); }
      }
      cancelSceneGroupCommand(scene, { commandId: command.id });
      throw new SceneGroupWorkflowError('group-history-failed', 'restore-deleted-group', {
        cause, identities: command.plans.map((plan) => plan.uuid), rollback: { ok: !errors.length, errors },
        message: `Failed to restore the deleted Scene Group: ${cause.message || cause}`
      });
    }
  }

  _registryAfterDocumentDeletion(registry, deletedUuids) {
    const nextRegistry = clone(registry);
    let changed = false;
    for (const uuid of deletedUuids) {
      const documentId = normalizeIdentity(uuid).split('.').pop();
      if (!Object.prototype.hasOwnProperty.call(nextRegistry.wallVisibilityStates, documentId)) continue;
      delete nextRegistry.wallVisibilityStates[documentId];
      changed = true;
    }
    for (const group of Object.values(nextRegistry.groups)) {
      const retained = group.directMemberUuids.filter((uuid) => !deletedUuids.has(uuid));
      if (retained.length === group.directMemberUuids.length) continue;
      group.directMemberUuids = retained;
      changed = true;
    }
    const retainedRelationships = nextRegistry.relationships.filter((relationship) => (
      !deletedUuids.has(normalizeIdentity(relationship?.ownerUuid))
      && !deletedUuids.has(normalizeIdentity(relationship?.dependentUuid))
    ));
    if (retainedRelationships.length !== nextRegistry.relationships.length) {
      nextRegistry.relationships = retainedRelationships;
      changed = true;
    }
    if (changed) this._pruneEmptyGroups(nextRegistry);
    return { registry: nextRegistry, changed };
  }

  async _writeNativeDeletionRegistry({ scene, registry, deletedUuids }) {
    const reconciliation = this._registryAfterDocumentDeletion(registry, deletedUuids);
    const missing = await this._missingRegistryUuids(scene, reconciliation.registry);
    const next = this._repairMissingRegistry(reconciliation.registry, missing);
    if (!reconciliation.changed && !missing.size) return next;
    await this._validateRegistry(scene, next);
    await this._writeRegistry(scene, clone(next));
    return next;
  }

  /**
   * Foundry's Undo brought back documents whose deletion this session had reconciled. Each gets back its place
   * in its Scene Group, and a group that the deletion had emptied is made again as it was, with the ancestors
   * that went with it. `before` is the registry as it was before that deletion.
   * Nothing that changed since is overwritten: a document that is a member again is left alone, and one whose
   * group cannot be made again because its parent group is gone stays ungrouped and is reported.
   * Relationships and a Wall's saved visibility state are not restored here: a Building or Path is deleted through
   * the confirmed delete command, whose own Undo restores them.
   */
  async _restoreNativeDeletion({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const before = action?.before;
    const memberUuids = Array.isArray(action?.memberUuids)
      ? Array.from(new Set(action.memberUuids.map(normalizeIdentity).filter(Boolean)))
      : [];
    if (!memberUuids.length || !before?.groups || typeof before.groups !== 'object') {
      throw new SceneGroupWorkflowError('restored-members-required', 'validate-input');
    }
    const next = clone(registry);
    const memberOf = (candidate, uuid) => Object.values(candidate.groups)
      .find((group) => Array.isArray(group?.directMemberUuids) && group.directMemberUuids.includes(uuid)) || null;
    const restoredMemberUuids = [];
    const unrestoredMemberUuids = [];
    for (const uuid of memberUuids) {
      if (!(await this._resolveDocument(uuid, scene))) continue;
      const formerGroup = memberOf(before, uuid);
      if (!formerGroup || memberOf(next, uuid)) continue;
      // The group and every ancestor that the deletion had emptied, outermost first.
      const emptied = [];
      for (let cursor = formerGroup; cursor && !next.groups[cursor.id];
        cursor = cursor.parentId ? before.groups[cursor.parentId] : null) emptied.unshift(cursor);
      const outermost = emptied[0] || null;
      if (outermost?.parentId && !next.groups[outermost.parentId]) {
        unrestoredMemberUuids.push(uuid);
        continue;
      }
      for (const group of emptied) next.groups[group.id] = { ...clone(group), directMemberUuids: [] };
      const target = next.groups[formerGroup.id];
      // Its old place among the members that are there; members added since follow.
      const present = new Set([...target.directMemberUuids, uuid]);
      target.directMemberUuids = [
        ...formerGroup.directMemberUuids.filter((memberUuid) => present.has(memberUuid)),
        ...target.directMemberUuids.filter((memberUuid) => !formerGroup.directMemberUuids.includes(memberUuid))
      ];
      restoredMemberUuids.push(uuid);
    }
    if (restoredMemberUuids.length) {
      await this._validateRegistry(scene, next);
      await this._writeRegistry(scene, clone(next));
    }
    this._logger?.info?.('SceneGroupWorkflow.nativeDeletion.restored', {
      sceneId: normalizeIdentity(scene?.id),
      restoredMemberUuids,
      unrestoredMemberUuids
    });
    const result = await this._result(scene, restoredMemberUuids.length ? next : registry);
    return { ...result, restoredMemberUuids, unrestoredMemberUuids };
  }

  async _reconcileNativeDeletion({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const memberUuids = Array.isArray(action?.memberUuids)
      ? Array.from(new Set(action.memberUuids.map(normalizeIdentity).filter(Boolean)))
      : [];
    if (!memberUuids.length) {
      throw new SceneGroupWorkflowError('deleted-members-required', 'validate-input');
    }
    const nativeDeletedUuids = new Set(memberUuids);
    // #101 FAIL-CLOSED RULE: the destructive dependent cascade runs ONLY for deletions THIS
    // session initiated (the caller classifies them via `locallyInitiatedUuids` — the runtime
    // derives it from Foundry's initiator-only `preDelete<Type>` hooks). For deletions this
    // session merely OBSERVED — a broadcast from another session, including a freshly loading
    // client's view of someone else's mid-commit state — the reconciliation prunes the deleted
    // members' registry entries (provably stale: their documents are gone) and REPORTS the
    // dependents it deliberately leaves alive, but never destroys documents to explain state it
    // did not watch change. A caller that does not classify (no `locallyInitiatedUuids` field)
    // keeps the full destructive behavior.
    const locallyInitiatedUuids = Array.isArray(action?.locallyInitiatedUuids)
      ? new Set(action.locallyInitiatedUuids.map(normalizeIdentity).filter(Boolean))
      : null;
    const foreignMemberUuids = locallyInitiatedUuids
      ? memberUuids.filter((uuid) => !locallyInitiatedUuids.has(uuid))
      : [];
    const withheldDependentUuids = new Set(
      foreignMemberUuids.length
        ? this._collectRelationshipDescendants(registry, foreignMemberUuids, { allowRootDependents: true })
          .map((record) => record.dependentUuid)
        : []
    );
    const relationshipRecords = this._collectRelationshipDescendants(registry, memberUuids, {
      allowRootDependents: true
    });
    const cascadeDocuments = [];
    const withheldLiveDependents = [];
    for (const relationship of relationshipRecords) {
      if (withheldDependentUuids.has(relationship.dependentUuid)) {
        const existingDocument = await this._resolveDocument(relationship.dependentUuid, scene);
        if (!existingDocument) {
          nativeDeletedUuids.add(relationship.dependentUuid);
          continue;
        }
        withheldLiveDependents.push(relationship.dependentUuid);
        continue;
      }
      const existingDocument = await this._resolveDocument(relationship.dependentUuid, scene);
      if (!existingDocument) {
        nativeDeletedUuids.add(relationship.dependentUuid);
        continue;
      }
      const document = await this._requireSupportedDocument(relationship.dependentUuid, scene);
      if (typeof document?.canUserModify === 'function' && !document.canUserModify(user, 'delete')) {
        await this._writeNativeDeletionRegistry({
          scene,
          registry,
          deletedUuids: nativeDeletedUuids
        });
        throw new SceneGroupWorkflowError('document-delete-forbidden', 'preflight-native-delete-cascade', {
          identities: [relationship.dependentUuid]
        });
      }
      cascadeDocuments.push({
        uuid: relationship.dependentUuid,
        id: normalizeIdentity(document?.id),
        documentName: documentType(document),
        snapshot: clone(this._serializeDocument(document))
      });
    }

    if (withheldLiveDependents.length) {
      this._logger?.warn?.('SceneGroupWorkflow.nativeDeletion.cascadeWithheld', {
        sceneId: normalizeIdentity(scene?.id),
        foreignMemberUuids,
        withheldDependentUuids: withheldLiveDependents,
        reason: 'This session did not initiate these deletions, so it prunes their registry entries'
          + ' but never destroys their live dependents. The initiating session owns the destructive'
          + ' cascade; these documents are left alive (possibly orphaned) rather than reconciled away.'
      });
    }
    const cascadeBatches = new Map();
    for (const document of [...cascadeDocuments].reverse()) {
      const ids = cascadeBatches.get(document.documentName) || [];
      ids.push(document.id);
      cascadeBatches.set(document.documentName, ids);
    }
    for (const [documentName, ids] of cascadeBatches) {
      try {
        await this._deleteDocuments(scene, documentName, ids, {
          faNexusSceneGroupDelete: true,
          faNexusPreserveLinkedTileCleanup: true,
          faNexusNativeRelationshipCascade: true
        });
      } catch (cause) {
        const rollback = await this._rollbackDelete({
          scene,
          plan: { documents: cascadeDocuments },
          registry,
          restoreRegistry: false
        });
        try {
          await this._writeNativeDeletionRegistry({
            scene,
            registry,
            deletedUuids: nativeDeletedUuids
          });
          rollback.registryReconciled = true;
        } catch (registryError) {
          rollback.registryReconciled = false;
          rollback.registryResidue = true;
          rollback.failedIdentities.push(normalizeIdentity(scene?.id));
          rollback.errors.push({
            stage: 'reconcile-native-deletion-registry',
            identities: [normalizeIdentity(scene?.id)],
            message: String(registryError?.message || registryError)
          });
        }
        throw new SceneGroupWorkflowError('native-delete-cascade-failed', 'delete-relationship-descendants', {
          identities: cascadeDocuments
            .filter((document) => document.documentName === documentName)
            .map((document) => document.uuid),
          cause,
          rollback
        });
      }
    }

    const deletedUuids = new Set([
      ...nativeDeletedUuids,
      ...cascadeDocuments.map((document) => document.uuid)
    ]);
    let nextRegistry;
    try {
      nextRegistry = await this._writeNativeDeletionRegistry({ scene, registry, deletedUuids });
    } catch (cause) {
      const rollback = await this._rollbackDelete({
        scene,
        plan: { documents: cascadeDocuments },
        registry,
        restoreRegistry: false
      });
      try {
        nextRegistry = await this._writeNativeDeletionRegistry({
          scene,
          registry,
          deletedUuids: nativeDeletedUuids
        });
        rollback.registryReconciled = true;
      } catch (registryError) {
        rollback.registryReconciled = false;
        rollback.registryResidue = true;
        rollback.failedIdentities.push(normalizeIdentity(scene?.id));
        rollback.errors.push({
          stage: 'reconcile-native-deletion-registry',
          identities: [normalizeIdentity(scene?.id)],
          message: String(registryError?.message || registryError)
        });
      }
      throw new SceneGroupWorkflowError('native-delete-reconciliation-failed', 'commit-registry', {
        identities: [normalizeIdentity(scene?.id), ...deletedUuids],
        cause,
        rollback
      });
    }
    this._logger?.info?.('SceneGroupWorkflow.nativeDeletion.reconciled', {
      sceneId: normalizeIdentity(scene?.id),
      memberUuids,
      cascadedUuids: cascadeDocuments.map((document) => document.uuid)
    });
    return await this._result(scene, nextRegistry);
  }

  async _replaceGeneratedMembers({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const previousMemberUuids = Array.from(new Set(
      Array.isArray(action?.previousMemberUuids)
        ? action.previousMemberUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    const nextMemberUuids = Array.from(new Set(
      Array.isArray(action?.nextMemberUuids)
        ? action.nextMemberUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    if (!previousMemberUuids.length) {
      throw new SceneGroupWorkflowError('previous-generated-members-required', 'validate-input');
    }
    for (const uuid of nextMemberUuids) await this._requireSupportedDocument(uuid, scene);
    let replacement;
    try {
      replacement = planSceneGroupGeneratedMemberReplacement({
        registry,
        previousMemberUuids,
        nextMemberUuids
      });
    } catch (error) {
      if (error instanceof SceneGroupGeneratedMemberReplacementError) {
        throw new SceneGroupWorkflowError(error.code, error.stage, {
          identities: error.identities,
          cause: error,
          message: error.message
        });
      }
      throw error;
    }
    if (!replacement.changed) return await this._result(scene, replacement.registry);

    await this._validateRegistry(scene, replacement.registry);
    await this._writeRegistry(scene, clone(replacement.registry));
    this._logger?.info?.('SceneGroupWorkflow.generatedMembers.replaced', {
      sceneId: normalizeIdentity(scene?.id),
      groupId: replacement.groupId,
      previousMemberUuids,
      nextMemberUuids
    });
    return await this._result(scene, replacement.registry, {
      selectedGroupId: replacement.groupId
    });
  }

  async _adoptGeneratedPathWalls({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const ownerUuid = normalizeIdentity(action?.ownerUuid);
    const dependentUuids = Array.from(new Set(
      Array.isArray(action?.dependentUuids)
        ? action.dependentUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    const owner = await this._requireSupportedDocument(ownerUuid, scene);
    if (documentType(owner) !== 'Tile') {
      throw new SceneGroupWorkflowError('path-generator-tile-required', 'validate-input', {
        identities: [ownerUuid, documentType(owner)]
      });
    }
    for (const dependentUuid of dependentUuids) {
      const dependent = await this._requireSupportedDocument(dependentUuid, scene);
      if (documentType(dependent) !== 'Wall') {
        throw new SceneGroupWorkflowError('path-generated-wall-required', 'validate-input', {
          identities: [dependentUuid, documentType(dependent)]
        });
      }
    }

    const nextRegistry = clone(registry);
    for (const relationship of nextRegistry.relationships) {
      const dependentUuid = normalizeIdentity(relationship?.dependentUuid);
      if (!dependentUuids.includes(dependentUuid)) continue;
      const existingOwnerUuid = normalizeIdentity(relationship?.ownerUuid);
      if (existingOwnerUuid && existingOwnerUuid !== ownerUuid) {
        throw new SceneGroupWorkflowError('duplicate-relationship-dependent', 'validate-relationships', {
          identities: [dependentUuid, existingOwnerUuid, ownerUuid]
        });
      }
    }
    const existingOwnerRelationshipIndex = nextRegistry.relationships.findIndex((relationship) => (
        normalizeIdentity(relationship?.ownerUuid) === ownerUuid
        && normalizeIdentity(relationship?.type) === 'generated-by'
        && normalizeIdentity(relationship?.generator) === 'path-v2'
    ));
    const ownerRelationshipIndex = existingOwnerRelationshipIndex >= 0
      ? existingOwnerRelationshipIndex
      : nextRegistry.relationships.length;
    nextRegistry.relationships = nextRegistry.relationships.filter((relationship) => !(
      normalizeIdentity(relationship?.ownerUuid) === ownerUuid
      && normalizeIdentity(relationship?.type) === 'generated-by'
      && normalizeIdentity(relationship?.generator) === 'path-v2'
    ));

    for (const group of Object.values(nextRegistry.groups)) {
      const conflictingUuids = group.directMemberUuids
        .map(normalizeIdentity)
        .filter((uuid) => dependentUuids.includes(uuid));
      if (conflictingUuids.length) {
        throw new SceneGroupWorkflowError('relationship-dependent-direct-member', 'validate-relationships', {
          identities: [group.id, ...conflictingUuids],
          message: 'A generated Path Wall must be removed from direct Scene Group membership explicitly before adoption.'
        });
      }
    }

    const ownerGroup = Object.values(nextRegistry.groups).find((group) => (
      group.directMemberUuids.some((uuid) => normalizeIdentity(uuid) === ownerUuid)
    )) || null;

    const nextOwnerRelationships = dependentUuids.map((dependentUuid) => ({
      id: `generated-by:${ownerUuid}:${dependentUuid}`,
      type: 'generated-by',
      ownerUuid,
      dependentUuid,
      generator: 'path-v2'
    }));
    nextRegistry.relationships.splice(
      Math.min(ownerRelationshipIndex, nextRegistry.relationships.length),
      0,
      ...nextOwnerRelationships
    );
    this._pruneEmptyGroups(nextRegistry);
    if (JSON.stringify(nextRegistry) === JSON.stringify(registry)) {
      return await this._result(scene, registry, { selectedGroupId: ownerGroup?.id || null });
    }
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistry(scene, clone(nextRegistry));
    this._logger?.info?.('SceneGroupWorkflow.pathGeneratedWalls.adopted', {
      sceneId: normalizeIdentity(scene?.id),
      ownerUuid,
      dependentUuids,
      groupId: ownerGroup?.id || null
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: ownerGroup?.id || null });
  }

  async _adoptGeneratedBuildingDocuments({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const ownerUuid = normalizeIdentity(action?.ownerUuid);
    const dependentUuids = Array.from(new Set(
      Array.isArray(action?.dependentUuids)
        ? action.dependentUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    const previousDependentUuids = Array.from(new Set(
      Array.isArray(action?.previousDependentUuids)
        ? action.previousDependentUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    const reconciledOwnerUuids = Array.from(new Set(
      Array.isArray(action?.reconciledOwnerUuids)
        ? action.reconciledOwnerUuids.map(normalizeIdentity).filter(Boolean)
        : []
    ));
    const owner = await this._requireSupportedDocument(ownerUuid, scene);
    if (documentType(owner) !== 'Tile') {
      throw new SceneGroupWorkflowError('building-generator-tile-required', 'validate-input', {
        identities: [ownerUuid, documentType(owner)]
      });
    }
    for (const dependentUuid of dependentUuids) {
      const dependent = await this._requireSupportedDocument(dependentUuid, scene);
      const type = documentType(dependent);
      if (!['Tile', 'Wall', 'Region'].includes(type)) {
        throw new SceneGroupWorkflowError('building-generated-document-required', 'validate-input', {
          identities: [dependentUuid, type]
        });
      }
    }

    const adoption = planBuildingGeneratedDocumentAdoption({
      registry,
      ownerUuid,
      dependentUuids,
      previousDependentUuids,
      reconciledOwnerUuids
    });
    if (JSON.stringify(adoption.registry) === JSON.stringify(registry)) {
      return await this._result(scene, registry, { selectedGroupId: adoption.groupId });
    }
    await this._validateRegistry(scene, adoption.registry, {
      allowMissingUuids: new Set(previousDependentUuids)
    });
    await this._writeRegistry(scene, clone(adoption.registry));
    this._logger?.info?.('SceneGroupWorkflow.buildingGeneratedDocuments.adopted', {
      sceneId: normalizeIdentity(scene?.id),
      ownerUuid,
      dependentUuids,
      previousDependentUuids,
      groupId: adoption.groupId
    });
    return await this._result(scene, adoption.registry, { selectedGroupId: adoption.groupId });
  }

  async _makeGeneratedIndependent({ scene, user, action, registry }) {
    this._authorizeWrite(scene, user);
    const dependentUuid = normalizeIdentity(action?.dependentUuid);
    const relationship = registry.relationships.find((candidate) => (
      normalizeIdentity(candidate?.dependentUuid) === dependentUuid
    )) || null;
    if (!relationship || normalizeIdentity(relationship?.type) !== 'generated-by') {
      throw new SceneGroupWorkflowError('generated-relationship-not-found', 'validate-input', {
        identities: [dependentUuid]
      });
    }
    const expectedGenerator = normalizeIdentity(action?.expectedGenerator);
    const generator = normalizeIdentity(relationship?.generator);
    if (expectedGenerator && generator !== expectedGenerator) {
      throw new SceneGroupWorkflowError('generated-relationship-adapter-mismatch', 'validate-input', {
        identities: [dependentUuid, expectedGenerator, generator || 'missing-generator']
      });
    }
    const ownerUuid = normalizeIdentity(relationship?.ownerUuid);
    const nextRegistry = clone(registry);
    nextRegistry.relationships = nextRegistry.relationships.filter((candidate) => (
      normalizeIdentity(candidate?.id) !== normalizeIdentity(relationship?.id)
    ));
    await this._validateRegistry(scene, nextRegistry);
    await this._writeRegistry(scene, clone(nextRegistry));
    const ownerGroup = Object.values(nextRegistry.groups).find((group) => (
      group.directMemberUuids.some((uuid) => normalizeIdentity(uuid) === ownerUuid)
    )) || null;
    this._logger?.info?.('SceneGroupWorkflow.generatedDependent.madeIndependent', {
      sceneId: normalizeIdentity(scene?.id),
      relationshipId: normalizeIdentity(relationship?.id),
      ownerUuid,
      dependentUuid,
      generator: generator || null
    });
    return await this._result(scene, nextRegistry, { selectedGroupId: ownerGroup?.id || null });
  }

  async _result(scene, registry, { selectedGroupId = null, tolerateMissing = false } = {}) {
    const missingUuids = tolerateMissing ? await this._missingRegistryUuids(scene, registry) : new Set();
    const projection = [];
    const appendGroup = async (group, depth) => {
      const members = [];
      const appendMember = async (uuid, relationship = null, relationshipDepth = 0) => {
        const missing = missingUuids.has(uuid);
        const document = missing ? null : await this._requireSupportedDocument(uuid, scene);
        const memberDocumentName = missing ? uuid.split('.')[2] : documentType(document);
        members.push({
          uuid,
          missing,
          id: normalizeIdentity(document?.id) || uuid.split('.').pop(),
          documentName: memberDocumentName,
          name: missing ? `Missing ${memberDocumentName} (${uuid.split('.').pop()})` : memberDocumentName === 'Tile'
            ? resolveTileDisplayName(document, members.length)
            : normalizeIdentity(document?.name || memberDocumentName),
          direct: !relationship,
          relationshipId: normalizeIdentity(relationship?.id) || null,
          relationshipType: normalizeIdentity(relationship?.type) || null,
          relationshipDepth,
          hidden: !missing && deriveGroupMemberState([document], 'hidden', { enabled: 'hidden', disabled: 'visible' }, registry).state === 'hidden',
          locked: !missing && isSceneMemberLocked(document),
          supportsLock: !missing && supportsGroupMemberState(document, 'locked'),
          groupIcon: document?.flags?.['fa-nexus']?.sceneGroupIcon || '',
          groupIconColor: document?.flags?.['fa-nexus']?.sceneGroupIconColor || '',
          ownerUuid: normalizeIdentity(relationship?.ownerUuid) || null,
          generator: normalizeIdentity(relationship?.generator) || null
        });
        for (const childRelationship of registry.relationships || []) {
          if (normalizeIdentity(childRelationship?.ownerUuid) !== uuid) continue;
          await appendMember(
            normalizeIdentity(childRelationship?.dependentUuid),
            childRelationship,
            relationshipDepth + 1
          );
        }
      };
      for (let memberIndex = 0; memberIndex < group.directMemberUuids.length; memberIndex += 1) {
        const uuid = group.directMemberUuids[memberIndex];
        await appendMember(uuid);
      }
      const childGroups = Object.values(registry.groups).filter((candidate) => candidate.parentId === group.id);
      const effectiveDocuments = [];
      for (const uuid of this._collectEffectiveGroupMemberUuids(registry, group.id)) {
        if (missingUuids.has(uuid)) continue;
        effectiveDocuments.push(await this._requireSupportedDocument(uuid, scene));
      }
      const visibility = deriveGroupMemberState(effectiveDocuments, 'hidden', {
        enabled: 'hidden',
        disabled: 'visible'
      }, registry);
      const locking = deriveGroupMemberState(effectiveDocuments, 'locked', {
        enabled: 'locked',
        disabled: 'unlocked'
      }, registry);
      projection.push({
        id: group.id,
        name: group.name,
        icon: group.icon || '',
        iconColor: group.iconColor || '',
        parentId: group.parentId || null,
        depth,
        childGroupIds: childGroups.map((child) => child.id),
        pivot: clone(group.pivot),
        selected: group.id === selectedGroupId,
        visibilityState: visibility.state,
        visibilityBlockers: visibility.blockers,
        lockState: locking.state,
        lockBlockers: locking.blockers,
        members
      });
      for (const child of childGroups) await appendGroup(child, depth + 1);
    };
    for (const group of Object.values(registry.groups)) {
      if (!group.parentId) await appendGroup(group, 0);
    }
    const selectedGroup = selectedGroupId ? registry.groups[selectedGroupId] || null : null;
    const selectedMemberUuids = selectedGroup
      ? this._collectEffectiveGroupMemberUuids(registry, selectedGroup.id)
      : [];
    return {
      missingUuids: [...missingUuids],
      registry: clone(registry),
      projection,
      group: selectedGroup ? clone(selectedGroup) : null,
      selection: selectedGroup ? {
        groupId: selectedGroup.id,
        memberUuids: selectedMemberUuids
      } : null
    };
  }
}
