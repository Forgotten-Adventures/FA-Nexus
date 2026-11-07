import { clone, finite, roundTransformNumber, validateTileGeometry, derivePathResizeCommit } from './path-resize-contract.js';
export { resizePathEntry, derivePathResizeCommit } from './path-resize-contract.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { applyPathTile } from './path-geometry.js';
import { registerGridReferenceSource, turnRotationOnlyChangeAboutGridPivot } from '../canvas/grid-reference-snap.js';
import { captureNativeTileTransformHistoryContext, installNativeTileTransformHistory } from '../canvas/native-tile-transform-history.js';
import {
  NATIVE_TILE_TRANSFORM_BUSY,
  rejectNativeTileTransformReservation,
  releaseNativeTileTransformReservation,
  reserveNativeTileTransformTransaction,
  trackNativeTileTransformTransaction
} from '../canvas/native-tile-transform-transactions.js';

const MODULE_ID = 'fa-nexus';
const PATH_FLAG_KEYS = ['pathV2', 'pathsV2'];
const POSE_FIELDS = ['x', 'y', 'width', 'height', 'rotation'];
const PENDING_WALL_TRANSFORMS = new Map();
const DEG_TO_RAD = Math.PI / 180;
const PATH_NATIVE_PREVIEW_PATCH = Symbol.for('fa-nexus.path-native-preview');
const PATH_NATIVE_PREVIEW_STATES = new WeakMap();

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
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
    texture: {
      anchorX: finite(source.texture?.anchorX ?? document?.texture?.anchorX) ?? 0.5,
      anchorY: finite(source.texture?.anchorY ?? document?.texture?.anchorY) ?? 0.5
    }
  };
}

function finalTileSnapshot(original, changes) {
  return {
    x: finite(readChange(changes, 'x', original.x)),
    y: finite(readChange(changes, 'y', original.y)),
    width: finite(readChange(changes, 'width', original.width)),
    height: finite(readChange(changes, 'height', original.height)),
    rotation: finite(readChange(changes, 'rotation', original.rotation)) ?? 0,
    texture: {
      anchorX: finite(readChange(changes, 'texture.anchorX', original.texture.anchorX)) ?? 0.5,
      anchorY: finite(readChange(changes, 'texture.anchorY', original.texture.anchorY)) ?? 0.5
    }
  };
}

function changedPose(original, final) {
  return POSE_FIELDS.some((field) => Number(original[field]) !== Number(final[field]))
    || Number(original.texture.anchorX) !== Number(final.texture.anchorX)
    || Number(original.texture.anchorY) !== Number(final.texture.anchorY);
}

function readPathFlags(document) {
  const source = document?._source?.flags?.[MODULE_ID] || document?.flags?.[MODULE_ID] || {};
  const getFlag = typeof document?.getFlag === 'function'
    ? (key) => document.getFlag(MODULE_ID, key)
    : (key) => source[key];
  return {
    pathV2: getFlag('pathV2') || null,
    pathsV2: getFlag('pathsV2') || null
  };
}

function readExplicitPathChange(changes) {
  for (const key of PATH_FLAG_KEYS) {
    if (hasOwn(changes, `flags.${MODULE_ID}.${key}`)) return true;
    if (hasOwn(changes?.flags?.[MODULE_ID], key) || hasOwn(changes?.flags?.[MODULE_ID], `-=${key}`)) {
      return true;
    }
  }
  return false;
}

function writePathChange(changes, key, value) {
  const flatKey = `flags.${MODULE_ID}.${key}`;
  if (hasOwn(changes, flatKey)) {
    changes[flatKey] = value;
    return;
  }
  changes.flags ||= {};
  changes.flags[MODULE_ID] ||= {};
  changes.flags[MODULE_ID][key] = value;
}

export function applyPathNativeTransformToChanges(document, changes = {}, options = {}) {
  if (!document || !changes || typeof changes !== 'object') {
    return { changed: false, reason: 'invalid-input' };
  }
  if (
    options?.faNexusSceneGroupCommand
    || options?.faNexusPathNativeTransformRollback
  ) {
    return { changed: false, reason: 'managed-transform' };
  }

  const current = readPathFlags(document);
  const entries = current.pathV2
    ? [current.pathV2]
    : (Array.isArray(current.pathsV2?.paths) ? current.pathsV2.paths : []);
  if (!entries.length) return { changed: false, reason: 'not-path' };

  // A turn that leaves the position alone (the wheel, the Rotation box of the Tile sheet) turns a Path about the
  // grid, as its rotate handle does (grid-reference-snap.js).
  turnRotationOnlyChangeAboutGridPivot(document, changes, options);
  const originalTile = tileSnapshot(document);
  const finalTile = finalTileSnapshot(originalTile, changes);
  validateTileGeometry(originalTile, 'original');
  validateTileGeometry(finalTile, 'final');
  if (!changedPose(originalTile, finalTile)) {
    return { changed: false, reason: 'pose-unchanged' };
  }

  const dimensionsChanged = (
    originalTile.width !== finalTile.width
    || originalTile.height !== finalTile.height
  );
  const explicitPathChange = readExplicitPathChange(changes);
  let resized = null;
  if (dimensionsChanged && !explicitPathChange) {
    resized = derivePathResizeCommit({
      ...current,
      originalTile,
      finalTile
    });
    if (current.pathV2) writePathChange(changes, 'pathV2', resized.pathV2);
    if (current.pathsV2) writePathChange(changes, 'pathsV2', resized.pathsV2);
  }

  return {
    changed: !!resized,
    reason: resized ? 'native-resize' : (explicitPathChange ? 'explicit-path-update' : 'native-pose'),
    transformWalls: !explicitPathChange,
    tileId: String(document?.id || ''),
    entries,
    originalTile,
    finalTile,
    resized
  };
}

export async function syncPathNativeTransformPreview(originalDocument, preview) {
  if (!originalDocument || !preview?.document || !preview?.mesh) return false;
  const state = PATH_NATIVE_PREVIEW_STATES.get(preview) || {
    requested: 0,
    applied: 0,
    running: null,
    originalDocument
  };
  state.originalDocument = originalDocument;
  state.requested += 1;
  PATH_NATIVE_PREVIEW_STATES.set(preview, state);
  if (!state.running) {
    state.running = (async () => {
      let changed = false;
      while (!preview.destroyed && state.applied < state.requested) {
        const requested = state.requested;
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
        const result = applyPathNativeTransformToChanges(state.originalDocument, changes, {});
        if (result.changed) {
          pending.updateSource(changes);
          preview.faNexusPathSemanticNativePreview = true;
          await applyPathTile(preview);
          changed = true;
        }
        state.applied = requested;
      }
      return changed;
    })().finally(() => {
      state.running = null;
      if (preview.destroyed) PATH_NATIVE_PREVIEW_STATES.delete(preview);
    });
  }
  return await state.running;
}

function installPathNativePreviewPatch() {
  const prototype = globalThis?.canvas?.tiles?.placeables
    ?.find?.((tile) => tile?.controls?.constructor?.prototype?._updateDragPreview)
    ?.controls?.constructor?.prototype
    || null;
  if (!prototype || typeof prototype._updateDragPreview !== 'function') return false;
  if (prototype[PATH_NATIVE_PREVIEW_PATCH]) return true;
  const original = prototype._updateDragPreview;
  prototype._updateDragPreview = function faNexusPathNativePreview(event) {
    const result = original.call(this, event);
    const sourceDocument = this?.object?.document || this?.document || null;
    const preview = event?.interactionData?.preview || null;
    const flags = readPathFlags(sourceDocument);
    if ((flags.pathV2 || flags.pathsV2) && preview) {
      const previewPromise = syncPathNativeTransformPreview(sourceDocument, preview);
      preview.faNexusPathSemanticNativePreviewPromise = previewPromise;
      void previewPromise.catch((error) => {
        Logger.error?.('PathTiles.nativeTransform.previewFailed', {
          tileId: String(sourceDocument?.id || ''),
          error: String(error?.message || error)
        });
      });
    }
    return result;
  };
  Object.defineProperty(prototype, PATH_NATIVE_PREVIEW_PATCH, {
    value: true,
    configurable: false
  });
  return true;
}

function tileLocalPointToWorld(tile, point) {
  const radians = Number(tile.rotation || 0) * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const pivotX = tile.width * tile.texture.anchorX;
  const pivotY = tile.height * tile.texture.anchorY;
  const x = point.x - pivotX;
  const y = point.y - pivotY;
  return {
    x: tile.x + (x * cosine) - (y * sine),
    y: tile.y + (x * sine) + (y * cosine)
  };
}

function worldPointToTileLocal(tile, point) {
  const radians = -Number(tile.rotation || 0) * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const x = point.x - tile.x;
  const y = point.y - tile.y;
  return {
    x: (x * cosine) - (y * sine) + (tile.width * tile.texture.anchorX),
    y: (x * sine) + (y * cosine) + (tile.height * tile.texture.anchorY)
  };
}

export function transformPathWorldPoint(point, originalTile, finalTile) {
  validateTileGeometry(originalTile, 'original');
  validateTileGeometry(finalTile, 'final');
  const world = {
    x: finite(point?.x),
    y: finite(point?.y)
  };
  if (world.x == null || world.y == null) {
    throw new Error('Native Path Wall transform requires finite world coordinates.');
  }
  const local = worldPointToTileLocal(originalTile, world);
  const resizedLocal = {
    x: local.x * (finalTile.width / originalTile.width),
    y: local.y * (finalTile.height / originalTile.height)
  };
  const transformed = tileLocalPointToWorld(finalTile, resizedLocal);
  return {
    x: roundTransformNumber(transformed.x),
    y: roundTransformNumber(transformed.y)
  };
}

/**
 * The points a Path is snapped by when it is moved or turned with Foundry's own tools (grid-reference-snap.js):
 * its control points, where the Path was drawn. Its Foundry Walls follow from them.
 */
function collectPathGridReferencePoints(document) {
  const flags = readPathFlags(document);
  const entries = flags.pathV2
    ? [flags.pathV2]
    : (Array.isArray(flags.pathsV2?.paths) ? flags.pathsV2.paths : []);
  if (!entries.length) return null;
  const tile = tileSnapshot(document);
  if (![tile.x, tile.y, tile.width, tile.height].every(Number.isFinite)) return null;
  const points = [];
  for (const entry of entries) {
    for (const point of Array.isArray(entry?.controlPoints) ? entry.controlPoints : []) {
      const x = finite(point?.x);
      const y = finite(point?.y);
      if (x != null && y != null) points.push(tileLocalPointToWorld(tile, { x, y }));
    }
  }
  return points;
}

registerGridReferenceSource(collectPathGridReferencePoints);

function collectPathWalls(document, entries) {
  const scene = document?.parent;
  if (!scene?.walls) return [];
  const tileId = String(document?.id || '');
  const wallIds = new Set();
  const groupIds = new Set();
  for (const entry of entries || []) {
    for (const wallId of entry?.foundryWalls?.wallIds || []) {
      if (wallId) wallIds.add(String(wallId));
    }
    if (entry?.foundryWalls?.groupId) groupIds.add(String(entry.foundryWalls.groupId));
  }
  return Array.from(scene.walls).filter((wall) => {
    const flag = wall?.getFlag?.(MODULE_ID, 'pathWall')
      || wall?._source?.flags?.[MODULE_ID]?.pathWall;
    return !!wall?.id && (!flag?.tileId || flag.tileId === tileId) && (
      wallIds.has(String(wall.id))
      || flag?.tileId === tileId
      || (flag?.groupId && groupIds.has(String(flag.groupId)))
    );
  });
}

export function buildPathWallTransformPlan(document, transform) {
  const walls = collectPathWalls(document, transform?.entries);
  if (!walls.length) return null;
  const originalWalls = walls.map((wall) => (
    typeof wall.toObject === 'function' ? wall.toObject(false) : clone(wall?._source || wall)
  ));
  const updates = walls.map((wall) => {
    const coordinates = Array.from(wall?.c || wall?._source?.c || []).map(Number);
    if (coordinates.length !== 4 || !coordinates.every(Number.isFinite)) {
      throw new Error(`Path Wall ${wall?.id || 'unknown'} has malformed coordinates.`);
    }
    const start = transformPathWorldPoint(
      { x: coordinates[0], y: coordinates[1] },
      transform.originalTile,
      transform.finalTile
    );
    const end = transformPathWorldPoint(
      { x: coordinates[2], y: coordinates[3] },
      transform.originalTile,
      transform.finalTile
    );
    return {
      _id: wall.id,
      c: [
        Math.round(start.x),
        Math.round(start.y),
        Math.round(end.x),
        Math.round(end.y)
      ]
    };
  });
  return {
    scene: document.parent,
    tileId: String(document.id || ''),
    originalTileSource: typeof document.toObject === 'function'
      ? document.toObject(false)
      : clone(document?._source || document),
    originals: originalWalls.map(source => ({ documentName: 'Wall', source })),
    operations: [{ operation: transform.originalTile.width !== transform.finalTile.width
      || transform.originalTile.height !== transform.finalTile.height ? 'scale'
      : transform.originalTile.rotation !== transform.finalTile.rotation ? 'rotate' : 'move' }],
    updates
  };
}

async function restorePathTransformPlan(document, plan, cause) {
  const errors = [];
  try {
    if (plan.originals.length) {
      await plan.scene.updateEmbeddedDocuments('Wall', plan.originals.map(entry => clone(entry.source)), {
        diff: false,
        isUndo: true,
        faNexusPathNativeTransformRollback: true
      });
    }
  } catch (error) {
    errors.push(`Walls: ${error?.message || error}`);
  }
  try {
    await document.update(clone(plan.originalTileSource), {
      diff: false,
      isUndo: true,
      faNexusPathNativeTransformRollback: true
    });
  } catch (error) {
    errors.push(`Tile: ${error?.message || error}`);
  }
  const suffix = errors.length ? ` Rollback errors: ${errors.join('; ')}` : '';
  throw new Error(
    `Native Path transform failed and was rolled back: ${cause?.message || cause}.${suffix}`,
    { cause }
  );
}

async function commitPathWallTransform(document, plan) {
  try {
    await plan.scene.updateEmbeddedDocuments('Wall', clone(plan.updates), {
      diff: false,
      isUndo: plan.isUndo === true,
      faNexusPathNativeTransform: true
    });
    const mismatches = plan.updates.filter((update) => {
      const actual = Array.from(plan.scene.walls?.get?.(update._id)?.c || []).map(Number);
      return actual.length !== 4 || actual.some((value, index) => value !== update.c[index]);
    });
    if (mismatches.length) {
      throw new Error(`Path Wall verification mismatched: ${mismatches.map((entry) => entry._id).join(', ')}.`);
    }
  } catch (error) {
    await restorePathTransformPlan(document, plan, error);
  }
}

export function registerPathNativeTileTransformHooks() {
  if (!globalThis.Hooks?.on) {
    throw new Error('Foundry Hooks are unavailable for native Path Tile transforms.');
  }

  installPathNativePreviewPatch();
  installNativeTileTransformHistory('faNexusPathNativeTransformTokens', token => PENDING_WALL_TRANSFORMS.get(token));
  // An empty Scene has no Tile controls to patch. Its false install result is
  // not a veto: Foundry's canvasReady dispatch must reach the other listeners.
  Hooks.on('canvasReady', () => {
    installNativeTileTransformHistory('faNexusPathNativeTransformTokens', token => PENDING_WALL_TRANSFORMS.get(token));
    installPathNativePreviewPatch();
  });
  Hooks.on('drawTile', () => { installPathNativePreviewPatch(); });

  Hooks.on('preUpdateTile', (document, changes, options) => {
    let reservationToken = null;
    try {
      const transform = applyPathNativeTransformToChanges(document, changes, options);
      if (!transform.originalTile || !transform.finalTile) return true;
      const wallPlan = transform.transformWalls
        ? buildPathWallTransformPlan(document, transform)
        : null;
      if (wallPlan) {
        const token = globalThis.foundry?.utils?.randomID?.()
          || globalThis.crypto?.randomUUID?.();
        if (!token) throw new Error('Could not allocate a native Path Wall transform transaction.');
        reserveNativeTileTransformTransaction(document, token, { family: 'path' });
        reservationToken = token;
        wallPlan.historyContext = captureNativeTileTransformHistoryContext(document.parent, options);
        options.faNexusPathNativeTransformTokens ||= {};
        options.faNexusPathNativeTransformTokens[document.id] = token;
        PENDING_WALL_TRANSFORMS.set(token, wallPlan);
        globalThis.setTimeout?.(() => {
          if (!PENDING_WALL_TRANSFORMS.delete(token)) return;
          const error = new Error(
            `Native Path Tile ${String(document?.id || '')} transform timed out waiting for its authoritative update.`
          );
          rejectNativeTileTransformReservation(document, token, error);
          Logger.error?.('PathTiles.nativeTransform.reservationTimedOut', {
            tileId: String(document?.id || ''),
            error: error.message
          });
          globalThis.ui?.notifications?.error?.(error.message);
        }, 30000);
      }
      if (transform.changed) {
        Logger.debug?.('PathTiles.nativeResize.planned', {
          tileId: transform.tileId,
          original: transform.originalTile,
          final: transform.finalTile,
          scaleX: transform.resized?.scaleX,
          scaleY: transform.resized?.scaleY
        });
      }
      return true;
    } catch (error) {
      if (reservationToken) {
        PENDING_WALL_TRANSFORMS.delete(reservationToken);
        releaseNativeTileTransformReservation(document, reservationToken);
      }
      const message = String(error?.message || error);
      // A change while the last one still writes the Path's Walls (slow on a hosted world) is refused, not a fault.
      if (error?.code === NATIVE_TILE_TRANSFORM_BUSY) {
        Logger.warn?.('PathTiles.nativeTransform.busy', { tileId: String(document?.id || '') });
        globalThis.ui?.notifications?.warn?.('This Path is still saving its last change. Try again in a moment.');
        return false;
      }
      Logger.error?.('PathTiles.nativeTransform.failed', {
        tileId: String(document?.id || ''),
        changeKeys: Object.keys(changes || {}),
        error: message
      });
      globalThis.ui?.notifications?.error?.(
        `Path transform was cancelled because its stored geometry could not be preserved: ${message}`
      );
      return false;
    }
  });

  Hooks.on('updateTile', (document, _changes, options) => {
    const token = options?.faNexusPathNativeTransformTokens?.[document.id];
    if (!token) return;
    const plan = PENDING_WALL_TRANSFORMS.get(token);
    PENDING_WALL_TRANSFORMS.delete(token);
    if (!plan) {
      releaseNativeTileTransformReservation(document, token);
      return;
    }
    plan.isUndo = options.isUndo === true;
    const transaction = trackNativeTileTransformTransaction(
      document,
      commitPathWallTransform(document, plan),
      { family: 'path', reservationToken: token }
    );
    void transaction.catch((error) => {
      const message = String(error?.message || error);
      Logger.error?.('PathTiles.nativeTransform.wallCommitFailed', {
        tileId: String(document?.id || ''),
        error: message
      });
      globalThis.ui?.notifications?.error?.(message);
    });
  });
}

if (globalThis.Hooks?.on) registerPathNativeTileTransformHooks();
