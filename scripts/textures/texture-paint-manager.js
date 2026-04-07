import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { premiumEntitlementsService } from '../premium/premium-entitlements-service.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import './masked-tiles.js';
import { applyMaskedTilingToTile, applyStandardTileMaskToTile } from './texture-render.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import {
  createNormalizedToolOptionsDescriptor,
  TOOL_OPTIONS_RENDERER_MODE
} from '../core/tool-options-descriptor.js';
import {
  createShortcut,
  createStandardEditorShortcuts,
  mergeShortcutLists,
  resolveEffectivePolarity
} from '../core/editor-shortcuts.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const EDITING_MODE_MASKED_TILING = 'maskedTiling';
const EDITING_MODE_STANDARD_TILE_MASK = 'standardTileMask';

function getEditingTileSet() {
  try {
    const root = globalThis;
    if (!root) return null;
    let set = root[EDITING_TILE_SET_KEY];
    if (!(set instanceof Set)) {
      set = new Set();
      root[EDITING_TILE_SET_KEY] = set;
    }
    return set;
  } catch (_) {
    return null;
  }
}

function resolveTileId(targetTile) {
  try {
    return targetTile?.document?.id || targetTile?.id || targetTile?.document?._id || null;
  } catch (_) {
    return null;
  }
}

function resolvePlaceableTile(targetTile, tileId) {
  try {
    if (targetTile?.document && targetTile?.mesh) return targetTile;
    const doc = targetTile?.document || targetTile;
    if (doc?.object) return doc.object;
    const id = tileId || doc?.id || doc?._id;
    if (!id) return null;
    return canvas?.tiles?.placeables?.find((tile) => tile?.document?.id === id) || null;
  } catch (_) {
    return null;
  }
}

function normalizeEditingMode(mode) {
  if (mode === EDITING_MODE_MASKED_TILING || mode === EDITING_MODE_STANDARD_TILE_MASK) return mode;
  return null;
}

function getEditingRefreshTargets(tile, mode) {
  const tileId = resolveTileId(tile);
  let hasMaskedTilingFlag = false;
  let hasStandardTileMaskFlag = false;
  let hasMaskedTilingContainer = false;
  let hasStandardTileMaskContainer = false;
  try {
    const flags = tile?.document?.flags?.['fa-nexus'] || tile?.document?._source?.flags?.['fa-nexus'] || null;
    hasMaskedTilingFlag = !!flags?.maskedTiling;
    hasStandardTileMaskFlag = !!flags?.standardTileMask;
  } catch (_) {}
  try {
    hasMaskedTilingContainer = !!(tile?.mesh?.faNexusMaskContainer || tile?.faNexusMaskContainer);
    hasStandardTileMaskContainer = !!(tile?.mesh?.faNexusStandardMaskContainer || tile?.faNexusStandardMaskContainer);
  } catch (_) {}
  if ((hasMaskedTilingFlag || hasMaskedTilingContainer) && (hasStandardTileMaskFlag || hasStandardTileMaskContainer)) {
    Logger.error?.('TexturePaintManager.editingTile.conflictingModes', {
      tileId: tileId || null,
      mode: mode || null
    });
  }
  const shouldRunMaskedTiling = mode === EDITING_MODE_MASKED_TILING || hasMaskedTilingFlag || hasMaskedTilingContainer;
  const shouldRunStandardTileMask = mode === EDITING_MODE_STANDARD_TILE_MASK || hasStandardTileMaskFlag || hasStandardTileMaskContainer;
  if (!mode && (shouldRunMaskedTiling || shouldRunStandardTileMask)) {
    Logger.error?.('TexturePaintManager.editingTile.missingMode', {
      tileId: tileId || null,
      hasMaskedTilingFlag,
      hasStandardTileMaskFlag,
      hasMaskedTilingContainer,
      hasStandardTileMaskContainer
    });
  }
  return {
    shouldRunMaskedTiling,
    shouldRunStandardTileMask
  };
}

function isScatterTileDocument(doc) {
  try {
    const scatter = doc?.getFlag?.('fa-nexus', 'assetScatter');
    if (scatter && typeof scatter === 'object' && Array.isArray(scatter.instances)) return true;
  } catch (_) {}
  try {
    const flags = doc?.flags?.['fa-nexus'] || doc?._source?.flags?.['fa-nexus'];
    return !!(flags?.assetScatter && typeof flags.assetScatter === 'object' && Array.isArray(flags.assetScatter.instances));
  } catch (_) {
    return false;
  }
}

function stripPathQueryAndHash(value) {
  return String(value ?? '').split(/[?#]/, 1)[0] || '';
}

function safeDecodePath(value) {
  if (typeof value !== 'string') return value;
  try {
    return decodeURI(value);
  } catch (_) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }
}

function extractFilenameSuggestionBase(value) {
  let normalized = stripPathQueryAndHash(String(value ?? '').trim()).replace(/\\/g, '/');
  if (!normalized) return '';
  for (let i = 0; i < 3; i += 1) {
    const decoded = safeDecodePath(normalized);
    if (!decoded || decoded === normalized) break;
    normalized = decoded;
  }
  const tail = normalized.split('/').pop() || '';
  return tail.replace(/\.[^.]+$/, '').trim();
}

function normalizeFilenameSuggestion(value, fallback = 'standard-tile-mask.webp') {
  const base = extractFilenameSuggestionBase(value);
  if (!base) return fallback;
  return `${base}.webp`;
}

function deriveStandardTileMaskFilenameSuggestion(doc, options = {}) {
  const explicitSuggestion = typeof options?.filenameSuggestion === 'string'
    ? options.filenameSuggestion.trim()
    : '';
  if (explicitSuggestion) {
    return {
      filenameSuggestion: normalizeFilenameSuggestion(explicitSuggestion),
      source: 'options'
    };
  }

  let maskSrc = '';
  try { maskSrc = doc?.getFlag?.('fa-nexus', 'standardTileMask')?.maskSrc || ''; } catch (_) {}
  if (!maskSrc) {
    try { maskSrc = doc?.flags?.['fa-nexus']?.standardTileMask?.maskSrc || doc?._source?.flags?.['fa-nexus']?.standardTileMask?.maskSrc || ''; } catch (_) {}
  }
  const maskBase = extractFilenameSuggestionBase(maskSrc)
    .replace(/-mask-\d{14}-\d{6}$/i, '')
    .replace(/-mask$/i, '')
    .trim();
  if (maskBase) {
    return {
      filenameSuggestion: `${maskBase}.webp`,
      source: 'existing-mask'
    };
  }

  const textureSrc = String(doc?.texture?.src || '').trim();
  const textureBase = extractFilenameSuggestionBase(textureSrc);
  if (textureBase) {
    return {
      filenameSuggestion: `${textureBase}.webp`,
      source: 'tile-texture'
    };
  }

  return {
    filenameSuggestion: 'standard-tile-mask.webp',
    source: 'default'
  };
}

export class TexturePaintManager {
  constructor(app) {
    this._app = app;
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._delegateListenerBound = false;
    this._editingTileId = null;
    this._editingTileMode = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    if (!this._delegate?.isActive) return false;
    try {
      if (typeof this._delegate?.hasSessionChanges === 'function') {
        return !!this._delegate.hasSessionChanges();
      }
    } catch (_) {}
    return true;
  }

  async _ensureDelegate() {
    if (this._delegate) {
      this._bindDelegate(this._delegate);
      return this._delegate;
    }
    ensurePremiumFeaturesRegistered();
    if (this._loading) return this._loading;
    this._loading = (async () => {
      const helper = await premiumFeatureBroker.resolve('texture.paint');
      let instance = null;
      if (helper?.create) instance = helper.create(this._app);
      else if (typeof helper === 'function') instance = new helper(this._app);
      if (!instance) throw new Error('Premium texture editor bundle missing TexturePaintManager implementation');
      this._delegate = instance;
      this._bindDelegate(instance);
      return instance;
    })();
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
  }

  _bindDelegate(delegate) {
    if (!delegate || this._delegateListenerBound) return delegate;
    this._patchDelegate(delegate);
    try {
      delegate.setToolOptionsListener?.((options = {}) => {
        const suppressRender = options && typeof options === 'object' && 'suppressRender' in options
          ? !!options.suppressRender
          : false;
        this._syncToolOptionsState({ suppressRender });
      });
      this._delegateListenerBound = true;
    } catch (_) {}
    return delegate;
  }

  _patchDelegate(delegate) {
    if (!delegate || delegate._faNexusHostPatchApplied) return delegate;
    try {
      const originalPrepareMaskCanvas = delegate._prepareMaskCanvasForSave;
      if (typeof originalPrepareMaskCanvas === 'function') {
        delegate._prepareMaskCanvasForSave = function (srcCanvas, ...args) {
          try {
            const originalWidth = Math.max(1, Math.round(srcCanvas?.width || 0));
            const originalHeight = Math.max(1, Math.round(srcCanvas?.height || 0));
            if (!srcCanvas || !originalWidth || !originalHeight) {
              return originalPrepareMaskCanvas.call(this, srcCanvas, ...args);
            }
            const readbackCanvas = globalThis?.document?.createElement?.('canvas');
            if (!readbackCanvas) {
              return originalPrepareMaskCanvas.call(this, srcCanvas, ...args);
            }
            readbackCanvas.width = originalWidth;
            readbackCanvas.height = originalHeight;
            const readbackContext = readbackCanvas.getContext('2d', { willReadFrequently: true });
            if (!readbackContext) {
              return originalPrepareMaskCanvas.call(this, srcCanvas, ...args);
            }
            readbackContext.drawImage(srcCanvas, 0, 0);

            const image = readbackContext.getImageData(0, 0, originalWidth, originalHeight);
            const data = image.data;
            let minX = originalWidth;
            let minY = originalHeight;
            let maxX = -1;
            let maxY = -1;
            let hasPartialAlpha = false;
            const threshold = 3;

            for (let y = 0; y < originalHeight; y += 1) {
              const rowStart = y * originalWidth;
              for (let x = 0; x < originalWidth; x += 1) {
                const index = (rowStart + x) * 4;
                const alpha = data[index + 3];
                if (alpha > 0 && alpha < 255) hasPartialAlpha = true;
                if (alpha > threshold) {
                  if (x < minX) minX = x;
                  if (x > maxX) maxX = x;
                  if (y < minY) minY = y;
                  if (y > maxY) maxY = y;
                }
                data[index] = 255;
                data[index + 1] = 255;
                data[index + 2] = 255;
                data[index + 3] = alpha;
              }
            }
            readbackContext.putImageData(image, 0, 0);

            const originalSize = { width: originalWidth, height: originalHeight };
            const hasPaint = maxX >= minX && maxY >= minY;
            if (!hasPaint) {
              return {
                canvas: readbackCanvas,
                originalSize,
                crop: { x: 0, y: 0, width: originalWidth, height: originalHeight },
                hasPartialAlpha
              };
            }

            const padding = 2;
            const paddedMinX = Math.max(0, minX - padding);
            const paddedMinY = Math.max(0, minY - padding);
            const paddedMaxX = Math.min(originalWidth - 1, maxX + padding);
            const paddedMaxY = Math.min(originalHeight - 1, maxY + padding);
            const cropWidth = Math.max(1, paddedMaxX - paddedMinX + 1);
            const cropHeight = Math.max(1, paddedMaxY - paddedMinY + 1);
            const crop = { x: paddedMinX, y: paddedMinY, width: cropWidth, height: cropHeight };

            if (cropWidth === originalWidth && cropHeight === originalHeight && paddedMinX === 0 && paddedMinY === 0) {
              return { canvas: readbackCanvas, originalSize, crop, hasPartialAlpha };
            }

            const croppedCanvas = globalThis?.document?.createElement?.('canvas');
            if (!croppedCanvas) {
              return { canvas: readbackCanvas, originalSize, crop, hasPartialAlpha };
            }
            croppedCanvas.width = cropWidth;
            croppedCanvas.height = cropHeight;
            const croppedContext = croppedCanvas.getContext('2d');
            if (!croppedContext) {
              return { canvas: readbackCanvas, originalSize, crop, hasPartialAlpha };
            }
            croppedContext.drawImage(
              readbackCanvas,
              crop.x,
              crop.y,
              crop.width,
              crop.height,
              0,
              0,
              crop.width,
              crop.height
            );
            return { canvas: croppedCanvas, originalSize, crop, hasPartialAlpha };
          } catch (_) {
            return originalPrepareMaskCanvas.call(this, srcCanvas, ...args);
          }
        };
      }
    } catch (_) {}
    delegate._faNexusHostPatchApplied = true;
    return delegate;
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    let result;
    try {
      if (!this._editingTileId) {
        this._clearEditingTile();
      }
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      this._syncToolOptionsState({ suppressRender: false });
      result = delegate.start?.(...args);
      if (result?.then) result = await result;
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({ suppressRender: false });
      this._scheduleToolOptionsRefresh();
    } catch (error) {
      await this._handleSessionLaunchFailure(error, { phase: 'start' });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed texture painter bundle does not support editing existing tiles.');
    }
    let result;
    try {
      this._markEditingTile(targetTile, EDITING_MODE_MASKED_TILING);
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      this._syncToolOptionsState({ suppressRender: false });
      result = delegate.editTile(targetTile, options);
      if (result?.then) result = await result;
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({ suppressRender: false });
      this._scheduleToolOptionsRefresh();
    } catch (error) {
      await this._handleSessionLaunchFailure(error, {
        phase: 'edit',
        tileId: resolveTileId(targetTile)
      });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async editStandardTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editStandardTile !== 'function') {
      throw new Error('Installed texture painter bundle does not support editing standard tile masks.');
    }
    const doc = targetTile?.document || targetTile || null;
    if (isScatterTileDocument(doc)) {
      Logger.error?.('TexturePaintManager.editStandardTile.unsupportedScatter', { tileId: doc?.id || null });
      throw new Error('Standard tile mask editing does not support scatter tiles.');
    }
    const src = String(doc?.texture?.src || '').trim();
    if (!src) {
      Logger.error?.('TexturePaintManager.editStandardTile.missingTexture', { tileId: doc?.id || null });
      throw new Error('Standard tile mask editing requires an image-backed tile.');
    }
    if (/\.(webm|mp4)$/i.test(src)) {
      Logger.error?.('TexturePaintManager.editStandardTile.unsupportedVideo', { tileId: doc?.id || null, src });
      throw new Error('Standard tile mask editing does not support video tiles.');
    }
    const launchOptions = { ...(options && typeof options === 'object' ? options : {}) };
    const filenameDetails = deriveStandardTileMaskFilenameSuggestion(doc, launchOptions);
    launchOptions.filenameSuggestion = filenameDetails.filenameSuggestion;
    if (filenameDetails.source === 'default') {
      Logger.warn('TexturePaintManager.editStandardTile.filenameSuggestion.defaulted', {
        tileId: doc?.id || null,
        textureSrc: src || null,
        filenameSuggestion: launchOptions.filenameSuggestion
      });
    } else {
      Logger.info?.('TexturePaintManager.editStandardTile.filenameSuggestion', {
        tileId: doc?.id || null,
        source: filenameDetails.source,
        textureSrc: src || null,
        filenameSuggestion: launchOptions.filenameSuggestion
      });
    }
    let result;
    try {
      this._markEditingTile(targetTile, EDITING_MODE_STANDARD_TILE_MASK);
      toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
      this._beginToolWindowMonitor('texture.paint', delegate);
      this._syncToolOptionsState({ suppressRender: false });
      result = delegate.editStandardTile(targetTile, launchOptions);
      if (result?.then) result = await result;
      try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
      this._syncToolOptionsState({ suppressRender: false });
      this._scheduleToolOptionsRefresh();
    } catch (error) {
      await this._handleSessionLaunchFailure(error, {
        phase: 'edit-standard',
        tileId: resolveTileId(targetTile)
      });
      throw error;
    } finally {
      this._scheduleEntitlementProbe();
    }
    return result;
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileId = null } = {}) {
    Logger.error?.('TexturePaintManager.session.launchFailed', {
      phase,
      error: String(error?.message || error),
      tileId: tileId || this._editingTileId || null,
      editingMode: this._editingTileMode || null,
      delegateActive: !!this._delegate?.isActive,
      canvasReady: !!canvas?.ready,
      hasCanvasStage: !!canvas?.stage
    });
    this._cancelToolWindowMonitor();
    try {
      await Promise.resolve(this.stop({ reason: `${phase}-failed` }));
    } catch (stopError) {
      Logger.error?.('TexturePaintManager.session.launchFailed.stopFailed', {
        phase,
        error: String(stopError?.message || stopError)
      });
      this._clearEditingTile();
      try { toolOptionsController.deactivateTool('texture.paint'); } catch (_) {}
    }
  }

  _isEditorHostReady() {
    try {
      if (!canvas?.ready || !canvas?.stage) return false;
      if (!this._app) return false;
      if (this._app.rendered === false) return false;
      if (!this._app.element) return false;
      return true;
    } catch (_) {
      return false;
    }
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    Logger.error?.('TexturePaintManager.session.orphaned', {
      reason,
      tileId: this._editingTileId || null,
      editingMode: this._editingTileMode || null,
      delegateActive: !!this._delegate?.isActive,
      canvasReady: !!canvas?.ready,
      hasCanvasStage: !!canvas?.stage,
      appRendered: !!this._app?.rendered,
      hasAppElement: !!this._app?.element
    });
    this._cancelToolWindowMonitor();
    try {
      const result = this.stop({ reason });
      if (result && typeof result.catch === 'function') {
        result.catch((stopError) => {
          Logger.error?.('TexturePaintManager.session.orphaned.stopFailed', {
            reason,
            error: String(stopError?.message || stopError)
          });
        });
      }
    } catch (stopError) {
      Logger.error?.('TexturePaintManager.session.orphaned.stopFailed', {
        reason,
        error: String(stopError?.message || stopError)
      });
      this._clearEditingTile();
      try { toolOptionsController.deactivateTool('texture.paint'); } catch (_) {}
    }
  }

  stop(...args) {
    this._cancelToolWindowMonitor();
    this._clearEditingTile();
    if (!this._delegate) {
      toolOptionsController.deactivateTool('texture.paint');
      return;
    }
    try {
      return this._delegate.stop?.(...args);
    } finally {
      toolOptionsController.deactivateTool('texture.paint');
    }
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.save?.(...args);
  }

  async saveMask(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.saveMask?.(...args);
  }

  async placeMaskedTiling(...args) {
    const delegate = await this._ensureDelegate();
    return delegate.placeMaskedTiling?.(...args);
  }

  _scheduleEntitlementProbe() {
    ensurePremiumFeaturesRegistered();
    if (this._entitlementProbe) return this._entitlementProbe;
    const probe = (async () => {
      try {
        await premiumFeatureBroker.require('texture.paint', { revalidate: true, reason: 'texture-paint:revalidate' });
      } catch (error) {
        this._handleEntitlementFailure(error);
      } finally {
        if (this._entitlementProbe === probe) this._entitlementProbe = null;
      }
    })();
    this._entitlementProbe = probe;
    probe.catch(() => {});
    return probe;
  }

  _handleEntitlementFailure(error) {
    try { this.stop?.(); }
    catch (_) {}
    this._delegate = null;
    this._delegateListenerBound = false;
    const hasAuth = this._hasPremiumAuth();
    if (!hasAuth) {
      Logger.info?.('TexturePaintManager.entitlement.skipDisconnect', {
        code: error?.code || error?.name,
        message: String(error?.message || error)
      });
      return;
    }
    const message = '🔐 Authentication expired - premium texture painting has been disabled. Please reconnect Patreon.';
    if (this._isAuthFailure(error)) {
      try { premiumEntitlementsService?.clear?.({ reason: 'texture-revalidate-failed' }); }
      catch (_) {}
      try { game?.settings?.set?.('fa-nexus', 'patreon_auth_data', null); }
      catch (_) {}
      ui?.notifications?.warn?.(message);
    } else {
      const fallback = `Unable to confirm premium access: ${error?.message || error}`;
      ui?.notifications?.error?.(fallback);
    }
    try { Hooks?.callAll?.('fa-nexus-premium-auth-lost', { featureId: 'texture.paint', error }); }
    catch (_) {}
  }

  _isAuthFailure(error) {
    if (!error) return false;
    const code = String(error?.code || error?.name || '').toUpperCase();
    if (code && (/AUTH/.test(code) || ['STATE_MISSING', 'ENTITLEMENT_REQUIRED', 'HTTP_401', 'HTTP_403', 'SESSION_EXPIRED', 'STATE_INVALID'].includes(code))) {
      return true;
    }
    const message = String(error?.message || '').toLowerCase();
    return message.includes('auth') || message.includes('state');
  }

  _hasPremiumAuth() {
    try {
      const authData = game?.settings?.get?.('fa-nexus', 'patreon_auth_data');
      return !!(authData && authData.authenticated && authData.state);
    } catch (_) {
      return false;
    }
  }

  _beginToolWindowMonitor(toolId, delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    const token = { cancelled: false, handle: null, usingTimeout: false, toolId };
    const schedule = (callback) => {
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        token.usingTimeout = false;
        token.handle = window.requestAnimationFrame(callback);
      } else {
        token.usingTimeout = true;
        token.handle = setTimeout(callback, 200);
      }
    };
    const tick = () => {
      if (token.cancelled) return;
      let active = false;
      try { active = !!delegate?.isActive; }
      catch (_) { active = false; }
      if (!active) {
        this._clearEditingTile();
        toolOptionsController.deactivateTool(toolId);
        this._cancelToolWindowMonitor();
        return;
      }
      if (!this._isEditorHostReady()) {
        if (!token.hostFailureHandled) {
          token.hostFailureHandled = true;
          this._stopOrphanedSession({ reason: 'host-context-unavailable' });
        }
        return;
      }
      schedule(tick);
    };
    this._toolMonitor = token;
    schedule(tick);
  }

  _cancelToolWindowMonitor() {
    const token = this._toolMonitor;
    if (!token) return;
    token.cancelled = true;
    if (token.handle != null) {
      try {
        if (token.usingTimeout) clearTimeout(token.handle);
        else if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(token.handle);
      } catch (_) {}
    }
    this._toolMonitor = null;
  }

  _markEditingTile(targetTile, mode = null) {
    try {
      const tileId = resolveTileId(targetTile);
      if (!tileId) return;
      const editingMode = normalizeEditingMode(mode);
      if (this._editingTileId && (this._editingTileId !== tileId || this._editingTileMode !== editingMode)) {
        this._clearEditingTile();
      }
      this._editingTileId = tileId;
      this._editingTileMode = editingMode;
      const set = getEditingTileSet();
      if (set) set.add(tileId);
      const tile = resolvePlaceableTile(targetTile, tileId);
      if (tile) {
        const targets = getEditingRefreshTargets(tile, editingMode);
        if (targets.shouldRunMaskedTiling) applyMaskedTilingToTile(tile);
        if (targets.shouldRunStandardTileMask) applyStandardTileMaskToTile(tile);
      }
    } catch (_) {}
  }

  _clearEditingTile() {
    try {
      const tileId = this._editingTileId;
      const editingMode = this._editingTileMode;
      if (!tileId) return;
      this._editingTileId = null;
      this._editingTileMode = null;
      const set = getEditingTileSet();
      if (set) set.delete(tileId);
      const tile = resolvePlaceableTile(null, tileId);
      const refreshJobs = [];
      if (tile) {
        const targets = getEditingRefreshTargets(tile, editingMode);
        if (targets.shouldRunMaskedTiling) refreshJobs.push(Promise.resolve(applyMaskedTilingToTile(tile)));
        if (targets.shouldRunStandardTileMask) refreshJobs.push(Promise.resolve(applyStandardTileMaskToTile(tile)));
      }
      const requestRefresh = () => {
        requestSelectionFilterRefresh({
          reason: 'texture-editor-edit-exit',
          source: 'texture-paint-manager',
          tileIds: [tileId]
        });
      };
      if (refreshJobs.length) {
        Promise.allSettled(refreshJobs).finally(requestRefresh);
      } else {
        requestRefresh();
      }
    } catch (_) {}
  }

  _buildToolOptionsState() {
    try {
      const delegateState = this._delegate?.buildToolOptionsState?.();
      if (delegateState && typeof delegateState === 'object') return delegateState;
    } catch (_) {}
    return {
      hints: [
        'LMB paint the texture;',
        'E to toggle erase mode.',
        'Ctrl/Cmd+Wheel adjusts brush size.',
        'Alt+Wheel, Alt+[ / ], or Alt+Up / Down change tile elevation (default 0.01, Shift 0.1, Ctrl/Cmd 0.001).',
        'Press Ctrl/Cmd+S to commit; tap S toggles grid snap and S + wheel changes subgrid density; ESC cancels.'
      ],
      texturePaint: { available: false },
      elevation: { available: false },
      textureOffset: { available: false },
      rotation: { available: false },
      scale: { available: false },
      layerOpacity: { available: false },
      hsbc: { available: false }
    };
  }

  _buildToolOptionsDescriptor() {
    const legacyState = this._buildToolOptionsState();
    const activeMode = Array.isArray(legacyState?.texturePaint?.modes)
      ? (legacyState.texturePaint.modes.find((mode) => mode?.active)?.id || null)
      : null;
    const basePolarity = this._delegate?._eraseMode ? 'erase' : 'paint';
    const invertHeld = !!this._delegate?._polarityInvertHeld;
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const shortcuts = mergeShortcutLists(
      createStandardEditorShortcuts({ includePolarity: true }),
      [
        createShortcut('paint-texture', {
          binding: 'LMB',
          label: 'Paint',
          description: 'Paint or apply fills, depending on the active mode.'
        }),
        createShortcut('brush-size', {
          binding: 'Ctrl/Cmd+Wheel',
          label: 'Brush Size',
          description: 'Adjust brush size.'
        }),
        createShortcut('adjust-elevation-wheel', {
          binding: 'Alt+Wheel',
          label: 'Elevation Wheel',
          description: 'Adjust tile elevation by 0.01; add Shift for 0.1 or Ctrl/Cmd for 0.001.'
        }),
        createShortcut('adjust-elevation-keys', {
          binding: 'Alt+[ / ] or Alt+Up / Down',
          label: 'Elevation Keys',
          description: 'Nudge tile elevation with the same step modifiers as Alt+Wheel.'
        })
      ]
    );
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: 'texture.paint',
        toolLabel: 'Texture Painter',
        activeMode,
        activeSubtool: activeMode,
        polarity: {
          supported: true,
          base: basePolarity,
          effective: resolveEffectivePolarity(basePolarity, invertHeld),
          inverted: invertHeld
        },
        dirty: this.hasSessionChanges(),
        selectionSummary: legacyState?.texturePaint?.status || null,
        helpTopicId: 'texture-paint'
      },
      legacyState,
      controls,
      sections,
      handlers: this._buildToolOptionsHandlers(legacyState),
      shortcuts,
      sessionState: {
        editingTileId: this._editingTileId || null,
        toolMode: activeMode,
        dirty: this.hasSessionChanges()
      },
      renderState: {
        previewElevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : 0,
        selectionActive: !!(this._delegate?._selectionState || this._delegate?._lassoState)
      },
      persistedState: {
        documentFlags: ['flags.fa-nexus.maskedTiling', 'flags.fa-nexus.standardTileMask', 'flags.fa-nexus.hsbc']
      }
    });
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}) {
    const controls = {};
    const sections = [];
    const addHintControl = ({
      id,
      text
    } = {}) => {
      if (!id || typeof text !== 'string' || !text.trim().length) return null;
      controls[id] = {
        id,
        type: 'hint',
        text: text.trim()
      };
      return id;
    };
    const addRangeControl = ({
      id,
      label,
      state,
      handlerId,
      headerToggle = null,
      compact = false,
      ariaLabel = '',
      inputOnly = false
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'range',
        label,
        headerToggle: headerToggle && typeof headerToggle === 'object' ? { ...headerToggle } : null,
        compact,
        ariaLabel,
        handlerId,
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        defaultValue: state.defaultValue,
        disabled: !!state.disabled,
        hint: typeof state.hint === 'string' ? state.hint : '',
        tooltip: typeof state.tooltip === 'string' ? state.tooltip : '',
        inputOnly: !!inputOnly || !!state.inputOnly
      };
      return id;
    };
    const addScalarRandomizedControl = ({
      id,
      label,
      ariaLabel = '',
      state,
      variant = 'scale',
      handlerId,
      randomHandlerId = '',
      strengthHandlerId = ''
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      controls[id] = {
        id,
        type: 'scalar-randomized',
        variant,
        label: typeof state.label === 'string' && state.label.trim().length ? state.label.trim() : label,
        ariaLabel,
        state,
        handlerId,
        randomHandlerId,
        strengthHandlerId
      };
      return id;
    };

    if (legacyState?.texturePaint?.available) {
      const textureModes = Array.isArray(legacyState.texturePaint.modes)
        ? legacyState.texturePaint.modes
          .filter((mode) => mode && typeof mode === 'object')
          .map((mode) => ({
            id: String(mode.id || ''),
            label: String(mode.label || mode.id || ''),
            tooltip: String(mode.tooltip || ''),
            icon: typeof mode.icon === 'string' ? mode.icon : '',
            enabled: !!mode.active,
            disabled: !!mode.disabled
          }))
          .filter((mode) => mode.id.length)
        : [];
      const modeControlIds = [];
      if (textureModes.length) {
        controls['texture-tool-mode'] = {
          id: 'texture-tool-mode',
          type: 'segmented',
          handlerId: 'setTextureMode',
          options: textureModes
        };
        modeControlIds.push('texture-tool-mode');
      }
      const subtoolOptions = Array.isArray(legacyState?.customToggles)
        ? legacyState.customToggles.filter((toggle) => String(toggle?.group || '') === 'subtool-option')
        : [];
      if (subtoolOptions.length) {
        controls['texture-mode-options'] = {
          id: 'texture-mode-options',
          type: 'toggle-list',
          items: subtoolOptions
        };
        modeControlIds.push('texture-mode-options');
      }
      modeControlIds.push(addHintControl({
        id: 'texture-mode-status',
        text: legacyState.texturePaint.status
      }));
      const textureActions = Array.isArray(legacyState.texturePaint.actions)
        ? legacyState.texturePaint.actions.filter((action) => action && typeof action === 'object')
        : [];
      if (textureActions.length) {
        controls['texture-mode-actions'] = {
          id: 'texture-mode-actions',
          type: 'action-row',
          handlerId: 'handleTextureAction',
          actions: textureActions
        };
        modeControlIds.push('texture-mode-actions');
      }
      modeControlIds.push(addHintControl({
        id: 'texture-mode-hint',
        text: legacyState.texturePaint.hint
      }));
      sections.push({
        id: 'mode',
        label: 'Mode',
        region: 'header',
        collapsible: false,
        controls: modeControlIds.filter(Boolean)
      });
    }

    const paintControlIds = [];
    if (legacyState?.texturePaint?.opacity?.available) {
      paintControlIds.push(addRangeControl({
        id: 'texture-opacity',
        label: 'Tool Opacity',
        state: legacyState.texturePaint.opacity,
        handlerId: 'setTextureOpacity',
        ariaLabel: 'Texture fill opacity'
      }));
    }
    if (legacyState?.textureBrush?.available) {
      const brushState = legacyState.textureBrush;
      paintControlIds.push(addRangeControl({
        id: 'texture-brush-size',
        label: 'Size',
        state: brushState.brushSize,
        handlerId: 'setBrushSize',
        compact: true,
        ariaLabel: 'Brush size'
      }));
      paintControlIds.push(addRangeControl({
        id: 'texture-particle-size',
        label: 'Stamp %',
        state: brushState.particleSize,
        handlerId: 'setParticleSize',
        compact: true,
        ariaLabel: 'Particle size'
      }));
      paintControlIds.push(addRangeControl({
        id: 'texture-particle-density',
        label: 'Density',
        state: brushState.particleDensity,
        handlerId: 'setParticleDensity',
        compact: true,
        ariaLabel: 'Particle density'
      }));
      paintControlIds.push(addRangeControl({
        id: 'texture-spray-deviation',
        label: 'Deviation',
        state: brushState.sprayDeviation,
        handlerId: 'setSprayDeviation',
        compact: true,
        ariaLabel: 'Spray deviation'
      }));
      paintControlIds.push(addRangeControl({
        id: 'texture-brush-spacing',
        label: 'Spacing',
        state: brushState.spacing,
        handlerId: 'setBrushSpacing',
        compact: true,
        ariaLabel: 'Brush spacing'
      }));
      if (typeof brushState.hint === 'string' && brushState.hint.trim().length) {
        controls['texture-brush-hint'] = {
          id: 'texture-brush-hint',
          type: 'hint',
          text: brushState.hint
        };
        paintControlIds.push('texture-brush-hint');
      }
    }
    if (paintControlIds.length) {
      sections.push({
        id: 'paint',
        label: 'Tool options',
        controls: paintControlIds.filter(Boolean)
      });
    }

    const heightMapToggles = Array.isArray(legacyState?.customToggles)
      ? legacyState.customToggles.filter((toggle) => String(toggle?.group || '') === 'height-map')
      : [];
    const heightMapControlIds = [];
    if (heightMapToggles.length) {
      controls['height-map-options'] = {
        id: 'height-map-options',
        type: 'toggle-list',
        items: heightMapToggles
      };
      heightMapControlIds.push('height-map-options');
    }
    if (legacyState?.heightBrush?.available) {
      const heightBrush = legacyState.heightBrush;
      controls['height-threshold'] = {
        id: 'height-threshold',
        type: 'range-pair',
        label: heightBrush.label || 'Height Threshold',
        handlerId: 'setHeightThreshold',
        hint: heightBrush.hint,
        items: [
          {
            id: 'min',
            label: 'Min',
            ariaLabel: 'Height threshold minimum',
            ...heightBrush.min
          },
          {
            id: 'max',
            label: 'Max',
            ariaLabel: 'Height threshold maximum',
            ...heightBrush.max
          }
        ]
      };
      heightMapControlIds.push('height-threshold');
      heightMapControlIds.push(addHintControl({
        id: 'height-map-tuning-hint',
        text: heightBrush.tuningHint
      }));
      heightMapControlIds.push(addRangeControl({
        id: 'height-contrast',
        label: 'Contrast',
        state: heightBrush.contrast,
        handlerId: 'setHeightContrast',
        compact: true,
        ariaLabel: 'Height map contrast'
      }));
      heightMapControlIds.push(addRangeControl({
        id: 'height-lift',
        label: 'Lift',
        state: heightBrush.lift,
        handlerId: 'setHeightLift',
        compact: true,
        ariaLabel: 'Height map lift'
      }));
    }
    if (heightMapControlIds.length) {
      sections.push({
        id: 'height-map',
        label: 'Height Map',
        controls: heightMapControlIds.filter(Boolean)
      });
    }

    const transformControlIds = [];
    if (legacyState?.elevation?.available) {
      transformControlIds.push(addRangeControl({
        id: 'texture-elevation',
        label: 'Elevation',
        state: legacyState.elevation,
        handlerId: 'setElevation',
        inputOnly: true,
        ariaLabel: 'Texture elevation'
      }));
    }
    if (legacyState?.scale?.available) {
      transformControlIds.push(addScalarRandomizedControl({
        id: 'texture-scale',
        variant: 'scale',
        label: 'Scale',
        ariaLabel: 'Scale',
        state: legacyState.scale,
        handlerId: 'setScale',
        randomHandlerId: 'toggleScaleRandom',
        strengthHandlerId: 'setScaleRandomStrength'
      }));
    }
    if (legacyState?.rotation?.available) {
      transformControlIds.push(addScalarRandomizedControl({
        id: 'texture-rotation',
        variant: 'rotation',
        label: 'Rotation',
        ariaLabel: 'Rotation',
        state: legacyState.rotation,
        handlerId: 'setRotation',
        randomHandlerId: 'toggleRotationRandom',
        strengthHandlerId: 'setRotationRandomStrength'
      }));
    }
    if (legacyState?.textureOffset?.available) {
      controls['texture-offset'] = {
        id: 'texture-offset',
        type: 'range-pair',
        label: 'Texture Offset',
        handlerId: 'setTextureOffset',
        hint: legacyState.textureOffset.hint,
        items: [
          {
            id: 'x',
            label: 'X',
            ariaLabel: 'Texture offset X',
            handlerArg: 'x',
            ...legacyState.textureOffset.x
          },
          {
            id: 'y',
            label: 'Y',
            ariaLabel: 'Texture offset Y',
            handlerArg: 'y',
            ...legacyState.textureOffset.y
          }
        ]
      };
      transformControlIds.push('texture-offset');
    }
    if (legacyState?.layerOpacity?.available) {
      transformControlIds.push(addRangeControl({
        id: 'texture-layer-opacity',
        label: 'Texture Opacity',
        state: legacyState.layerOpacity,
        handlerId: 'setLayerOpacity',
        ariaLabel: 'Texture opacity'
      }));
    }
    if (transformControlIds.length) {
      sections.push({
        id: 'transform',
        label: 'Transform',
        controls: transformControlIds.filter(Boolean)
      });
    }
    buildHsbcToolOptionsControls({
      state: legacyState?.hsbc,
      controls,
      sections,
      addRangeControl,
      addHintControl,
      sectionId: 'color',
      sectionLabel: 'Color',
      idPrefix: 'texture-hsbc',
      ariaPrefix: 'Texture HSBC'
    });

    const editorActions = Array.isArray(legacyState?.editorActions)
      ? legacyState.editorActions.filter((action) => action && typeof action === 'object')
      : [];
    if (editorActions.length) {
      controls['texture-session-actions'] = {
        id: 'texture-session-actions',
        type: 'action-row',
        actions: editorActions
      };
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: ['texture-session-actions']
      });
    }

    return { controls, sections };
  }

  _buildToolOptionsHandlers(legacyState = {}) {
    const handlers = {
      setTextureMode: (modeId) => {
        const fn = this._delegate?.setTextureMode;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, modeId); }
        catch (_) { return false; }
      },
      handleTextureAction: (actionId) => {
        const fn = this._delegate?.handleTextureAction;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, actionId); }
        catch (_) { return false; }
      },
      handleEditorAction: (actionId) => {
        const fn = this._delegate?.handleEditorAction;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, actionId); }
        catch (_) { return false; }
      },
      setTextureOpacity: (value, commit) => {
        const fn = this._delegate?.setTextureOpacity;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setBrushSize: (value, commit) => {
        const fn = this._delegate?.setBrushSize;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setParticleSize: (value, commit) => {
        const fn = this._delegate?.setParticleSize;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setParticleDensity: (value, commit) => {
        const fn = this._delegate?.setParticleDensity;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setSprayDeviation: (value, commit) => {
        const fn = this._delegate?.setSprayDeviation;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setBrushSpacing: (value, commit) => {
        const fn = this._delegate?.setBrushSpacing;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setElevation: (value, commit) => {
        const fn = this._delegate?.setElevation;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setRotation: (value, commit) => {
        const fn = this._delegate?.setRotation || this._delegate?.setTextureRotation;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setScale: (value, commit) => {
        const fn = this._delegate?.setScale || this._delegate?.setTextureScale;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setTextureOffset: (axis, value, commit) => {
        const fn = this._delegate?.setTextureOffset;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, axis, value, commit); }
        catch (_) { return false; }
      },
      setLayerOpacity: (value, commit) => {
        const fn = this._delegate?.setLayerOpacity;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setHue: (value, commit) => {
        const fn = this._delegate?.setHue;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setSaturation: (value, commit) => {
        const fn = this._delegate?.setSaturation;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setBrightness: (value, commit) => {
        const fn = this._delegate?.setBrightness;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setContrast: (value, commit) => {
        const fn = this._delegate?.setContrast;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setHeightThreshold: (axis, value, commit) => {
        const fn = this._delegate?.setHeightThreshold;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, axis, value, commit); }
        catch (_) { return false; }
      },
      setHeightContrast: (value, commit) => {
        const fn = this._delegate?.setHeightContrast;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      setHeightLift: (value, commit) => {
        const fn = this._delegate?.setHeightLift;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate, value, commit); }
        catch (_) { return false; }
      },
      toggleHeightMapCollapsed: () => {
        const fn = this._delegate?.toggleHeightMapCollapsed;
        if (typeof fn !== 'function') return false;
        try { return fn.call(this._delegate); }
        catch (_) { return false; }
      }
    };
    const customToggles = this._delegate?.getCustomToggleHandlers?.();
    const mergedCustomToggles = customToggles && typeof customToggles === 'object'
      ? { ...customToggles }
      : {};
    const textureModes = Array.isArray(legacyState?.texturePaint?.modes)
      ? legacyState.texturePaint.modes
      : [];
    for (const mode of textureModes) {
      const modeId = String(mode?.id || '');
      if (!modeId) continue;
      mergedCustomToggles[modeId] = (enabled) => {
        if (!enabled) return true;
        return handlers.setTextureMode(modeId);
      };
    }
    if (Object.keys(mergedCustomToggles).length) handlers.customToggles = mergedCustomToggles;
    return handlers;
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const descriptor = this._buildToolOptionsDescriptor();
      toolOptionsController.setToolOptions('texture.paint', {
        ...descriptor,
        suppressRender
      });
    } catch (_) {}
  }

  _scheduleToolOptionsRefresh() {
    try { queueMicrotask(() => this._syncToolOptionsState({ suppressRender: false })); } catch (_) {}
    try { setTimeout(() => this._syncToolOptionsState({ suppressRender: false }), 0); } catch (_) {}
    try { setTimeout(() => this._syncToolOptionsState({ suppressRender: false }), 50); } catch (_) {}
  }
}

export default TexturePaintManager;
