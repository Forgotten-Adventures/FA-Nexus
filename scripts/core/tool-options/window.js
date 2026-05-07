import { GRID_SNAP_SUBDIV_DEFAULT } from '../grid-snap-utils.js';
import {
  DEFAULT_WINDOW_TITLE,
  MODULE_ID,
  TOOL_WINDOW_SETTING_KEY
} from './shared.js';
import { installToolOptionsWindowControlMethods } from './window-control-methods.js';
import { installToolOptionsWindowPersistenceMethods } from './window-persistence-methods.js';
import { installToolOptionsWindowRenderMethods } from './window-render-methods.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * ToolOptionsWindow
 * Lightweight application shell that reflects the currently active canvas tool.
 */
export class ToolOptionsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-tool-options',
    tag: 'section',
    position: { width: 320, height: 400 },
    window: {
      resizable: true,
      minimizable: true,
      title: DEFAULT_WINDOW_TITLE
    }
  };

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-options.hbs' }
    },
    { inplace: false }
  );

  constructor({
    controller,
    gridSnapEnabled = true,
    gridSnapAvailable = true,
    gridSnapSubdivisions = GRID_SNAP_SUBDIV_DEFAULT,
    toolOptions = {}
  } = {}) {
    super();
    this._controller = controller;
    this._activeTool = null;
    this._restoringPosition = false;
    this._gridSnapEnabled = !!gridSnapEnabled;
    this._gridSnapAvailable = !!gridSnapAvailable;
    this._gridSnapSubdivisions = this._normalizeGridSnapSubdivision(gridSnapSubdivisions);
    this._gridSnapToggle = null;
    this._gridSnapResolutionRoot = null;
    this._gridSnapResolutionSlider = null;
    this._gridSnapResolutionDisplay = null;
    this._boundGridSnapChange = (event) => this._handleGridSnapChange(event);
    this._boundGridSnapResolutionInput = (event) => this._handleGridSnapResolutionInput(event, false);
    this._boundGridSnapResolutionCommit = (event) => this._handleGridSnapResolutionInput(event, true);
    this._toolOptionState = toolOptions && typeof toolOptions === 'object' ? toolOptions : {};
    this._activeNormalizedOptions = null;
    this._dropShadowToggle = null;
    this._dropShadowControlId = '';
    this._boundDropShadowChange = (event) => this._handleDropShadowChange(event);
    this._dropShadowRoot = null;
    this._dropShadowScaleSlider = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowPreviewRoot = null;
    this._dropShadowPreviewImage = null;
    this._dropShadowOffsetMaxDistance = 40;
    this._dropShadowOffsetPointerId = null;
    this._dropShadowOffsetPointerActive = false;
    this._dropShadowScaleDisplay = null;
    this._dropShadowAlphaDisplay = null;
    this._resizeObserver = null;
    this._resizeObserverFrame = null;
    this._userResizing = false;
    this._savedHeight = null;
    this._boundResizeObserverStart = (event) => this._handleResizeObserverStart(event);
    this._boundResizeObserverEnd = () => this._handleResizeObserverEnd();
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowOffsetMaxDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
    this._dropShadowEditRoot = null;
    this._dropShadowEditToggle = null;
    this._dropShadowEditResetButton = null;
    this._dropShadowOnlyRoot = null;
    this._dropShadowOnlyToggle = null;
    this._dropShadowPresetsRoot = null;
    this._dropShadowPresetButtons = [];
    this._dropShadowResetButton = null;
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
    this._shortcutsCollapsed = false;
    this._shortcutsCollapsedByTool = new Map();
    this._restoreShortcutsState();
    this._boundShortcutsToggle = (event) => this._handleShortcutsToggle(event);
    this._sectionRoots = new Map();
    this._sectionToggleButtons = new Map();
    this._sectionBodies = new Map();
    this._boundSectionToggle = (event) => this._handleSectionToggle(event);
    this._portalSectionCollapsedByKey = new Map();
    this._portalControlsSyncTimer = null;
    this._helpButton = null;
    this._helpKeyRoot = null;
    this._boundHelpOpen = (event) => this._handleHelpOpen(event);
    this._boundWindowKeyDown = (event) => this._handleWindowKeyDown(event);
    this._toolPanelActivityRoot = null;
    this._toolPanelActivityActive = false;
    this._boundToolPanelPointerEnter = () => this._setToolPanelActivity(true);
    this._boundToolPanelPointerLeave = () => this._syncToolPanelActivityState();
    this._boundToolPanelFocusIn = () => this._syncToolPanelActivityState();
    this._boundToolPanelFocusOut = (event) => this._handleToolPanelFocusOut(event);
    this._boundDropShadowScaleInput = (event) => this._handleDropShadowSlider(event, 'scale', false);
    this._boundDropShadowScaleCommit = (event) => this._handleDropShadowSlider(event, 'scale', true);
    this._boundDropShadowAlphaInput = (event) => this._handleDropShadowSlider(event, 'alpha', false);
    this._boundDropShadowAlphaCommit = (event) => this._handleDropShadowSlider(event, 'alpha', true);
    this._boundDropShadowDilationInput = (event) => this._handleDropShadowSlider(event, 'dilation', false);
    this._boundDropShadowDilationCommit = (event) => this._handleDropShadowSlider(event, 'dilation', true);
    this._boundDropShadowBlurInput = (event) => this._handleDropShadowSlider(event, 'blur', false);
    this._boundDropShadowBlurCommit = (event) => this._handleDropShadowSlider(event, 'blur', true);
    this._boundDropShadowOffsetInput = (event) => this._handleDropShadowSlider(event, 'offset', false);
    this._boundDropShadowOffsetCommit = (event) => this._handleDropShadowSlider(event, 'offset', true);
    this._boundDropShadowOffsetPointerDown = (event) => this._handleDropShadowOffsetPointerDown(event);
    this._boundDropShadowOffsetPointerMove = (event) => this._handleDropShadowOffsetPointerMove(event);
    this._boundDropShadowOffsetPointerUp = (event) => this._handleDropShadowOffsetPointerUp(event);
    this._boundDropShadowOffsetContext = (event) => this._handleDropShadowOffsetContext(event);
    this._boundDropShadowOffsetMaxInput = (event) => this._handleDropShadowOffsetMaxSlider(event, false);
    this._boundDropShadowOffsetMaxCommit = (event) => this._handleDropShadowOffsetMaxSlider(event, true);
    this._boundDropShadowCollapse = (event) => this._handleDropShadowCollapse(event);
    this._boundDropShadowEditToggle = (event) => this._handleDropShadowEditToggle(event);
    this._boundDropShadowEditReset = (event) => this._handleDropShadowEditReset(event);
    this._boundDropShadowOnlyToggle = (event) => this._handleDropShadowOnlyToggle(event);
    this._boundDropShadowPresetClick = (event) => this._handleDropShadowPresetClick(event);
    this._boundDropShadowPresetContext = (event) => this._handleDropShadowPresetContext(event);
    this._boundDropShadowReset = (event) => this._handleDropShadowReset(event);
    this._boundResettableContext = (event) => this._handleResettableContext(event);
    this._customToggleBindings = new Map();
    this._declarativeSegmentedControls = new Map();
    this._declarativeToggleControls = new Map();
    this._declarativeSelectControls = new Map();
    this._declarativeRangeControls = new Map();
    this._declarativeRangePairControls = new Map();
    this._declarativeAxisPairControls = new Map();
    this._declarativeScalarRandomizedControls = new Map();
    this._declarativeStackOrderControls = new Map();
    this._resettableContextRoot = null;
    this._sliderWheelRoot = null;
    this._boundSliderWheel = (event) => this._handleSliderWheel(event);
    this._boundDeclarativeToggleChange = (event) => this._handleDeclarativeToggleChange(event);
    this._boundDeclarativeSelectChange = (event) => this._handleDeclarativeSelectChange(event);
    this._boundDeclarativeRangeInput = (event) => this._handleDeclarativeRangeInput(event, false);
    this._boundDeclarativeRangeCommit = (event) => this._handleDeclarativeRangeInput(event, true);
    this._boundDeclarativeRangeToggle = (event) => this._handleDeclarativeRangeToggle(event);
    this._boundDeclarativeRangePairInput = (event) => this._handleDeclarativeRangePairInput(event, false);
    this._boundDeclarativeRangePairCommit = (event) => this._handleDeclarativeRangePairInput(event, true);
    this._boundDeclarativeAxisPairToggle = (event) => this._handleDeclarativeAxisPairToggle(event, false);
    this._boundDeclarativeAxisPairRandomToggle = (event) => this._handleDeclarativeAxisPairToggle(event, true);
    this._boundDeclarativeScalarRandomizedInput = (event) => this._handleDeclarativeScalarRandomizedInput(event, false);
    this._boundDeclarativeScalarRandomizedCommit = (event) => this._handleDeclarativeScalarRandomizedInput(event, true);
    this._boundDeclarativeScalarRandomizedStrengthInput = (event) => this._handleDeclarativeScalarRandomizedStrength(event, false);
    this._boundDeclarativeScalarRandomizedStrengthCommit = (event) => this._handleDeclarativeScalarRandomizedStrength(event, true);
    this._boundDeclarativeScalarRandomizedMin = (event) => this._handleDeclarativeScalarRandomizedRange(event, 'min');
    this._boundDeclarativeScalarRandomizedMax = (event) => this._handleDeclarativeScalarRandomizedRange(event, 'max');
    this._boundDeclarativeScalarRandomizedRandom = (event) => this._handleDeclarativeScalarRandomizedRandom(event);
    this._boundDeclarativeStackOrderTop = (event) => this._handleDeclarativeStackOrderAction(event, 'top');
    this._boundDeclarativeStackOrderBottom = (event) => this._handleDeclarativeStackOrderAction(event, 'bottom');
    this._boundDeclarativeSegmentedChange = (event) => this._handleDeclarativeSegmentedChange(event);
    this._placementRoot = null;
    this._placementPushTopButton = null;
    this._placementPushBottomButton = null;
    this._placementOrderDisplay = null;
    this._placementHint = null;
    this._placementStateLabels = [];
    this._placementSwitchRoots = [];
    this._boundPlacementPushTop = (event) => this._handlePlacementPush(event, 'top');
    this._boundPlacementPushBottom = (event) => this._handlePlacementPush(event, 'bottom');
    this._declarativeActionRows = new Map();
    this._boundEditorActionClick = (event) => this._handleEditorActionClick(event);
    this._pathOpacityRoot = null;
    this._pathOpacitySlider = null;
    this._pathOpacityDisplay = null;
    this._boundPathOpacityInput = (event) => this._handlePathOpacity(event, false);
    this._boundPathOpacityCommit = (event) => this._handlePathOpacity(event, true);
    this._pathScaleRoot = null;
    this._pathScaleSlider = null;
    this._pathScaleDisplay = null;
    this._boundPathScaleInput = (event) => this._handlePathScale(event, false);
    this._boundPathScaleCommit = (event) => this._handlePathScale(event, true);
    this._boundPathScaleWheel = (event) => this._handlePathScaleWheel(event);
    this._placeAsNamingRerenderJob = null;
    this._placeAsNamingRerenderRevision = null;
    this._placeAsNamingRerenderCount = 0;
    this._pathOffsetRoot = null;
    this._pathOffsetXSlider = null;
    this._pathOffsetYSlider = null;
    this._pathOffsetXDisplay = null;
    this._pathOffsetYDisplay = null;
    this._boundPathOffsetXInput = (event) => this._handlePathOffset(event, 'x', false);
    this._boundPathOffsetXCommit = (event) => this._handlePathOffset(event, 'x', true);
    this._boundPathOffsetYInput = (event) => this._handlePathOffset(event, 'y', false);
    this._boundPathOffsetYCommit = (event) => this._handlePathOffset(event, 'y', true);
    this._pathTensionRoot = null;
    this._pathTensionSlider = null;
    this._pathTensionDisplay = null;
    this._boundPathTensionInput = (event) => this._handlePathTension(event, false);
    this._boundPathTensionCommit = (event) => this._handlePathTension(event, true);
    this._pathSimplifyRoot = null;
    this._pathSimplifySlider = null;
    this._pathSimplifyDisplay = null;
    this._boundPathSimplifyInput = (event) => this._handlePathSimplify(event, false);
    this._boundPathSimplifyCommit = (event) => this._handlePathSimplify(event, true);
    this._showWidthTangentsRoot = null;
    this._showWidthTangentsToggle = null;
    this._boundShowWidthTangentsChange = (event) => this._handleShowWidthTangentsChange(event);
    this._placeAsSearchInput = null;
    this._placeAsList = null;
    this._placeAsLinkedToggle = null;
    this._placeAsActorTypeSelect = null;
    this._placeAsActorTypeHint = null;
    this._placeAsAppendNumberToggle = null;
    this._placeAsPrependAdjectiveToggle = null;
    this._placeAsToggleButton = null;
    this._placeAsHpModeSelect = null;
    this._placeAsHpPercentInput = null;
    this._placeAsHpStaticInput = null;
    this._placeAsHpModeHint = null;
    this._placeAsHpPercentHint = null;
    this._placeAsHpStaticHint = null;
    this._placeAsHpStaticError = null;
    this._placeAsHpPercentRow = null;
    this._placeAsHpStaticRow = null;
    this._boundPlaceAsSearch = (event) => this._handlePlaceAsSearch(event);
    this._boundPlaceAsOptionClick = (event) => this._handlePlaceAsOptionClick(event);
    this._boundPlaceAsLinkedChange = (event) => this._handlePlaceAsLinked(event);
    this._boundPlaceAsActorTypeChange = (event) => this._handlePlaceAsActorType(event);
    this._boundPlaceAsAppendNumberChange = (event) => this._handlePlaceAsAppendNumber(event);
    this._boundPlaceAsPrependAdjectiveChange = (event) => this._handlePlaceAsPrependAdjective(event);
    this._boundPlaceAsToggle = (event) => this._handlePlaceAsToggle(event);
    this._boundPlaceAsFilter = (event) => this._handlePlaceAsFilter(event);
    this._placeAsFilterButton = null;
    this._boundPlaceAsHpMode = (event) => this._handlePlaceAsHpMode(event);
    this._boundPlaceAsHpPercent = (event) => this._handlePlaceAsHpPercent(event);
    this._boundPlaceAsHpStatic = (event) => this._handlePlaceAsHpStatic(event);
    this._flipRoot = null;
    this._flipDisplay = null;
    this._flipPreviewDisplay = null;
    this._flipHorizontalButton = null;
    this._flipVerticalButton = null;
    this._flipHorizontalRandomButton = null;
    this._flipVerticalRandomButton = null;
    this._boundFlipHorizontal = (event) => this._handleFlipHorizontal(event);
    this._boundFlipVertical = (event) => this._handleFlipVertical(event);
    this._boundFlipHorizontalRandom = (event) => this._handleFlipRandomHorizontal(event);
    this._boundFlipVerticalRandom = (event) => this._handleFlipRandomVertical(event);
    this._scaleRoot = null;
    this._scaleDisplay = null;
    this._scaleBaseSlider = null;
    this._scaleRandomButton = null;
    this._scaleStrengthRow = null;
    this._scaleStrengthSlider = null;
    this._scaleStrengthDisplay = null;
    this._boundScaleInput = (event) => this._handleScaleInput(event);
    this._boundScaleRandom = (event) => this._handleScaleRandom(event);
    this._boundScaleStrength = (event) => this._handleScaleStrength(event);
    this._rotationRoot = null;
    this._rotationDisplay = null;
    this._rotationBaseSlider = null;
    this._rotationRandomButton = null;
    this._rotationStrengthRow = null;
    this._rotationStrengthSlider = null;
    this._rotationStrengthDisplay = null;
    this._boundRotationInput = (event) => this._handleRotationInput(event);
    this._boundRotationStrength = (event) => this._handleRotationStrength(event);
    this._boundRotationRandom = (event) => this._handleRotationRandom(event);
    this._pathShadowRoot = null;
    this._pathShadowToggle = null;
    this._pathShadowEditToggle = null;
    this._pathShadowEditRoot = null;
    this._pathShadowOffsetSlider = null;
    this._pathShadowOffsetDisplay = null;
    this._pathShadowAlphaSlider = null;
    this._pathShadowAlphaDisplay = null;
    this._pathShadowBlurSlider = null;
    this._pathShadowBlurDisplay = null;
    this._pathShadowDilationSlider = null;
    this._pathShadowDilationDisplay = null;
    this._pathShadowPresetsRoot = null;
    this._pathShadowPresetButtons = [];
    this._pathShadowResetButton = null;
    this._pathShadowEditResetButton = null;
    this._pathShadowElevationDisplay = null;
    this._pathShadowNoteDisplay = null;
    this._boundPathShadowToggle = (event) => this._handlePathShadowToggle(event);
    this._boundPathShadowEditToggle = (event) => this._handlePathShadowEdit(event);
    this._boundPathShadowScaleInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowScale', false);
    this._boundPathShadowScaleCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowScale', true);
    this._boundPathShadowOffsetInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowOffset', false);
    this._boundPathShadowOffsetCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowOffset', true);
    this._boundPathShadowAlphaInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowAlpha', false);
    this._boundPathShadowAlphaCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowAlpha', true);
    this._boundPathShadowBlurInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowBlur', false);
    this._boundPathShadowBlurCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowBlur', true);
    this._boundPathShadowDilationInput = (event) => this._handlePathShadowSlider(event, 'setPathShadowDilation', false);
    this._boundPathShadowDilationCommit = (event) => this._handlePathShadowSlider(event, 'setPathShadowDilation', true);
    this._boundPathShadowPresetClick = (event) => this._handlePathShadowPresetClick(event);
    this._boundPathShadowPresetContext = (event) => this._handlePathShadowPresetContext(event);
    this._boundPathShadowReset = (event) => this._handlePathShadowReset(event);
    this._boundPathShadowEditReset = (event) => this._handlePathShadowEditReset(event);
    this._pathFeatherRoot = null;
    this._pathFeatherStartToggle = null;
    this._pathFeatherEndToggle = null;
    this._pathFeatherStartSlider = null;
    this._pathFeatherEndSlider = null;
    this._pathFeatherStartValue = null;
    this._pathFeatherEndValue = null;
    this._pathFeatherHint = null;
    this._boundPathFeatherStartToggle = (event) => this._handlePathFeatherToggle(event, 'start');
    this._boundPathFeatherEndToggle = (event) => this._handlePathFeatherToggle(event, 'end');
    this._boundPathFeatherStartInput = (event) => this._handlePathFeatherLength(event, 'start', false);
    this._boundPathFeatherStartCommit = (event) => this._handlePathFeatherLength(event, 'start', true);
    this._boundPathFeatherEndInput = (event) => this._handlePathFeatherLength(event, 'end', false);
    this._boundPathFeatherEndCommit = (event) => this._handlePathFeatherLength(event, 'end', true);
    this._opacityFeatherRoot = null;
    this._opacityFeatherStartToggle = null;
    this._opacityFeatherEndToggle = null;
    this._opacityFeatherStartSlider = null;
    this._opacityFeatherEndSlider = null;
    this._opacityFeatherStartValue = null;
    this._opacityFeatherEndValue = null;
    this._opacityFeatherHint = null;
    this._boundOpacityFeatherStartToggle = (event) => this._handleOpacityFeatherToggle(event, 'start');
    this._boundOpacityFeatherEndToggle = (event) => this._handleOpacityFeatherToggle(event, 'end');
    this._boundOpacityFeatherStartInput = (event) => this._handleOpacityFeatherLength(event, 'start', false);
    this._boundOpacityFeatherStartCommit = (event) => this._handleOpacityFeatherLength(event, 'start', true);
    this._boundOpacityFeatherEndInput = (event) => this._handleOpacityFeatherLength(event, 'end', false);
    this._boundOpacityFeatherEndCommit = (event) => this._handleOpacityFeatherLength(event, 'end', true);
    this._pendingScrollState = null;
    this._pendingContentStyle = null;
    this._resetScrollNextRender = false;
    this._syncWindowTitle();
  }


  render(force, options) {
    if (this.rendered) {
      if (this._resetScrollNextRender) this._pendingScrollState = { top: 0, left: 0 };
      else this._pendingScrollState = this._measureScrollState();
      this._pendingContentStyle = this._measureContentStyle();
    } else {
      this._pendingScrollState = null;
      this._pendingContentStyle = null;
    }
    return super.render(force, options);
  }

  get activeTool() {
    return this._activeTool;
  }

  setActiveTool(tool) {
    const previousId = this._activeTool?.id ?? null;
    const next = tool ? { id: String(tool.id || ''), label: String(tool.label || tool.id || '') } : null;
    this._activeTool = next;
    this._activeNormalizedOptions = next?.id
      ? (this._controller?._getToolNormalized?.(next.id) || null)
      : null;
    const nextId = next?.id ?? null;
    if (nextId && this._shortcutsCollapsedByTool.has(nextId)) {
      this._shortcutsCollapsed = !!this._shortcutsCollapsedByTool.get(nextId);
    } else {
      this._shortcutsCollapsed = false;
    }
    if (!nextId) this._shortcutsCollapsed = false;
    this._syncShortcutsControls();
    this._syncWindowTitle();
    if (this._toolPanelActivityActive) this._emitToolPanelActivity();
    if (nextId !== previousId) this._resetScrollNextRender = true;
    if (this.rendered) this.render(false);
  }


  setPosition(position) {
    const result = super.setPosition(position);
    // Update saved height when position changes (including user resizes)
    if (position?.height && Number.isFinite(position.height)) {
      this._savedHeight = position.height;
    }
    this._persistWindowPosition();
    return result;
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
    try {
      const root = this.element;
      root?.classList?.add('fa-nexus-tool-options-root');
      if (root) root.dataset.faNexusToolOverlay = 'true';
    } catch (_) {}
    this._syncHeaderHelpButton();
    this._rebuildDynamicSections();
    this._bindControls();
    this._ensurePlaceAsNamingSection();
    this._restoreContentStyle();
    this._restoreScrollState();
    if (initial) {
      this._restoreWindowPosition();
      this._setupResizeObserver();
    }
    this._resetScrollNextRender = false;
  }

  _syncHeaderHelpButton() {
    const root = this.element;
    const header = root?.querySelector?.('.window-header');
    const help = this._controller?.getToolHelpContext?.(this._activeTool?.id) || { available: false };
    const existing = header?.querySelector?.('[data-fa-nexus-help-open]') || null;
    if (!header || !help.available) {
      if (existing) existing.remove();
      return;
    }

    let button = existing;
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'header-control fa-nexus-tool-options__header-help';
      button.setAttribute('data-fa-nexus-help-open', 'true');
      button.innerHTML = '<i class="fas fa-circle-question" aria-hidden="true"></i>';
    }

    button.title = `Open ${help.toolLabel} help (F1)`;
    button.setAttribute('aria-label', `Open ${help.toolLabel} help`);

    const closeButton = Array.from(header.children || []).find(
      (child) => child?.dataset?.action === 'close' || child?.classList?.contains('close')
    ) || null;

    if (closeButton && closeButton !== button) {
      if (button.parentNode !== header || button.nextElementSibling !== closeButton) {
        header.insertBefore(button, closeButton);
      }
      return;
    }

    if (button.parentNode !== header || header.lastElementChild !== button) {
      header.appendChild(button);
    }
  }

  _onClose(options = {}) {
    this._cleanupResizeObserver();
    this._persistWindowPosition();
    this._unbindControls();
    this._setToolPanelActivity(false);
    if (this._placeAsNamingRerenderJob) {
      clearTimeout(this._placeAsNamingRerenderJob);
      this._placeAsNamingRerenderJob = null;
    }
    this._placeAsNamingRerenderRevision = null;
    this._placeAsNamingRerenderCount = 0;
    this._pendingScrollState = null;
    this._pendingContentStyle = null;
    this._resetScrollNextRender = false;
    try { this._controller?._handleWindowClosed(this); } catch (_) {}
    super._onClose(options);
  }


  _restoreWindowPosition() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, TOOL_WINDOW_SETTING_KEY);
      if (!saved || typeof saved !== 'object') return;
      const current = foundry.utils.deepClone(this.position ?? {}) || {};
      let hasValue = false;
      if (Number.isFinite(saved.left)) { current.left = saved.left; hasValue = true; }
      if (Number.isFinite(saved.top)) { current.top = saved.top; hasValue = true; }
      if (Number.isFinite(saved.width)) { current.width = saved.width; hasValue = true; }
      if (Number.isFinite(saved.height)) { 
        current.height = saved.height; 
        this._savedHeight = saved.height; // Store for resize observer
        hasValue = true; 
      }
      if (!hasValue) return;
      this._restoringPosition = true;
      try { super.setPosition(current); }
      finally { this._restoringPosition = false; }
    } catch (_) {
      this._restoringPosition = false;
    }
  }


  _forceSavedHeight() {
    if (!this._savedHeight) return;
    const current = foundry.utils.deepClone(this.position ?? {}) || {};
    current.height = this._savedHeight;
    this._restoringPosition = true;
    try { super.setPosition(current); }
    finally { this._restoringPosition = false; }
  }
}

installToolOptionsWindowRenderMethods(ToolOptionsWindow);
installToolOptionsWindowControlMethods(ToolOptionsWindow);
installToolOptionsWindowPersistenceMethods(ToolOptionsWindow);
