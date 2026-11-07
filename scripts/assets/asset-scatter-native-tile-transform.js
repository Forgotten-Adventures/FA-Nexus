import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { syncAssetScatterContainerTransform } from './asset-scatter-geometry.js';
import {
  deriveScatterNativeResizeCommit,
  readScatterTilePose
} from './asset-scatter-tile-transform.js';

const MODULE_ID = 'fa-nexus';
const FLAG_KEY = 'assetScatter';
const CONTROLS_PATCH_MARKER = Symbol.for('fa-nexus.asset-scatter-native-controls');

function hasOwn(object, key) {
  return !!object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function readChange(changes, path, fallback) {
  if (hasOwn(changes, path)) return changes[path];
  const value = String(path).split('.').reduce((entry, key) => entry?.[key], changes);
  return value === undefined ? fallback : value;
}

function readScatter(document) {
  const direct = document?.getFlag?.(MODULE_ID, FLAG_KEY);
  if (direct !== undefined) return direct;
  return document?._source?.flags?.[MODULE_ID]?.[FLAG_KEY]
    ?? document?.flags?.[MODULE_ID]?.[FLAG_KEY]
    ?? null;
}

function readExplicitScatterChange(changes) {
  const flatKey = `flags.${MODULE_ID}.${FLAG_KEY}`;
  if (hasOwn(changes, flatKey)) return { present: true, value: changes[flatKey] };
  const moduleFlags = changes?.flags?.[MODULE_ID];
  if (hasOwn(moduleFlags, FLAG_KEY)) return { present: true, value: moduleFlags[FLAG_KEY] };
  if (hasOwn(moduleFlags, `-=${FLAG_KEY}`)) return { present: true, value: null };
  return { present: false, value: null };
}

function writeScatterChange(changes, value) {
  const flatKey = `flags.${MODULE_ID}.${FLAG_KEY}`;
  if (hasOwn(changes, flatKey)) {
    changes[flatKey] = value;
    return;
  }
  changes.flags ||= {};
  changes.flags[MODULE_ID] ||= {};
  changes.flags[MODULE_ID][FLAG_KEY] = value;
}

function finalTilePose(original, changes) {
  return {
    x: Number(readChange(changes, 'x', original.x)),
    y: Number(readChange(changes, 'y', original.y)),
    width: Number(readChange(changes, 'width', original.width)),
    height: Number(readChange(changes, 'height', original.height)),
    rotation: Number(readChange(changes, 'rotation', original.rotation)),
    texture: {
      anchorX: Number(readChange(changes, 'texture.anchorX', original.texture.anchorX)),
      anchorY: Number(readChange(changes, 'texture.anchorY', original.texture.anchorY)),
      scaleX: Number(readChange(changes, 'texture.scaleX', original.texture.scaleX)),
      scaleY: Number(readChange(changes, 'texture.scaleY', original.texture.scaleY))
    }
  };
}

export function applyAssetScatterNativeTransformToChanges(document, changes = {}, options = {}) {
  if (!document || !changes || typeof changes !== 'object') return { changed: false, reason: 'invalid-input' };
  if (
    options.faNexusSceneGroupCommand
    || options.faNexusAssetScatterEditCommit
    || options.faNexusAssetScatterNativeRollback
  ) {
    return { changed: false, reason: 'managed-transform' };
  }
  const scatter = readScatter(document);
  if (!scatter || !Array.isArray(scatter.instances) || !scatter.instances.length) {
    return { changed: false, reason: 'not-scatter' };
  }
  const explicit = readExplicitScatterChange(changes);
  if (explicit.present) return { changed: false, reason: 'explicit-scatter-update' };

  const originalTile = readScatterTilePose(document, { label: 'original' });
  const finalTile = finalTilePose(originalTile, changes);
  if (originalTile.width === finalTile.width && originalTile.height === finalTile.height) {
    return { changed: false, reason: 'native-pose', originalTile, finalTile };
  }
  const resized = deriveScatterNativeResizeCommit({ scatter, originalTile, finalTile });
  writeScatterChange(changes, resized.scatter);
  return {
    changed: true,
    reason: 'native-resize',
    tileId: String(document.id || ''),
    originalTile,
    finalTile,
    ...resized
  };
}

function scatterPreviewScale(originalDocument, previewDocument) {
  const original = readScatterTilePose(originalDocument, { label: 'original preview' });
  const preview = readScatterTilePose(previewDocument, { label: 'live preview' });
  return {
    scaleX: preview.width / original.width,
    scaleY: preview.height / original.height
  };
}

export function applyAssetScatterTransformPreview(tile, scale) {
  const normalized = {
    scaleX: Number(scale?.scaleX),
    scaleY: Number(scale?.scaleY)
  };
  if (![normalized.scaleX, normalized.scaleY].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error(`Asset Scatter preview for Tile ${tile?.document?.id || tile?.id || 'unknown'} produced invalid scale.`);
  }
  const container = tile?.faNexusAssetScatterContainer || tile?.mesh?.faNexusAssetScatterContainer || null;
  if (!tile?.mesh || !container || container.destroyed) {
    throw new Error(
      `Asset Scatter Tile ${tile?.document?.uuid || tile?.document?.id || tile?.id || 'unknown'} `
        + 'cannot preview its semantic transform because the Scatter renderer is not ready.'
    );
  }
  tile.faNexusAssetScatterNativePreviewScale = normalized;
  syncAssetScatterContainerTransform(container, tile.mesh, tile.document, normalized);
  return normalized;
}

export function clearAssetScatterTransformPreview(tile, { sync = true } = {}) {
  if (!tile) return;
  tile.faNexusAssetScatterNativePreviewScale = null;
  if (!sync) return;
  const container = tile.faNexusAssetScatterContainer || tile.mesh?.faNexusAssetScatterContainer || null;
  if (container && tile.mesh) syncAssetScatterContainerTransform(container, tile.mesh, tile.document, null);
}

class AssetScatterNativePreviewRuntime {
  initialize() {
    if (!globalThis.Hooks?.on) {
      throw new Error('Foundry Hooks are unavailable for Asset Scatter native transforms.');
    }
    Hooks.on('drawTile', (tile) => this.patchControls(tile));
    Hooks.on('canvasReady', () => {
      for (const tile of globalThis.canvas?.tiles?.placeables || []) this.patchControls(tile);
    });
    for (const tile of globalThis.canvas?.tiles?.placeables || []) this.patchControls(tile);
  }

  patchControls(tile) {
    const prototype = tile?.controls?.constructor?.prototype;
    if (!prototype || prototype[CONTROLS_PATCH_MARKER]) return;
    const original = prototype._updateDragPreview;
    if (typeof original !== 'function') {
      throw new Error('Foundry v14 TileShapeControls._updateDragPreview is unavailable.');
    }
    const runtime = this;
    Object.defineProperty(prototype, CONTROLS_PATCH_MARKER, { value: true, configurable: false });
    prototype._updateDragPreview = function faNexusAssetScatterNativePreview(event) {
      const result = original.call(this, event);
      runtime.update(this, event);
      return result;
    };
  }

  update(controls, event) {
    const originalDocument = controls?.object?.document || controls?.document || null;
    if (!readScatter(originalDocument)) return;
    const preview = event?.interactionData?.preview || null;
    const previewDocument = preview?.document || null;
    if (!preview || !previewDocument) return;
    const scale = scatterPreviewScale(originalDocument, previewDocument);
    if (![scale.scaleX, scale.scaleY].every((value) => Number.isFinite(value) && value > 0)) {
      throw new Error(`Asset Scatter native preview for Tile ${originalDocument.id || 'unknown'} produced invalid scale.`);
    }
    // Foundry draws the preview clone asynchronously: its first preview updates arrive before
    // the clone's Scatter renderer has attached. The renderer reads this scale when it
    // attaches, so the early frame is recorded rather than thrown into Foundry's drag pipeline.
    const container = preview.faNexusAssetScatterContainer || preview.mesh?.faNexusAssetScatterContainer || null;
    if (!preview.mesh || !container || container.destroyed) {
      preview.faNexusAssetScatterNativePreviewScale = scale;
      return;
    }
    applyAssetScatterTransformPreview(preview, scale);
  }
}

export function registerAssetScatterNativeTileTransformHooks() {
  Hooks.on('preUpdateTile', (document, changes, options) => {
    try {
      const result = applyAssetScatterNativeTransformToChanges(document, changes, options);
      if (result.changed) {
        Logger.debug?.('AssetScatter.nativeResize.planned', {
          tileId: result.tileId,
          scaleX: result.scaleX,
          scaleY: result.scaleY
        });
      }
      return true;
    } catch (error) {
      const message = String(error?.message || error);
      Logger.error('AssetScatter.nativeTransform.failed', {
        tileId: String(document?.id || ''),
        changeKeys: Object.keys(changes || {}),
        error: message
      });
      globalThis.ui?.notifications?.error?.(
        `Asset Scatter transform was cancelled because its instance geometry could not be preserved: ${message}`
      );
      return false;
    }
  });
  new AssetScatterNativePreviewRuntime().initialize();
}

if (globalThis.Hooks?.on) registerAssetScatterNativeTileTransformHooks();
