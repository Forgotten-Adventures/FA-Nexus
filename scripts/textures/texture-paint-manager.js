import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolvePremiumFeatureDelegate } from '../premium/session-host/delegate-bootstrap.js';
import { getPremiumRuntimeAdapter } from '../premium/session-host/premium-runtime-adapter.js';
import { callRequiredDelegateMethod } from '../premium/session-host/delegate-methods.js';
import { callRequiredPreviewPlacementAdapterMethod } from '../premium/session-host/preview-placement-adapter.js';
import {
  resolveTileDocument,
  resolveTileId
} from '../premium/session-host/editing-targets.js';
import {
  buildHostedSessionContextDetails,
  isApplicationHostReady
} from '../premium/session-host/host-context.js';
import {
  beginHostedToolWindowMonitor,
  cancelHostedToolWindowMonitor
} from '../premium/session-host/tool-window-monitor.js';
import {
  beginEditingTileTracking,
  endEditingTileTracking,
  endEditingTileWithRefresh
} from '../premium/session-host/editing-session-state.js';
import {
  handleSessionLaunchFailure as handleHostedSessionLaunchFailure,
  hasHostedSessionChanges,
  runHostedSessionLaunch,
  syncHostedPreviewLaunchState,
  stopSessionWithFinalize
} from '../premium/session-host/session-lifecycle.js';
import {
  handleInactiveHostedSceneSessionStop,
  isHostedSceneSessionHostReady,
  snapshotHostedSessionScene,
  stopOrphanedHostedSceneSession
} from '../premium/session-host/scene-session-guard.js';
import {
  handleEntitlementRevalidationFailure,
  scheduleEntitlementRevalidation
} from '../premium/session-host/entitlement-revalidation.js';
import {
  notifyHostedPreviewLayerChangeIfNeeded,
  scheduleHostedToolOptionsRefresh,
  syncHostedToolOptions
} from '../premium/session-host/tool-options-sync.js';
import './masked-tiles.js';
import { TextureToolOptionsAdapter } from './texture-tool-options-adapter.js';
import {
  applyMaskedTilingToTile,
  applyStandardTileMaskToTile
} from './texture-mask-runtime.js';
import { getFlattenedChunkEntries } from './texture-runtime-core.js';
import { hasStandardMaskCustomBaseSource } from './standard-mask-custom-base.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { buildHsbcToolOptionsControls } from '../core/hsbc.js';
import {
  addDeclarativeActionRowControl,
  addDeclarativeHintControl,
  addDeclarativeRangeControl,
  addDeclarativeRangePairControl,
  addDeclarativeScalarRandomizedControl,
  addDeclarativeSelectControl,
  addDeclarativeToggleListControl
} from '../core/tool-options/tool-options-control-builders.js';
import { requestSelectionFilterRefresh } from '../canvas/selection-filter-refresh.js';
import {
  resolvePlacementAnchorTile
} from '../canvas/elevation-band-utils.js';

const EDITING_TILE_SET_KEY = '__faNexusTextureEditingTileIds';
const EDITING_MODE_MASKED_TILING = 'maskedTiling';
const EDITING_MODE_STANDARD_TILE_MASK = 'standardTileMask';

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
    this.premiumRuntimeAdapter = getPremiumRuntimeAdapter(app);
    this._delegate = null;
    this._loading = null;
    this._entitlementProbe = null;
    this._toolMonitor = null;
    this._editingTileId = null;
    this._editingTileMode = null;
    this._pendingLaunchPlacementAnchorTileId = undefined;
    this._sessionSceneId = null;
    this._hostUnavailableReason = 'host-context-unavailable';
    this._lastPreviewLayerSignature = null;
    this._toolOptionsAdapter = null;
    this._syncToolOptionsState();
  }

  get isActive() {
    return !!this._delegate?.isActive;
  }

  hasSessionChanges() {
    return hasHostedSessionChanges(this._delegate);
  }

  async _ensureDelegate() {
    if (this._delegate) return this._delegate;
    if (this._loading) return this._loading;
    this._loading = resolvePremiumFeatureDelegate({
      featureId: 'texture.paint',
      app: this._app,
      host: this,
      assignDelegate: (instance) => {
        this._delegate = instance;
      },
      missingMessage: 'Premium texture editor bundle missing TexturePaintManager implementation'
    });
    try {
      return await this._loading;
    } finally {
      this._loading = null;
    }
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
      launchSession: () => callRequiredDelegateMethod({
        delegate,
        methodName: 'start',
        args,
        loggerPrefix: 'TexturePaintManager',
        logScope: 'sessionLaunch',
        bundleLabel: 'texture painter'
      }),
      awaitLaunch: true,
      afterLaunch: () => {
        syncHostedPreviewLaunchState({
          applyLaunchPlacementAnchorTileId: () => this._applyPendingLaunchPlacementAnchorTileId(),
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
        syncHostedPreviewLaunchState({
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
        syncHostedPreviewLaunchState({
          syncPreviewRenderSort: () => this._syncDelegatePreviewRenderSort(),
          applyCurrentPreviewLayerOrdering: () => this._applyCurrentPreviewLayerOrdering()
        });
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
    return snapshotHostedSessionScene(this, {
      target,
      phase,
      loggerPrefix: 'TexturePaintManager'
    });
  }

  _isSessionHostReady() {
    return isHostedSceneSessionHostReady(this, {
      app: this._app,
      isEditorHostReady: () => this._isEditorHostReady()
    });
  }

  _handleInactiveMonitorStop() {
    return handleInactiveHostedSceneSessionStop(this, {
      loggerPrefix: 'TexturePaintManager',
      details: {
        tileId: this._editingTileId || null,
        editingMode: this._editingTileMode || null
      }
    });
  }

  _stopOrphanedSession({ reason = 'host-context-unavailable' } = {}) {
    return stopOrphanedHostedSceneSession(this, {
      reason,
      loggerPrefix: 'TexturePaintManager',
      app: this._app,
      delegate: this._delegate,
      contextDetails: {
        tileId: this._editingTileId || null,
        editingMode: this._editingTileMode || null
      },
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
        this._clearEditingTile({ refresh: false });
      },
      stopSession: (delegate) => callRequiredDelegateMethod({
        delegate,
        methodName: 'stop',
        args,
        loggerPrefix: 'TexturePaintManager',
        logScope: 'sessionStop',
        bundleLabel: 'texture painter'
      }),
      finalize: () => {
        this._sessionSceneId = null;
        toolOptionsController.deactivateTool('texture.paint');
      }
    });
  }

  async save(...args) {
    const delegate = await this._ensureDelegate();
    return callRequiredDelegateMethod({
      delegate,
      methodName: 'save',
      args,
      loggerPrefix: 'TexturePaintManager',
      logScope: 'persistence',
      bundleLabel: 'texture painter'
    });
  }

  async saveMask(...args) {
    const delegate = await this._ensureDelegate();
    return callRequiredDelegateMethod({
      delegate,
      methodName: 'saveMask',
      args,
      loggerPrefix: 'TexturePaintManager',
      logScope: 'persistence',
      bundleLabel: 'texture painter'
    });
  }

  async placeMaskedTiling(...args) {
    const delegate = await this._ensureDelegate();
    return callRequiredDelegateMethod({
      delegate,
      methodName: 'placeMaskedTiling',
      args,
      loggerPrefix: 'TexturePaintManager',
      logScope: 'persistence',
      bundleLabel: 'texture painter'
    });
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
    try {
      return !!callRequiredDelegateMethod({
        delegate,
        methodName: 'hasActiveMarqueeSession',
        loggerPrefix: 'TexturePaintManager',
        logScope: 'marqueeSession',
        bundleLabel: 'texture painter'
      });
    } catch (error) {
      Logger.error('TexturePaintManager.marqueeSession.failed', {
        error: stringifyError(error)
      });
      ui?.notifications?.error?.(`Failed to read Texture Painter marquee session: ${error?.message || error}`);
      throw error;
    }
  }

  isMarqueeModeActive() {
    const delegate = this._delegate;
    if (!delegate?.isActive) return false;
    try {
      return !!callRequiredDelegateMethod({
        delegate,
        methodName: 'isMarqueeModeActive',
        loggerPrefix: 'TexturePaintManager',
        logScope: 'marqueeMode',
        bundleLabel: 'texture painter'
      });
    } catch (error) {
      Logger.error('TexturePaintManager.marqueeMode.failed', {
        error: stringifyError(error)
      });
      ui?.notifications?.error?.(`Failed to read Texture Painter marquee mode: ${error?.message || error}`);
      throw error;
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
    try {
      return await callRequiredDelegateMethod({
        delegate,
        methodName: 'applyLayerPixelsToMarquee',
        args: [docOrTile, { operation }],
        loggerPrefix: 'TexturePaintManager',
        logScope: 'marqueeLayerPixels',
        bundleLabel: 'texture painter'
      });
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
      editorLabel: 'Texture Painter session'
    });
  }

  _beginToolWindowMonitor(toolId, delegate) {
    beginHostedToolWindowMonitor(this, {
      delegate,
      toolId,
      isHostReady: () => this._isSessionHostReady(),
      clearEditingTile: () => this._clearEditingTile(),
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
    cancelHostedToolWindowMonitor(this);
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

  _clearEditingTile({ refresh = true } = {}) {
    const editingMode = this._editingTileMode;
    if (!refresh) {
      this._editingTileMode = null;
      return endEditingTileTracking(this, {
        sharedSetKey: EDITING_TILE_SET_KEY
      });
    }
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

  _getToolOptionsAdapter() {
    if (!this._toolOptionsAdapter) {
      this._toolOptionsAdapter = new TextureToolOptionsAdapter({
        buildToolOptionsState: () => this._buildToolOptionsState(),
        buildDeclarativeToolOptionsConfig: (legacyState) => this._buildDeclarativeToolOptionsConfig(legacyState),
        getToolOptionsHostState: () => this._getToolOptionsHostState(),
        getCustomToggleHandlers: () => this._getCustomToggleHandlers(),
        callDelegateToolOption: (handlerName, methodName, args) => this._callDelegateToolOption(handlerName, methodName, args),
        hasSessionChanges: () => this.hasSessionChanges(),
        getEditingTileId: () => this._editingTileId || null
      });
    }
    return this._toolOptionsAdapter;
  }

  _buildToolOptionsState() {
    const delegate = this._delegate;
    if (delegate) {
      const delegateState = callRequiredDelegateMethod({
        delegate,
        methodName: 'buildToolOptionsState',
        loggerPrefix: 'TexturePaintManager',
        logScope: 'toolOptionsState',
        bundleLabel: 'texture painter'
      });
      if (delegateState && typeof delegateState === 'object') return delegateState;
      Logger.error?.('TexturePaintManager.toolOptionsState.invalidState', {
        stateType: typeof delegateState
      });
      throw new Error('Texture painter bundle returned invalid tool-options state.');
    }
    return {
      hints: [
        'LMB paint the texture;',
        'E to toggle erase mode.',
        'Ctrl/Cmd+Wheel adjusts brush size.',
        'Alt+Wheel changes tile elevation by 0.001; Ctrl/Cmd+Alt+Wheel moves it one layer.',
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
    return this._getToolOptionsAdapter().buildDescriptor();
  }

  _getToolOptionsHostState() {
    const delegate = this._delegate;
    if (!delegate) return {};
    const state = callRequiredDelegateMethod({
      delegate,
      methodName: 'getToolOptionsHostState',
      loggerPrefix: 'TexturePaintManager',
      logScope: 'toolOptionsHostState',
      bundleLabel: 'texture painter'
    });
    if (state && typeof state === 'object') return state;
    Logger.error?.('TexturePaintManager.toolOptionsHostState.invalidState', {
      stateType: typeof state
    });
    throw new Error('Texture painter bundle returned invalid tool-options host state.');
  }

  _getCustomToggleHandlers() {
    const delegate = this._delegate;
    if (!delegate) return {};
    const handlers = callRequiredDelegateMethod({
      delegate,
      methodName: 'getCustomToggleHandlers',
      loggerPrefix: 'TexturePaintManager',
      logScope: 'toolOptionsHandlers',
      bundleLabel: 'texture painter'
    });
    if (!handlers) return {};
    if (handlers && typeof handlers === 'object') return handlers;
    Logger.error?.('TexturePaintManager.toolOptionsHandlers.invalidHandlers', {
      handlersType: typeof handlers
    });
    throw new Error('Texture painter bundle returned invalid custom toggle handlers.');
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}) {
    const controls = {};
    const sections = [];
    const addHintControl = (config) => addDeclarativeHintControl(controls, config);
    const addRangeControl = (config) => addDeclarativeRangeControl(controls, config, {
      includeHeaderToggle: true
    });
    const addRangePairControl = (config) => addDeclarativeRangePairControl(controls, config);
    const addSelectControl = (config) => addDeclarativeSelectControl(controls, config);
    const addToggleListControl = (config) => addDeclarativeToggleListControl(controls, config);
    const addActionRowControl = (config) => addDeclarativeActionRowControl(controls, config);
    const addScalarRandomizedControl = (config) => addDeclarativeScalarRandomizedControl(controls, config);

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
        modeControlIds.push(addToggleListControl({
          id: 'texture-mode-options',
          items: subtoolOptions
        }));
      }
      modeControlIds.push(addHintControl({
        id: 'texture-mode-status',
        text: legacyState.texturePaint.status
      }));
      const textureActions = Array.isArray(legacyState.texturePaint.actions)
        ? legacyState.texturePaint.actions.filter((action) => action && typeof action === 'object')
        : [];
      if (textureActions.length) {
        modeControlIds.push(addActionRowControl({
          id: 'texture-mode-actions',
          handlerId: 'handleTextureAction',
          actions: textureActions
        }));
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
      heightMapControlIds.push(addToggleListControl({
        id: 'height-map-options',
        items: heightMapToggles
      }));
    }
    if (legacyState?.heightBrush?.available) {
      const heightBrush = legacyState.heightBrush;
      heightMapControlIds.push(addRangePairControl({
        id: 'height-threshold',
        label: heightBrush.label || 'Height Threshold',
        state: heightBrush,
        handlerId: 'setHeightThreshold',
        hint: heightBrush.hint,
        items: [
          {
            id: 'min',
            label: 'Min',
            ariaLabel: 'Height threshold minimum',
            state: heightBrush.min
          },
          {
            id: 'max',
            label: 'Max',
            ariaLabel: 'Height threshold maximum',
            state: heightBrush.max
          }
        ]
      }));
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
      transformControlIds.push(addRangePairControl({
        id: 'texture-offset',
        label: 'Texture Offset',
        state: legacyState.textureOffset,
        handlerId: 'setTextureOffset',
        items: [
          {
            id: 'x',
            label: 'X',
            ariaLabel: 'Texture offset X',
            handlerArg: 'x',
            state: legacyState.textureOffset.x
          },
          {
            id: 'y',
            label: 'Y',
            ariaLabel: 'Texture offset Y',
            handlerArg: 'y',
            state: legacyState.textureOffset.y
          }
        ]
      }));
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
      sections.push({
        id: 'session',
        label: 'Session',
        region: 'footer',
        collapsible: false,
        controls: [addActionRowControl({
          id: 'texture-session-actions',
          actions: editorActions
        })]
      });
    }

    return { controls, sections };
  }

  _callDelegateToolOption(handlerName, methodName, args = []) {
    try {
      return callRequiredDelegateMethod({
        delegate: this._delegate,
        methodName,
        args,
        loggerPrefix: 'TexturePaintManager',
        logScope: 'toolOptionHandler',
        bundleLabel: 'texture painter'
      });
    } catch (error) {
      const message = stringifyError(error);
      if (!message.includes(`does not support ${methodName}()`)) {
        Logger.error?.('TexturePaintManager.toolOptionHandler.failed', {
          handler: handlerName,
          delegateMethod: methodName,
          args,
          error: message
        });
      }
      throw error;
    }
  }

  _buildToolOptionsHandlers(legacyState = {}) {
    return this._getToolOptionsAdapter().buildHandlers(legacyState);
  }

  _notifyPreviewLayerChangeIfNeeded(descriptor = null, { force = false, source = 'texture-preview' } = {}) {
    const hostState = this._getPreviewLayerHostState();
    const previewState = {
      active: !!hostState?.active,
      elevation: Number.isFinite(hostState?.elevation) ? Number(hostState.elevation) : null,
      sort: Number.isFinite(hostState?.sort) ? Number(hostState.sort) : null,
      mode: descriptor?.descriptor?.activeMode || null
    };
    notifyHostedPreviewLayerChangeIfNeeded({
      previewState,
      source,
      force,
      lastSignature: this._lastPreviewLayerSignature,
      setLastSignature: (signature) => { this._lastPreviewLayerSignature = signature; },
      loggerPrefix: 'TexturePaintManager'
    });
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
    this._callRequiredPreviewPlacementDelegateMethod('applyLaunchPlacementAnchorTileId', [anchorTileId]);
    Logger.debug?.('TexturePaintManager.sortAnchor.launchApply', { anchorTileId });
    return anchorTileId;
  }

  _getPreviewLayerHostState() {
    if (!this._delegate) return { active: false, elevation: null, sort: null };
    return this._callRequiredPreviewPlacementDelegateMethod('getPreviewLayerHostState');
  }

  _callRequiredPreviewPlacementDelegateMethod(methodName, args = []) {
    return callRequiredPreviewPlacementAdapterMethod({
      delegate: this._delegate,
      adapterKind: 'texture',
      methodName,
      args,
      loggerPrefix: 'TexturePaintManager',
      bundleLabel: 'texture painter'
    });
  }

  _syncDelegatePreviewRenderSort() {
    if (!this._delegate) return null;
    return this._callRequiredPreviewPlacementDelegateMethod('syncPreviewRenderSort', [{
      editingTileId: this._editingTileId || null
    }]);
  }

  _applyCurrentPreviewLayerOrdering() {
    if (!this._delegate) return false;
    return this._callRequiredPreviewPlacementDelegateMethod('applyCurrentPreviewLayerOrdering');
  }

  applyLayerManagerPreviewPlacement({
    elevation = null,
    sort = undefined,
    previewSort = undefined,
    placementLevelId = undefined,
    anchorTileId = undefined,
    sortBefore = undefined
  } = {}) {
    if (!this._delegate) return false;
    const changed = !!this._callRequiredPreviewPlacementDelegateMethod('applyLayerManagerPreviewPlacement', [{
      elevation,
      sort,
      previewSort,
      placementLevelId,
      anchorTileId,
      sortBefore
    }]);
    if (!changed) return false;
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

  requestToolOptionsUpdate(options = {}) {
    this._syncToolOptionsState(options);
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
