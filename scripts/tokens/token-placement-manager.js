import { TokenDragDropManager } from './token-dragdrop-manager.js';
import { ActorFactory } from './actor-factory.js';
import * as SystemDetection from './system-detection.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { getCanvasInteractionController, announceChange } from '../canvas/canvas-interaction-controller.js';
import { isPointerOverCanvas } from '../canvas/canvas-pointer-utils.js';
import { createCanvasGestureSession } from '../canvas/canvas-gesture-session.js';
import { toolOptionsController } from '../core/tool-options-controller.js';
import { PlacementPrefetchQueue } from '../core/placement/placement-prefetch-queue.js';

const DEFAULT_PLACE_AS_SELECTION = 'fa-nexus:create-new';
const MAX_PLACE_AS_RESULTS = 60;
const MAX_PLACE_AS_SUGGESTIONS = 10;
const MIN_AUTO_PLACE_AS_SCORE = 35;
const HP_MODES = ['actor', 'formula', 'percent', 'static'];
const DEFAULT_HP_PERCENT = 20;

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
    this.isPlacementActive = false;
    this._stickyMode = false;
    this._current = null; // { card, payload }
    this._preview = null;
    this._session = null;
    this._lastPointer = null;
    this._lastPointerWorld = null;
    this._rotation = 0;
    this._rotationRandomEnabled = false;
    this._rotationRandomStrength = 0;
    this._currentRandomOffset = 0;
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
    this._hoveredActorEl = null;
    this._pendingActorClickBlocker = null;
    this._suppressNextActorClick = false;
    this._settingsHook = null;
    this._gridSnapHook = null;
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
    this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
    this._placeAsLinked = false;
    this._placeAsSearch = '';
    this._placeAsOptions = [];
    this._placeAsWorldOptions = [];
    this._placeAsCompendiumOptions = [];
    this._placeAsOptionMap = new Map();
    this._placeAsResolvedCompendium = new Map();
    this._placeAsLoading = false;
    this._placeAsLoadError = null;
    this._placeAsRefreshPromise = null;
    this._placeAsRefreshTimer = null;
    this._placeAsActorHooksInstalled = false;
    this._placeAsOpen = false;
    this._placeAsMatchRaw = '';
    this._placeAsMatchNormalized = '';
    this._placeAsMatchTokens = [];
    this._placeAsSuggestions = [];
    this._placeAsUserModified = false;
    this._placeAsSelectionAuto = false;
    this._placeAsSelectedOption = null;
    this._hpMode = 'actor';
    this._hpPercent = DEFAULT_HP_PERCENT;
    this._hpStaticValue = '';
    this._hpFormulaWarned = false;
    this._scrollingTextGuardReady = false;

    this._installGridSnapHooks();
    this._installActorOptionHooks();
    this._ensureActorOptionsLoaded();
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
    try {
      this._syncToolOptionsState({ suppressRender: false });
      toolOptionsController.activateTool('token.placement', { label: 'Token Placement' });
    } catch (_) {}
  }

  _deactivateToolOptions() {
    try { toolOptionsController.deactivateTool('token.placement'); } catch (_) {}
  }

  _activateTokensLayer() {
    try { canvas?.tokens?.activate?.(); }
    catch (_) { /* no-op */ }
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
      this._placeAsOpen = false;
      this._placeAsSearch = '';
      this._applyPlaceAsMatchContext(payload, cardElement, { resetContext: true, autoSelect: true });

      this.isPlacementActive = true;
      this._stickyMode = !!sticky;
      this._hpFormulaWarned = false;
      this._current = { card: cardElement, payload };
      this._currentEntry = this._createEntryFromCard(cardElement, payload);
      this._rotation = 0;
      this._rotationRandomEnabled = false;
      this._rotationRandomStrength = 45;
      this._currentRandomOffset = 0;
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
      this._hoveredActorEl = null;
      this._setupEvents();
      this._announceStart(sticky);
    } catch (error) {
      Logger.warn('TokenPlacement.start.failed', { error: String(error?.message || error) });
      ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
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
      this._rotationRandomStrength = 45;
      this._currentRandomOffset = 0;
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
      this._placeAsOpen = false;
      this._placeAsSearch = '';
      this._placeAsUserModified = false;
      this._placeAsSelectionAuto = false;
      this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
      this._placeAsLinked = false;
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

      this._hoveredActorEl = null;
      this._setupEvents();
      this._announceStart(true);
    } catch (error) {
      Logger.warn('TokenPlacement.random.start.failed', { error: String(error?.message || error) });
      ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
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
    this._currentRandomOffset = 0;
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
    this._clearActorHoverHighlight();
    this._teardownActorClickBlocker();
    try {
      if (reason === 'esc') {
        const target = this.app?.element || document;
        target?.dispatchEvent?.(new CustomEvent('fa-nexus:placement-cancelled', { bubbles: true }));
      }
    } catch (_) {}
    this._hpFormulaWarned = false;
  }

  _normalizeRotation(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return ((num % 360) + 360) % 360;
  }

  _hasRandomRotationEnabled() {
    return !!this._rotationRandomEnabled && Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0)) > 0;
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
      this._currentRandomOffset = 0;
      this._pendingRotation = base;
      this._applyRotationToPreview();
      return;
    }
    const limit = Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0));
    if (regenerateOffset || !Number.isFinite(this._currentRandomOffset)) {
      this._currentRandomOffset = (Math.random() * 2 - 1) * limit;
    } else if (clampOffset) {
      this._currentRandomOffset = Math.max(-limit, Math.min(limit, this._currentRandomOffset));
    }
    this._pendingRotation = this._normalizeRotation(base + this._currentRandomOffset);
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
    this._teardownEvents();

    const pointerMoveHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (pointer?.screen) {
        this._lastPointer = { x: pointer.screen.x, y: pointer.screen.y };
      }
      if (pointer?.world) {
        this._lastPointerWorld = { x: pointer.world.x, y: pointer.world.y };
      } else if (pointer?.screen) {
        const world = this._screenToWorld(pointer.screen.x, pointer.screen.y, pointer.canvas);
        if (world) this._lastPointerWorld = world;
      }
      if (this._preview?.box) {
        if (this._preview.box.style.display === 'none') this._preview.box.style.display = 'block';
        this._updatePreviewPosition({ pointer });
      }
      if (pointer?.screen) {
        this._updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
    };

    const wheelHandler = (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (!pointer?.overCanvas || !pointer.zOk) return;

      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
        const baseStep = 15;
        const step = event.shiftKey ? baseStep / 3 : baseStep;
        const dir = event.deltaY > 0 ? 1 : -1;
        this._rotation = ((this._rotation + dir * step) % 360 + 360) % 360;
        this._updateRotationPreview({ clampOffset: true });
        this._syncToolOptionsState();
        return;
      }

      try {
        event.preventDefault();
        event.stopPropagation();
        const stage = canvas?.stage; if (!stage) return;
        const rect = pointer.canvas?.getBoundingClientRect();
        if (!rect) return;
        const cx = pointer.screen.x - rect.left; const cy = pointer.screen.y - rect.top;
        const currentScale = Number(stage.scale?.x || 1);
        const step = 1.25;
        const dir = event.deltaY < 0 ? 1 : -1;
        const targetScale = currentScale * Math.pow(step, dir);
        const cfgMin = Number((globalThis.CONFIG && globalThis.CONFIG.Canvas && globalThis.CONFIG.Canvas.minZoom) || 0.25);
        const cfgMax = Number((globalThis.CONFIG && globalThis.CONFIG.Canvas && globalThis.CONFIG.Canvas.maxZoom) || 4);
        const minZ = isNaN(cfgMin) ? 0.25 : cfgMin;
        const maxZ = isNaN(cfgMax) ? 4 : cfgMax;
        const newScale = Math.min(maxZ, Math.max(minZ, targetScale));
        if (Math.abs(newScale - currentScale) < 1e-6) return;
        const worldUnderCursor = stage.worldTransform.applyInverse(new PIXI.Point(cx, cy));
        const centerX = rect.width / 2; const centerY = rect.height / 2;
        const desiredCenterX = worldUnderCursor.x + (centerX - cx) / newScale;
        const desiredCenterY = worldUnderCursor.y + (centerY - cy) / newScale;
        if (typeof canvas?.animatePan === 'function') {
          canvas.animatePan({ x: desiredCenterX, y: desiredCenterY, scale: newScale, duration: 50 });
        } else {
          stage.scale.set(newScale, newScale);
          stage.position.set(centerX - newScale * desiredCenterX, centerY - newScale * desiredCenterY);
        }
      } catch (_) {}
    };

    const pointerDownHandler = async (event, { pointer }) => {
      if (!this.isPlacementActive) return;
      if (event.button !== 0) return;
      if (this._placing) {
        event.preventDefault();
        return;
      }
      if (pointer?.screen) {
        this._updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
      const actorEl = pointer?.screen ? this._findActorElement(pointer.screen.x, pointer.screen.y) : null;
      const overCanvas = pointer?.overCanvas && pointer.zOk;
      if (!overCanvas && !actorEl) return;
      if (actorEl) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this._installActorClickBlocker();
      } else {
        event.preventDefault();
        event.stopPropagation();
      }
      const result = await this._placeAtPointer(event, actorEl);
      if (result === 'none') {
        this.cancelPlacement('error');
        return;
      }
      const keepPlacing = event.shiftKey || this._stickyMode;
      if (!keepPlacing && (result === 'canvas' || result === 'actor')) {
        this.cancelPlacement('placed');
      } else if (keepPlacing && result === 'actor' && pointer?.screen) {
        this._updateActorHoverHighlight(pointer.screen.x, pointer.screen.y);
      }
      if (keepPlacing && (result === 'canvas' || result === 'actor') && this._randomMode) {
        await this._switchToNextRandomEntry({ pointerEvent: event });
      }
    };

    const keyDownHandler = (event) => {
      if (!this.isPlacementActive) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.cancelPlacement('esc');
      }
    };

    this._session = createCanvasGestureSession({
      pointermove: { handler: pointerMoveHandler, respectZIndex: false },
      wheel: { handler: wheelHandler, respectZIndex: true },
      pointerdown: pointerDownHandler,
      keydown: keyDownHandler
    }, {
      lockCanvasLayer: 'tokens',
      onCanvasTearDown: () => this.cancelPlacement('canvas-teardown'),
      onStop: () => {
        this._session = null;
      }
    });
  }

  _teardownEvents() {
    if (this._session) {
      try {
        this._session.stop('manual');
      } catch (_) {
        // no-op
      }
      this._session = null;
    }
    this._clearActorHoverHighlight();
    this._teardownActorClickBlocker();
  }

  _updateActorHoverHighlight(clientX, clientY) {
    try {
      const actorEl = this._findActorElement(clientX, clientY);
      if (actorEl === this._hoveredActorEl) return;
      if (this._hoveredActorEl) {
        try { this._hoveredActorEl.classList.remove('actor-drop-target'); } catch (_) {}
      }
      if (actorEl) {
        try { actorEl.classList.add('actor-drop-target'); } catch (_) {}
      }
      this._hoveredActorEl = actorEl || null;
    } catch (_) {}
  }

  _clearActorHoverHighlight() {
    if (this._hoveredActorEl) {
      try { this._hoveredActorEl.classList.remove('actor-drop-target'); } catch (_) {}
      this._hoveredActorEl = null;
    }
  }

  _installActorClickBlocker() {
    this._suppressNextActorClick = true;
    if (this._pendingActorClickBlocker) return;
    const blocker = (ev) => {
      if (!this._suppressNextActorClick) {
        document.removeEventListener('click', blocker, true);
        this._pendingActorClickBlocker = null;
        return;
      }
      ev.stopImmediatePropagation();
      ev.preventDefault();
      this._suppressNextActorClick = false;
      document.removeEventListener('click', blocker, true);
      this._pendingActorClickBlocker = null;
    };
    this._pendingActorClickBlocker = blocker;
    document.addEventListener('click', blocker, true);
  }

  _teardownActorClickBlocker() {
    this._suppressNextActorClick = false;
    if (this._pendingActorClickBlocker) {
      document.removeEventListener('click', this._pendingActorClickBlocker, true);
      this._pendingActorClickBlocker = null;
    }
  }

  async _prepareTokenPayload(cardElement, { authed = false, authState = null, allowPendingDownload = false } = {}) {
    const filename = cardElement.getAttribute('data-filename') || '';
    const displayName = cardElement.getAttribute('data-display-name') || '';
    const originSource = cardElement.getAttribute('data-source') || '';
    const originTier = cardElement.getAttribute('data-tier') || '';
    const sizeInfo = TokenDragDropManager._readSizeInfoFromCard(cardElement);

    let localPath = cardElement._resolvedLocalPath || cardElement.getAttribute('data-url') || '';
    const looksLikeFile = (p) => /\.(webp|png|jpg|jpeg|gif|svg)$/i.test(String(p || ''));
    if (!localPath || !looksLikeFile(localPath)) {
      const pathAttr = cardElement.getAttribute('data-path') || '';
      if (looksLikeFile(pathAttr)) localPath = pathAttr;
    }

    const isCloud = (originSource || '').toLowerCase() === 'cloud';
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
              cardElement._resolvedLocalPath = local;
              cardElement.setAttribute('data-url', local);
              cardElement.setAttribute('data-cached', 'true');
              const icon = cardElement.querySelector('.fa-nexus-status-icon');
              if (icon) {
                icon.classList.remove('cloud-plus', 'cloud', 'premium');
                icon.classList.add('cloud', 'cached');
                icon.title = 'Downloaded';
                icon.innerHTML = '<i class="fas fa-cloud-check"></i>';
              }
              const variantIcon = cardElement.querySelector('.fa-nexus-token-status-icon');
              if (variantIcon) {
                variantIcon.classList.remove('premium', 'cloud-plus');
                variantIcon.classList.add('cloud', 'cached');
                variantIcon.title = 'Downloaded';
                variantIcon.innerHTML = '<i class="fas fa-cloud-check"></i>';
                cardElement.classList.remove('locked-token');
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
            ui.notifications?.error?.(`Failed to download token asset: ${error?.message || error}`);
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
          if (this._hoveredActorEl === resolvedActorEl) this._hoveredActorEl = null;
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
        const created = await ActorFactory.createActorFromDragData(dragData, drop, {
          beforeTokenCreate: async (actorDoc) => {
            try {
              pendingHpOverride = await this._resolveHpOverride({ actor: actorDoc });
            } catch (error) {
              Logger.warn('TokenPlacement.hp.resolveFailed', { scope: 'new-actor', error: String(error?.message || error) });
              pendingHpOverride = null;
            }
            if (!pendingHpOverride) return {};
            await this._applyHpOverrideToActorDocument(actorDoc, pendingHpOverride);
            return { hpOverride: pendingHpOverride };
          }
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
      ui.notifications?.error?.(`Failed to place token: ${error?.message || error}`);
      this._clearActorHoverHighlight();
      this._teardownActorClickBlocker();
      return 'none';
    } finally {
      this._suppressNextActorClick = false;
      this._placing = false;
    }
  }

  _resolveCurrentUrl(card, payload) {
    const looksFile = (p) => {
      if (!p) return false;
      let path = String(p);
      try {
        const url = new URL(path, window.location.origin);
        path = url.pathname || path;
      } catch (_) { /* not an absolute URL */ }
      return /\.(webp|png|jpg|jpeg|gif|svg)$/i.test(path);
    };
    const attrs = card || {};
    const attrUrl = typeof attrs.getAttribute === 'function' ? attrs.getAttribute('data-url') : '';
    const resolved = attrs._resolvedLocalPath || '';
    if (looksFile(resolved)) return resolved;
    if (looksFile(attrUrl)) return attrUrl;
    if (looksFile(payload?.url)) return payload.url;
    return payload?.url || '';
  }

  _createEntryFromCard(cardElement, payload = null) {
    if (!cardElement) return null;
    const entry = {
      card: cardElement,
      source: cardElement.getAttribute('data-source') || 'local',
      tier: cardElement.getAttribute('data-tier') || 'free',
      filename: cardElement.getAttribute('data-filename') || payload?.filename || '',
      file_path: cardElement.getAttribute('data-file-path') || payload?.file_path || '',
      path: cardElement.getAttribute('data-path') || payload?.path || '',
      cachedLocalPath: cardElement._resolvedLocalPath || cardElement.getAttribute('data-url') || payload?.url || '',
      display_name: cardElement.getAttribute('data-display-name') || payload?.displayName || '',
      grid_width: Number(cardElement.getAttribute('data-grid-w') || payload?.tokenSize?.gridWidth || 1) || 1,
      grid_height: Number(cardElement.getAttribute('data-grid-h') || payload?.tokenSize?.gridHeight || 1) || 1,
      scale: Number(cardElement.getAttribute('data-scale') || payload?.tokenSize?.scale || 1) || 1,
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
    if (!entry) return null;
    if (entry._nexusNormalized) return entry;
    const card = entry.card || null;
    const item = entry.source_item || entry.item || null;
    const filename = entry.filename ?? item?.filename ?? card?.getAttribute?.('data-filename') ?? '';
    const folderPath = entry.path ?? item?.path ?? card?.getAttribute?.('data-path') ?? '';
    const filePathRaw = entry.file_path ?? item?.file_path ?? card?.getAttribute?.('data-file-path') ?? '';
    const resolvedFilePath = filePathRaw || (folderPath && filename ? joinPath(folderPath, filename) : filename);
    let cachedLocalPath = entry.cachedLocalPath ?? item?.cachedLocalPath ?? card?._resolvedLocalPath ?? '';
    if (!cachedLocalPath) {
      const cardCached = card?.getAttribute?.('data-cached') === 'true';
      const cardUrl = card?.getAttribute?.('data-url') ?? '';
      if (cardCached && cardUrl) cachedLocalPath = cardUrl;
    }
    let resolvedPath = folderPath;
    if (!resolvedPath && cachedLocalPath) resolvedPath = cachedLocalPath;
    const normalized = {
      card,
      source_item: item,
      source: entry.source ?? item?.source ?? card?.getAttribute?.('data-source') ?? 'local',
      tier: entry.tier ?? item?.tier ?? card?.getAttribute?.('data-tier') ?? 'free',
      filename,
      file_path: resolvedFilePath,
      path: resolvedPath,
      cachedLocalPath,
      display_name: entry.display_name ?? item?.display_name ?? card?.getAttribute?.('data-display-name') ?? '',
      grid_width: Number(entry.grid_width ?? item?.grid_width ?? card?.getAttribute?.('data-grid-w') ?? 1) || 1,
      grid_height: Number(entry.grid_height ?? item?.grid_height ?? card?.getAttribute?.('data-grid-h') ?? 1) || 1,
      scale: Number(entry.scale ?? item?.scale ?? card?.getAttribute?.('data-scale') ?? 1) || 1,
      color_variant: entry.color_variant ?? item?.color_variant ?? card?.getAttribute?.('data-variant') ?? null,
      base_name_no_variant: entry.base_name_no_variant ?? item?.base_name_no_variant ?? '',
      has_color_variant: entry.has_color_variant ?? !!item?.has_color_variant,
      variant_group: entry.variant_group ?? item?.base_name_no_variant ?? item?.display_name ?? '',
      thumbnail_url: entry.thumbnail_url ?? item?.thumbnail_url ?? '',
      _ensureLocalPromise: entry._ensureLocalPromise || null
    };
    normalized.key = this._entryKey(normalized);
    this._applyEntryAttributesToCard(normalized, card || null);
    normalized._nexusNormalized = true;
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
    entry.cachedLocalPath = localPath;
    entry.path = entry.path || localPath;
    entry.file_path = entry.file_path || localPath;
    const card = entry.card || null;
    if (!card) return;
    try {
      card._resolvedLocalPath = localPath;
      card.setAttribute('data-url', localPath);
      card.setAttribute('data-cached', 'true');
      const statusIcon = card.querySelector?.('.fa-nexus-status-icon');
      if (statusIcon) {
        statusIcon.classList.remove('cloud-plus', 'cloud', 'premium');
        statusIcon.classList.add('cloud', 'cached');
        statusIcon.title = 'Downloaded';
        statusIcon.innerHTML = '<i class="fas fa-cloud-check"></i>';
      }
      card.classList.remove('locked-token');
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
        card.setAttribute('data-url', entry.cachedLocalPath);
        card.setAttribute('data-cached', 'true');
        card._resolvedLocalPath = entry.cachedLocalPath;
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
        ui.notifications?.error?.(`Failed to start token placement: ${error?.message || error}`);
        this.cancelPlacement('error');
      }
      return;
    }

    if (!payload) {
      if (initial) this.cancelPlacement('error');
      return;
    }

    payload.url = this._resolveCurrentUrl(card, payload);
    const autoAllowed = !this._placeAsUserModified;
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
          ui.notifications?.error?.(`Failed to download token asset: ${error?.message || error}`);
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
    const gridSnapEnabled = !!game.settings.get('fa-nexus', 'gridSnap');
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
        if (!setting || setting.namespace !== 'fa-nexus' || setting.key !== 'gridSnap') return;
        this._handleGridSnapChanged(!!setting.value);
      };
      try { hooks.on('updateSetting', this._settingsHook); } catch (_) { this._settingsHook = null; }
    }
    if (!this._gridSnapHook) {
      this._gridSnapHook = (enabled) => this._handleGridSnapChanged(!!enabled);
      try { hooks.on('fa-nexus:gridSnapChanged', this._gridSnapHook); } catch (_) { this._gridSnapHook = null; }
    }
  }

  _handleGridSnapChanged(enabled) {
    if (!this.isPlacementActive) return;
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
        'Shift - Sticky placement; ESC to cancel.',
        'Ctrl/Cmd+Wheel rotates the token (Shift slows).',
      ]
    };
    state.rotation = this._buildRotationToolState();
    state.flip = this._buildFlipToolState();
    const placeAs = this._buildPlaceAsUIState();
    if (placeAs) state.placeAs = placeAs;
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
    const strength = Math.max(0, Math.min(180, Number(this._rotationRandomStrength) || 0));
    const randomToggleOn = !!this._rotationRandomEnabled;
    const randomActive = this._hasRandomRotationEnabled();
    const baseDisplay = `${Math.round(base)}°`;
    const previewDisplay = `${Math.round(preview)}°`;
    return {
      available: true,
      min: 0,
      max: 359,
      step: 1,
      value: base,
      display: randomActive ? `${previewDisplay} preview` : baseDisplay,
      randomEnabled: randomToggleOn,
      strength,
      strengthMin: 0,
      strengthMax: 180,
      strengthStep: 1,
      strengthDisplay: `±${Math.round(strength)}°`,
      randomLabel: randomToggleOn ? 'Random On' : 'Random',
      randomTooltip: randomToggleOn ? 'Disable random rotation' : 'Enable random rotation',
      randomHint: 'Random rotation offsets each placement within the selected strength.'
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
    return {
      available: true,
      display: randomActive ? `${previewSummary} preview` : baseSummary,
      previewDisplay: previewMatches ? '' : `Preview: ${previewSummary}`,
      randomHint: 'Mirror Image applies per-axis. Random toggles choose a fresh horizontal/vertical mirror on each placement.',
      horizontal: {
        active: base.horizontal,
        pending: pending.horizontal,
        label: 'Flip H',
        tooltip: 'Mirror token left/right.',
        previewDiff: horizontalPreviewDiff,
        aria: 'Toggle horizontal mirroring',
        disabled: false,
        randomEnabled: horizontalRandomEnabled,
        randomLabel: horizontalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: horizontalRandomEnabled ? 'Disable random horizontal mirror' : 'Enable random horizontal mirror',
        randomDisabled: false,
        randomAria: 'Toggle random horizontal mirroring',
        randomPreviewDiff: horizontalRandomEnabled && horizontalPreviewDiff
      },
      vertical: {
        active: base.vertical,
        pending: pending.vertical,
        label: 'Flip V',
        tooltip: 'Mirror token up/down.',
        previewDiff: verticalPreviewDiff,
        aria: 'Toggle vertical mirroring',
        disabled: false,
        randomEnabled: verticalRandomEnabled,
        randomLabel: verticalRandomEnabled ? 'Random On' : 'Random',
        randomTooltip: verticalRandomEnabled ? 'Disable random vertical mirror' : 'Enable random vertical mirror',
        randomDisabled: false,
        randomAria: 'Toggle random vertical mirroring',
        randomPreviewDiff: verticalRandomEnabled && verticalPreviewDiff
      }
    };
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
    if (next && (!Number.isFinite(this._rotationRandomStrength) || this._rotationRandomStrength <= 0)) {
      this._rotationRandomStrength = 45;
    }
    this._updateRotationPreview({ regenerateOffset: next, clampOffset: true });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _handleRotationRandomStrength(value) {
    const numeric = Number(value);
    const clamped = Number.isFinite(numeric) ? Math.min(180, Math.max(0, numeric)) : 0;
    this._rotationRandomStrength = clamped;
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

  _syncToolOptionsState({ suppressRender = true } = {}) {
    try {
      toolOptionsController.setToolOptions('token.placement', {
        state: this._buildToolOptionsState(),
        handlers: {
          togglePlaceAsOpen: (value) => this._togglePlaceAsOpen(value),
          setPlaceAsSearch: (value) => this._setPlaceAsSearch(value),
          selectPlaceAsOption: (id) => this._selectPlaceAsOption(id),
          setPlaceAsLinked: (value) => this._setPlaceAsLinked(value),
          setPlaceAsHpMode: (mode) => this._setPlaceAsHpMode(mode),
          setPlaceAsHpPercent: (value) => this._setPlaceAsHpPercent(value),
          setPlaceAsHpStatic: (value) => this._setPlaceAsHpStatic(value),
          toggleFlipHorizontal: () => this._handleFlipHorizontalToggle(),
          toggleFlipVertical: () => this._handleFlipVerticalToggle(),
          toggleFlipHorizontalRandom: () => this._handleFlipRandomHorizontalToggle(),
          toggleFlipVerticalRandom: () => this._handleFlipRandomVerticalToggle(),
          setRotation: (value) => this._handleRotationSliderInput(value),
          toggleRotationRandom: () => this._handleRotationRandomToggle(),
          setRotationRandomStrength: (value) => this._handleRotationRandomStrength(value)
        },
        suppressRender
      });
    } catch (_) {}
  }

  _ensureActorOptionsLoaded() {
    if (!globalThis?.game) return null;
    if (this._placeAsRefreshPromise) return this._placeAsRefreshPromise;
    if (this._placeAsOptions.length) return null;
    return this._refreshActorOptions({ includeCompendium: true });
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
      this._placeAsActorHooksInstalled = true;
    } catch (error) {
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
      this._placeAsWorldOptions = worldOptions;
      this._placeAsOptions = worldOptions.concat(this._placeAsCompendiumOptions || []);
      this._rebuildPlaceAsOptionMap();
      this._syncPlaceAsSelection();
      this._refreshPlaceAsSuggestions({ autoSelect: true });
      this._syncToolOptionsState({ suppressRender: false });

      if (!includeCompendium) return;

      this._placeAsLoading = true;
      this._syncToolOptionsState({ suppressRender: false });

      try {
        const compOptions = await this._collectCompendiumActorOptions();
        this._placeAsCompendiumOptions = compOptions;
        this._placeAsLoadError = null;
      } catch (error) {
        this._placeAsLoadError = error?.message || String(error);
        Logger.warn('TokenPlacement.placeAs.compendiumLoadFailed', { error: this._placeAsLoadError });
      } finally {
        this._placeAsLoading = false;
      }

      this._placeAsOptions = this._placeAsWorldOptions.concat(this._placeAsCompendiumOptions || []);
      this._rebuildPlaceAsOptionMap();
      this._syncPlaceAsSelection();
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
    this._placeAsOptionMap.clear();
    for (const option of this._placeAsOptions) {
      if (!option || !option.id) continue;
      this._placeAsOptionMap.set(option.id, option);
    }
    if (this._placeAsSelectedOption) {
      const replacement = this._placeAsOptionMap.get(this._placeAsSelectedOption.id);
      if (replacement) this._placeAsSelectedOption = replacement;
    }
  }

  _syncPlaceAsSelection() {
    if (this._placeAsSelectionId !== DEFAULT_PLACE_AS_SELECTION && !this._placeAsOptionMap.has(this._placeAsSelectionId)) {
      this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
      this._placeAsLinked = false;
    }
  }

  _togglePlaceAsOpen(value) {
    if (typeof value === 'boolean') return this._setPlaceAsOpen(value);
    return this._setPlaceAsOpen(!this._placeAsOpen);
  }

  _setPlaceAsOpen(value) {
    const next = !!value;
    if (next) this._ensureActorOptionsLoaded();
    const wasOpen = !!this._placeAsOpen;
    if (wasOpen === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._placeAsOpen = next;
    if (!next && this._placeAsSearch) {
      this._placeAsSearch = '';
    }
    if (next) this._refreshPlaceAsSuggestions({ autoSelect: false });
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _normalizeMatchString(value) {
    if (!value) return '';
    return String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  _tokenizeMatchString(value) {
    const normalized = this._normalizeMatchString(value);
    if (!normalized) return [];
    return normalized.split(' ');
  }

  _buildMatchTokens(...values) {
    const tokens = new Set();
    for (const value of values) {
      if (!value) continue;
      const parts = this._tokenizeMatchString(value);
      for (const part of parts) {
        if (part) tokens.add(part);
      }
    }
    return Array.from(tokens);
  }

  _stripFileExtension(value) {
    if (!value) return '';
    return String(value).replace(/\.[^./\\]+$/, '');
  }

  _derivePlaceAsMatchKey(payload, card) {
    const displayName = payload?.displayName || card?.getAttribute?.('data-display-name') || '';
    const filename = payload?.filename || card?.getAttribute?.('data-filename') || '';
    const variant = payload?.variant_group || payload?.variantGroup || '';
    const fileStem = this._stripFileExtension(filename).replace(/[_-]+/g, ' ');
    const baseName = displayName || fileStem || filename || variant || '';
    const tokens = this._buildMatchTokens(displayName, fileStem, filename, variant);
    const normalized = this._normalizeMatchString(baseName);
    return {
      raw: baseName,
      normalized,
      tokens
    };
  }

  _scorePlaceAsOption(option, { tokens = [], normalized = '' } = {}) {
    if (!option) return 0;
    const optionTokens = option.matchTokens && option.matchTokens.length
      ? option.matchTokens
      : this._tokenizeMatchString(option.label);
    const optionNormalized = option.matchNormalized || this._normalizeMatchString(option.label);
    const tokenSet = new Set(optionTokens);
    let score = 0;

    if (normalized) {
      if (optionNormalized === normalized) score += 50;
      else if (optionNormalized.startsWith(normalized) && normalized.length >= 3) score += 20;
      else if (normalized.startsWith(optionNormalized) && optionNormalized.length >= 3) score += 12;
      else if (optionNormalized.includes(normalized) && normalized.length >= 3) score += 10;
    }

    let matchCount = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (tokenSet.has(token)) {
        matchCount += 1;
        score += 12;
      } else if (optionNormalized.includes(token)) {
        matchCount += 0.5;
        score += 6;
      }
      const sourceTokens = option.sourceTokens;
      if (sourceTokens && sourceTokens.includes(token)) score += 3;
      const packTokens = option.packTokens;
      if (packTokens && packTokens.includes(token)) score += 2;
    }

    if (tokens.length && matchCount >= tokens.length) score += 8;

    if (tokens.length) {
      const diff = Math.abs(optionTokens.length - tokens.length);
      score -= diff * 1.5;
    }

    if (option.type === 'world') score += 2;

    if (normalized && option.sourceNormalized && option.sourceNormalized.includes(normalized)) {
      score += 4;
    }

    return Math.max(score, 0);
  }

  _rankPlaceAsOptions({ tokens = [], normalized = '', includeCompendium = true, limit = MAX_PLACE_AS_SUGGESTIONS, allowZero = false } = {}) {
    const candidates = [...this._placeAsWorldOptions];
    if (includeCompendium) candidates.push(...this._placeAsCompendiumOptions);
    const results = new Map();

    candidates.forEach((option, index) => {
      const score = this._scorePlaceAsOption(option, { tokens, normalized });
      if (score <= 0 && !allowZero) return;
      const existing = results.get(option.id);
      if (existing) {
        if (score > existing.score) {
          existing.score = score;
          existing.order = index;
        }
        return;
      }
      results.set(option.id, {
        option,
        score,
        rank: option.type === 'world' ? 0 : 1,
        order: index
      });
    });

    let ranked = Array.from(results.values());

    if (allowZero && ranked.length < limit) {
      const seen = new Set(ranked.map((entry) => entry.option.id));
      for (let i = 0; i < candidates.length && ranked.length < limit; i += 1) {
        const option = candidates[i];
        if (!option || seen.has(option.id)) continue;
        ranked.push({
          option,
          score: 0,
          rank: option.type === 'world' ? 0 : 1,
          order: ranked.length + i
        });
        seen.add(option.id);
      }
    }

    ranked.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.rank !== b.rank) return a.rank - b.rank;
      const aSort = a.option.sort || '';
      const bSort = b.option.sort || '';
      if (aSort !== bSort) return aSort.localeCompare(bSort);
      return a.order - b.order;
    });

    return ranked.slice(0, limit);
  }

  _refreshPlaceAsSuggestions({ autoSelect = false } = {}) {
    const tokens = Array.isArray(this._placeAsMatchTokens) ? this._placeAsMatchTokens : [];
    const normalized = this._placeAsMatchNormalized || '';
    const allowZero = !tokens.length;
    this._placeAsSuggestions = this._rankPlaceAsOptions({
      tokens,
      normalized,
      includeCompendium: true,
      limit: MAX_PLACE_AS_SUGGESTIONS,
      allowZero
    });
    if (autoSelect) this._autoSelectPlaceAsFromSuggestions();
  }

  _autoSelectPlaceAsFromSuggestions() {
    if (this._placeAsUserModified) return;
    const suggestions = this._placeAsSuggestions || [];
    if (!suggestions.length) {
      if (this._placeAsSelectionAuto && this._placeAsSelectionId !== DEFAULT_PLACE_AS_SELECTION) {
        this._selectPlaceAsOption(DEFAULT_PLACE_AS_SELECTION, { user: false, auto: false });
      }
      this._placeAsSelectionAuto = false;
      return;
    }
    const top = suggestions[0];
    if (!top || top.score < MIN_AUTO_PLACE_AS_SCORE) {
      if (this._placeAsSelectionAuto && this._placeAsSelectionId !== DEFAULT_PLACE_AS_SELECTION) {
        this._selectPlaceAsOption(DEFAULT_PLACE_AS_SELECTION, { user: false, auto: false });
      }
      this._placeAsSelectionAuto = false;
      return;
    }
    if (this._placeAsSelectionId !== DEFAULT_PLACE_AS_SELECTION && !this._placeAsSelectionAuto) return;
    if (this._placeAsSelectionId === top.option.id) {
      this._placeAsSelectionAuto = true;
      return;
    }
    this._selectPlaceAsOption(top.option.id, { user: false, auto: true, option: top.option });
  }

  _applyPlaceAsMatchContext(payload, card, { resetContext = false, autoSelect = true } = {}) {
    const derived = this._derivePlaceAsMatchKey(payload, card);
    this._placeAsMatchRaw = derived.raw || '';
    this._placeAsMatchNormalized = derived.normalized || '';
    this._placeAsMatchTokens = Array.isArray(derived.tokens) ? derived.tokens : [];
    if (resetContext) {
      this._placeAsUserModified = false;
      this._placeAsSelectionAuto = false;
      this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
      this._placeAsLinked = false;
      this._placeAsSelectedOption = null;
    }
    this._refreshPlaceAsSuggestions({ autoSelect });
  }

  _composePlaceAsDisplayList() {
    const list = [];
    const defaultSelected = this._placeAsSelectionId === DEFAULT_PLACE_AS_SELECTION;
    list.push({
      isHeader: false,
      id: DEFAULT_PLACE_AS_SELECTION,
      label: 'Create new basic actor',
      subtitle: 'Creates a new actor for each placement.',
      type: 'default',
      selected: defaultSelected
    });
    const addedIds = new Set([DEFAULT_PLACE_AS_SELECTION]);

    const queryNormalized = this._normalizeMatchString(this._placeAsSearch);
    const queryTokens = queryNormalized ? queryNormalized.split(' ').filter(Boolean) : [];

    if (queryTokens.length) {
      let ranked = this._rankPlaceAsOptions({
        tokens: queryTokens,
        normalized: queryNormalized,
        includeCompendium: true,
        limit: MAX_PLACE_AS_RESULTS,
        allowZero: false
      });
      if (!ranked.length) {
        ranked = this._rankPlaceAsOptions({
          tokens: queryTokens,
          normalized: queryNormalized,
          includeCompendium: true,
          limit: MAX_PLACE_AS_RESULTS,
          allowZero: true
        });
      }
      for (const entry of ranked) {
        if (!entry?.option) continue;
        if (addedIds.has(entry.option.id)) continue;
        list.push(this._formatPlaceAsOption(entry.option));
        addedIds.add(entry.option.id);
      }
      return list;
    }

    const suggestions = (this._placeAsSuggestions || []).map((entry) => entry.option).filter(Boolean);
    if (suggestions.length) {
      list.push({ isHeader: true, label: 'Suggested Matches' });
      for (const option of suggestions) {
        if (addedIds.has(option.id)) continue;
        list.push(this._formatPlaceAsOption(option));
        addedIds.add(option.id);
      }
    }

    const existingNonDefault = list.filter((entry) => !entry.isHeader && entry.id !== DEFAULT_PLACE_AS_SELECTION).length;
    const remainingSlots = Math.max(0, MAX_PLACE_AS_RESULTS - existingNonDefault);
    if (remainingSlots > 0 && this._placeAsWorldOptions.length) {
      const worldOptions = this._placeAsWorldOptions
        .filter((option) => !addedIds.has(option.id))
        .slice(0, remainingSlots);
      if (worldOptions.length) {
        list.push({ isHeader: true, label: 'All World Actors' });
        for (const option of worldOptions) {
          list.push(this._formatPlaceAsOption(option));
          addedIds.add(option.id);
        }
      }
    }

    return list;
  }

  _formatPlaceAsOption(option) {
    return {
      isHeader: false,
      id: option.id,
      label: option.label,
      subtitle: this._formatPlaceAsSubtitle(option),
      type: option.type,
      selected: this._placeAsSelectionId === option.id
    };
  }

  _formatPlaceAsSubtitle(option) {
    if (!option) return '';
    if (option.type === 'world') {
      return option.source ? option.source : 'World Actor';
    }
    if (option.type === 'compendium') {
      return option.source ? `Compendium • ${option.source}` : 'Compendium Actor';
    }
    return 'Default';
  }

  _buildPlaceAsUIState() {
    const options = this._composePlaceAsDisplayList();
    const selection = this._getActivePlaceAsSelection();
    const hpState = this._buildHpUIState(selection);
    const isFiltered = (this._placeAsSearch || '').trim().length > 0;
    const selectedLabel = (() => {
      if (selection.mode === 'actor' && selection.option) {
        return selection.option.label || 'Unnamed Actor';
      }
      return 'Create new basic actor';
    })();
    const actorSubtitle = (() => {
      if (selection.mode === 'actor' && selection.option) {
        return this._formatPlaceAsSubtitle(selection.option);
      }
      return 'Creates a new actor for each placement.';
    })();
    const selectedSubtitle = (() => {
      const parts = [];
      if (actorSubtitle) parts.push(actorSubtitle);
      if (hpState?.summary) parts.push(hpState.summary);
      return parts.join(' • ');
    })();
    const hasSelectableOptions = options.some((entry) => !entry.isHeader && entry.id !== DEFAULT_PLACE_AS_SELECTION);
    const emptyMessage = (() => {
      if (!this._placeAsOpen) return '';
      if (this._placeAsLoading) return 'Loading actors…';
      if (isFiltered) return hasSelectableOptions ? '' : 'No actors match your search.';
      return hasSelectableOptions ? '' : 'No world actors available. Create or import actors to reuse them.';
    })();
    const linkedDisabled = this._placeAsSelectionId === DEFAULT_PLACE_AS_SELECTION;
    return {
      available: true,
      open: !!this._placeAsOpen,
      searchValue: this._placeAsSearch,
      options,
      hasOptions: options.some((entry) => !entry.isHeader),
      isLoading: !!this._placeAsLoading,
      loadError: this._placeAsLoadError || '',
      linked: !linkedDisabled && !!this._placeAsLinked,
      linkedDisabled,
      linkedLabel: 'Link placed tokens to actor',
      linkedTooltip: linkedDisabled
        ? 'Select an actor to enable linked placement.'
        : 'Linked tokens reuse the actor sheet and update the prototype.',
      emptyMessage,
      isFiltered,
      selectedId: this._placeAsSelectionId,
      selectedLabel,
      selectedSubtitle,
      hasSelectableOptions,
      hp: hpState
    };
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
    const id = this._placeAsSelectionId;
    if (!id || id === DEFAULT_PLACE_AS_SELECTION) return { mode: 'new' };
    const option = this._placeAsOptionMap.get(id) || this._placeAsSelectedOption;
    if (!option) return { mode: 'new' };
    return {
      mode: 'actor',
      option,
      linked: !!this._placeAsLinked
    };
  }

  _setPlaceAsSearch(value) {
    const next = typeof value === 'string' ? value.slice(0, 120) : '';
    if (this._placeAsSearch === next) {
      this._syncToolOptionsState();
      return true;
    }
    this._placeAsUserModified = true;
    this._placeAsSelectionAuto = false;
    this._placeAsSearch = next;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _selectPlaceAsOption(optionId, { user = true, auto = false, option = null } = {}) {
    const id = typeof optionId === 'string' && optionId.length ? optionId : DEFAULT_PLACE_AS_SELECTION;
    if (user) {
      this._placeAsUserModified = true;
      this._placeAsSelectionAuto = false;
    } else if (auto) {
      this._placeAsUserModified = false;
      this._placeAsSelectionAuto = true;
    }
    if (id === DEFAULT_PLACE_AS_SELECTION) {
      this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
      this._placeAsLinked = false;
      this._placeAsOpen = false;
      this._placeAsSearch = '';
      this._placeAsSelectedOption = null;
      if (!auto) this._placeAsSelectionAuto = false;
      this._syncToolOptionsState({ suppressRender: false });
      return true;
    }
    let resolvedOption = option || this._placeAsOptionMap.get(id);
    if (!resolvedOption && Array.isArray(this._placeAsSuggestions)) {
      const entry = this._placeAsSuggestions.find((suggestion) => suggestion?.option?.id === id);
      if (entry?.option) resolvedOption = entry.option;
    }
    if (!resolvedOption) {
      this._syncPlaceAsSelection();
      this._syncToolOptionsState({ suppressRender: false });
      return false;
    }
    if (this._placeAsSelectionId === id) {
      this._placeAsOpen = false;
      this._syncToolOptionsState({ suppressRender: false });
      return true;
    }
    this._placeAsSelectionId = id;
    this._placeAsOpen = false;
    this._placeAsSearch = '';
    this._placeAsSelectedOption = resolvedOption;
    this._syncToolOptionsState({ suppressRender: false });
    return true;
  }

  _setPlaceAsLinked(value, { user = true } = {}) {
    const canLink = this._placeAsSelectionId !== DEFAULT_PLACE_AS_SELECTION;
    const next = !!value && canLink;
    if (this._placeAsLinked === next) {
      this._syncToolOptionsState();
      return true;
    }
    if (user) {
      this._placeAsUserModified = true;
      this._placeAsSelectionAuto = false;
    }
    this._placeAsLinked = next;
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
    this._placeAsOptionMap.delete(optionId);
    this._placeAsWorldOptions = this._placeAsWorldOptions.filter((option) => option.id !== optionId);
    this._placeAsOptions = this._placeAsOptions.filter((option) => option.id !== optionId);
    if (this._placeAsSelectionId === optionId) {
      this._placeAsSelectionId = DEFAULT_PLACE_AS_SELECTION;
      this._placeAsLinked = false;
    }
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
    if (shouldUpdatePrototype) {
      try {
        await ActorFactory.updateActorPrototypeToken(actor, dragData, { updateActorImage: true });
      } catch (error) {
        Logger.warn('TokenPlacement.placeAs.updatePrototypeFailed', { error: String(error?.message || error) });
      }
    }

    const linked = !!selection?.linked;
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
    if (!actor || !drop?.world) throw new Error('Missing placement context');
    const tokenSize = dragData?.tokenSize || { gridWidth: 1, gridHeight: 1, scale: 1 };
    let tokenProto = null;
    if (typeof ActorFactory._buildTokenData === 'function') {
      try {
        tokenProto = ActorFactory._buildTokenData(dragData) || null;
      } catch (_) {
        tokenProto = null;
      }
    }
    if (!tokenProto) {
      const width = Number(tokenSize.gridWidth || 1) || 1;
      const height = Number(tokenSize.gridHeight || 1) || 1;
      const scale = Number(tokenSize.scale || 1) || 1;
      tokenProto = {
        width,
        height,
        texture: {
          src: dragData?.url || actor.prototypeToken?.texture?.src || '',
          scaleX: scale * (dragData?.mirrorX ? -1 : 1),
          scaleY: scale * (dragData?.mirrorY ? -1 : 1),
          fit: 'contain'
        }
      };
    }

    const gridSize = canvas?.grid?.size || 100;
    const tokenWidthPx = Number(tokenProto.width || 1) * gridSize;
    const tokenHeightPx = Number(tokenProto.height || 1) * gridSize;
    const rotation = Number.isFinite(dragData?.rotation) ? Number(dragData.rotation) : 0;
    const world = drop.world;
    const x = world.x - tokenWidthPx / 2;
    const y = world.y - tokenHeightPx / 2;

    let protoData = {};
    try {
      protoData = actor.prototypeToken?.toObject?.() ?? foundry?.utils?.deepClone?.(actor.prototypeToken ?? {}) ?? {};
    } catch (_) {
      protoData = {};
    }

    const utils = foundry?.utils;
    const protoScaleX = Number(tokenProto?.texture?.scaleX ?? tokenSize.scale ?? 1) || 1;
    const protoScaleY = Number(tokenProto?.texture?.scaleY ?? tokenSize.scale ?? 1) || 1;
    const protoMirrorX = tokenProto?.mirrorX ?? (protoScaleX < 0);
    const protoMirrorY = tokenProto?.mirrorY ?? (protoScaleY < 0);
    const baseScaleX = Math.abs(protoScaleX);
    const baseScaleY = Math.abs(protoScaleY);
    const requestMirrorX = dragData?.mirrorX !== undefined
      ? !!dragData.mirrorX
      : (protoMirrorX || (protoData?.texture?.scaleX ?? 1) < 0 || !!protoData?.mirrorX);
    const requestMirrorY = dragData?.mirrorY !== undefined
      ? !!dragData.mirrorY
      : (protoMirrorY || (protoData?.texture?.scaleY ?? 1) < 0 || !!protoData?.mirrorY);
    const appliedScaleX = baseScaleX * (requestMirrorX ? -1 : 1);
    const appliedScaleY = baseScaleY * (requestMirrorY ? -1 : 1);

    const baseData = {
      name: actor.name,
      actorId: actor.id,
      actorLink: !!linked,
      x,
      y,
      width: Number(tokenProto.width || 1) || 1,
      height: Number(tokenProto.height || 1) || 1,
      rotation,
      lockRotation: false,
      randomImg: false,
      texture: {
        ...(protoData.texture || {}),
        src: dragData?.url || protoData.texture?.src || '',
        scaleX: appliedScaleX,
        scaleY: appliedScaleY,
        fit: tokenProto.texture?.fit || protoData.texture?.fit || 'contain'
      },
      flags: {
        ...(protoData.flags || {}),
        'fa-nexus': {
          ...(protoData.flags?.['fa-nexus'] || {}),
          customScale: true,
          originalScale: baseScaleX
        }
      }
    };

    let merged = baseData;
    if (utils?.mergeObject) {
      try {
        merged = utils.mergeObject(protoData || {}, baseData, { inplace: false, overwrite: true, recursive: true });
      } catch (_) {
        merged = baseData;
      }
    }

    try { delete merged._id; } catch (_) {}
    merged.actorId = actor.id;
    merged.actorLink = !!linked;
    merged.randomImg = false;
    if (hpOverride && !linked) {
      this._applyHpOverrideToTokenData(merged, hpOverride);
    }

    const tokenDoc = await TokenDocument.create(merged, { parent: canvas.scene });
    if (dragData?.mirrorX !== undefined || dragData?.mirrorY !== undefined) {
      try {
        await tokenDoc.update({
          'texture.scaleX': appliedScaleX,
          'texture.scaleY': appliedScaleY
        }, { animate: false });
      } catch (_) {}
    }
    await this._applySystemScaleFixes(tokenDoc, {
      appliedScaleX,
      appliedScaleY,
      baseScaleX
    });
    return tokenDoc;
  }

  async _applySystemScaleFixes(tokenDoc, { appliedScaleX, appliedScaleY, baseScaleX }) {
    const systemId = SystemDetection.getCurrentSystemId?.();
    if (!systemId || !tokenDoc) return;
    try {
      if (systemId === 'pf2e') {
        await tokenDoc.update({
          'texture.scaleX': appliedScaleX,
          'texture.scaleY': appliedScaleY,
          'flags.pf2e.linkToActorSize': false,
          'flags.fa-nexus.customScale': true,
          'flags.fa-nexus.originalScale': baseScaleX
        }, { animate: false });
      } else if (systemId === 'dsa5') {
        setTimeout(async () => {
          try {
            await tokenDoc.update({
              'texture.scaleX': appliedScaleX,
              'texture.scaleY': appliedScaleY
            }, { animate: false });
          } catch (_) {}
        }, 50);
      }
    } catch (_) {}
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

      if (applyToActor && actor?.update) {
        const payload = {};
        payload[valuePath] = hpOverride.value;
        payload[maxPath] = hpOverride.max;
        updatePromises.push(actor.update(payload, updateOptions));
      }

      const tokenIsLinked = tokenDoc?.actorLink ?? tokenDoc?.data?.actorLink ?? tokenDoc?._source?.actorLink;
      if (tokenDoc?.update && tokenIsLinked === false) {
        const payload = {};
        payload[`actorData.${valuePath}`] = hpOverride.value;
        payload[`actorData.${maxPath}`] = hpOverride.max;
        updatePromises.push(tokenDoc.update(payload, {
          ...updateOptions,
          render: false,
          diff: false,
          faNexusSuppressFloaty: true
        }));
      }

      const tokenActor = tokenDoc?.actor;
      if (tokenActor && tokenActor !== actor && tokenActor.update) {
        const payload = {};
        payload[valuePath] = hpOverride.value;
        payload[maxPath] = hpOverride.max;
        updatePromises.push(tokenActor.update(payload, {
          ...updateOptions,
          render: false,
          diff: false,
          faNexusSuppressFloaty: true
        }));
      }

      if (updatePromises.length) {
        await Promise.allSettled(updatePromises);
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

  _applyHpOverrideToTokenData(target, override) {
    if (!target || !override) return false;
    const utils = foundry?.utils;
    const hpPath = override.path || 'system.attributes.hp';
    const valuePath = `actorData.${hpPath}.value`;
    const maxPath = `actorData.${hpPath}.max`;
    try {
      if (utils?.setProperty) {
        utils.setProperty(target, valuePath, override.value);
        utils.setProperty(target, maxPath, override.max);
        return true;
      }
    } catch (error) {
      Logger.warn('TokenPlacement.hp.injectFailed', { error: String(error?.message || error) });
    }
    // Fallback manual assignment
    const ensure = (obj, pathParts) => {
      let cursor = obj;
      for (let i = 0; i < pathParts.length - 1; i += 1) {
        const key = pathParts[i];
        if (cursor[key] === undefined || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key];
      }
      return cursor;
    };
    const apply = (path, value) => {
      const parts = String(path).split('.').filter((part) => part.length);
      if (!parts.length) return;
      const leafParent = ensure(target, parts);
      const leafKey = parts[parts.length - 1];
      leafParent[leafKey] = value;
    };
    apply(valuePath, override.value);
    apply(maxPath, override.max);
    return true;
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
    const RollClass = foundry?.dice?.Roll || globalThis?.Roll || globalThis?.CONFIG?.Dice?.Roll;
    if (typeof RollClass !== 'function') {
      Logger.warn('TokenPlacement.hp.rollUnavailable', { formula });
      return { success: false };
    }
    try {
      let roll = new RollClass(formula);
      let evaluated = false;

      if (typeof roll.evaluate === 'function') {
        try {
          const result = roll.evaluate({});
          if (result?.then) await result;
          evaluated = true;
        } catch (compatError) {
          // Recreate the roll and try legacy async option for older core versions.
          roll = new RollClass(formula);
          try {
            const legacyResult = roll.evaluate({ async: true });
            if (legacyResult?.then) await legacyResult;
            evaluated = true;
          } catch (_) {
            throw compatError;
          }
        }
      }
      if (!evaluated && typeof roll.evaluateSync === 'function') {
        roll.evaluateSync({});
        evaluated = true;
      }
      if (!evaluated && typeof roll.roll === 'function') {
        const legacy = roll.roll({});
        if (legacy?.then) await legacy;
        evaluated = true;
      }
      if (!evaluated) {
        throw new Error('Unable to evaluate roll formula.');
      }

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
    const gridSnapEnabled = !!game.settings.get('fa-nexus', 'gridSnap');
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
      ? 'Token placement: click to place, wheel zooms to cursor, Ctrl+Wheel rotates, hold Shift to keep placing, press ESC to cancel.'
      : 'Token placement: click to place, wheel zooms to cursor, Ctrl+Wheel rotates, hold Shift to keep placing, press ESC to cancel.';
    announceChange('token-placement-start', message, { level: 'info', throttleMs: 500 });
  }
}
