import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { syncFlattenContainerTransform } from './tile-flatten-chunks.js';
import { syncStandardMaskNativeTransformPreview } from '../textures/texture-mask-runtime.js';
import { planFlattenNativeTransform, commitFlattenNativeTransform, collectFlattenCompositionWalls } from './flatten-composition.js';
import { registerGridReferenceSource, turnRotationOnlyChangeAboutGridPivot, wallEndPoints } from '../canvas/grid-reference-snap.js';
import { syncFlattenCompositionPreview, prepareFlattenCompositionPreview, completeFlattenCompositionPreview,
  cancelFlattenCompositionPreview, clearFlattenCompositionPreviews } from './flatten-composition-preview.js';
import { captureNativeTileTransformHistoryContext, installNativeTileTransformHistory } from '../canvas/native-tile-transform-history.js';
import { NATIVE_TILE_TRANSFORM_BUSY, reserveNativeTileTransformTransaction, trackNativeTileTransformTransaction, rejectNativeTileTransformReservation } from '../canvas/native-tile-transform-transactions.js';
import {
  applyFlattenedNativeTransformToChanges,
  readFlattenedMetadata,
  readFlattenedTilePose
} from './flatten-tile-transform.js';

const CONTROLS_PATCH_MARKER = Symbol.for('fa-nexus.flattened-native-controls');
const BODY_PATCH_MARKER = Symbol.for('fa-nexus.flattened-native-body');
const pendingTransforms = new Map();

function gesturePreviews(event) {
  const data = event?.interactionData || {};
  return [...new Set([data.preview, ...(data.others || []), ...(data.clones || [])].filter(Boolean))];
}

function previewDocument(preview) {
  return preview?._original?.document || preview?.document?.parent?.tiles?.get(preview.document.id);
}

function reportPreviewFailure(error) {
  Logger.error('TileFlatten.nativePreview.failed', { error: String(error?.stack || error) });
  ui.notifications.error(`The flattened picture could not be previewed: ${error.message}`);
}

function previewScale(originalDocument, previewDocument) {
  const original = readFlattenedTilePose(originalDocument);
  const preview = readFlattenedTilePose(previewDocument);
  const scale = {
    x: preview.width / original.width,
    y: preview.height / original.height
  };
  if (![scale.x, scale.y].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Flattened Tile native preview produced invalid resize factors.');
  }
  return scale;
}

export function syncFlattenedNativeTransformPreview(
  originalDocument,
  preview,
  { documentPoseApplied = false } = {}
) {
  if (!readFlattenedMetadata(originalDocument) || !preview?.document || !preview?.mesh) return false;
  const scale = previewScale(originalDocument, preview.document);
  // Native TileShapeControls preview clones retain the committed mesh pose, so
  // their custom pixels need the pending scale explicitly. Scene Group preview
  // instead updates the live document and refreshes its mesh first; applying
  // the factor again there would produce a visible double-scale until mouse-up.
  const displayScale = documentPoseApplied ? { x: 1, y: 1 } : scale;
  const chunkContainer = preview.faNexusFlattenChunkContainer
    || preview.mesh.faNexusFlattenChunkContainer
    || null;
  if (chunkContainer) {
    syncFlattenContainerTransform(chunkContainer, preview.mesh, preview.document, displayScale);
  }
  const standardMask = preview.faNexusStandardMaskContainer
    || preview.mesh.faNexusStandardMaskContainer
    || null;
  const chunkBase = standardMask?.faNexusBaseKind === 'flattened-chunks'
    ? standardMask.faNexusBaseDisplayObject
    : null;
  if (chunkBase && !chunkBase.destroyed) chunkBase.scale?.set?.(displayScale.x, displayScale.y);
  const standardMaskSynced = syncStandardMaskNativeTransformPreview(preview);
  preview.faNexusFlattenedNativePreviewScale = scale;
  return !!(chunkContainer || chunkBase || standardMaskSynced);
}

class FlattenedNativePreviewRuntime {
  initialize() {
    if (!globalThis.Hooks?.on) {
      throw new Error('Foundry Hooks are unavailable for flattened Tile native transforms.');
    }
    Hooks.on('drawTile', (tile) => this.patchControls(tile));
    Hooks.on('canvasReady', () => {
      for (const tile of globalThis.canvas?.tiles?.placeables || []) this.patchControls(tile);
    });
    Hooks.on('canvasTearDown', clearFlattenCompositionPreviews);
    for (const tile of globalThis.canvas?.tiles?.placeables || []) this.patchControls(tile);
    this.patchBody();
  }

  patchControls(tile) {
    const prototype = tile?.controls?.constructor?.prototype;
    if (!prototype || prototype[CONTROLS_PATCH_MARKER]) return;
    const original = prototype._updateDragPreview;
    if (typeof original !== 'function') {
      throw new Error('Foundry v14 TileShapeControls._updateDragPreview is unavailable.');
    }
    Object.defineProperty(prototype, CONTROLS_PATCH_MARKER, { value: true, configurable: false });
    prototype._updateDragPreview = function faNexusFlattenedNativePreview(event) {
      const result = original.call(this, event);
      const sourceDocument = this?.object?.document || this?.document || null;
      const preview = event?.interactionData?.preview || null;
      if (readFlattenedMetadata(sourceDocument) && preview) {
        syncFlattenedNativeTransformPreview(sourceDocument, preview);
        globalThis.requestAnimationFrame?.(() => {
          if (!preview.destroyed) syncFlattenedNativeTransformPreview(sourceDocument, preview);
        });
      }
      try {
        for (const item of gesturePreviews(event)) syncFlattenCompositionPreview(previewDocument(item), item);
      } catch (error) { reportPreviewFailure(error); throw error; }
      return result;
    };
    for (const [method, commit] of [['_onDragDrop', true], ['_onDragCancel', false]]) {
      const originalEnd = prototype[method];
      prototype[method] = function faNexusFlattenedNativePreviewEnd(event) {
        for (const preview of gesturePreviews(event)) {
          const document = previewDocument(preview);
          if (commit) prepareFlattenCompositionPreview(document);
          else cancelFlattenCompositionPreview(document, { includingCommit: false });
        }
        return originalEnd.call(this, event);
      };
    }
  }

  patchBody() {
    const prototype = foundry.canvas.placeables.Tile.prototype;
    if (prototype[BODY_PATCH_MARKER]) return;
    Object.defineProperty(prototype, BODY_PATCH_MARKER, { value: true });
    const originalMove = prototype._onDragLeftMove;
    prototype._onDragLeftMove = function faNexusFlattenedBodyPreview(event) {
      const result = originalMove.call(this, event);
      try {
        for (const preview of gesturePreviews(event)) syncFlattenCompositionPreview(previewDocument(preview), preview);
      } catch (error) { reportPreviewFailure(error); throw error; }
      return result;
    };
    for (const [method, commit] of [['_onDragLeftDrop', true], ['_onDragLeftCancel', false]]) {
      const originalEnd = prototype[method];
      prototype[method] = function faNexusFlattenedBodyPreviewEnd(event) {
        for (const preview of gesturePreviews(event)) {
          const document = previewDocument(preview);
          if (commit) prepareFlattenCompositionPreview(document);
          else cancelFlattenCompositionPreview(document, { includingCommit: false });
        }
        return originalEnd.call(this, event);
      };
    }
  }
}

/**
 * A flattened section is moved through its owner, which carries the other
 * bands and the live Walls and Regions. The owner's picture is often
 * see-through where the pointer is (the walls of a house around its floor), so
 * the drag starts on another band: that move is passed on to the owner.
 * Returns true when it took the update over.
 */
function passBandMoveToOwner(document, changes, options) {
  const composition = document?.flags?.['fa-nexus']?.flattened?.composition;
  if (!composition?.ownerUuid || composition.ownerUuid === document.uuid) return false;
  if (options?.faNexusSceneGroupCommand || options?.faNexusFlattenedNativeTransform || options?.faNexusFlattenedNativeRollback
    || options?.faNexusFlattenCompositionTransaction || options?.isUndo) return false;
  const flat = foundry.utils.flattenObject(changes || {});
  const differs = (key) => Object.prototype.hasOwnProperty.call(flat, key)
    && flat[key] !== foundry.utils.getProperty(document._source, key);
  if (['width', 'height', 'rotation', 'texture.scaleX', 'texture.scaleY'].some(differs)) return false;
  const deltaX = differs('x') ? Number(flat.x) - document._source.x : 0;
  const deltaY = differs('y') ? Number(flat.y) - document._source.y : 0;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (!deltaX && !deltaY)) return false;
  const owner = document.parent?.tiles?.get(composition.ownerUuid.split('.').pop());
  if (!owner) throw new Error('The first picture of this flattened picture set is missing.');
  // The owner's own move is planned by the caller. (It reaches this point when the section still names another
  // Scene as its home; passing its move on to itself would never end.)
  if (owner === document) return false;
  cancelFlattenCompositionPreview(document);
  owner.update({ x: owner._source.x + deltaX, y: owner._source.y + deltaY }).catch((error) => {
    Logger.error('TileFlatten.nativeTransform.ownerMoveFailed', { tileId: owner.id, bandId: document.id, error: String(error?.stack || error) });
    ui.notifications.error(`The flattened picture could not be moved: ${error.message}`);
  });
  return true;
}

export function registerFlattenedNativeTileTransformHooks() {
  if (!globalThis.Hooks?.on) {
    throw new Error('Foundry Hooks are unavailable for flattened Tile native transforms.');
  }
  installNativeTileTransformHistory('faNexusFlattenNativeTokens', token => pendingTransforms.get(token));
  Hooks.on('preUpdateTile', (document, changes, options) => {
    try {
      if (passBandMoveToOwner(document, changes, options)) return false;
      // A turn that leaves the position alone (the wheel, the Rotation box of the Tile sheet) turns a section
      // that holds Walls about the grid, as its rotate handle does (grid-reference-snap.js).
      if (!options?.faNexusSceneGroupCommand && !options?.faNexusFlattenedNativeTransform
        && !options?.faNexusFlattenedNativeRollback && !options?.faNexusFlattenCompositionTransaction) {
        turnRotationOnlyChangeAboutGridPivot(document, changes, options);
      }
      prepareFlattenCompositionPreview(document);
      const result = applyFlattenedNativeTransformToChanges(document, changes, options);
      if (result.changed) {
        const plan = planFlattenNativeTransform(document, result.finalTile);
        if (plan) {
          const token = foundry.utils.randomID();
          reserveNativeTileTransformTransaction(document, token, { family: 'flatten' });
          plan.historyContext = captureNativeTileTransformHistoryContext(document.parent, options);
          pendingTransforms.set(token, plan);
          options.faNexusFlattenNativeTokens ||= {};
          options.faNexusFlattenNativeTokens[document.id] = token;
          setTimeout(() => {
            if (!pendingTransforms.delete(token)) return;
            const error = new Error('Flatten transform timed out waiting for its authoritative update.');
            rejectNativeTileTransformReservation(document, token, error);
            cancelFlattenCompositionPreview(document);
            Logger.error('TileFlatten.nativeTransform.timeout', { tileId: document.id, error: error.message });
            ui.notifications.error(error.message);
          }, 30000);
        }
        Logger.debug?.('TileFlatten.nativeTransform.planned', {
          tileId: result.tileId,
          scaleX: result.scaleX,
          scaleY: result.scaleY,
          rotationDelta: result.rotationDelta,
          delta: result.delta
        });
      } else cancelFlattenCompositionPreview(document);
      return true;
    } catch (error) {
      cancelFlattenCompositionPreview(document);
      const message = String(error?.message || error);
      // A change while the last one still writes the section's Walls (slow on a hosted world) is refused, not a fault.
      if (error?.code === NATIVE_TILE_TRANSFORM_BUSY) {
        Logger.warn('TileFlatten.nativeTransform.busy', { tileId: String(document?.id || '') });
        globalThis.ui?.notifications?.warn?.('This flattened section is still saving its last change. Try again in a moment.');
        return false;
      }
      Logger.error('TileFlatten.nativeTransform.failed', {
        tileId: String(document?.id || ''),
        changeKeys: Object.keys(changes || {}),
        error: message
      });
      globalThis.ui?.notifications?.error?.(
        `Flattened Tile transform was cancelled because its deconstruction state could not be preserved: ${message}`
      );
      return false;
    }
  });
  Hooks.on('updateTile', (document, _changes, options) => {
    const token = options.faNexusFlattenNativeTokens?.[document.id];
    const plan = pendingTransforms.get(token);
    if (!plan) return;
    pendingTransforms.delete(token);
    const commit = commitFlattenNativeTransform(document, plan).then(() => completeFlattenCompositionPreview(document));
    void trackNativeTileTransformTransaction(document, commit,
      { family: 'flatten', reservationToken: token }).catch(error => {
      cancelFlattenCompositionPreview(document);
      Logger.error('TileFlatten.nativeTransform.commitFailed', { tileId: document.id, error: String(error?.stack || error) });
      ui.notifications.error(`The flattened picture could not be turned or resized: ${error.message}`);
    });
  });
  new FlattenedNativePreviewRuntime().initialize();
}

// A flattened section that holds Foundry Walls is snapped by their ends (grid-reference-snap.js).
registerGridReferenceSource((document) => {
  const walls = collectFlattenCompositionWalls(document);
  return walls.length ? wallEndPoints(walls) : null;
});

if (globalThis.Hooks?.on) registerFlattenedNativeTileTransformHooks();
