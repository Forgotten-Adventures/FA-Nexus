import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { premiumFeatureBroker } from '../premium/premium-feature-broker.js';
import { ensurePremiumFeaturesRegistered } from '../premium/premium-feature-registry.js';
import {
  resolveTileDocument,
  resolveTileId
} from '../premium/session-host/editing-targets.js';
import {
  buildHostedSessionContextDetails,
  getCurrentSceneId,
  isHostedSessionSceneCurrent,
  isApplicationHostReady
} from '../premium/session-host/host-context.js';
import {
  cancelToolWindowMonitor,
  startHostedToolWindowMonitor
} from '../premium/session-host/tool-window-monitor.js';
import {
  beginEditingTileTracking,
  endEditingTileWithRefresh
} from '../premium/session-host/editing-session-state.js';
import {
  handleSessionLaunchFailure as handleHostedSessionLaunchFailure,
  hasHostedSessionChanges,
  runHostedSessionLaunch,
  stopSessionWithFinalize,
  stopOrphanedSession as stopHostedOrphanedSession
} from '../premium/session-host/session-lifecycle.js';
import {
  handleEntitlementRevalidationFailure,
  scheduleEntitlementRevalidation
} from '../premium/session-host/entitlement-revalidation.js';
import {
  scheduleHostedToolOptionsRefresh,
  syncHostedToolOptions
} from '../premium/session-host/tool-options-sync.js';
import './masked-tiles.js';
import { normalizeMaskedTextureBlendMode } from './texture-blend-runtime.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from './texture-mask-runtime.js';
import { getFlattenedChunkEntries } from './texture-runtime-core.js';
import { hasStandardMaskCustomBaseSource } from './standard-mask-custom-base.js';
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
import {
  getGroundBandRenderSort,
  getTileRenderElevation,
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';
import {
  getDefaultTilePlacementLevelId,
  resolveTileRenderOrder
} from '../canvas/tile-band-utils.js';
import { resolvePlacementSortAtElevation } from '../canvas/canvas-interaction-controller.js';

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const EDITING_MODE_MASKED_TILING = 'maskedTiling';
const EDITING_MODE_STANDARD_TILE_MASK = 'standardTileMask';
const PREVIEW_LAYER_HOOK = 'fa-nexus-preview-layers-changed';

function stringifyError(error) {
  return String(error?.message || error);
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
    this._pendingLaunchPlacementAnchorTileId = undefined;
    this._sessionSceneId = null;
    this._hostUnavailableReason = 'host-context-unavailable';
    this._lastPreviewLayerSignature = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    return hasHostedSessionChanges(this._delegate);
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
    if (typeof delegate.setToolOptionsListener !== 'function') return delegate;
    try {
      delegate.setToolOptionsListener((options = {}) => {
        const suppressRender = options && typeof options === 'object' && 'suppressRender' in options
          ? !!options.suppressRender
          : false;
        this._syncToolOptionsState({ suppressRender });
      });
      this._delegateListenerBound = true;
    } catch (error) {
      Logger.warn?.('TexturePaintManager.toolOptionsListener.bindFailed', { error: stringifyError(error) });
    }
    return delegate;
  }

  _unbindDelegateListener(delegate = this._delegate) {
    if (!this._delegateListenerBound) return;
    this._delegateListenerBound = false;
    if (typeof delegate?.setToolOptionsListener !== 'function') return;
    try {
      delegate.setToolOptionsListener(null);
    } catch (error) {
      Logger.warn?.('TexturePaintManager.toolOptionsListener.unbindFailed', { error: stringifyError(error) });
    }
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
          } catch (error) {
            Logger.warn?.('TexturePaintManager.prepareMaskCanvas.hostPatch.failed', {
              error: stringifyError(error),
              width: Number(srcCanvas?.width || 0) || 0,
              height: Number(srcCanvas?.height || 0) || 0
            });
            return originalPrepareMaskCanvas.call(this, srcCanvas, ...args);
          }
        };
      }
    } catch (error) {
      Logger.error?.('TexturePaintManager.delegatePatch.failed', { error: stringifyError(error) });
      return delegate;
    }
    delegate._faNexusHostPatchApplied = true;
    return delegate;
  }

  async start(...args) {
    const delegate = await this._ensureDelegate();
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._captureLaunchPlacementAnchorTileId();
        this._snapshotSessionScene(null, 'start');
        if (!this._editingTileId) {
          this._clearEditingTile();
        }
        toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
        this._beginToolWindowMonitor('texture.paint', delegate);
        this._syncToolOptionsState({ suppressRender: false });
      },
      launchSession: () => delegate.start?.(...args),
      awaitLaunch: true,
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._applyPendingLaunchPlacementAnchorTileId();
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
        this._syncToolOptionsState({ suppressRender: false });
        this._scheduleToolOptionsRefresh();
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, { phase: 'start' }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async editTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editTile !== 'function') {
      throw new Error('Installed texture painter bundle does not support editing existing tiles.');
    }
    const tileId = resolveTileId(targetTile);
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._snapshotSessionScene(targetTile, 'edit');
        this._markEditingTile(targetTile, EDITING_MODE_MASKED_TILING);
        toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
        this._beginToolWindowMonitor('texture.paint', delegate);
        this._syncToolOptionsState({ suppressRender: false });
      },
      launchSession: () => delegate.editTile(targetTile, options),
      awaitLaunch: true,
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
        this._syncToolOptionsState({ suppressRender: false });
        this._scheduleToolOptionsRefresh();
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, {
        phase: 'edit',
        tileId
      }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async editStandardTile(targetTile, options = {}) {
    const delegate = await this._ensureDelegate();
    if (!delegate || typeof delegate.editStandardTile !== 'function') {
      throw new Error('Installed texture painter bundle does not support Mask Tile editing.');
    }
    const doc = targetTile?.document || targetTile || null;
    const src = String(doc?.texture?.src || '').trim();
    const hasFlattenedChunks = getFlattenedChunkEntries(doc).length > 0;
    const hasCustomBase = hasStandardMaskCustomBaseSource(doc);
    if (!src && !hasFlattenedChunks && !hasCustomBase) {
      Logger.error?.('TexturePaintManager.editStandardTile.missingTexture', { tileId: doc?.id || null });
      throw new Error('Mask Tile editing requires an image-backed tile.');
    }
    if (!hasCustomBase && /\.(webm|mp4)$/i.test(src)) {
      Logger.error?.('TexturePaintManager.editStandardTile.unsupportedVideo', { tileId: doc?.id || null, src });
      throw new Error('Mask Tile editing does not support video tiles.');
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
    const tileId = resolveTileId(targetTile);
    return runHostedSessionLaunch({
      beforeLaunch: () => {
        this._snapshotSessionScene(targetTile, 'edit-standard');
        this._markEditingTile(targetTile, EDITING_MODE_STANDARD_TILE_MASK);
        toolOptionsController.activateTool('texture.paint', { label: 'Texture Painter' });
        this._beginToolWindowMonitor('texture.paint', delegate);
        this._syncToolOptionsState({ suppressRender: false });
      },
      launchSession: () => delegate.editStandardTile(targetTile, launchOptions),
      awaitLaunch: true,
      afterLaunch: () => {
        try { canvas?.tiles?.releaseAll?.(); } catch (_) {}
        this._syncDelegatePreviewRenderSort();
        this._applyCurrentPreviewLayerOrdering();
        this._syncToolOptionsState({ suppressRender: false });
        this._scheduleToolOptionsRefresh();
      },
      handleLaunchFailure: (error) => this._handleSessionLaunchFailure(error, {
        phase: 'edit-standard',
        tileId
      }),
      scheduleEntitlementProbe: () => this._scheduleEntitlementProbe()
    });
  }

  async _handleSessionLaunchFailure(error, { phase = 'start', tileId = null } = {}) {
    return handleHostedSessionLaunchFailure({
      error,
      phase,
      loggerPrefix: 'TexturePaintManager',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        tileId: tileId || this._editingTileId || null,
        editingMode: this._editingTileMode || null
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason }) => this.stop({ reason }),
      onFallbackCleanup: () => {
        this._clearEditingTile();
        try { toolOptionsController.deactivateTool('texture.paint'); } catch (_) {}
      }
    });
  }

  _isEditorHostReady() {
    return isApplicationHostReady(this._app);
  }

  _snapshotSessionScene(target = null, phase = 'start') {
    const doc = resolveTileDocument(target);
    const sceneId = String(doc?.parent?.id || getCurrentSceneId() || '').trim();
    this._sessionSceneId = sceneId || null;
    if (!sceneId) {
      Logger.warn?.('TexturePaintManager.session.sceneIdMissing', { phase });
    }
    return this._sessionSceneId;
  }

  _isSessionHostReady() {
    if (!this._isEditorHostReady()) {
      this._hostUnavailableReason = 'host-context-unavailable';
      return false;
    }
    if (!isHostedSessionSceneCurrent(this._sessionSceneId)) {
      this._hostUnavailableReason = 'scene-changed-during-editor-session';
      return false;
    }
    this._hostUnavailableReason = 'host-context-unavailable';
    return true;
  }

  _handleInactiveMonitorStop() {
    if (this._sessionSceneId && !isHostedSessionSceneCurrent(this._sessionSceneId)) {
      Logger.warn?.('TexturePaintManager.session.sceneChangedInactive', {
        reason: 'scene-changed-during-editor-session',
        sessionSceneId: this._sessionSceneId || null,
        currentSceneId: getCurrentSceneId() || null,
        tileId: this._editingTileId || null,
        editingMode: this._editingTileMode || null
      });
    }
    this._sessionSceneId = null;
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    return stopHostedOrphanedSession({
      reason,
      loggerPrefix: 'TexturePaintManager',
      details: buildHostedSessionContextDetails({
        app: this._app,
        delegate: this._delegate,
        includeAppState: true,
        tileId: this._editingTileId || null,
        editingMode: this._editingTileMode || null,
        extra: {
          sessionSceneId: this._sessionSceneId || null,
          currentSceneId: getCurrentSceneId() || null
        }
      }),
      cancelToolWindowMonitor: () => this._cancelToolWindowMonitor(),
      stopSession: ({ reason: stopReason }) => this.stop({ reason: stopReason }),
      onFallbackCleanup: () => {
        this._sessionSceneId = null;
        this._clearEditingTile();
        try { toolOptionsController.deactivateTool('texture.paint'); } catch (_) {}
      }
    });
  }

  stop(...args) {
    return stopSessionWithFinalize({
      delegate: this._delegate,
      beforeStop: () => {
        this._cancelToolWindowMonitor();
        this._clearEditingTile();
      },
      stopSession: (delegate) => delegate.stop?.(...args),
      finalize: () => {
        this._sessionSceneId = null;
        this._unbindDelegateListener();
        toolOptionsController.deactivateTool('texture.paint');
      }
    });
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

  setSolidTextureColor(color, options = {}) {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    const setter = delegate.setSolidTextureColor;
    if (typeof setter !== 'function') {
      Logger.error('TexturePaintManager.solidTextureColor.unsupportedDelegate', {
        delegate: delegate?.constructor?.name || null,
        color
      });
      return false;
    }
    try {
      return setter.call(delegate, color, options);
    } catch (error) {
      Logger.error('TexturePaintManager.solidTextureColor.failed', {
        color,
        error: stringifyError(error)
      });
      throw error;
    }
  }

  hasActiveMarqueeSession() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    if (typeof delegate.hasActiveMarqueeSession !== 'function') {
      Logger.error('TexturePaintManager.marqueeSession.unsupportedDelegate', {
        delegate: delegate?.constructor?.name || null
      });
      ui?.notifications?.error?.('Texture Painter marquee session is not supported by the installed premium bundle.');
      return false;
    }
    try {
      return !!delegate.hasActiveMarqueeSession();
    } catch (error) {
      Logger.error('TexturePaintManager.marqueeSession.failed', {
        error: stringifyError(error)
      });
      ui?.notifications?.error?.(`Failed to read Texture Painter marquee session: ${error?.message || error}`);
      return false;
    }
  }

  isMarqueeModeActive() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    if (typeof delegate.isMarqueeModeActive !== 'function') {
      Logger.error('TexturePaintManager.marqueeMode.unsupportedDelegate', {
        delegate: delegate?.constructor?.name || null
      });
      ui?.notifications?.error?.('Texture Painter marquee mode is not supported by the installed premium bundle.');
      return false;
    }
    try {
      return !!delegate.isMarqueeModeActive();
    } catch (error) {
      Logger.error('TexturePaintManager.marqueeMode.failed', {
        error: stringifyError(error)
      });
      ui?.notifications?.error?.(`Failed to read Texture Painter marquee mode: ${error?.message || error}`);
      return false;
    }
  }

  async applyLayerPixelsToMarquee(docOrTile, { operation } = {}) {
    const delegate = this._delegate;
    const doc = docOrTile?.document || docOrTile || null;
    const tileId = resolveTileId(docOrTile) || doc?.id || null;
    if (!delegate?.isActive) {
      const error = new Error('Texture Painter is not active.');
      Logger.error('TexturePaintManager.marqueeLayerPixels.inactive', {
        tileId,
        operation: operation || null
      });
      ui?.notifications?.error?.(error.message);
      throw error;
    }
    if (typeof delegate.applyLayerPixelsToMarquee !== 'function') {
      const error = new Error('Installed texture painter bundle does not support Layer Manager marquee updates.');
      Logger.error('TexturePaintManager.marqueeLayerPixels.unsupportedDelegate', {
        delegate: delegate?.constructor?.name || null,
        tileId,
        operation: operation || null
      });
      ui?.notifications?.error?.(error.message);
      throw error;
    }
    try {
      return await delegate.applyLayerPixelsToMarquee(docOrTile, { operation });
    } catch (error) {
      Logger.error('TexturePaintManager.marqueeLayerPixels.failed', {
        tileId,
        operation: operation || null,
        error: stringifyError(error)
      });
      ui?.notifications?.error?.(`Failed to apply layer pixels to the marquee: ${error?.message || error}`);
      throw error;
    }
  }

  _scheduleEntitlementProbe() {
    return scheduleEntitlementRevalidation(this, {
      featureId: 'texture.paint',
      revalidateReason: 'texture-paint:revalidate',
      onFailure: (error) => this._handleEntitlementFailure(error)
    });
  }

  async _handleEntitlementFailure(error) {
    return handleEntitlementRevalidationFailure({
      error,
      featureId: 'texture.paint',
      loggerPrefix: 'TexturePaintManager',
      clearReason: 'texture-revalidate-failed',
      warningMessage: 'Authentication expired - premium texture painting has been disabled. Please reconnect Patreon.',
      stopSession: () => this.stop?.(),
      resetState: () => {
        this._unbindDelegateListener();
        this._delegate = null;
      }
    });
  }

  _beginToolWindowMonitor(toolId, delegate) {
    this._cancelToolWindowMonitor();
    if (!delegate) return;
    this._toolMonitor = startHostedToolWindowMonitor({
      delegate,
      toolId,
      isHostReady: () => this._isSessionHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
      cancelMonitor: () => this._cancelToolWindowMonitor(),
      stopOrphanedSession: (details) => this._stopOrphanedSession({
        ...details,
        reason: this._hostUnavailableReason || details?.reason
      }),
      onInactive: () => {
        this._handleInactiveMonitorStop();
      }
    });
  }

  _cancelToolWindowMonitor() {
    this._toolMonitor = cancelToolWindowMonitor(this._toolMonitor);
  }

  _markEditingTile(targetTile, mode = null) {
    try {
      const tileId = resolveTileId(targetTile);
      if (!tileId) return;
      const editingMode = normalizeEditingMode(mode);
      if (this._editingTileId && (this._editingTileId !== tileId || this._editingTileMode !== editingMode)) {
        this._clearEditingTile();
      }
      const { tile } = beginEditingTileTracking(this, {
        target: targetTile,
        sharedSetKey: EDITING_TILE_SET_KEY
      });
      this._editingTileMode = editingMode;
      if (tile) {
        const targets = getEditingRefreshTargets(tile, editingMode);
        if (targets.shouldRunMaskedTiling) applyMaskedTilingToTile(tile);
        if (targets.shouldRunStandardTileMask) applyStandardTileMaskToTile(tile);
      }
    } catch (error) {
      Logger.warn?.('TexturePaintManager.editingTile.refresh.failed', {
        error: stringifyError(error),
        tileId: resolveTileId(targetTile) || null,
        mode: normalizeEditingMode(mode)
      });
    }
  }

  _clearEditingTile() {
    const editingMode = this._editingTileMode;
    endEditingTileWithRefresh(this, {
      sharedSetKey: EDITING_TILE_SET_KEY,
      loggerPrefix: 'TexturePaintManager',
      beforeCollect: () => {
        this._editingTileMode = null;
      },
      collectRefreshJobs: ({ tile }) => {
        const refreshJobs = [];
        const targets = getEditingRefreshTargets(tile, editingMode);
        if (targets.shouldRunMaskedTiling) refreshJobs.push(Promise.resolve(applyMaskedTilingToTile(tile)));
        if (targets.shouldRunStandardTileMask) refreshJobs.push(Promise.resolve(applyStandardTileMaskToTile(tile)));
        return refreshJobs;
      },
      refreshAfterJobs: ({ tileId }) => requestSelectionFilterRefresh({
        reason: 'texture-editor-edit-exit',
        source: 'texture-paint-manager',
        tileIds: [tileId]
      })
    });
  }

  _buildToolOptionsState() {
    try {
      const delegateState = this._delegate?.buildToolOptionsState?.();
      if (delegateState && typeof delegateState === 'object') return delegateState;
    } catch (error) {
      Logger.warn?.('TexturePaintManager.toolOptionsState.delegateFailed', { error: stringifyError(error) });
    }
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
      textureBlendMode: { available: false },
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
    const addSelectControl = ({
      id,
      label,
      state,
      handlerId,
      valueMode = 'string'
    } = {}) => {
      if (!id || !state || typeof state !== 'object') return null;
      const options = Array.isArray(state.options)
        ? state.options
          .map((option) => ({
            value: String(option?.value ?? option?.id ?? ''),
            label: String(option?.label ?? option?.value ?? option?.id ?? ''),
            selected: !!option?.selected,
            disabled: !!option?.disabled
          }))
          .filter((option) => option.value.length)
        : [];
      if (!options.length) return null;
      controls[id] = {
        id,
        type: 'select',
        label,
        handlerId,
        valueMode,
        value: String(state.value ?? options.find((option) => option.selected)?.value ?? options[0]?.value ?? ''),
        options,
        disabled: !!state.disabled,
        hint: typeof state.hint === 'string' ? state.hint : '',
        tooltip: typeof state.tooltip === 'string' ? state.tooltip : ''
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
    if (legacyState?.blackPixelGate?.available) {
      const gate = legacyState.blackPixelGate;
      paintControlIds.push(addRangeControl({
        id: 'texture-black-pixel-fuzziness',
        label: 'Black Fuzziness',
        state: gate.fuzziness,
        handlerId: 'setBlackPixelGateFuzziness',
        headerToggle: {
          label: gate.label || 'Block Black',
          value: !!gate.enabled,
          disabled: !!gate.disabled,
          tooltip: gate.tooltip || '',
          ariaLabel: gate.label || 'Block Black',
          handlerId: 'setBlackPixelGateEnabled'
        },
        ariaLabel: 'Black pixel fuzziness'
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
    if (legacyState?.textureBlendMode?.available) {
      const blendControlId = addSelectControl({
        id: 'texture-blend-mode',
        label: 'Blend Mode',
        state: legacyState.textureBlendMode,
        handlerId: 'setTextureBlendMode'
      });
      if (blendControlId) {
        const colorSection = sections.find((section) => section?.id === 'color');
        if (colorSection) {
          colorSection.controls = [blendControlId, ...(Array.isArray(colorSection.controls) ? colorSection.controls : [])];
        } else {
          sections.push({
            id: 'color',
            label: 'Color',
            controls: [blendControlId]
          });
        }
      }
    }

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

  _callDelegateToolOption(handlerName, methodNames, args = []) {
    const names = Array.isArray(methodNames) ? methodNames : [methodNames];
    for (const methodName of names) {
      const fn = this._delegate?.[methodName];
      if (typeof fn !== 'function') continue;
      try {
        return fn.call(this._delegate, ...(Array.isArray(args) ? args : []));
      } catch (error) {
        Logger.error('TexturePaint.toolOptionHandler.failed', {
          handler: handlerName,
          delegateMethod: methodName,
          args,
          error: String(error?.message || error)
        });
        return false;
      }
    }
    return false;
  }

  _buildToolOptionsHandlers(legacyState = {}) {
    const handlers = {
      setTextureMode: (modeId) => this._callDelegateToolOption('setTextureMode', 'setTextureMode', [modeId]),
      handleTextureAction: (actionId) => this._callDelegateToolOption('handleTextureAction', 'handleTextureAction', [actionId]),
      handleEditorAction: (actionId) => this._callDelegateToolOption('handleEditorAction', 'handleEditorAction', [actionId]),
      setTextureOpacity: (value, commit) => this._callDelegateToolOption('setTextureOpacity', 'setTextureOpacity', [value, commit]),
      setBrushSize: (value, commit) => this._callDelegateToolOption('setBrushSize', 'setBrushSize', [value, commit]),
      setParticleSize: (value, commit) => this._callDelegateToolOption('setParticleSize', 'setParticleSize', [value, commit]),
      setParticleDensity: (value, commit) => this._callDelegateToolOption('setParticleDensity', 'setParticleDensity', [value, commit]),
      setSprayDeviation: (value, commit) => this._callDelegateToolOption('setSprayDeviation', 'setSprayDeviation', [value, commit]),
      setBrushSpacing: (value, commit) => this._callDelegateToolOption('setBrushSpacing', 'setBrushSpacing', [value, commit]),
      setElevation: (value, commit) => this._callDelegateToolOption('setElevation', 'setElevation', [value, commit]),
      setRotation: (value, commit) => this._callDelegateToolOption('setRotation', ['setRotation', 'setTextureRotation'], [value, commit]),
      setScale: (value, commit) => this._callDelegateToolOption('setScale', ['setScale', 'setTextureScale'], [value, commit]),
      setTextureOffset: (axis, value, commit) => this._callDelegateToolOption('setTextureOffset', 'setTextureOffset', [axis, value, commit]),
      setLayerOpacity: (value, commit) => this._callDelegateToolOption('setLayerOpacity', 'setLayerOpacity', [value, commit]),
      setTextureBlendMode: (value) => this._callDelegateToolOption('setTextureBlendMode', 'setTextureBlendMode', [normalizeMaskedTextureBlendMode(value)]),
      setHue: (value, commit) => this._callDelegateToolOption('setHue', 'setHue', [value, commit]),
      setSaturation: (value, commit) => this._callDelegateToolOption('setSaturation', 'setSaturation', [value, commit]),
      setBrightness: (value, commit) => this._callDelegateToolOption('setBrightness', 'setBrightness', [value, commit]),
      setContrast: (value, commit) => this._callDelegateToolOption('setContrast', 'setContrast', [value, commit]),
      setBlackPixelGateEnabled: (enabled) => this._callDelegateToolOption('setBlackPixelGateEnabled', 'setBlackPixelGateEnabled', [enabled]),
      setBlackPixelGateFuzziness: (value, commit) => this._callDelegateToolOption('setBlackPixelGateFuzziness', 'setBlackPixelGateFuzziness', [value, commit]),
      setHeightThreshold: (axis, value, commit) => this._callDelegateToolOption('setHeightThreshold', 'setHeightThreshold', [axis, value, commit]),
      setHeightContrast: (value, commit) => this._callDelegateToolOption('setHeightContrast', 'setHeightContrast', [value, commit]),
      setHeightLift: (value, commit) => this._callDelegateToolOption('setHeightLift', 'setHeightLift', [value, commit]),
      toggleHeightMapCollapsed: () => this._callDelegateToolOption('toggleHeightMapCollapsed', 'toggleHeightMapCollapsed')
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

  _notifyPreviewLayerChangeIfNeeded(descriptor = null, { force = false, source = 'texture-preview' } = {}) {
    const previewState = {
      active: !!this._delegate?.isActive,
      elevation: Number.isFinite(this._delegate?._previewElevation) ? Number(this._delegate._previewElevation) : null,
      sort: Number.isFinite(this._delegate?._previewSort) ? Number(this._delegate._previewSort) : null,
      mode: descriptor?.descriptor?.activeMode || null
    };
    const signature = JSON.stringify(previewState);
    if (!force && signature === this._lastPreviewLayerSignature) return;
    this._lastPreviewLayerSignature = signature;
    try { Hooks?.callAll?.(PREVIEW_LAYER_HOOK, { source, previewState }); } catch (_) {}
  }

  _captureLaunchPlacementAnchorTileId(controlledTiles = canvas?.tiles?.controlled) {
    const anchorTile = resolvePlacementAnchorTile(controlledTiles, { source: 'texture-paint-start' });
    const anchorTileId = String(anchorTile?.document?.id || anchorTile?.id || '').trim() || null;
    this._pendingLaunchPlacementAnchorTileId = anchorTileId;
    Logger.debug?.('TexturePaintManager.sortAnchor.launchCapture', {
      anchorTileId,
      elevation: Number(anchorTile?.document?.elevation ?? anchorTile?.elevation ?? 0) || 0,
      sort: Number(anchorTile?.document?.sort ?? anchorTile?.sort ?? 0) || 0
    });
    return anchorTileId;
  }

  _applyPendingLaunchPlacementAnchorTileId() {
    if (this._pendingLaunchPlacementAnchorTileId === undefined) return null;
    const anchorTileId = this._pendingLaunchPlacementAnchorTileId || null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    if (!this._delegate) return anchorTileId;
    try { this._delegate._placementSortAnchorTileId = anchorTileId; } catch (_) {}
    try { this._delegate._placementSortBeforeAnchor = false; } catch (_) {}
    Logger.debug?.('TexturePaintManager.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _syncDelegatePreviewRenderSort() {
    const delegate = this._delegate;
    if (!delegate) return null;
    const currentPlacementSort = Number(delegate?._previewSort ?? 0);
    if (this._editingTileId) {
      const resolvedSort = Number.isFinite(currentPlacementSort) ? currentPlacementSort : 0;
      try { delegate._previewRenderSort = resolvedSort; } catch (_) {}
      return resolvedSort;
    }
    const elevation = Number(delegate?._previewElevation ?? 0);
    const resolved = resolvePlacementSortAtElevation(Number.isFinite(elevation) ? elevation : 0, {
      anchorTileId: delegate?._placementSortAnchorTileId,
      sortBefore: delegate?._placementSortBeforeAnchor === true,
      scene: canvas?.scene,
      count: 1
    });
    const placementSort = Number(resolved?.sort ?? currentPlacementSort);
    if (Number.isFinite(placementSort) && Number.isFinite(currentPlacementSort) && Math.abs(placementSort - currentPlacementSort) > 0.000001) {
      Logger.debug?.('TexturePaintManager.previewSort.launchResolved', {
        previousSort: currentPlacementSort,
        resolvedSort: placementSort,
        elevation: Number.isFinite(elevation) ? elevation : 0,
        anchorTileId: delegate?._placementSortAnchorTileId || null
      });
      try { delegate._previewSort = placementSort; } catch (_) {}
    }
    const renderSort = Number(resolved?.previewSort ?? placementSort);
    const nextRenderSort = Number.isFinite(renderSort)
      ? renderSort
      : (Number.isFinite(placementSort) ? placementSort : 0);
    try { delegate._previewRenderSort = nextRenderSort; } catch (_) {}
    return nextRenderSort;
  }

  _applyCurrentPreviewLayerOrdering() {
    const layer = this._delegate?._layer;
    if (!layer || layer.destroyed) return;
    const baseSort = Number(this._delegate?._previewSort ?? 0);
    const baseRenderSort = Number(this._delegate?._previewRenderSort ?? this._syncDelegatePreviewRenderSort() ?? baseSort);
    const elevation = Number(this._delegate?._previewElevation ?? 0);
    const resolvedSort = Number.isFinite(baseSort) ? baseSort : 0;
    const resolvedRenderSort = Number.isFinite(baseRenderSort) ? baseRenderSort : resolvedSort;
    const resolvedElevation = Number.isFinite(elevation) ? elevation : 0;
    const placementLevelId = String(this._delegate?._previewPlacementLevelId || getDefaultTilePlacementLevelId() || '').trim() || null;
    const renderOrder = resolveTileRenderOrder({ elevation: resolvedElevation, sort: resolvedRenderSort }, {
      elevation: resolvedElevation,
      sort: resolvedRenderSort,
      placementLevelId,
      allowCurrentLevelFallback: true
    });
    const renderSort = Number.isFinite(Number(renderOrder?.sort)) ? Number(renderOrder.sort) : resolvedRenderSort;
    const renderElevation = Number.isFinite(Number(renderOrder?.elevation)) ? Number(renderOrder.elevation) : getTileRenderElevation(resolvedElevation);
    const zIndex = Number.isFinite(Number(renderOrder?.zIndex)) ? Number(renderOrder.zIndex) : (getGroundBandRenderSort(resolvedElevation, resolvedRenderSort) !== null ? resolvedRenderSort : 0);
    const sortLayer = Number.isFinite(Number(renderOrder?.sortLayer)) ? Number(renderOrder.sortLayer) : layer.sortLayer;
    try { layer.sort = renderSort; } catch (_) {}
    try { layer.faNexusSort = renderSort; } catch (_) {}
    try { layer.faNexusPlacementSort = resolvedSort; } catch (_) {}
    try { layer.faNexusPreviewSort = resolvedRenderSort; } catch (_) {}
    try { layer.faNexusElevationDoc = resolvedElevation; } catch (_) {}
    try { layer.faNexusElevation = renderElevation; } catch (_) {}
    try { layer.faNexusPlacementLevelId = renderOrder?.placementLevelId || placementLevelId || null; } catch (_) {}
    try { layer.faNexusBandKind = renderOrder?.kind || 'normal'; } catch (_) {}
    try { layer.elevation = renderElevation; } catch (_) {}
    try { layer.sortLayer = sortLayer; } catch (_) {}
    try { layer.zIndex = zIndex; } catch (_) {}
    const parent = layer.parent;
    if (!parent) return;
    try {
      if ('sortDirty' in parent) parent.sortDirty = true;
      parent.sortChildren?.();
    } catch (_) {}
  }

  applyLayerManagerPreviewPlacement({
    elevation = null,
    sort = undefined,
    previewSort = undefined,
    placementLevelId = undefined,
    anchorTileId = undefined,
    sortBefore = undefined
  } = {}) {
    if (!this._delegate?.isActive) return false;
    let changed = false;

    if (placementLevelId !== undefined) {
      const nextPlacementLevelId = String(placementLevelId || '').trim() || null;
      if (String(this._delegate?._previewPlacementLevelId || '').trim() !== String(nextPlacementLevelId || '').trim()) {
        try { this._delegate._previewPlacementLevelId = nextPlacementLevelId; } catch (_) {}
        changed = true;
      }
    }

    if (anchorTileId !== undefined) {
      const nextAnchorTileId = String(anchorTileId || '').trim() || null;
      if (String(this._delegate?._placementSortAnchorTileId || '').trim() !== String(nextAnchorTileId || '').trim()) {
        try { this._delegate._placementSortAnchorTileId = nextAnchorTileId; } catch (_) {}
        changed = true;
      }
    }

    if (sortBefore !== undefined) {
      const nextSortBefore = sortBefore === true;
      if (this._delegate?._placementSortBeforeAnchor !== nextSortBefore) {
        try { this._delegate._placementSortBeforeAnchor = nextSortBefore; } catch (_) {}
        changed = true;
      }
    }

    if (Number.isFinite(Number(elevation))) {
      const nextElevation = Number(elevation);
      if (Number(this._delegate?._previewElevation) !== nextElevation) {
        const handled = this._callDelegateToolOption('setElevation', 'setElevation', [nextElevation, true]);
        if (handled === false) this._delegate._previewElevation = nextElevation;
        changed = true;
      }
    }

    if (sort !== undefined && Number.isFinite(Number(sort))) {
      const nextSort = Number(sort);
      if (Number(this._delegate?._previewSort) !== nextSort) {
        try { this._delegate._previewSort = nextSort; } catch (_) {}
        changed = true;
      }
      const nextPreviewSort = previewSort !== undefined && Number.isFinite(Number(previewSort))
        ? Number(previewSort)
        : nextSort;
      if (Number(this._delegate?._previewRenderSort) !== nextPreviewSort) {
        try { this._delegate._previewRenderSort = nextPreviewSort; } catch (_) {}
        changed = true;
      }
    }

    if (!changed) return false;
    this._applyCurrentPreviewLayerOrdering();
    this._scheduleToolOptionsRefresh();
    this._notifyPreviewLayerChangeIfNeeded(null, { force: true, source: 'texture-preview-layer-manager' });
    return true;
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    const descriptor = this._buildToolOptionsDescriptor();
    syncHostedToolOptions({
      toolId: 'texture.paint',
      descriptor,
      suppressRender,
      loggerPrefix: 'TexturePaintManager'
    });
    this._notifyPreviewLayerChangeIfNeeded(descriptor, { source: 'texture-preview' });
  }

  _scheduleToolOptionsRefresh() {
    scheduleHostedToolOptionsRefresh({
      refresh: () => this._syncToolOptionsState({ suppressRender: false }),
      shouldRefresh: () => !!this._delegate?.isActive,
      loggerPrefix: 'TexturePaintManager'
    });
  }
}

export default TexturePaintManager;
