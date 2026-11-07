import { TokenDragDropManager } from './token-dragdrop-manager.js';
import { ActorFactory } from './actor-factory.js';
import { TokenPlacementInteractionWorkflow } from './token-placement-interaction-workflow.js';
import { createActorTokenPlacement, createTokenPlacementDocument } from './token-placement-transaction-workflow.js';
import {
  buildMatchTokens,
  derivePlaceAsMatchKey,
  normalizeMatchString,
  scorePlaceAsOption,
  stripFileExtension,
  tokenizeMatchString
} from './token-place-as-matching.js';
import {
  AUTO_NEW_ACTOR_TYPE_SELECTION,
  MAX_PLACE_AS_SUGGESTIONS,
  TokenPlaceAsSelectionState
} from './token-place-as-selection-state.js';
import * as SystemDetection from './system-detection.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getCanvasInteractionController, announceChange } from '../canvas/canvas-interaction-controller.js';
import { isPointerOverCanvas } from '../canvas/canvas-pointer-utils.js';
import { SHORTCUT_ACTION, createShortcut } from '../core/editor-shortcuts.js';
import { createNormalizedToolOptionsDescriptor, TOOL_OPTIONS_RENDERER_MODE } from '../core/tool-options/tool-options-descriptor.js';
import {
  addDeclarativeAxisTogglePairControl,
  addDeclarativeScalarRandomizedControl
} from '../core/tool-options/tool-options-control-builders.js';
import { toolOptionsController } from '../core/tool-options/tool-options-controller.js';
import { PlacementPrefetchQueue } from '../core/placement/placement-prefetch-queue.js';
import {
  activatePlacementToolOptions,
  deactivatePlacementToolOptions
} from '../core/placement/placement-session-utils.js';
import { normalizeTokenPlacementEntry } from './token-placement-entry.js';
import { applyTokenCardCachedState, isDirectTokenCacheUrl } from './token-card-cache-state.js';

const HP_MODES = ['actor', 'formula', 'percent', 'static'];
const DEFAULT_HP_PERCENT = 20;
const DEFAULT_ROTATION_RANDOM_MIN = 0;
const DEFAULT_ROTATION_RANDOM_MAX = 359;
const joinPath = (folder, name) => {
  const filename = String(name || '').trim();
  if (!filename) return String(folder || '').trim();
  const base = String(folder || '').trim();
  if (!base) return filename;
  return `${base.replace(/\/+$/, '')}/${filename}`;
};

/**
 * TokenPlacementManager
 * Handles click-to-place token workflow aligned with asset placement behaviour
 * while preserving existing drag & drop flows.
 */
export class TokenPlacementManager {
  constructor(app) {
    this.app = app;
    this._interactionController = getCanvasInteractionController();
    this._interactionWorkflow = new TokenPlacementInteractionWorkflow(this);
    this.isPlacementActive = false;
    this._stickyMode = false;
    this._current = null; // { card, payload }
    this._preview = null;
    this._lastPointer = null;
    this._lastPointerWorld = null;
    this._rotation = 0;
    this._rotationRandomEnabled = false;
    this._rotationRandomMin = DEFAULT_ROTATION_RANDOM_MIN;
    this._rotationRandomMax = DEFAULT_ROTATION_RANDOM_MAX;
    this._pendingRotation = 0;
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = false;
    this._pendingFlipVertical = false;
    this._placing = false;
    this._settingsHook = null;
    this._gridSnapHook = null;
    this._actorOptionHook = null;
    this._randomMode = false;
    this._randomEntries = [];
    this._currentEntry = null;
    this._authContext = { authed: false, authState: null };
    this._randomPrefetch = new PlacementPrefetchQueue({
      prefetchCount: 4,
      getItemKey: (entry) => this._entryKey(entry),
      needsPrefetch: (entry) => this._entryNeedsPrefetch(entry),
      prefetch: (entry) => this._prefetchEntry(entry),
      logger: Logger,
      loggerTag: 'TokenPlacement.prefetch'
    });
    this._placeAsSelection = new TokenPlaceAsSelectionState();
    this._placeAsResolvedCompendium = new Map();
    this._placeAsRefreshPromise = null;
    this._placeAsRefreshTimer = null;
    this._placeAsActorHooksInstalled = false;
    this._placeAsAvailablePacks = [];
    this._placeAsFilterDialogOpen = false;
    this._newActorTypeChoices = [];
    this._newActorTypeAuto = '';
    this._newActorTypeOverride = null;
    this._newActorTypeLoading = false;
    this._newActorTypeError = null;
    this._newActorTypeRefreshPromise = null;
    this._hpMode = 'actor';
    this._hpPercent = DEFAULT_HP_PERCENT;
    this._hpStaticValue = '';
    this._hpFormulaWarned = false;
    this._appendNumberOverride = null;
    this._prependAdjectiveOverride = null;
    this._scrollingTextGuardReady = false;

    this._installGridSnapHooks();
    this._installActorOptionHooks();
    this._loadExcludedPacks();
    this._ensureActorOptionsLoaded();
    this._ensureNewActorTypeOptionsLoaded();
    this._syncToolOptionsState();
  }

  _readAuthContext() {
    let authed = false;
    let authState = null;
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      authed = !!(auth && auth.authenticated && auth.state);
      authState = authed ? auth.state : null;
    } catch (_) {}
    return { authed, authState };
  }

  _activateToolOptions() {
    activatePlacementToolOptions({
      toolId: 'token.placement',
      label: 'Token Placement',
      syncToolOptions: (options) => this._syncToolOptionsState(options)
    });
  }

  _deactivateToolOptions() {
    deactivatePlacementToolOptions('token.placement');
  }

  _activateTokensLayer() {
    try { canvas?.tokens?.activate?.(); }
    catch (_) { /* no-op */ }
  }

  primeActorTypeChoices() {
    return this._ensureNewActorTypeOptionsLoaded();
  }

  async startPlacementFromCard(cardElement, { sticky = false, pointerEvent = null } = {}) {
    try {
      if (!cardElement) return;
      // Prevent starting a new placement while one is already active
      if (this.isPlacementActive) this.cancelPlacement('restart');
      this._randomMode = false;
      this._randomEntries = [];
      this._currentEntry = null;
      try { this._randomPrefetch?.reset?.(); } catch (_) {}

      const isCloud = (cardElement.getAttribute('data-source') || '').toLowerCase() === 'cloud';
      const tier = (cardElement.getAttribute('data-tier') || '').toLowerCase();
      const downloaded = cardElement.getAttribute('data-cached') === 'true';
      this._authContext = this._readAuthContext();
      const { authed, authState } = this._authContext;
      if (isCloud && tier === 'premium' && !authed && !downloaded) {
        ui.notifications?.error?.('Authentication required for premium tokens. Please connect Patreon.');
        return;
      }

      const payload = await this._prepareTokenPayload(cardElement, { authed, authState });
      if (!payload) return;
      payload.url = this._resolveCurrentUrl(cardElement, payload);

      this._ensureActorOptionsLoaded();
      this._ensureNewActorTypeOptionsLoaded();
      this._applyPlaceAsMatchContext(payload, cardElement, { resetContext: true, autoSelect: true });

      this.isPlacementActive = true;
      this._stickyMode = !!sticky;
      this._hpFormulaWarned = false;
      this._current = { card: cardElement, payload };
      this._currentEntry = this._createEntryFromCard(cardElement, payload);
      this._rotation = 0;
      this._rotationRandomEnabled = false;
      this._rotationRandomMin = DEFAULT_ROTATION_RANDOM_MIN;
      this._rotationRandomMax = DEFAULT_ROTATION_RANDOM_MAX;
      this._pendingRotation = this._rotation;
      this._updateRotationPreview();
      this._flipHorizontal = false;
      this._flipVertical = false;
      this._flipRandomHorizontalEnabled = false;
      this._flipRandomVerticalEnabled = false;
      this._flipRandomHorizontalOffset = false;
      this._flipRandomVerticalOffset = false;
      this._pendingFlipHorizontal = this._flipHorizontal;
      this._pendingFlipVertical = this._flipVertical;
      this._updateFlipPreview();
      this._placing = false;
      this._activateToolOptions();
      this._activateTokensLayer();

      const startPointer = pointerEvent
        ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      this._lastPointer = startPointer;

      try { TokenDragDropManager.setHoverSuppressed(true); } catch (_) {}
      try { this.app?._tokenPreview?.hidePreview?.(); } catch (_) {}

      this._installPreview(cardElement, startPointer);
      this._applyRotationToPreview();
      this._clearActorHoverHighlight();
      this._setupEvents();
      this._announceStart(sticky);
    } catch (error) {
      Logger.warn('TokenPlacement.start.failed', { error: String(error?.message || error) });
      if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
      this.cancelPlacement('error');
    }
  }

  async startPlacementFromEntries(entries, { sticky = true, pointerEvent = null, forceRandom = false } = {}) {
    const list = Array.isArray(entries) ? entries : [];
    if (!list.length) return;
    this._authContext = this._readAuthContext();
    if (list.length === 1 && list[0]?.card && !forceRandom) {
      await this.startPlacementFromCard(list[0].card, { sticky, pointerEvent });
      return;
    }
    await this.startPlacementRandomFromEntries(list, { sticky, pointerEvent });
  }

  async startPlacementRandomFromEntries(entries, { sticky = true, pointerEvent = null } = {}) {
    try {
      const list = Array.isArray(entries) ? entries : [];
      if (!list.length) return;
      if (this.isPlacementActive) this.cancelPlacement('restart');
      this._authContext = this._readAuthContext();

      const normalized = list
        .map((entry) => this._normalizeEntry(entry))
        .filter((entry) => !!entry);
      if (!normalized.length) return;

      this.isPlacementActive = true;
      this._stickyMode = sticky !== false;
      this._randomMode = true;
      this._randomEntries = normalized;
      this._currentEntry = null;
      this._current = null;
      this._hpFormulaWarned = false;
      this._rotation = 0;
      this._rotationRandomEnabled = false;
      this._rotationRandomMin = DEFAULT_ROTATION_RANDOM_MIN;
      this._rotationRandomMax = DEFAULT_ROTATION_RANDOM_MAX;
      this._pendingRotation = this._rotation;
      this._updateRotationPreview();
      this._flipHorizontal = false;
      this._flipVertical = false;
      this._flipRandomHorizontalEnabled = false;
      this._flipRandomVerticalEnabled = false;
      this._flipRandomHorizontalOffset = false;
      this._flipRandomVerticalOffset = false;
      this._pendingFlipHorizontal = this._flipHorizontal;
      this._pendingFlipVertical = this._flipVertical;
      this._updateFlipPreview();
      this._placing = false;
      this._ensureActorOptionsLoaded();
      this._ensureNewActorTypeOptionsLoaded();
      this._applyPlaceAsMatchContext(null, null, { resetContext: true, autoSelect: false });
      this._activateToolOptions();
      this._activateTokensLayer();

      const startPointer = pointerEvent
        ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      this._lastPointer = startPointer;
      this._lastPointerWorld = null;

      try { TokenDragDropManager.setHoverSuppressed(true); } catch (_) {}
      try { this.app?._tokenPreview?.hidePreview?.(); } catch (_) {}

      this._randomPrefetch.setPool(normalized);
      this._randomPrefetch.prime();

      await this._switchToNextRandomEntry({ initial: true, pointerEvent });

      this._clearActorHoverHighlight();
      this._setupEvents();
      this._announceStart(true);
    } catch (error) {
      Logger.warn('TokenPlacement.random.start.failed', { error: String(error?.message || error) });
      if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
      this.cancelPlacement('error');
    }
  }

  cancelPlacement(reason = 'user') {
    if (!this.isPlacementActive) return;
    this.isPlacementActive = false;
    this._stickyMode = false;
    this._placing = false;
    this._randomMode = false;
    this._randomEntries = [];
    this._currentEntry = null;
    try { this._randomPrefetch?.reset?.(); } catch (_) {}
    const maintainToolUI = reason === 'restart' || reason === 'replace';
    if (!maintainToolUI) {
      this._deactivateToolOptions();
    }
    try { TokenDragDropManager.setHoverSuppressed(false); } catch (_) {}
    this._teardownEvents();
    this._removePreview();
    this._current = null;
    this._rotation = 0;
    this._rotationRandomEnabled = false;
    this._rotationRandomMin = DEFAULT_ROTATION_RANDOM_MIN;
    this._rotationRandomMax = DEFAULT_ROTATION_RANDOM_MAX;
    this._pendingRotation = 0;
    this._flipHorizontal = false;
    this._flipVertical = false;
    this._flipRandomHorizontalEnabled = false;
    this._flipRandomVerticalEnabled = false;
    this._flipRandomHorizontalOffset = false;
    this._flipRandomVerticalOffset = false;
    this._pendingFlipHorizontal = false;
    this._pendingFlipVertical = false;
    this._lastPointer = null;
    this._lastPointerWorld = null;
    try {
      if (reason === 'esc') {
        const target = this.app?.element || document;
        target?.dispatchEvent?.(new CustomEvent('fa-nexus:placement-cancelled', { bubbles: true }));
      }
    } catch (_) {}
    this._hpFormulaWarned = false;
  }

  destroy() {
    try { this.cancelPlacement('destroy'); } catch (_) {}
    if (this._placeAsRefreshTimer) {
      try { clearTimeout(this._placeAsRefreshTimer); } catch (_) {}
      this._placeAsRefreshTimer = null;
    }
    const hooks = globalThis?.Hooks;
    if (hooks && typeof hooks.off === 'function') {
      if (this._settingsHook) {
        try { hooks.off('updateSetting', this._settingsHook); } catch (_) {}
        this._settingsHook = null;
      }
      if (this._gridSnapHook) {
        try { hooks.off('fa-nexus:gridSnapChanged', this._gridSnapHook); } catch (_) {}
        this._gridSnapHook = null;
      }
      if (this._actorOptionHook) {
        for (const hookName of ['createActor', 'deleteActor', 'updateActor']) {
          try { hooks.off(hookName, this._actorOptionHook); } catch (_) {}
        }
        this._actorOptionHook = null;
        this._placeAsActorHooksInstalled = false;
      }
    }
    try { this._randomPrefetch?.reset?.(); } catch (_) {}
  }

  _normalizeRotation(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return ((num % 360) + 360) % 360;
  }

  _clampRotationRandomValue(value, fallback = DEFAULT_ROTATION_RANDOM_MIN) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(DEFAULT_ROTATION_RANDOM_MAX, Math.max(DEFAULT_ROTATION_RANDOM_MIN, Math.round(numeric)));
  }

  _getRotationRandomRange() {
    const min = this._clampRotationRandomValue(this._rotationRandomMin, DEFAULT_ROTATION_RANDOM_MIN);
    const max = this._clampRotationRandomValue(this._rotationRandomMax, DEFAULT_ROTATION_RANDOM_MAX);
    return min <= max ? { min, max } : { min: max, max: min };
  }

  _sampleRotationRandomValue() {
    const range = this._getRotationRandomRange();
    if (range.max <= range.min) return range.min;
    return range.min + Math.floor(Math.random() * (range.max - range.min + 1));
  }

  _hasRandomRotationEnabled() {
    return !!this._rotationRandomEnabled;
  }

  _getPendingRotation() {
    const value = Number(this._pendingRotation);
    if (Number.isFinite(value)) return this._normalizeRotation(value);
    return this._normalizeRotation(this._rotation);
  }

  _applyRotationToPreview() {
    try {
      if (!this._preview?.box) return;
      const rotation = this._getPendingRotation();
      this._preview._rotation = rotation;
      TokenDragDropManager._updatePreviewTransform(this._preview);
    } catch (_) {}
  }

  _updateRotationPreview({ regenerateOffset = false, clampOffset = false } = {}) {
    const base = this._normalizeRotation(this._rotation);
    if (!this._hasRandomRotationEnabled()) {
      this._pendingRotation = base;
      this._applyRotationToPreview();
      return;
    }
    const range = this._getRotationRandomRange();
    if (regenerateOffset || !Number.isFinite(this._pendingRotation)) {
      this._pendingRotation = this._sampleRotationRandomValue();
    } else if (clampOffset) {
      this._pendingRotation = Math.min(range.max, Math.max(range.min, this._normalizeRotation(this._pendingRotation)));
    }
    this._applyRotationToPreview();
  }

  _hasRandomFlipEnabled() {
    return !!this._flipRandomHorizontalEnabled || !!this._flipRandomVerticalEnabled;
  }

  _getPendingFlipState() {
    return {
      horizontal: !!this._pendingFlipHorizontal,
      vertical: !!this._pendingFlipVertical
    };
  }

  _applyFlipToPreview({ force = false } = {}) {
    try {
      if (!this._preview) return;
      TokenDragDropManager.setPreviewMirror(this._preview, {
        mirrorX: !!this._pendingFlipHorizontal,
        mirrorY: !!this._pendingFlipVertical,
        force
      });
    } catch (_) {}
  }

  _updateFlipPreview({ regenerateOffsets = false } = {}) {
    const baseHorizontal = !!this._flipHorizontal;
    const baseVertical = !!this._flipVertical;

    if (this._flipRandomHorizontalEnabled) {
      if (regenerateOffsets || this._flipRandomHorizontalOffset === null || this._flipRandomHorizontalOffset === undefined) {
        this._flipRandomHorizontalOffset = Math.random() < 0.5;
      }
      this._pendingFlipHorizontal = this._flipRandomHorizontalOffset ? !baseHorizontal : baseHorizontal;
    } else {
      this._flipRandomHorizontalOffset = false;
      this._pendingFlipHorizontal = baseHorizontal;
    }

    if (this._flipRandomVerticalEnabled) {
      if (regenerateOffsets || this._flipRandomVerticalOffset === null || this._flipRandomVerticalOffset === undefined) {
        this._flipRandomVerticalOffset = Math.random() < 0.5;
      }
      this._pendingFlipVertical = this._flipRandomVerticalOffset ? !baseVertical : baseVertical;
    } else {
      this._flipRandomVerticalOffset = false;
      this._pendingFlipVertical = baseVertical;
    }

    this._applyFlipToPreview({ force: true });
  }

  _prepareNextPlacementFlip() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomFlipEnabled();
    this._updateFlipPreview({ regenerateOffsets: regenerate });
    this._syncToolOptionsState();
  }

  _prepareNextPlacementRotation() {
    if (!this.isPlacementActive) return;
    const regenerate = this._hasRandomRotationEnabled();
    this._updateRotationPreview({ regenerateOffset: regenerate, clampOffset: true });
    this._syncToolOptionsState();
  }

  _installPreview(cardElement, pointer, { deferImage = false } = {}) {
    this._removePreview();
    this._preview = TokenDragDropManager.createPreviewForCard(cardElement, {
      cursorX: pointer?.x,
      cursorY: pointer?.y,
      deferImage
    });
    if (pointer?.x != null && pointer?.y != null) {
      const world = this._screenToWorld(pointer.x, pointer.y);
      if (world) this._lastPointerWorld = world;
    }
    this._updatePreviewPosition();
    if (this._preview?.box) {
      this._preview.box.classList.add('fa-nexus-token-placement-preview');
    }
    this._applyFlipToPreview({ force: true });
  }

  _removePreview() {
    try { TokenDragDropManager._stopPreviewZoomTracking(this._preview); } catch (_) {}
    try { this._preview?.overlay?.destroy?.(); } catch (_) {}
    try { this._preview?.box?.remove?.(); } catch (_) {}
    this._preview = null;
  }

  _setupEvents() {
    return this._interactionWorkflow.start();
  }

  _cleanupInteractionSessionState() {
    return this._interactionWorkflow.cleanup();
  }

  _teardownEvents() {
    return this._interactionWorkflow.stop();
  }

  _updateActorHoverHighlight(clientX, clientY) {
    return this._interactionWorkflow.updateActorHoverHighlight(clientX, clientY);
  }

  _clearActorHoverHighlight() {
    return this._interactionWorkflow.clearActorHoverHighlight();
  }

  _installActorClickBlocker() {
    return this._interactionWorkflow.installActorClickBlocker();
  }

  _teardownActorClickBlocker() {
    return this._interactionWorkflow.teardownActorClickBlocker();
  }

  _clearActorHoverIf(actorEl) {
    return this._interactionWorkflow.clearActorHoverIf(actorEl);
  }

  _clearActorClickSuppression() {
    return this._interactionWorkflow.clearActorClickSuppression();
  }

  async _prepareTokenPayload(cardElement, { authed = false, authState = null, allowPendingDownload = false } = {}) {
    const filename = cardElement.getAttribute('data-filename') || '';
    const displayName = cardElement.getAttribute('data-display-name') || '';
    const originSource = cardElement.getAttribute('data-source') || '';
    const originTier = cardElement.getAttribute('data-tier') || '';
    const sizeInfo = TokenDragDropManager._readSizeInfoFromCard(cardElement);

    const isCloud = (originSource || '').toLowerCase() === 'cloud';
    const looksLikeFile = TokenDragDropManager._looksLikeImagePath;
    let localPath = TokenDragDropManager._getResolvedCardImagePath(cardElement);
    let pendingDownload = false;
    let ensureLocalPromise = null;
    if (isCloud && (!localPath || !looksLikeFile(localPath))) {
      const content = this.app?._contentService;
      const download = this.app?._downloadManager;
      if (!content || !download) {
        throw new Error('Content services unavailable for token placement');
      }
      const rawFilePathAttr = cardElement.getAttribute('data-file-path') || '';
      const folderPathAttr = cardElement.getAttribute('data-path') || '';
      const resolvedFilePathAttr = rawFilePathAttr || (folderPathAttr && filename ? joinPath(folderPathAttr, filename) : filename);
      const item = {
        file_path: resolvedFilePathAttr,
        filename,
        tier: originTier || 'free'
      };

      let downloadPromise = cardElement._ensureLocalPromise;
      if (!downloadPromise) {
        downloadPromise = (async () => {
          try {
            const fullUrl = await content.getFullURL('tokens', item, authed ? authState : undefined);
            const local = await download.ensureLocal('tokens', item, fullUrl);
            if (!local) throw new Error('Unable to download token asset');
            // Update card attributes for preview loading
            try {
              const cacheState = applyTokenCardCachedState(cardElement, local, {
                iconSelector: '.fa-nexus-status-icon',
                removeLocked: false
              });
              if (cacheState.cached && cardElement.querySelector('.fa-nexus-token-status-icon')) {
                applyTokenCardCachedState(cardElement, local, {
                  iconSelector: '.fa-nexus-token-status-icon',
                  iconClassesToRemove: ['premium', 'cloud-plus'],
                  setResolvedLocalPath: false
                });
              }
            } catch (_) {}
            return local;
          } catch (error) {
            Logger.warn('TokenPlacement.download.failed', { error: String(error?.message || error) });
            throw error;
          }
        })();
        cardElement._ensureLocalPromise = downloadPromise;
      }
      ensureLocalPromise = downloadPromise;

      if (allowPendingDownload) {
        pendingDownload = true;
        downloadPromise.catch((error) => {
          Logger.warn('TokenPlacement.download.pendingFailed', { error: String(error?.message || error) });
          if (this._current?.card === cardElement) {
            if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to download token asset: ${error?.message || error}`);
            this.cancelPlacement('error');
          }
        });
      } else {
        localPath = await downloadPromise;
        try {
          if (cardElement._ensureLocalPromise === downloadPromise) {
            cardElement._ensureLocalPromise = null;
          }
        } catch (_) {}
        ensureLocalPromise = null;
      }
    }

    if ((!localPath || !looksLikeFile(localPath)) && !pendingDownload) {
      ui.notifications?.warn?.('Token image is not available locally yet. Please try again once it is cached.');
      return null;
    }

    return {
      filename,
      url: looksLikeFile(localPath) ? localPath : '',
      displayName,
      originSource,
      originTier,
      tokenSize: sizeInfo,
      pendingDownload,
      ensureLocalPromise
    };
  }

  async _placeAtPointer(event, actorEl) {
    if (!this._current || this._placing) return 'none';
    this._placing = true;
    try {
      const payload = this._current.payload;
      const card = this._current.card;
      const tokenSize = payload.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };

      // Wait for any pending download to complete before placing
      const pendingPromise = card._ensureLocalPromise || payload.ensureLocalPromise || null;
      if (pendingPromise) {
        try {
          const resolvedPath = await pendingPromise;
          if (resolvedPath) {
            card._resolvedLocalPath = resolvedPath;
            card.setAttribute('data-url', resolvedPath);
            payload.url = resolvedPath;
            payload.pendingDownload = false;
            payload.ensureLocalPromise = null;
            if (card._ensureLocalPromise === pendingPromise) {
              card._ensureLocalPromise = null;
            }
          }
        } catch (error) {
          Logger.warn('TokenPlacement.place.waitDownload.failed', { error: String(error?.message || error) });
          throw new Error('Failed to download token asset');
        }
      }

      const effectiveUrl = this._resolveCurrentUrl(card, payload);
      if (!effectiveUrl) throw new Error('Token image not available locally yet.');
      this._current.payload.url = effectiveUrl;

      const flipState = this._getPendingFlipState();
      const dragData = {
        type: 'fa-nexus-token',
        source: 'fa-nexus',
        filename: payload.filename,
        url: effectiveUrl,
        displayName: payload.displayName,
        originSource: payload.originSource,
        originTier: payload.originTier,
        tokenSize,
        rotation: this._getPendingRotation(),
        mirrorX: !!flipState.horizontal,
        mirrorY: !!flipState.vertical
      };

      const resolvedActorEl = actorEl || this._findActorElement(event.clientX, event.clientY);
      if (resolvedActorEl) {
        try { resolvedActorEl.classList.add('actor-drop-target'); } catch (_) {}
        const pointerSnapshot = { x: event.clientX, y: event.clientY };
        const rotationSnapshot = this._rotation;
        const previewCard = card;
        this._removePreview();
        try {
          await TokenDragDropManager.handleActorDrop(resolvedActorEl, dragData, {
            clientX: event.clientX,
            clientY: event.clientY,
            shiftKey: event.shiftKey
          });
        } finally {
          try { resolvedActorEl.classList.remove('actor-drop-target'); } catch (_) {}
          this._clearActorHoverIf(resolvedActorEl);
          this._teardownActorClickBlocker();
          if (this.isPlacementActive && (event.shiftKey || this._stickyMode)) {
            const pointer = this._lastPointer || pointerSnapshot;
            const deferImage = this._shouldDeferPreview(this._current?.payload || null, previewCard);
            this._installPreview(previewCard, pointer, { deferImage });
            this._rotation = rotationSnapshot;
            this._updateRotationPreview({ clampOffset: true });
            if (deferImage) {
              this._attachDeferredPreviewLoad(previewCard, this._currentEntry, this._current?.payload || null);
            }
          }
        }
        this._prepareNextPlacementRotation();
        this._prepareNextPlacementFlip();
        return 'actor';
      }

      const drop = this._transformCoordinates(event.clientX, event.clientY, tokenSize);
      if (!drop) throw new Error('Unable to determine drop coordinates');

      const placeAsSelection = this._getActivePlaceAsSelection();
      if (placeAsSelection.mode === 'actor') {
        await this._placeUsingActorSelection(placeAsSelection, dragData, drop);
      } else {
        let pendingHpOverride = null;
        const actorTypeOverride = this._getSelectedNewActorType();
        const created = await createActorTokenPlacement({
          dragData,
          drop,
          options: {
            actorTypeOverride,
            beforeTokenCreate: async (actorDoc) => {
              const tokenOptions = {};
              try {
                pendingHpOverride = await this._resolveHpOverride({ actor: actorDoc });
              } catch (error) {
                Logger.warn('TokenPlacement.hp.resolveFailed', { scope: 'new-actor', error: String(error?.message || error) });
                pendingHpOverride = null;
              }
              if (pendingHpOverride) {
                await this._applyHpOverrideToActorDocument(actorDoc, pendingHpOverride);
                tokenOptions.hpOverride = pendingHpOverride;
              }
              if (this._supportsTokenNamingOptions()) {
                if (this._appendNumberOverride !== null) tokenOptions.appendNumber = !!this._appendNumberOverride;
                if (this._prependAdjectiveOverride !== null) tokenOptions.prependAdjective = !!this._prependAdjectiveOverride;
              }
              return tokenOptions;
            }
          }
        });
        Logger.info('TokenPlacement.actorType.createNew', {
          requestedType: this._newActorTypeOverride || null,
          effectiveType: actorTypeOverride,
          autoType: this._newActorTypeAuto || null,
          actorCreated: !!created?.actor
        });
        if (created?.actor && created?.token) {
          try {
            await this._applyHpOverrides({
              actor: created.actor,
              tokenDoc: created.token,
              applyToActor: true,
              override: pendingHpOverride || undefined
            });
          } catch (error) {
            Logger.warn('TokenPlacement.hp.applyFailed', { scope: pendingHpOverride ? 'new-actor-override' : 'new-actor', error: String(error?.message || error) });
          }
        }
      }
      this._prepareNextPlacementRotation();
      this._prepareNextPlacementFlip();
      return 'canvas';
    } catch (error) {
      Logger.warn('TokenPlacement.place.failed', { error: String(error?.message || error) });
      if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to place token: ${error?.message || error}`);
      this._clearActorHoverHighlight();
      this._teardownActorClickBlocker();
      return 'none';
    } finally {
      this._clearActorClickSuppression();
      this._placing = false;
    }
  }

  _resolveCurrentUrl(card, payload) {
    const attrs = card || {};
    const resolved = TokenDragDropManager._getResolvedCardImagePath(attrs);
    if (resolved) return resolved;
    const source = typeof attrs.getAttribute === 'function' ? (attrs.getAttribute('data-source') || '').toLowerCase() : '';
    const isCached = typeof attrs.getAttribute === 'function' ? attrs.getAttribute('data-cached') === 'true' : false;
    if (TokenDragDropManager._looksLikeImagePath(payload?.url)) {
      if (source !== 'cloud' || isCached || TokenDragDropManager._isAbsoluteHttpUrl(payload.url)) return payload.url;
      return '';
    }
    return payload?.url || '';
  }

  _createEntryFromCard(cardElement, payload = null) {
    if (!cardElement) return null;
    const resolvedImagePath = TokenDragDropManager._getResolvedCardImagePath(cardElement) || payload?.url || '';
    const entry = {
      card: cardElement,
      source: cardElement.getAttribute('data-source') || 'local',
      tier: cardElement.getAttribute('data-tier') || 'free',
      filename: cardElement.getAttribute('data-filename') || payload?.filename || '',
      file_path: cardElement.getAttribute('data-file-path') || payload?.file_path || '',
      path: cardElement.getAttribute('data-path') || payload?.path || '',
      cachedLocalPath: resolvedImagePath,
      display_name: cardElement.getAttribute('data-display-name') || payload?.displayName || '',
      grid_width: Number(cardElement.getAttribute('data-grid-w') || payload?.tokenSize?.gridWidth || 1) || 1,
      grid_height: Number(cardElement.getAttribute('data-grid-h') || payload?.tokenSize?.gridHeight || 1) || 1,
      scale: (() => { const s = cardElement.getAttribute('data-scale') || payload?.tokenSize?.scale || 1; return (typeof s === 'string' && s.endsWith('x')) ? (Number(s.replace('x', '')) || 1) : (Number(s) || 1); })(),
      color_variant: cardElement.getAttribute('data-variant') || payload?.colorVariant || null,
      base_name_no_variant: payload?.baseName || '',
      has_color_variant: !!payload?.hasVariants,
      variant_group: payload?.variantGroup || '',
      thumbnail_url: payload?.thumbnail || '',
      source_item: null
    };
    entry.key = this._entryKey(entry);
    this._applyEntryAttributesToCard(entry, cardElement);
    return entry;
  }

  _normalizeEntry(entry) {
    const normalized = normalizeTokenPlacementEntry(entry);
    if (!normalized) return null;
    this._applyEntryAttributesToCard(normalized, normalized.card || null);
    return normalized;
  }

  _entryKey(entry) {
    if (!entry) return '';
    if (entry.key) return String(entry.key).toLowerCase();
    if (entry.file_path) return String(entry.file_path).toLowerCase();
    if (entry.path) return String(entry.path).toLowerCase();
    if (entry.filename) return String(entry.filename).toLowerCase();
    if (entry.display_name) return String(entry.display_name).toLowerCase();
    return '';
  }

  _entryNeedsPrefetch(entry) {
    if (!entry) return false;
    const source = String(entry.source || '').toLowerCase();
    if (source !== 'cloud') return false;
    if (entry.cachedLocalPath) return false;
    return true;
  }

  async _prefetchEntry(entry) {
    try {
      if (!this._entryNeedsPrefetch(entry)) return;
      if (entry._prefetching) return;
      entry._prefetching = true;
      const local = await this._ensureEntryLocal(entry);
      return local;
    } catch (_) {
      return null;
    } finally {
      entry._prefetching = false;
    }
  }

  async _ensureEntryLocal(entry) {
    if (!entry) return null;
    if (entry.cachedLocalPath) return entry.cachedLocalPath;
    if (entry._ensureLocalPromise) {
      try {
        const existing = await entry._ensureLocalPromise;
        if (existing) this._markEntryCached(entry, existing);
        return existing;
      } catch (error) {
        throw error;
      }
    }
    const source = String(entry.source || '').toLowerCase();
    if (source !== 'cloud') {
      const localPath = entry.cachedLocalPath
        || entry.file_path
        || (entry.path && entry.filename ? joinPath(entry.path, entry.filename) : '')
        || entry.path
        || entry.filename
        || '';
      if (localPath) this._markEntryCached(entry, localPath);
      return localPath;
    }
    const content = this.app?._contentService;
    const download = this.app?._downloadManager;
    if (!content || !download) throw new Error('Content services unavailable for token placement');
    let authState = null;
    let authed = false;
    try {
      const auth = game.settings.get('fa-nexus', 'patreon_auth_data');
      authed = !!(auth && auth.authenticated && auth.state);
      authState = authed ? auth.state : null;
    } catch (_) {}
    const resolvedFilePath = entry.file_path
      || (entry.path && entry.filename ? joinPath(entry.path, entry.filename) : '');
    if (!resolvedFilePath) throw new Error('Missing token file path');
    const item = {
      file_path: resolvedFilePath,
      filename: entry.filename || '',
      tier: entry.tier || 'free'
    };
    const promise = (async () => {
      const fullUrl = await content.getFullURL('tokens', item, authed ? authState : undefined);
      const local = await download.ensureLocal('tokens', item, fullUrl);
      if (!local) throw new Error('Unable to download token asset');
      return local;
    })();
    entry._ensureLocalPromise = promise;
    try {
      const localPath = await promise;
      this._markEntryCached(entry, localPath);
      return localPath;
    } finally {
      entry._ensureLocalPromise = null;
    }
  }

  _markEntryCached(entry, localPath) {
    if (!entry || !localPath) return;
    // Check if this is a direct CDN URL (not actually cached locally)
    const isDirectUrl = isDirectTokenCacheUrl(localPath);
    if (!isDirectUrl) {
      entry.cachedLocalPath = localPath;
    }
    entry.path = entry.path || localPath;
    entry.file_path = entry.file_path || localPath;
    const card = entry.card || null;
    if (!card) return;
    try {
      applyTokenCardCachedState(card, localPath, { iconSelector: '.fa-nexus-status-icon' });
    } catch (_) {}
  }

  _ensureEntryCard(entry) {
    if (!entry) return null;
    if (entry.card) {
      this._applyEntryAttributesToCard(entry, entry.card);
      return entry.card;
    }
    const synthetic = this._createSyntheticCard(entry);
    entry.card = synthetic;
    return synthetic;
  }

  _applyEntryAttributesToCard(entry, card) {
    if (!card) return;
    try { card.setAttribute('data-source', entry.source || 'local'); } catch (_) {}
    try { card.setAttribute('data-tier', entry.tier || 'free'); } catch (_) {}
    try { card.setAttribute('data-filename', entry.filename || ''); } catch (_) {}
    try { if (entry.file_path) card.setAttribute('data-file-path', entry.file_path); } catch (_) {}
    try { if (entry.path) card.setAttribute('data-path', entry.path); } catch (_) {}
    try { if (entry.key) card.setAttribute('data-key', entry.key); } catch (_) {}
    try {
      if (entry.cachedLocalPath) {
        applyTokenCardCachedState(card, entry.cachedLocalPath, {
          iconSelector: null,
          removeLocked: false
        });
      }
    } catch (_) {}
    try { card.setAttribute('data-display-name', entry.display_name || ''); } catch (_) {}
    try { card.setAttribute('data-grid-w', String(entry.grid_width || 1)); } catch (_) {}
    try { card.setAttribute('data-grid-h', String(entry.grid_height || 1)); } catch (_) {}
    try { card.setAttribute('data-scale', String(entry.scale || 1)); } catch (_) {}
    try {
      if (entry.color_variant != null) card.setAttribute('data-variant', String(entry.color_variant));
    } catch (_) {}
  }

  _createSyntheticCard(entry) {
    const card = document.createElement('div');
    card.className = 'fa-nexus-card fa-nexus-token-synthetic';
    const thumb = document.createElement('div');
    thumb.className = 'thumb fa-nexus-thumb-placeholder';
    const img = document.createElement('img');
    img.alt = entry.display_name || entry.filename || '';
    thumb.appendChild(img);
    const status = document.createElement('div');
    status.className = 'fa-nexus-status-icon';
    thumb.appendChild(status);
    card.appendChild(thumb);
    const footer = document.createElement('div');
    footer.className = 'card-footer';
    const label = document.createElement('div');
    label.className = 'label token-title';
    label.textContent = entry.display_name || entry.filename || '';
    footer.appendChild(label);
    card.appendChild(footer);
    this._applyEntryAttributesToCard(entry, card);
    return card;
  }

  _pickRandomEntry() {
    if (!this._randomMode || !Array.isArray(this._randomEntries) || !this._randomEntries.length) return null;
    const next = this._randomPrefetch?.next?.(this._currentEntry) || null;
    if (next) {
      try { Logger.info('TokenPlacement.random.pick', { source: 'queue', key: this._entryKey(next) }); } catch (_) {}
      return next;
    }
    const idx = Math.floor(Math.random() * this._randomEntries.length);
    const fallback = this._randomEntries[idx];
    try { Logger.info('TokenPlacement.random.pick', { source: 'fallback', index: idx, key: this._entryKey(fallback) }); } catch (_) {}
    return fallback;
  }

  async _switchToNextRandomEntry({ initial = false, pointerEvent = null } = {}) {
    const entry = this._pickRandomEntry();
    if (!entry) {
      if (initial) this.cancelPlacement('error');
      return;
    }
    const card = this._ensureEntryCard(entry);
    if (entry._ensureLocalPromise && !card._ensureLocalPromise) {
      card._ensureLocalPromise = entry._ensureLocalPromise;
    }
    const pointer = pointerEvent
      ? { x: pointerEvent.clientX, y: pointerEvent.clientY }
      : (this._lastPointer ? { x: this._lastPointer.x, y: this._lastPointer.y } : { x: window.innerWidth / 2, y: window.innerHeight / 2 });
    this._lastPointer = pointer;

    let payload = null;
    try {
      payload = await this._prepareTokenPayload(card, {
        authed: this._authContext?.authed ?? false,
        authState: this._authContext?.authState ?? null,
        allowPendingDownload: true
      });
    } catch (error) {
      Logger.warn('TokenPlacement.random.preparePayload.failed', { error: String(error?.message || error) });
      if (initial) {
        if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
        this.cancelPlacement('error');
      }
      return;
    }

    if (!payload) {
      if (initial) this.cancelPlacement('error');
      return;
    }

    payload.url = this._resolveCurrentUrl(card, payload);
    const autoAllowed = !this._placeAsSelection.userModified;
    this._applyPlaceAsMatchContext(payload, card, {
      resetContext: autoAllowed && initial,
      autoSelect: autoAllowed
    });
    this._currentEntry = entry;
    this._current = { card, payload };

    const pendingPromise = payload.ensureLocalPromise || card._ensureLocalPromise || entry._ensureLocalPromise || null;
    if (pendingPromise) {
      try {
        if (!card._ensureLocalPromise) card._ensureLocalPromise = pendingPromise;
      } catch (_) {}
      entry._ensureLocalPromise = pendingPromise;
      payload.ensureLocalPromise = pendingPromise;
    }

    const deferPreviewImage = this._shouldDeferPreview(payload, card);
    this._installPreview(card, pointer, { deferImage: deferPreviewImage });
    this._applyRotationToPreview();
    this._updateFlipPreview({ regenerateOffsets: true });

    if (deferPreviewImage) {
      this._attachDeferredPreviewLoad(card, entry, payload, pendingPromise);
    }

    try { this._randomPrefetch?.prime?.(entry); } catch (_) {}
    this._syncToolOptionsState({ suppressRender: false });
  }

  _attachDeferredPreviewLoad(card, entry, payload, pendingPromise = null) {
    const promise = pendingPromise || payload?.ensureLocalPromise || card?._ensureLocalPromise || entry?._ensureLocalPromise;
    const previewRef = this._preview;
    if (!promise) return;
    if (card && !card._ensureLocalPromise) card._ensureLocalPromise = promise;
    if (entry && !entry._ensureLocalPromise) entry._ensureLocalPromise = promise;
    payload.ensureLocalPromise = promise;
    promise
      .then((localPath) => {
        if (!localPath) return;
        this._markEntryCached(entry, localPath);
        if (!this.isPlacementActive || this._current?.card !== card) return;
        try {
          if (payload) {
            payload.pendingDownload = false;
            payload.url = this._resolveCurrentUrl(card, payload);
            payload.ensureLocalPromise = null;
          }
        } catch (_) {}
        try {
          if (card) card._ensureLocalPromise = null;
        } catch (_) {}
        if (entry) entry._ensureLocalPromise = null;
        if (this._preview !== previewRef || !previewRef?.img || !previewRef?.loadingDiv) return;
        TokenDragDropManager._loadPreviewImageForCard(card, previewRef.img, previewRef.loadingDiv);
      })
      .catch((error) => {
        Logger.warn('TokenPlacement.random.pendingDownload.failed', { error: String(error?.message || error) });
        if (this._current && this._current.card === card) {
          if (!error?.faNexusNotified) ui.notifications?.error?.(`Failed to download token asset: ${error?.message || error}`);
          this.cancelPlacement('error');
        }
      })
      .finally(() => {
        if (payload) payload.ensureLocalPromise = null;
        try {
          if (card && card._ensureLocalPromise === promise) card._ensureLocalPromise = null;
        } catch (_) {}
        if (entry && entry._ensureLocalPromise === promise) entry._ensureLocalPromise = null;
      });
  }

  _findActorElement(clientX, clientY) {
    try {
      const under = document.elementFromPoint(clientX, clientY);
      const actorSelector = '.directory-item.actor, .document[data-document-type="Actor"], [data-document-type="Actor"][data-entry-id], [data-document-id][data-document-type="Actor"], .document.actor';
      const candidate = under?.closest?.(actorSelector);
      const isFolder = candidate && (candidate.classList?.contains('folder') || candidate.getAttribute?.('data-document-type') === 'Folder');
      return (!isFolder && candidate) ? candidate : null;
    } catch (_) {
      return null;
    }
  }

  _updatePreviewPosition({ pointer } = {}) {
    if (!this.isPlacementActive || !this._preview?.box) return;
    const previewBox = this._preview.box;
    const pointerScreen = pointer?.screen
      ? { x: pointer.screen.x, y: pointer.screen.y }
      : (pointer && typeof pointer.x === 'number' && typeof pointer.y === 'number'
        ? { x: pointer.x, y: pointer.y }
        : null);
    if (pointerScreen) this._lastPointer = { x: pointerScreen.x, y: pointerScreen.y };
    const screen = this._lastPointer;
    if (!screen) return;

    const canvasElement = pointer?.canvas || this._interactionController.getCanvasElement?.();
    const stage = canvas?.stage;
    const gridSnapEnabled = TokenDragDropManager.isGridSnapEnabled();
    let previewX = screen.x;
    let previewY = screen.y;

    if (gridSnapEnabled && this._current?.payload?.tokenSize && stage && canvasElement) {
      let world = null;
      if (pointer?.world) world = { x: pointer.world.x, y: pointer.world.y };
      else if (this._lastPointerWorld) world = this._lastPointerWorld;
      else {
        const computed = this._screenToWorld(screen.x, screen.y, canvasElement, stage);
        if (computed) {
          this._lastPointerWorld = computed;
          world = computed;
        }
      }

      if (world) {
        try {
          const snappedCoords = TokenDragDropManager.applyGridSnapping(world, canvas, this._current.payload.tokenSize);
          const canvasCoords = stage.worldTransform.apply(snappedCoords);
          const rect = canvasElement.getBoundingClientRect();
          previewX = rect.left + canvasCoords.x;
          previewY = rect.top + canvasCoords.y;
        } catch (_) {}
      }
    }

    previewBox.style.left = `${previewX}px`;
    previewBox.style.top = `${previewY}px`;
    try { this._preview?.overlay?.updatePointer?.(previewX, previewY); } catch (_) {}
    TokenDragDropManager._maybeAdjustPreviewForActorsSidebar(this._preview, previewX);
  }

  _screenToWorld(clientX, clientY, canvasElement = null, stage = null) {
    try {
      const el = canvasElement || this._interactionController.getCanvasElement?.();
      const stageRef = stage || canvas?.stage;
      if (!el || !stageRef) return null;
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left;
      const localY = clientY - rect.top;
      const point = new PIXI.Point(localX, localY);
      const world = stageRef.worldTransform.applyInverse(point);
      return { x: world.x, y: world.y };
    } catch (_) {
      return null;
    }
  }

  _installGridSnapHooks() {
    const hooks = globalThis?.Hooks;
    if (!hooks || typeof hooks.on !== 'function') return;
    if (!this._settingsHook) {
      this._settingsHook = (setting) => {
        if (!setting || setting.namespace !== 'fa-nexus') return;
        if (setting.key !== 'gridSnap') return;
        this._handleGridSnapChanged(!!setting.value);
      };
      try { hooks.on('updateSetting', this._settingsHook); } catch (_) { this._settingsHook = null; }
    }
    if (!this._gridSnapHook) {
      this._gridSnapHook = (enabled) => this._handleGridSnapChanged(!!enabled);
      try { hooks.on('fa-nexus:gridSnapChanged', this._gridSnapHook); } catch (_) { this._gridSnapHook = null; }
    }
  }

  _handleGridSnapChanged(_enabled) {
    if (!this.isPlacementActive) return;
    this._refreshPlacementAfterGridSnapChange();
  }

  _refreshPlacementAfterGridSnapChange() {
    this._updatePreviewPosition();
  }

  _createPointerSnapshot() {
    if (!this._lastPointer) return null;
    const { x, y } = this._lastPointer;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return { clientX: x, clientY: y };
  }

  async updatePlacementEntries(entries, { forceRandom = false } = {}) {
    if (!this.isPlacementActive) return;
    const list = Array.isArray(entries) ? entries.slice() : [];
    if (!list.length) return;
    const pointer = this._createPointerSnapshot();
    const sticky = !!this._stickyMode;
    const rotation = this._rotation;
    try {
      await this.startPlacementFromEntries(list, {
        sticky,
        pointerEvent: pointer,
        forceRandom
      });
    } catch (error) {
      Logger.warn('TokenPlacement.updateEntries.failed', { error: String(error?.message || error) });
      throw error;
    }
    if (!this.isPlacementActive) return;
    if (typeof rotation === 'number' && Number.isFinite(rotation)) {
      this._rotation = this._normalizeRotation(rotation);
      this._updateRotationPreview({ clampOffset: true });
      this._syncToolOptionsState();
    }
  }

  _shouldDeferPreview(payload, card) {
    if (payload?.pendingDownload) return true;
    if (!card) return false;
    const source = (card.getAttribute?.('data-source') || '').toLowerCase();
    const cached = card.getAttribute?.('data-cached') === 'true';
    if (source === 'cloud' && !cached && (card._ensureLocalPromise || payload?.ensureLocalPromise)) {
      return true;
    }
    return false;
  }

  _buildToolOptionsState() {
    const state = {
      hints: [
        'Click to place on the canvas or an actor entry; hold Shift to keep placing; ESC cancels.',
        'Ctrl/Cmd+Wheel rotates the token (add Shift for finer steps).',
        'Tap S to toggle grid snap.',
        'Press F1 to open help.'
      ]
    };
    state.rotation = this._buildRotationToolState();
    state.flip = this._buildFlipToolState();
    const placeAs = this._buildPlaceAsUIState();
    if (placeAs) state.placeAs = placeAs;
    // Tool options window sometimes runs "sync-only" updates which cannot create new DOM.
    // Bump layoutRevision when conditional sections (like naming toggles) appear/disappear so
    // the controller forces a re-render.
    state.layoutRevision = `token.placement:${placeAs?.naming?.available ? 'n1' : 'n0'}:${placeAs?.actorType?.available ? 't1' : 't0'}`;
    return state;
  }

  _formatFlipSummary(state) {
    const horizontal = !!state?.horizontal;
    const vertical = !!state?.vertical;
    if (horizontal && vertical) return 'H & V';
    if (horizontal) return 'H';
    if (vertical) return 'V';
    return 'None';
  }

  _buildRotationToolState() {
    const base = this._normalizeRotation(this._rotation);
    const preview = this._getPendingRotation();
    const range = this._getRotationRandomRange();
    const randomToggleOn = !!this._rotationRandomEnabled;
    const baseDisplay = `${Math.round(base)}°`;
    const previewDisplay = `${Math.round(preview)}°`;
    return {
      available: true,
      min: 0,
      max: 359,
      step: 1,
      value: base,
      defaultValue: 0,
      display: randomToggleOn ? `${previewDisplay} preview` : baseDisplay,
      randomEnabled: randomToggleOn,
      randomMode: 'range',
      randomMin: range.min,
      randomMax: range.max,
      randomMinDefault: DEFAULT_ROTATION_RANDOM_MIN,
      randomMaxDefault: DEFAULT_ROTATION_RANDOM_MAX,
      randomMinDisplay: `${range.min}°`,
      randomMaxDisplay: `${range.max}°`,
      randomMinAriaLabel: 'Minimum random rotation',
      randomMaxAriaLabel: 'Maximum random rotation',
      randomAria: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomLabel: randomToggleOn ? 'On' : 'Off',
      randomTooltip: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomHint: 'Samples a rotation between Min and Max for each placement.'
    };
  }

  _buildFlipToolState() {
    const base = { horizontal: !!this._flipHorizontal, vertical: !!this._flipVertical };
    const pending = this._getPendingFlipState();
    const randomActive = this._hasRandomFlipEnabled();
    const baseSummary = this._formatFlipSummary(base);
    const previewSummary = this._formatFlipSummary(pending);
    const previewMatches = base.horizontal === pending.horizontal && base.vertical === pending.vertical;
    const horizontalRandomEnabled = !!this._flipRandomHorizontalEnabled;
    const verticalRandomEnabled = !!this._flipRandomVerticalEnabled;
    const horizontalPreviewDiff = pending.horizontal !== base.horizontal;
    const verticalPreviewDiff = pending.vertical !== base.vertical;
    const display = randomActive ? `${previewSummary} preview` : baseSummary;
    const previewDisplay = !previewMatches ? `Preview: ${previewSummary}` : '';
    return {
      available: true,
      display,
      previewDisplay,
      previewMatchesBase: previewMatches,
      randomActive,
      randomHint: 'Randomizes flips per placement on the selected axes.',
      horizontal: {
        active: base.horizontal,
        pending: pending.horizontal,
        label: 'Flip H',
        tooltip: 'Mirror token left/right.',
        previewDiff: randomActive && horizontalPreviewDiff,
        aria: 'Toggle horizontal mirroring',
        disabled: false,
        randomEnabled: horizontalRandomEnabled,
        randomLabel: horizontalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: horizontalRandomEnabled ? 'Disable random horizontal flip' : 'Enable random horizontal flip',
        randomDisabled: false,
        randomAria: 'Toggle random horizontal mirroring',
        randomPreviewDiff: horizontalRandomEnabled && horizontalPreviewDiff
      },
      vertical: {
        active: base.vertical,
        pending: pending.vertical,
        label: 'Flip V',
        tooltip: 'Mirror token up/down.',
        previewDiff: randomActive && verticalPreviewDiff,
        aria: 'Toggle vertical mirroring',
        disabled: false,
        randomEnabled: verticalRandomEnabled,
        randomLabel: verticalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: verticalRandomEnabled ? 'Disable random vertical flip' : 'Enable random vertical flip',
        randomDisabled: false,
        randomAria: 'Toggle random vertical mirroring',
        randomPreviewDiff: verticalRandomEnabled && verticalPreviewDiff
      }
    };
  }

  _buildDeclarativeToolOptionsConfig(legacyState = {}) {
    const controls = {};
    const sections = [];
    const addScalarRandomizedControl = (config) => addDeclarativeScalarRandomizedControl(controls, config);
    const addAxisTogglePairControl = (config) => addDeclarativeAxisTogglePairControl(controls, config);
    const transformControlIds = [];
    if (legacyState?.rotation?.available) {
      transformControlIds.push(addScalarRandomizedControl({
        id: 'token-rotation',
        variant: 'rotation',
        label: 'Rotation',
        ariaLabel: 'Rotation',
        state: legacyState.rotation,
        handlerId: 'setRotation',
        randomHandlerId: 'toggleRotationRandom',
        randomMinHandlerId: 'setRotationRandomMin',
        randomMaxHandlerId: 'setRotationRandomMax'
      }));
    }
    if (legacyState?.flip?.available) {
      transformControlIds.push(addAxisTogglePairControl({
        id: 'token-flip',
        label: 'Flip / Mirror',
        state: legacyState.flip,
        horizontalHandlerId: 'toggleFlipHorizontal',
        verticalHandlerId: 'toggleFlipVertical',
        horizontalRandomHandlerId: 'toggleFlipHorizontalRandom',
        verticalRandomHandlerId: 'toggleFlipVerticalRandom'
      }));
    }
    if (transformControlIds.length) {
      sections.push({
        id: 'transform',
        label: 'Transform',
        controls: transformControlIds.filter(Boolean)
      });
    }
    return { controls, sections };
  }

  _handleRotationSliderInput(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      this._syncToolOptionsState();
      return false;
    }
    const normalized = this._normalizeRotation(numeric);
    this._rotation = normalized;
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleRotationRandomToggle() {
    const next = !this._rotationRandomEnabled;
    this._rotationRandomEnabled = next;
    const range = this._getRotationRandomRange();
    this._rotationRandomMin = range.min;
    this._rotationRandomMax = range.max;
    this._updateRotationPreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleRotationRandomMin(value) {
    const current = this._getRotationRandomRange();
    const nextMin = Math.min(current.max, this._clampRotationRandomValue(value, DEFAULT_ROTATION_RANDOM_MIN));
    this._rotationRandomMin = nextMin;
    this._rotationRandomMax = current.max;
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleRotationRandomMax(value) {
    const current = this._getRotationRandomRange();
    const nextMax = Math.max(current.min, this._clampRotationRandomValue(value, DEFAULT_ROTATION_RANDOM_MAX));
    this._rotationRandomMin = current.min;
    this._rotationRandomMax = nextMax;
    this._updateRotationPreview({ clampOffset: true });
    this._syncToolOptionsState();
    return true;
  }

  _handleFlipHorizontalToggle() {
    this._flipHorizontal = !this._flipHorizontal;
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleFlipVerticalToggle() {
    this._flipVertical = !this._flipVertical;
    this._updateFlipPreview();
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleFlipRandomHorizontalToggle() {
    const next = !this._flipRandomHorizontalEnabled;
    this._flipRandomHorizontalEnabled = next;
    this._flipRandomHorizontalOffset = next ? null : false;
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleFlipRandomVerticalToggle() {
    const next = !this._flipRandomVerticalEnabled;
    this._flipRandomVerticalEnabled = next;
    this._flipRandomVerticalOffset = next ? null : false;
    this._updateFlipPreview({ regenerateOffsets: next });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _buildToolOptionsDescriptor() {
    const legacyState = this._buildToolOptionsState();
    const { controls, sections } = this._buildDeclarativeToolOptionsConfig(legacyState);
    const selectionSummary = this._currentEntry?.display_name
      || this._currentEntry?.filename
      || this._current?.payload?.displayName
      || this._current?.payload?.filename
      || null;
    const shortcuts = [
      createShortcut(SHORTCUT_ACTION.HELP, {
        label: 'Help',
        description: 'Open contextual tool help.'
      }),
      createShortcut(SHORTCUT_ACTION.CANCEL, {
        label: 'Cancel',
        description: 'Cancel token placement.'
      }),
      createShortcut(SHORTCUT_ACTION.TOGGLE_GRID_SNAP, {
        label: 'Grid Snap',
        description: 'Tap to toggle grid snapping.'
      }),
      createShortcut('rotate-preview', {
        binding: 'Ctrl/Cmd+Wheel',
        label: 'Rotate',
        description: 'Rotate the token preview; add Shift for finer steps.'
      }),
      createShortcut('keep-placing', {
        binding: 'Hold Shift',
        label: 'Keep Placing',
        description: 'Keep placement active after a successful drop.'
      })
    ];
    return createNormalizedToolOptionsDescriptor({
      rendererMode: TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE,
      descriptor: {
        toolId: 'token.placement',
        toolLabel: 'Token Placement',
        selectionSummary,
        helpTopicId: 'token-placement'
      },
      legacyState,
      controls,
      sections,
      shortcuts,
      handlers: this._buildToolOptionsHandlers()
    });
  }

  _buildToolOptionsHandlers() {
    return {
      togglePlaceAsOpen: (value) => this._togglePlaceAsOpen(value),
      setPlaceAsSearch: (value) => this._setPlaceAsSearch(value),
      selectPlaceAsOption: (id) => this._selectPlaceAsOption(id),
      setPlaceAsLinked: (value) => this._setPlaceAsLinked(value),
      setPlaceAsActorType: (value) => this._setPlaceAsActorType(value),
      setPlaceAsHpMode: (mode) => this._setPlaceAsHpMode(mode),
      setPlaceAsHpPercent: (value) => this._setPlaceAsHpPercent(value),
      setPlaceAsHpStatic: (value) => this._setPlaceAsHpStatic(value),
      setPlaceAsAppendNumber: (value) => this._setPlaceAsAppendNumber(value),
      setPlaceAsPrependAdjective: (value) => this._setPlaceAsPrependAdjective(value),
      toggleFlipHorizontal: () => this._handleFlipHorizontalToggle(),
      toggleFlipVertical: () => this._handleFlipVerticalToggle(),
      toggleFlipHorizontalRandom: () => this._handleFlipRandomHorizontalToggle(),
      toggleFlipVerticalRandom: () => this._handleFlipRandomVerticalToggle(),
      setRotation: (value) => this._handleRotationSliderInput(value),
      toggleRotationRandom: () => this._handleRotationRandomToggle(),
      setRotationRandomMin: (value) => this._handleRotationRandomMin(value),
      setRotationRandomMax: (value) => this._handleRotationRandomMax(value),
      openCompendiumFilterDialog: () => this._openCompendiumFilterDialog()
    };
  }

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      const descriptor = this._buildToolOptionsDescriptor();
      toolOptionsController.setToolOptions('token.placement', {
        ...descriptor,
        suppressRender
      });
    } catch (_) {}
  }

  _shouldIgnorePlacementHotkey(event, key = '') {
    try {
      const target = event?.target ?? document?.activeElement ?? null;
      if (!target || target === document.body) return false;
      if (target.dataset?.faNexusHotkeys === 'allow') return false;
      if (typeof target.isContentEditable === 'boolean' && target.isContentEditable) {
        return key !== 'Escape';
      }
      const tag = target.tagName ? String(target.tagName).toLowerCase() : '';
      if (!tag) return false;
      if (tag === 'input') {
        const type = typeof target.type === 'string' ? target.type.toLowerCase() : '';
        const allowTypes = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'];
        if (!type) return true;
        return !allowTypes.includes(type);
      }
      if (tag === 'textarea' || tag === 'select') return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  _ensureActorOptionsLoaded() {
    if (!globalThis?.game) return null;
    if (this._placeAsRefreshPromise) return this._placeAsRefreshPromise;
    if (this._placeAsSelection.hasOptions) return null;
    return this._refreshActorOptions({ includeCompendium: true });
  }

  _ensureNewActorTypeOptionsLoaded() {
    if (!globalThis?.game) return null;
    if (this._newActorTypeRefreshPromise) return this._newActorTypeRefreshPromise;
    if (this._newActorTypeChoices.length && this._newActorTypeAuto) return null;
    return this._refreshNewActorTypeOptions();
  }

  _formatActorTypeLabel(actorType) {
    const rawType = typeof actorType === 'string' ? actorType.trim() : '';
    if (!rawType) return 'Unknown';
    const labelKey = globalThis?.CONFIG?.Actor?.typeLabels?.[rawType];
    let localized = '';
    if (typeof labelKey === 'string' && labelKey.trim().length) {
      try {
        localized = globalThis?.game?.i18n?.localize?.(labelKey) || labelKey;
      } catch (_) {
        localized = labelKey;
      }
    }
    if (localized && localized !== labelKey) return localized;
    if (localized && !/^TYPES\./.test(localized)) return localized;
    return rawType
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  _getSelectedNewActorType() {
    const override = typeof this._newActorTypeOverride === 'string' ? this._newActorTypeOverride.trim() : '';
    if (override) return override;
    const auto = typeof this._newActorTypeAuto === 'string' ? this._newActorTypeAuto.trim() : '';
    return auto || null;
  }

  async _refreshNewActorTypeOptions() {
    if (this._newActorTypeRefreshPromise) return this._newActorTypeRefreshPromise;
    const promise = (async () => {
      this._newActorTypeLoading = true;
      this._newActorTypeError = null;
      this._syncToolOptionsState({ suppressRender: false });

      try {
        const systemId = SystemDetection.getCurrentSystemId();
        const availableTypes = Array.isArray(SystemDetection.getAvailableActorTypes?.())
          ? SystemDetection.getAvailableActorTypes()
          : [];
        const fallbackTypes = await SystemDetection.getFallbackActorTypes(systemId);
        const availableTypeSet = new Set(
          availableTypes
            .filter((value) => typeof value === 'string')
            .map((value) => value.trim())
            .filter((value) => value.length)
        );
        const orderedTypes = [...new Set(
          availableTypeSet.size
            ? [
                ...fallbackTypes.filter((value) => availableTypeSet.has(value)),
                ...availableTypes
              ]
            : fallbackTypes
        )];

        this._newActorTypeChoices = orderedTypes.map((actorType) => ({
          id: actorType,
          label: this._formatActorTypeLabel(actorType)
        }));
        this._newActorTypeAuto = orderedTypes[0] || '';

        if (this._newActorTypeOverride && !orderedTypes.includes(this._newActorTypeOverride)) {
          Logger.info('TokenPlacement.actorType.overrideCleared', {
            previousOverride: this._newActorTypeOverride,
            systemId,
            availableTypes: orderedTypes
          });
          this._newActorTypeOverride = null;
        }

        Logger.info('TokenPlacement.actorType.optionsResolved', {
          systemId,
          autoType: this._newActorTypeAuto || null,
          choices: this._newActorTypeChoices.map((entry) => ({ id: entry.id, label: entry.label }))
        });
      } catch (error) {
        this._newActorTypeChoices = [];
        this._newActorTypeAuto = '';
        this._newActorTypeError = error?.message || String(error);
        Logger.warn('TokenPlacement.actorType.optionsFailed', { error: this._newActorTypeError });
      } finally {
        this._newActorTypeLoading = false;
        this._syncToolOptionsState({ suppressRender: false });
      }
    })();

    this._newActorTypeRefreshPromise = promise.finally(() => {
      this._newActorTypeRefreshPromise = null;
    });
    return this._newActorTypeRefreshPromise;
  }

  _installActorOptionHooks() {
    if (this._placeAsActorHooksInstalled) return;
    const hooks = globalThis?.Hooks;
    if (!hooks || typeof hooks.on !== 'function') return;
    const handler = () => this._scheduleActorOptionRefresh({ includeCompendium: false });
    try {
      hooks.on('createActor', handler);
      hooks.on('deleteActor', handler);
      hooks.on('updateActor', handler);
      this._actorOptionHook = handler;
      this._placeAsActorHooksInstalled = true;
    } catch (error) {
      for (const hookName of ['createActor', 'deleteActor', 'updateActor']) {
        try { hooks.off?.(hookName, handler); } catch (_) {}
      }
      this._actorOptionHook = null;
      this._placeAsActorHooksInstalled = false;
      Logger.warn('TokenPlacement.placeAs.hookFailed', { error: String(error?.message || error) });
    }
  }

  _scheduleActorOptionRefresh({ includeCompendium = false } = {}) {
    if (this._placeAsRefreshTimer) {
      clearTimeout(this._placeAsRefreshTimer);
      this._placeAsRefreshTimer = null;
    }
    this._placeAsRefreshTimer = setTimeout(() => {
      this._placeAsRefreshTimer = null;
      try {
        this._refreshActorOptions({ includeCompendium });
      } catch (_) {}
    }, 150);
  }

  _refreshActorOptions({ includeCompendium = true } = {}) {
    if (this._placeAsRefreshPromise) return this._placeAsRefreshPromise;
    const promise = (async () => {
      const worldOptions = this._collectWorldActorOptions();
      this._applyPlaceAsStateResult(this._placeAsSelection.setWorldOptions(worldOptions));
      this._refreshPlaceAsSuggestions({ autoSelect: true });
      this._syncToolOptionsState({ suppressRender: false });

      if (!includeCompendium) return;

      this._placeAsSelection.setLoading(true);
      this._syncToolOptionsState({ suppressRender: false });

      try {
        const compOptions = await this._collectCompendiumActorOptions();
        this._applyPlaceAsStateResult(this._placeAsSelection.setCompendiumOptions(compOptions));
        this._placeAsSelection.setLoadError(null);
      } catch (error) {
        this._placeAsSelection.setLoadError(error?.message || String(error));
        Logger.warn('TokenPlacement.placeAs.compendiumLoadFailed', { error: this._placeAsSelection.loadError });
      } finally {
        this._placeAsSelection.setLoading(false);
      }

      this._refreshPlaceAsSuggestions({ autoSelect: true });
      this._syncToolOptionsState({ suppressRender: false });
    })();
    this._placeAsRefreshPromise = promise.finally(() => {
      this._placeAsRefreshPromise = null;
    });
    return this._placeAsRefreshPromise;
  }

  _collectWorldActorOptions() {
    const actors = Array.from(globalThis?.game?.actors ?? []);
    const results = [];
    for (const actor of actors) {
      if (!actor) continue;
      try {
        const folderNames = [];
        let folder = actor.folder;
        while (folder) {
          folderNames.unshift(folder.name);
          folder = folder.folder;
        }
        const folderPath = folderNames.join(' / ');
        const label = actor.name || 'Unnamed Actor';
        const protoName = actor?.prototypeToken?.name || '';
        const search = [label, folderPath, actor.id || '']
          .filter((value) => !!value)
          .join(' | ')
          .toLowerCase();
        const matchTokens = this._buildMatchTokens(label, folderPath, protoName);
        const matchNormalized = this._normalizeMatchString(label);
        const sourceTokens = this._tokenizeMatchString(folderPath);
        const sourceNormalized = this._normalizeMatchString(folderPath);
        results.push({
          id: `world:${actor.id}`,
          type: 'world',
          label,
          sort: label.toLowerCase(),
          source: folderPath,
          actorId: actor.id,
          icon: actor.img || '',
          search,
          matchTokens,
          matchNormalized,
          sourceTokens,
          sourceNormalized
        });
      } catch (error) {
        Logger.warn('TokenPlacement.placeAs.actorNormalizeFailed', { error: String(error?.message || error) });
      }
    }
    results.sort((a, b) => a.sort.localeCompare(b.sort));
    return results;
  }

  async _collectCompendiumActorOptions() {
    const packs = Array.from(globalThis?.game?.packs ?? []);
    const results = [];
    for (const pack of packs) {
      if (!pack || pack.documentName !== 'Actor') continue;
      try {
        const label = pack.metadata?.label || pack.title || pack.collection;
        const prefix = pack.collection;
        const index = await pack.getIndex({ fields: ['name', 'img'] });
        for (const entry of index) {
          const name = entry.name || 'Unnamed Actor';
          const docId = entry._id || entry.id;
          if (!docId) continue;
          const search = [name, label, prefix]
            .filter((value) => !!value)
            .join(' | ')
            .toLowerCase();
          const matchTokens = this._buildMatchTokens(name, label, prefix);
          const matchNormalized = this._normalizeMatchString(name);
          const sourceTokens = this._tokenizeMatchString(label);
          const sourceNormalized = this._normalizeMatchString(label);
          const packTokens = this._tokenizeMatchString(prefix);
          results.push({
            id: `comp:${prefix}:${docId}`,
            type: 'compendium',
            label: name,
            sort: name.toLowerCase(),
            source: label,
            pack: prefix,
            documentId: docId,
            icon: entry.img || '',
            search,
            packLabel: label,
            matchTokens,
            matchNormalized,
            sourceTokens,
            sourceNormalized,
            packTokens
          });
        }
      } catch (error) {
        Logger.warn('TokenPlacement.placeAs.packIndexFailed', { pack: pack?.collection, error: String(error?.message || error) });
      }
    }
    results.sort((a, b) => {
      if (a.packLabel === b.packLabel) return a.sort.localeCompare(b.sort);
      return a.packLabel.localeCompare(b.packLabel);
    });
    return results;
  }

  _rebuildPlaceAsOptionMap() {
    this._placeAsSelection.rebuildOptionMap();
  }

  _syncPlaceAsSelection() {
    this._applyPlaceAsStateResult(this._placeAsSelection.syncSelection());
  }

  _applyPlaceAsStateResult(stateResult = null) {
    if (stateResult?.resetTokenNamingOverrides) this._resetTokenNamingOverrides();
  }

  _loadExcludedPacks() {
    try {
      const raw = globalThis?.game?.settings?.get?.('fa-nexus', 'placeAsExcludedPacks') || '[]';
      const parsed = JSON.parse(raw);
      this._placeAsSelection.setExcludedPacks(Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      Logger.warn('TokenPlacement.placeAs.loadExcludedPacksFailed', { error: String(error?.message || error) });
      this._placeAsSelection.setExcludedPacks([]);
    }
  }

  _saveExcludedPacks() {
    try {
      const value = JSON.stringify(this._placeAsSelection.getExcludedPackIds());
      globalThis?.game?.settings?.set?.('fa-nexus', 'placeAsExcludedPacks', value);
    } catch (error) {
      Logger.warn('TokenPlacement.placeAs.saveExcludedPacksFailed', { error: String(error?.message || error) });
    }
  }

  _isPackExcluded(packId) {
    return this._placeAsSelection.isPackExcluded(packId);
  }

  _setPackExcluded(packId, excluded) {
    this._placeAsSelection.setPackExcluded(packId, excluded);
    this._saveExcludedPacks();
    this._refreshActorOptions();
  }

  _setMultiplePacksExcluded(packIds, excluded) {
    this._placeAsSelection.setMultiplePacksExcluded(packIds, excluded);
    this._saveExcludedPacks();
    this._refreshActorOptions();
  }

  _getAvailableActorPacks() {
    const packs = Array.from(globalThis?.game?.packs ?? []);
    return packs
      .filter((pack) => pack && pack.documentName === 'Actor')
      .map((pack) => {
        const folderPath = this._buildFolderPath(pack.folder);
        const packageName = pack.metadata?.packageName || null;
        return {
          id: pack.collection,
          label: pack.metadata?.label || pack.title || pack.collection,
          folder: folderPath,
          packageName,
          excluded: this._placeAsSelection.isPackExcluded(pack.collection)
        };
      })
      .sort((a, b) => {
        // Sort by folder first, then by label
        const folderA = a.folder || '';
        const folderB = b.folder || '';
        if (folderA !== folderB) return folderA.localeCompare(folderB);
        return a.label.localeCompare(b.label);
      });
  }

  _buildFolderPath(folder) {
    if (!folder) return null;
    const parts = [];
    let current = folder;
    while (current) {
      if (current.name) parts.unshift(current.name);
      current = current.folder;
    }
    return parts.length > 0 ? parts.join(' / ') : null;
  }

  _getExcludedPackCount() {
    return this._placeAsSelection.getExcludedPackCount();
  }

  _openCompendiumFilterDialog() {
    import('./place-as-compendium-filter-dialog.js').then(({ PlaceAsCompendiumFilterDialog }) => {
      const dialog = new PlaceAsCompendiumFilterDialog({
        manager: this,
        packs: this._getAvailableActorPacks()
      });
      dialog.render(true);
    }).catch((error) => {
      Logger.error('TokenPlacement.placeAs.openFilterDialogFailed', { error: String(error?.message || error) });
    });
  }

  _togglePlaceAsOpen(value) {
    if (typeof value === 'boolean') return this._setPlaceAsOpen(value);
    return this._setPlaceAsOpen(!this._placeAsSelection.open);
  }

  _setPlaceAsOpen(value) {
    const next = !!value;
    if (next) this._ensureActorOptionsLoaded();
    const stateResult = this._placeAsSelection.setOpen(next);
    this._applyPlaceAsStateResult(stateResult);
    if (!stateResult.changed) {
      this._syncToolOptionsState();
      return true;
    }
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _normalizeMatchString(value) {
    return normalizeMatchString(value);
  }

  _tokenizeMatchString(value) {
    return tokenizeMatchString(value);
  }

  _buildMatchTokens(...values) {
    return buildMatchTokens(...values);
  }

  _stripFileExtension(value) {
    return stripFileExtension(value);
  }

  _derivePlaceAsMatchKey(payload, card) {
    return derivePlaceAsMatchKey(payload, card);
  }

  _scorePlaceAsOption(option, { tokens = [], normalized = '' } = {}) {
    return scorePlaceAsOption(option, { tokens, normalized });
  }

  _rankPlaceAsOptions({ tokens = [], normalized = '', includeCompendium = true, limit = MAX_PLACE_AS_SUGGESTIONS, allowZero = false } = {}) {
    return this._placeAsSelection.rankOptions({
      tokens,
      normalized,
      includeCompendium,
      limit,
      allowZero
    });
  }

  _refreshPlaceAsSuggestions({ autoSelect = false } = {}) {
    this._applyPlaceAsStateResult(this._placeAsSelection.refreshSuggestions({ autoSelect }));
  }

  _autoSelectPlaceAsFromSuggestions() {
    this._applyPlaceAsStateResult(this._placeAsSelection.autoSelectFromSuggestions());
  }

  _applyPlaceAsMatchContext(payload, card, { resetContext = false, autoSelect = true } = {}) {
    const derived = this._derivePlaceAsMatchKey(payload, card);
    this._applyPlaceAsStateResult(this._placeAsSelection.applyMatchContext(derived, { resetContext, autoSelect }));
  }

  _composePlaceAsDisplayList() {
    return this._placeAsSelection.composeDisplayList();
  }

  _formatPlaceAsOption(option) {
    return this._placeAsSelection.formatOption(option);
  }

  _formatPlaceAsSubtitle(option) {
    return this._placeAsSelection.formatSubtitle(option);
  }

  _buildPlaceAsUIState() {
    const selection = this._getActivePlaceAsSelection();
    const hpState = this._buildHpUIState(selection);
    const namingState = this._buildTokenNamingUIState(selection);
    const actorTypeState = this._buildNewActorTypeUIState(selection);
    return this._placeAsSelection.buildUiState({ hpState, namingState, actorTypeState });
  }

  _buildNewActorTypeUIState(selection) {
    if (selection?.mode === 'actor') {
      return { available: false };
    }

    const autoType = typeof this._newActorTypeAuto === 'string' ? this._newActorTypeAuto.trim() : '';
    const selectedType = this._getSelectedNewActorType();
    const selectedLabel = selectedType ? this._formatActorTypeLabel(selectedType) : '';
    const autoLabel = autoType ? this._formatActorTypeLabel(autoType) : '';
    const options = [];

    if (autoType) {
      options.push({
        id: AUTO_NEW_ACTOR_TYPE_SELECTION,
        label: `Auto (${autoLabel})`,
        selected: !this._newActorTypeOverride
      });
    }

    for (const entry of this._newActorTypeChoices) {
      if (!entry?.id) continue;
      options.push({
        id: entry.id,
        label: entry.label || this._formatActorTypeLabel(entry.id),
        selected: this._newActorTypeOverride === entry.id
      });
    }

    let hint = '';
    if (this._newActorTypeLoading) {
      hint = 'Detecting available actor types for this system...';
    } else if (this._newActorTypeError) {
      hint = `Actor type detection failed: ${this._newActorTypeError}. The normal creation fallback will still run.`;
    } else if (!options.length) {
      hint = 'No actor types were discovered yet. The normal creation fallback will be used.';
    } else if (this._newActorTypeOverride) {
      hint = autoLabel && this._newActorTypeOverride !== autoType
        ? `Manual override for new actors. Auto suggestion: ${autoLabel}.`
        : 'Manual override for new actors.';
    } else if (autoLabel) {
      hint = `Auto will try ${autoLabel} first, then fall back if actor creation fails.`;
    }

    return {
      available: !!this._newActorTypeLoading || !!this._newActorTypeError || options.length > 0,
      disabled: this._newActorTypeLoading || options.length === 0,
      value: this._newActorTypeOverride || AUTO_NEW_ACTOR_TYPE_SELECTION,
      label: 'New Actor Type',
      hint,
      summary: selectedLabel ? `Type: ${selectedLabel}` : '',
      options
    };
  }

  _supportsTokenNamingOptions() {
    return true;
  }

  _resolveSelectedActorForNaming(selection) {
    if (!selection || selection.mode !== 'actor' || !selection.option) return null;
    const option = selection.option;
    if (option.type === 'world') {
      return globalThis?.game?.actors?.get?.(option.actorId) || null;
    }
    if (option.type === 'compendium') {
      const cachedId = this._placeAsResolvedCompendium.get(option.id);
      if (cachedId) return globalThis?.game?.actors?.get?.(cachedId) || null;
      const flagged = this._findActorByCompendiumSource(option.pack, option.documentId);
      if (flagged) return flagged;
    }
    return null;
  }

  _getTokenNamingDefaults(selection) {
    if (!this._supportsTokenNamingOptions() || !selection || selection.mode !== 'actor') {
      return { supported: false, defaults: { appendNumber: false, prependAdjective: false }, actor: null };
    }
    const actor = this._resolveSelectedActorForNaming(selection);
    const defaults = {
      appendNumber: !!actor?.prototypeToken?.appendNumber,
      prependAdjective: !!actor?.prototypeToken?.prependAdjective
    };
    return { supported: true, defaults, actor };
  }

  _buildTokenNamingUIState(selection) {
    const { supported, defaults } = this._getTokenNamingDefaults(selection);
    if (!supported) return { available: false };
    const appendNumber = this._appendNumberOverride === null ? defaults.appendNumber : !!this._appendNumberOverride;
    const prependAdjective = this._prependAdjectiveOverride === null ? defaults.prependAdjective : !!this._prependAdjectiveOverride;
    return {
      available: true,
      appendNumber,
      prependAdjective,
      appendNumberLabel: 'Append incrementing number',
      prependAdjectiveLabel: 'Prepend random adjective',
      appendNumberTooltip: 'Append an auto-incrementing number to the name of unlinked tokens (e.g. Goblin 3).',
      prependAdjectiveTooltip: 'Prepend a random adjective to the name of unlinked tokens (e.g. Angry Goblin).'
    };
  }

  _resetTokenNamingOverrides() {
    this._appendNumberOverride = null;
    this._prependAdjectiveOverride = null;
  }

  _hasTokenNamingOverrides() {
    return this._appendNumberOverride !== null || this._prependAdjectiveOverride !== null;
  }

  async _applyTokenNamingOverridesToActor(actor) {
    if (!this._supportsTokenNamingOptions()) return false;
    if (!actor || typeof actor.update !== 'function') return false;
    if (!this._hasTokenNamingOverrides()) return false;

    const update = {};
    if (this._appendNumberOverride !== null) {
      const next = !!this._appendNumberOverride;
      if (next !== !!actor?.prototypeToken?.appendNumber) update['prototypeToken.appendNumber'] = next;
    }
    if (this._prependAdjectiveOverride !== null) {
      const next = !!this._prependAdjectiveOverride;
      if (next !== !!actor?.prototypeToken?.prependAdjective) update['prototypeToken.prependAdjective'] = next;
    }
    if (!Object.keys(update).length) {
      // Overrides match actor already; treat as consumed.
      this._resetTokenNamingOverrides();
      return false;
    }

    try {
      await actor.update(update);
      this._resetTokenNamingOverrides();
      this._syncToolOptionsState({ suppressRender: false });
      return true;
    } catch (error) {
      Logger.warn('TokenPlacement.naming.updatePrototypeFailed', { error: String(error?.message || error) });
      return false;
    }
  }

  _normalizeHpMode(mode) {
    if (typeof mode !== 'string') return 'actor';
    const value = mode.toLowerCase();
    return HP_MODES.includes(value) ? value : 'actor';
  }

  _sanitizeHpPercent(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_HP_PERCENT;
    return Math.max(0, Math.min(500, Math.round(number)));
  }

  _parseStaticHpValue(input) {
    const raw = typeof input === 'string' ? input.trim() : '';
    if (!raw) return { valid: false, reason: '' };
    const normalized = raw.replace(/[–—−]/g, '-');
    const match = normalized.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) return { valid: false, reason: 'Enter a number or range like 20-85.' };
    const first = Number.parseInt(match[1], 10);
    if (!Number.isFinite(first) || first <= 0) {
      return { valid: false, reason: 'HP must be greater than zero.' };
    }
    if (!match[2]) {
      return { valid: true, type: 'fixed', value: first };
    }
    const second = Number.parseInt(match[2], 10);
    if (!Number.isFinite(second) || second <= 0) {
      return { valid: false, reason: 'HP must be greater than zero.' };
    }
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    if (min === max) {
      return { valid: true, type: 'fixed', value: min };
    }
    return { valid: true, type: 'range', min, max };
  }

  _formatHpSummary(mode, { percent, staticValue, staticParsed } = {}) {
    switch (mode) {
      case 'formula':
        return 'HP: Roll formula';
      case 'percent': {
        const pct = Number.isFinite(percent) ? percent : DEFAULT_HP_PERCENT;
        return `HP: ±${pct}% of preset`;
      }
      case 'static': {
        if (staticParsed?.valid) {
          if (staticParsed.type === 'fixed') return `HP: ${staticParsed.value}`;
          return `HP: ${staticParsed.min}-${staticParsed.max}`;
        }
        if (staticValue && staticValue.trim().length) {
          return `HP: ${staticValue.trim()}`;
        }
        return 'HP: Custom value';
      }
      case 'actor':
      default:
        return 'HP: Actor preset';
    }
  }

  _actorHasHpFormula(actor) {
    if (!actor) return false;
    const utils = foundry?.utils;
    const formula = utils?.getProperty
      ? utils.getProperty(actor, 'system.attributes.hp.formula')
      : actor?.system?.attributes?.hp?.formula;
    return typeof formula === 'string' && formula.trim().length > 0;
  }

  _getHpFormulaAvailability(selection) {
    if (!selection || selection.mode !== 'actor' || !selection.option) {
      return {
        selectable: false,
        reason: 'Select an existing actor to roll from its HP formula.'
      };
    }
    const option = selection.option;
    let actor = null;
    if (option.type === 'world') {
      actor = globalThis?.game?.actors?.get?.(option.actorId) || null;
    } else if (option.type === 'compendium') {
      const cachedId = this._placeAsResolvedCompendium.get(option.id);
      if (cachedId) actor = globalThis?.game?.actors?.get?.(cachedId) || null;
    }
    if (!actor) {
      return { selectable: true, reason: '' };
    }
    const hasFormula = this._actorHasHpFormula(actor);
    return {
      selectable: hasFormula,
      reason: hasFormula ? '' : 'Selected actor has no HP formula.'
    };
  }

  _buildHpUIState(selection) {
    let mode = this._normalizeHpMode(this._hpMode);
    const percent = this._sanitizeHpPercent(this._hpPercent);
    const staticValue = typeof this._hpStaticValue === 'string' ? this._hpStaticValue : '';
    const staticParsed = this._parseStaticHpValue(staticValue);
    const staticError = (() => {
      if (mode !== 'static') return '';
      if (!staticValue.trim()) return '';
      return staticParsed.valid ? '' : (staticParsed.reason || 'Enter a number or range like 20-85.');
    })();
    const formulaAvailability = this._getHpFormulaAvailability(selection);
    if (mode === 'formula' && !formulaAvailability.selectable) {
      mode = 'actor';
      if (this._hpMode !== 'actor') this._hpMode = 'actor';
    }
    const summary = this._formatHpSummary(mode, { percent, staticValue, staticParsed });
    const modeOptions = HP_MODES.map((id) => {
      if (id === 'actor') {
        return { id, label: 'Use actor preset', selected: mode === id, disabled: false };
      }
      if (id === 'formula') {
        return {
          id,
          label: 'Roll HP formula',
          selected: mode === id,
          disabled: !formulaAvailability.selectable,
          hint: formulaAvailability.reason || ''
        };
      }
      if (id === 'percent') {
        return {
          id,
          label: `Random ±${percent}%`,
          selected: mode === id,
          disabled: false
        };
      }
      return {
        id,
        label: 'Custom value or range',
        selected: mode === id,
        disabled: false
      };
    });
    return {
      available: true,
      mode,
      summary,
      modeOptions,
      modeHint: mode === 'formula' && formulaAvailability.reason ? formulaAvailability.reason : '',
      showPercent: mode === 'percent',
      percentValue: percent,
      percentMin: 0,
      percentMax: 500,
      percentHint: `Randomizes within ±${percent}% of the preset HP.`,
      showStatic: mode === 'static',
      staticValue,
      staticHint: 'Enter a single value (e.g. 45) or a range (e.g. 20-85).',
      staticError
    };
  }

  _setPlaceAsHpMode(mode) {
    const next = this._normalizeHpMode(mode);
    if (this._hpMode === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._hpMode = next;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _setPlaceAsActorType(value) {
    const requested = typeof value === 'string' ? value.trim() : '';
    const next = (requested && requested !== AUTO_NEW_ACTOR_TYPE_SELECTION) ? requested : null;
    if (next && !this._newActorTypeChoices.some((entry) => entry?.id === next)) {
      Logger.warn('TokenPlacement.actorType.unknownOption', { requested: next });
      this._syncToolOptionsState();
      return false;
    }
    if (this._newActorTypeOverride === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._newActorTypeOverride = next;
    Logger.info('TokenPlacement.actorType.overrideChanged', {
      override: this._newActorTypeOverride,
      effectiveType: this._getSelectedNewActorType(),
      autoType: this._newActorTypeAuto || null
    });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _setPlaceAsHpPercent(value) {
    const next = this._sanitizeHpPercent(value);
    if (this._hpPercent === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._hpPercent = next;
    this._syncToolOptionsState({ suppressRender: true });
    return true;
  }

  _setPlaceAsHpStatic(value) {
    const next = typeof value === 'string' ? value.slice(0, 120) : '';
    if (this._hpStaticValue === next) {
      this._syncToolOptionsState({ suppressRender: true });
      return true;
    }
    this._hpStaticValue = next;
    this._syncToolOptionsState({ suppressRender: true });
    return true;
  }

  _setPlaceAsAppendNumber(value) {
    const selection = this._getActivePlaceAsSelection();
    const { supported, defaults } = this._getTokenNamingDefaults(selection);
    if (!supported) return false;
    const next = !!value;
    const override = next === defaults.appendNumber ? null : next;
    if (this._appendNumberOverride === override) {
      this._syncToolOptionsState();
      return true;
    }
    this._appendNumberOverride = override;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _setPlaceAsPrependAdjective(value) {
    const selection = this._getActivePlaceAsSelection();
    const { supported, defaults } = this._getTokenNamingDefaults(selection);
    if (!supported) return false;
    const next = !!value;
    const override = next === defaults.prependAdjective ? null : next;
    if (this._prependAdjectiveOverride === override) {
      this._syncToolOptionsState();
      return true;
    }
    this._prependAdjectiveOverride = override;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _ensureScrollingTextGuard() {
    if (canvas?.interface && !canvas.interface._faNexusOriginalScrollingText) {
      this._scrollingTextGuardReady = false;
    }
    if (this._scrollingTextGuardReady) return;
    const install = () => {
      try {
        const iface = canvas?.interface;
        if (!iface) return;
        if (iface._faNexusOriginalScrollingText) {
          this._scrollingTextGuardReady = true;
          return;
        }
        const original = iface.createScrollingText;
        if (typeof original !== 'function') return;
        iface._faNexusOriginalScrollingText = original;
        iface.createScrollingText = async function faNexusScrollingGuard(origin, content, options = {}) {
          const guard = globalThis.__faNexusScrollingTextGuard;
          if (guard?.depth > 0) return;
          return original.call(this, origin, content, options);
        };
        this._scrollingTextGuardReady = true;
      } catch (_) {}
    };
    if (canvas?.interface) install();
    else {
      try {
        globalThis?.Hooks?.once?.('canvasReady', () => install());
      } catch (_) {}
    }
  }

  async _withScrollingTextSuppressed(fn) {
    this._ensureScrollingTextGuard();
    const guard = globalThis.__faNexusScrollingTextGuard || (globalThis.__faNexusScrollingTextGuard = { depth: 0 });
    guard.depth += 1;
    try {
      return await fn();
    } finally {
      guard.depth = Math.max(0, guard.depth - 1);
    }
  }

  _getActivePlaceAsSelection() {
    return this._placeAsSelection.getActiveSelection();
  }

  _setPlaceAsSearch(value) {
    const stateResult = this._placeAsSelection.setSearch(value);
    this._applyPlaceAsStateResult(stateResult);
    if (!stateResult.changed) {
      this._syncToolOptionsState();
      return true;
    }
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _selectPlaceAsOption(optionId, { user = true, auto = false, option = null } = {}) {
    const stateResult = this._placeAsSelection.selectOption(optionId, { user, auto, option });
    this._applyPlaceAsStateResult(stateResult);
    this._syncToolOptionsState({ suppressRender: false });
    return stateResult.found !== false;
  }

  _setPlaceAsLinked(value, { user = true } = {}) {
    const stateResult = this._placeAsSelection.setLinked(value, { user });
    this._applyPlaceAsStateResult(stateResult);
    if (!stateResult.changed) {
      this._syncToolOptionsState();
      return true;
    }
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  async _resolveActorForSelection(option) {
    if (!option) return null;
    if (option.type === 'world') {
      const actor = globalThis?.game?.actors?.get?.(option.actorId);
      if (!actor) this._handleMissingActorOption(option.id);
      return actor || null;
    }
    if (option.type === 'compendium') {
      const cachedId = this._placeAsResolvedCompendium.get(option.id);
      if (cachedId) {
        const cachedActor = globalThis?.game?.actors?.get?.(cachedId);
        if (cachedActor) return cachedActor;
        this._placeAsResolvedCompendium.delete(option.id);
      }
      const flagged = this._findActorByCompendiumSource(option.pack, option.documentId);
      if (flagged) {
        this._placeAsResolvedCompendium.set(option.id, flagged.id);
        return flagged;
      }
      const imported = await this._importActorFromCompendium(option);
      if (imported) {
        this._placeAsResolvedCompendium.set(option.id, imported.id);
        this._scheduleActorOptionRefresh({ includeCompendium: false });
      }
      return imported || null;
    }
    return null;
  }

  _handleMissingActorOption(optionId) {
    if (!optionId) return;
    this._applyPlaceAsStateResult(this._placeAsSelection.handleMissingOption(optionId));
    this._syncToolOptionsState({ suppressRender: false });
  }

  _findActorByCompendiumSource(packId, documentId) {
    const actors = globalThis?.game?.actors;
    if (!actors) return null;
    for (const actor of actors) {
      try {
        const source = actor.getFlag?.('fa-nexus', 'compendiumSource');
        if (!source) continue;
        if (source.pack === packId && source.documentId === documentId) return actor;
      } catch (_) {}
    }
    return null;
  }

  async _importActorFromCompendium(option) {
    const packs = globalThis?.game?.packs;
    if (!packs || typeof packs.get !== 'function') {
      throw new Error('Compendium access unavailable');
    }
    const pack = packs.get(option.pack);
    if (!pack) throw new Error('Compendium not found');
    const document = await pack.getDocument(option.documentId);
    if (!document) throw new Error('Compendium actor not found');
    const data = document.toObject();
    try { delete data._id; } catch (_) {}
    try {
      const utils = foundry?.utils;
      if (utils?.mergeObject) {
        const existing = utils.getProperty?.(data, 'flags.fa-nexus.compendiumSource');
        const payload = { pack: option.pack, documentId: option.documentId };
        if (existing && typeof existing === 'object') Object.assign(existing, payload);
        else utils.setProperty?.(data, 'flags.fa-nexus.compendiumSource', payload);
      } else if (typeof data === 'object') {
        data.flags = data.flags || {};
        data.flags['fa-nexus'] = data.flags['fa-nexus'] || {};
        data.flags['fa-nexus'].compendiumSource = { pack: option.pack, documentId: option.documentId };
      }
    } catch (_) {}
    if (ActorFactory?._createActorInTargetFolder) {
      return await ActorFactory._createActorInTargetFolder(data);
    }
    return await Actor.create(data);
  }

  async _placeUsingActorSelection(selection, dragData, drop) {
    const option = selection?.option;
    if (!option) return null;
    const actor = await this._resolveActorForSelection(option);
    if (!actor) throw new Error('Selected actor is no longer available.');

    const shouldUpdatePrototype = !!selection?.linked || option.type === 'compendium';
    let prototypeUpdated = false;
    if (shouldUpdatePrototype) {
      try {
        const updateOptions = { updateActorImage: true };
        if (this._appendNumberOverride !== null) updateOptions.appendNumber = !!this._appendNumberOverride;
        if (this._prependAdjectiveOverride !== null) updateOptions.prependAdjective = !!this._prependAdjectiveOverride;
        await ActorFactory.updateActorPrototypeToken(actor, dragData, updateOptions);
        prototypeUpdated = true;
      } catch (error) {
        Logger.warn('TokenPlacement.placeAs.updatePrototypeFailed', { error: String(error?.message || error) });
      }
    }

    const linked = !!selection?.linked;

    // If the user changed naming rules in the tool options, persist them onto the selected actor
    // before token creation so Actor#getTokenDocument can generate the correct name.
    if (!prototypeUpdated && this._hasTokenNamingOverrides()) {
      await this._applyTokenNamingOverridesToActor(actor);
    } else if (prototypeUpdated && this._hasTokenNamingOverrides()) {
      // updateActorPrototypeToken already applied these fields; clear local overrides so the UI
      // reflects the actor's saved prototype settings.
      this._resetTokenNamingOverrides();
      this._syncToolOptionsState({ suppressRender: false });
    }

    let hpOverride = null;
    try {
      hpOverride = await this._resolveHpOverride({ actor });
    } catch (error) {
      Logger.warn('TokenPlacement.hp.resolveFailed', { scope: 'actor-selection', error: String(error?.message || error) });
      hpOverride = null;
    }

    if (hpOverride && linked) {
      await this._applyHpOverrideToActorDocument(actor, hpOverride);
    }

    const tokenDoc = await this._createTokenFromSelection(actor, dragData, drop, {
      linked,
      hpOverride: !linked ? hpOverride : null
    });

    try {
      await this._applyHpOverrides({
        actor,
        tokenDoc,
        applyToActor: linked,
        override: hpOverride || undefined
      });
    } catch (error) {
      Logger.warn('TokenPlacement.hp.applyFailed', { scope: 'actor-selection', error: String(error?.message || error) });
    }

    return tokenDoc;
  }

  async _createTokenFromSelection(actor, dragData, drop, { linked = false, hpOverride = null } = {}) {
    return createTokenPlacementDocument({
      actor,
      dragData,
      drop,
      linked,
      hpOverride,
      appendNumberOverride: this._appendNumberOverride,
      prependAdjectiveOverride: this._prependAdjectiveOverride,
      supportsTokenNamingOptions: this._supportsTokenNamingOptions()
    });
  }

  async _resolveHpOverride({ actor = null, tokenDoc = null } = {}) {
    const mode = this._normalizeHpMode(this._hpMode);
    if (mode === 'actor') return null;
    if (!actor && !tokenDoc) return null;
    const hpData = this._resolveActorHpData(actor, tokenDoc);
    if (!hpData) return null;

    const base = Math.max(1, Math.round(hpData.max || hpData.value || 0));
    let finalValue = null;

    if (mode === 'formula') {
      const formula = hpData.formula || this._resolveHpFormula(actor, tokenDoc);
      if (!formula) {
        if (!this._hpFormulaWarned) {
          ui.notifications?.warn?.('No HP formula available for the selected actor. Using preset HP.');
          this._hpFormulaWarned = true;
        }
        return null;
      }
      const rollResult = await this._rollHpFormula(formula);
      if (!rollResult.success) {
        if (!this._hpFormulaWarned) {
          ui.notifications?.warn?.('Failed to roll HP formula. Using preset HP instead.');
          this._hpFormulaWarned = true;
        }
        return null;
      }
      finalValue = rollResult.value;
    } else if (mode === 'percent') {
      const percent = this._sanitizeHpPercent(this._hpPercent);
      const { min, max } = this._calculatePercentHpRange(base, percent);
      finalValue = this._randomInRange(min, max);
    } else if (mode === 'static') {
      const parsed = this._parseStaticHpValue(this._hpStaticValue);
      if (!parsed.valid) return null;
      if (parsed.type === 'fixed') finalValue = parsed.value;
      else finalValue = this._randomInRange(parsed.min, parsed.max);
    }

    if (!Number.isFinite(finalValue) || finalValue <= 0) return null;
    const finalHp = Math.max(1, Math.round(finalValue));
    const finalMax = Math.max(1, Math.round(finalValue));
    return {
      path: hpData.path || 'system.attributes.hp',
      value: finalHp,
      max: finalMax
    };
  }

  async _applyHpOverrides({ actor = null, tokenDoc = null, applyToActor = false, override = null } = {}) {
    const hpOverride = override || await this._resolveHpOverride({ actor, tokenDoc });
    if (!hpOverride) return;

    const hpPath = hpOverride.path || 'system.attributes.hp';
    const valuePath = `${hpPath}.value`;
    const maxPath = `${hpPath}.max`;

    await this._withScrollingTextSuppressed(async () => {
      const updateOptions = { animate: false };
      const updatePromises = [];
      const updateContexts = [];
      const tokenId = tokenDoc?.id ?? tokenDoc?._id;
      const queueUpdate = (promise, context) => {
        updatePromises.push(promise);
        updateContexts.push(context);
      };
      const hpErrorString = (error) => String(error?.message || error).replace(/https?:\/\/\S+/gi, '[url]');

      if (applyToActor && actor?.update) {
        const payload = {};
        payload[valuePath] = hpOverride.value;
        payload[maxPath] = hpOverride.max;
        queueUpdate(actor.update(payload, updateOptions), {
          scope: 'actor-prototype',
          actorId: actor?.id ?? actor?._id,
          actorName: actor?.name,
          tokenId
        });
      }

      const tokenIsLinked = tokenDoc?.actorLink ?? tokenDoc?.data?.actorLink ?? tokenDoc?._source?.actorLink;
      if (tokenDoc?.update && tokenIsLinked === false) {
        const payload = {};
        payload[`actorData.${valuePath}`] = hpOverride.value;
        payload[`actorData.${maxPath}`] = hpOverride.max;
        queueUpdate(tokenDoc.update(payload, {
          ...updateOptions,
          render: false,
          diff: false,
          faNexusSuppressFloaty: true
        }), {
          scope: 'unlinked-token-actor-data',
          actorId: actor?.id ?? actor?._id ?? tokenDoc?.actor?.id ?? tokenDoc?.actor?._id,
          actorName: actor?.name ?? tokenDoc?.actor?.name,
          tokenId
        });
      }

      const tokenActor = tokenDoc?.actor;
      if (tokenActor && tokenActor !== actor && tokenActor.update) {
        const payload = {};
        payload[valuePath] = hpOverride.value;
        payload[maxPath] = hpOverride.max;
        queueUpdate(tokenActor.update(payload, {
          ...updateOptions,
          render: false,
          diff: false,
          faNexusSuppressFloaty: true
        }), {
          scope: 'token-actor',
          actorId: tokenActor?.id ?? tokenActor?._id,
          actorName: tokenActor?.name,
          tokenId
        });
      }

      if (updatePromises.length) {
        const updateResults = await Promise.allSettled(updatePromises);
        for (const [index, result] of updateResults.entries()) {
          if (result.status !== 'rejected') continue;
          Logger.warn('TokenPlacement.hp.updateRejected', {
            ...updateContexts[index],
            hpPath,
            error: hpErrorString(result.reason)
          });
        }
      }
    });
  }

  async _applyHpOverrideToActorDocument(actor, override) {
    if (!actor?.update || !override) return false;
    const hpPath = override.path || 'system.attributes.hp';
    const valuePath = `${hpPath}.value`;
    const maxPath = `${hpPath}.max`;
    const payload = {};
    payload[valuePath] = override.value;
    payload[maxPath] = override.max;
    try {
      await this._withScrollingTextSuppressed(async () => {
        await actor.update(payload, {
          animate: false,
          render: false,
          diff: false,
          faNexusSuppressFloaty: true
        });
      });
      return true;
    } catch (error) {
      Logger.warn('TokenPlacement.hp.applyToActorFailed', { error: String(error?.message || error) });
      return false;
    }
  }

  _resolveActorHpData(actor, tokenDoc) {
    const utils = foundry?.utils;
    const path = 'system.attributes.hp';
    const resolve = (target, basePath) => {
      if (!target) return null;
      if (utils?.getProperty) return utils.getProperty(target, basePath);
      return target?.system?.attributes?.hp ?? null;
    };

    let data = resolve(actor, path);
    if (!data && tokenDoc) {
      data = utils?.getProperty?.(tokenDoc, `actorData.${path}`)
        ?? tokenDoc?.actorData?.system?.attributes?.hp
        ?? resolve(tokenDoc?.actor, path);
    }
    if (!data || typeof data !== 'object') return null;
    const value = Number(data.value ?? data.max ?? 0) || 0;
    const max = Number(data.max ?? data.value ?? 0) || 0;
    const temp = Number(data.temp ?? 0) || 0;
    const formula = this._resolveHpFormula(actor, tokenDoc);
    return { path, value, max, temp, formula };
  }

  _resolveHpFormula(actor, tokenDoc) {
    const utils = foundry?.utils;
    const extract = (target) => {
      if (!target) return '';
      const value = utils?.getProperty
        ? utils.getProperty(target, 'system.attributes.hp.formula')
        : target?.system?.attributes?.hp?.formula;
      if (typeof value === 'string' && value.trim().length) return value.trim();
      return '';
    };
    let formula = extract(actor);
    if (formula) return formula;
    if (tokenDoc) {
      const tokenFormula = utils?.getProperty?.(tokenDoc, 'actorData.system.attributes.hp.formula');
      if (typeof tokenFormula === 'string' && tokenFormula.trim().length) return tokenFormula.trim();
      formula = extract(tokenDoc.actor);
      if (formula) return formula;
    }
    return '';
  }

  async _rollHpFormula(formula) {
    const RollClass = globalThis?.foundry?.dice?.Roll;
    if (typeof RollClass !== 'function') {
      Logger.warn('TokenPlacement.hp.rollUnavailable', { formula });
      return { success: false };
    }
    try {
      const roll = new RollClass(formula);
      if (typeof roll.evaluate !== 'function') {
        throw new Error('Roll.evaluate is unavailable.');
      }
      await roll.evaluate();

      const total = Math.max(1, Math.round(Number(roll.total) || 0));
      return { success: Number.isFinite(total) && total > 0, value: total };
    } catch (error) {
      Logger.warn('TokenPlacement.hp.rollFailed', { formula, error: String(error?.message || error) });
      return { success: false };
    }
  }

  _calculatePercentHpRange(base, percent) {
    const pct = this._sanitizeHpPercent(percent);
    const baseValue = Math.max(1, Math.round(Number(base) || 0));
    const min = Math.max(1, Math.round(baseValue * (1 - pct / 100)));
    const max = Math.max(min, Math.round(baseValue * (1 + pct / 100)));
    return { min, max };
  }

  _randomInRange(min, max) {
    const low = Math.floor(Math.min(min, max));
    const high = Math.floor(Math.max(min, max));
    if (!Number.isFinite(low) || !Number.isFinite(high)) return low;
    if (high <= low) return Math.max(1, low);
    const span = high - low + 1;
    return low + Math.floor(Math.random() * span);
  }


  _transformCoordinates(screenX, screenY, tokenSize) {
    if (!canvas) return null;
    const world = canvas.canvasCoordinatesFromClient({ x: screenX, y: screenY });

    // Check FA Nexus grid snap setting - only snap if enabled
    const gridSnapEnabled = TokenDragDropManager.isGridSnapEnabled();
    const finalCoords = gridSnapEnabled
      ? TokenDragDropManager.applyGridSnapping(world, canvas, tokenSize)
      : world;

    return {
      screen: { x: screenX, y: screenY },
      world: finalCoords
    };
  }

  _announceStart(isSticky) {
    const message = isSticky
      ? 'Token placement: click to place, wheel zooms to cursor, Ctrl+Wheel rotates, tap S toggles grid snap, F1 opens help, hold Shift to keep placing, press ESC to cancel.'
      : 'Token placement: click to place, wheel zooms to cursor, Ctrl+Wheel rotates, tap S toggles grid snap, F1 opens help, hold Shift to keep placing, press ESC to cancel.';
    announceChange('token-placement-start', message, { level: 'info', throttleMs: 500 });
  }
}
