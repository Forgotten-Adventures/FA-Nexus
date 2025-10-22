import { NexusLogger as Logger } from './nexus-logger.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = 'fa-nexus';
const TOOL_WINDOW_SETTING_KEY = 'toolOptionsWindowPos';
const GRID_SNAP_SETTING_KEY = 'gridSnap';
const SHORTCUTS_SETTING_KEY = 'toolOptionsShortcuts';
const DEFAULT_WINDOW_TITLE = 'Tool Options';

/**
 * ToolOptionsWindow
 * Lightweight application shell that reflects the currently active canvas tool.
 */
class ToolOptionsWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.DEFAULT_OPTIONS ?? {}),
    {
      id: 'fa-nexus-tool-options',
      tag: 'section',
      position: { width: 320, height: 400 },
      window: {
        resizable: true,
        minimizable: true,
        title: DEFAULT_WINDOW_TITLE
      }
    },
    { inplace: false }
  );

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-options.hbs' }
    },
    { inplace: false }
  );

  constructor({ controller, gridSnapEnabled = true, gridSnapAvailable = true, toolOptions = {} } = {}) {
    super();
    this._controller = controller;
    this._activeTool = null;
    this._restoringPosition = false;
    this._gridSnapEnabled = !!gridSnapEnabled;
    this._gridSnapAvailable = !!gridSnapAvailable;
    this._gridSnapToggle = null;
    this._boundGridSnapChange = (event) => this._handleGridSnapChange(event);
    this._toolOptionState = toolOptions && typeof toolOptions === 'object' ? toolOptions : {};
    this._dropShadowToggle = null;
    this._boundDropShadowChange = (event) => this._handleDropShadowChange(event);
    this._dropShadowRoot = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowOffsetMaxDistance = 40;
    this._dropShadowOffsetPointerId = null;
    this._dropShadowOffsetPointerActive = false;
    this._dropShadowAlphaDisplay = null;
    this._resizeObserver = null;
    this._userResizing = false;
    this._savedHeight = null;
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
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
    this._boundDropShadowAlphaInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowAlpha', false);
    this._boundDropShadowAlphaCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowAlpha', true);
    this._boundDropShadowDilationInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowDilation', false);
    this._boundDropShadowDilationCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowDilation', true);
    this._boundDropShadowBlurInput = (event) => this._handleDropShadowSlider(event, 'setDropShadowBlur', false);
    this._boundDropShadowBlurCommit = (event) => this._handleDropShadowSlider(event, 'setDropShadowBlur', true);
    this._boundDropShadowOffsetPointerDown = (event) => this._handleDropShadowOffsetPointerDown(event);
    this._boundDropShadowOffsetPointerMove = (event) => this._handleDropShadowOffsetPointerMove(event);
    this._boundDropShadowOffsetPointerUp = (event) => this._handleDropShadowOffsetPointerUp(event);
    this._boundDropShadowOffsetContext = (event) => this._handleDropShadowOffsetContext(event);
    this._boundDropShadowCollapse = (event) => this._handleDropShadowCollapse(event);
    this._boundDropShadowPresetClick = (event) => this._handleDropShadowPresetClick(event);
    this._boundDropShadowPresetContext = (event) => this._handleDropShadowPresetContext(event);
    this._boundDropShadowReset = (event) => this._handleDropShadowReset(event);
    this._customToggleBindings = new Map();
    this._textureToolsRoot = null;
    this._textureModeLabel = null;
    this._textureModeButtons = [];
    this._textureModeButtonMap = new Map();
    this._textureActionsRoot = null;
    this._textureActionButtons = [];
    this._textureActionButtonMap = new Map();
    this._textureStatusDisplay = null;
    this._textureHintDisplay = null;
    this._boundTextureModeClick = (event) => this._handleTextureModeClick(event);
    this._boundTextureActionClick = (event) => this._handleTextureActionClick(event);
    this._textureOpacityRoot = null;
    this._textureOpacitySlider = null;
    this._textureOpacityDisplay = null;
    this._boundTextureOpacityInput = (event) => this._handleTextureOpacity(event, false);
    this._boundTextureOpacityCommit = (event) => this._handleTextureOpacity(event, true);
    this._textureLayerRoot = null;
    this._textureLayerSlider = null;
    this._textureLayerDisplay = null;
    this._boundTextureLayerInput = (event) => this._handleTextureLayerOpacity(event, false);
    this._boundTextureLayerCommit = (event) => this._handleTextureLayerOpacity(event, true);
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
    this._textureOffsetRoot = null;
    this._textureOffsetXSlider = null;
    this._textureOffsetYSlider = null;
    this._textureOffsetXDisplay = null;
    this._textureOffsetYDisplay = null;
    this._boundTextureOffsetXInput = (event) => this._handleTextureOffset(event, 'x', false);
    this._boundTextureOffsetXCommit = (event) => this._handleTextureOffset(event, 'x', true);
    this._boundTextureOffsetYInput = (event) => this._handleTextureOffset(event, 'y', false);
    this._boundTextureOffsetYCommit = (event) => this._handleTextureOffset(event, 'y', true);
    this._placeAsSearchInput = null;
    this._placeAsList = null;
    this._placeAsLinkedToggle = null;
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
    this._boundPlaceAsToggle = (event) => this._handlePlaceAsToggle(event);
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
    const nextId = next?.id ?? null;
    if (nextId && this._shortcutsCollapsedByTool.has(nextId)) {
      this._shortcutsCollapsed = !!this._shortcutsCollapsedByTool.get(nextId);
    } else {
      this._shortcutsCollapsed = false;
    }
    if (!nextId) this._shortcutsCollapsed = false;
    this._syncShortcutsControls();
    this._syncWindowTitle();
    if (nextId !== previousId) this._resetScrollNextRender = true;
    if (this.rendered) this.render(false);
  }

  setActiveToolOptions(options = {}, { suppressRender = false } = {}) {
    if (!options || typeof options !== 'object') this._toolOptionState = {};
    else this._toolOptionState = options;
    if (this.rendered && !suppressRender) this.render(false);
    else if (this.rendered) {
      this._syncGridSnapControl();
      this._syncDropShadowControl();
      this._syncDropShadowControls();
      this._syncTextureToolControls();
      this._syncTextureOpacityControl();
      this._syncTextureOffsetControls();
      this._syncTextureLayerControl();
      this._syncPathAppearanceControls();
      this._syncCustomToggles();
      this._syncFlipControls();
      this._syncScaleControls();
      this._syncRotationControls();
      this._syncPathFeatherControls();
      this._syncOpacityFeatherControls();
      this._syncShortcutsControls();
      this._syncPlaceAsControls();
    }
  }

  _resolveWindowTitle() {
    const label = typeof this._activeTool?.label === 'string' ? this._activeTool.label.trim() : '';
    if (label.length > 0) return `${label} Options`;
    return DEFAULT_WINDOW_TITLE;
  }

  _syncWindowTitle() {
    const title = this._resolveWindowTitle();
    try {
      if (!this.options.window || typeof this.options.window !== 'object') this.options.window = {};
      this.options.window.title = title;
    } catch (_) {}
    try {
      const appWindow = this.window;
      if (appWindow) {
        if (typeof appWindow.setTitle === 'function') appWindow.setTitle(title);
        else appWindow.title = title;
      }
    } catch (_) {}
    try {
      const headerTitle = this.element?.querySelector('.window-title');
      if (headerTitle) headerTitle.textContent = title;
    } catch (_) {}
  }

  async _prepareContext() {
    const tool = this._activeTool;
    const canToggleGridSnap = !!(this._controller?.supportsGridSnap?.() && this._gridSnapAvailable);
    const options = this._toolOptionState || {};
    const dropShadow = options.dropShadow || {};
    const dropShadowTooltip = typeof dropShadow.tooltip === 'string' && dropShadow.tooltip.length
      ? dropShadow.tooltip
      : 'Toggle drop shadows for asset placements.';
    const dropShadowHint = typeof dropShadow.hint === 'string' ? dropShadow.hint : '';
    const dropShadowControls = this._prepareDropShadowControls(options.dropShadowControls, dropShadow);
    const hintLines = (() => {
      if (Array.isArray(options.hints)) {
        return options.hints.filter((line) => typeof line === 'string' && line.trim().length).map((line) => line.trim());
      }
      if (typeof options.hints === 'string' && options.hints.trim().length) {
        return [options.hints.trim()];
      }
      return [];
    })();
    const shortcuts = {
      available: hintLines.length > 0,
      collapsed: !!this._shortcutsCollapsed,
      lines: hintLines
    };
    const customToggleList = Array.isArray(options.customToggles)
      ? options.customToggles.map((toggle) => ({
        id: String(toggle?.id || ''),
        label: String(toggle?.label || ''),
        tooltip: String(toggle?.tooltip || ''),
        enabled: !!toggle?.enabled,
        disabled: !!toggle?.disabled
      })).filter((toggle) => toggle.id.length)
      : [];
    const placeAs = options.placeAs && typeof options.placeAs === 'object' ? options.placeAs : null;
    const scale = this._prepareScaleContext(options.scale);
    const rotation = this._prepareRotationContext(options.rotation);
    const flip = this._prepareFlipContext(options.flip);
    const texturePaint = this._prepareTexturePaintContext(options.texturePaint);
    const textureOffset = this._prepareTextureOffsetContext(options.textureOffset);
    const layerOpacity = this._prepareLayerOpacityContext(options.layerOpacity);
    const pathAppearance = this._preparePathAppearanceContext(options.pathAppearance);
    const pathFeather = this._preparePathFeatherContext(options.pathFeather);
    const opacityFeather = this._prepareOpacityFeatherContext(options.opacityFeather);
    return {
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      showDropShadowToggle: !!dropShadow.available,
      dropShadowEnabled: !!dropShadow.enabled,
      dropShadowDisabled: !!dropShadow.disabled,
      dropShadowTooltip,
      dropShadowHint: dropShadowHint,
      dropShadowControls,
      shortcuts,
      hasCustomToggles: customToggleList.length > 0,
      customToggles: customToggleList,
      flip,
      scale,
      placeAs: placeAs || { available: false },
      rotation,
      texturePaint,
      textureOffset,
      layerOpacity,
      pathAppearance,
      pathFeather,
      opacityFeather
    };
  }

  _prepareFlipContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const buildAxis = (axisRaw = {}) => {
      const data = axisRaw && typeof axisRaw === 'object' ? axisRaw : {};
      const randomButtonVisible = data.randomButtonVisible !== undefined ? !!data.randomButtonVisible : true;
      return {
        active: coerceBool(data.active),
        label: coerceString(data.label, 'Flip'),
        tooltip: coerceString(data.tooltip, ''),
        disabled: coerceBool(data.disabled),
        aria: coerceString(data.aria, 'Toggle mirroring'),
        previewDiff: coerceBool(data.previewDiff),
        randomEnabled: coerceBool(data.randomEnabled),
        randomLabel: coerceString(data.randomLabel, 'Random'),
        randomTooltip: coerceString(data.randomTooltip, data.randomEnabled ? 'Disable random' : 'Enable random'),
        randomDisabled: coerceBool(data.randomDisabled),
        randomAria: coerceString(data.randomAria, 'Toggle random mirroring'),
        randomPreviewDiff: coerceBool(data.randomPreviewDiff),
        randomButtonVisible
      };
    };
    return {
      available: true,
      display: coerceString(raw.display, 'None'),
      previewDisplay: coerceString(raw.previewDisplay, ''),
      randomHint: coerceString(raw.randomHint, ''),
      horizontal: buildAxis(raw.horizontal),
      vertical: buildAxis(raw.vertical)
    };
  }

  _prepareScaleContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 10;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 250;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = clamp(raw.value, min, max, Math.max(min, Math.min(max, 100)));
    const randomEnabled = !!raw.randomEnabled;
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 100;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : `±${Math.round(strength)}%`;
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random scale' : 'Enable random scale');
    const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
    const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      randomEnabled,
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      randomLabel,
      randomTooltip,
      randomHint,
      randomButtonVisible
    };
  }

  _prepareRotationContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 360;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = clamp(raw.value, min, max, min);
    const randomEnabled = !!raw.randomEnabled;
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 180;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}°`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : (strength > 0 ? `±${Math.round(strength)}°` : '±0°');
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random rotation' : 'Enable random rotation');
    const randomHint = typeof raw.randomHint === 'string' ? raw.randomHint : '';
    const randomButtonVisible = raw.randomButtonVisible !== undefined ? !!raw.randomButtonVisible : true;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      randomEnabled,
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      randomLabel,
      randomTooltip,
      randomHint,
      randomButtonVisible
    };
  }

  _prepareTexturePaintContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false, opacity: { available: false } };
    }
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const modes = Array.isArray(raw.modes)
      ? raw.modes.map((entry) => {
        const id = coerceString(entry?.id, '');
        if (!id) return null;
        return {
          id,
          label: coerceString(entry?.label, id),
          tooltip: coerceString(entry?.tooltip, ''),
          icon: coerceString(entry?.icon, ''),
          active: coerceBool(entry?.active),
          disabled: coerceBool(entry?.disabled)
        };
      }).filter(Boolean)
      : [];
    const actions = Array.isArray(raw.actions)
      ? raw.actions.map((entry) => {
        const id = coerceString(entry?.id, '');
        if (!id) return null;
        return {
          id,
          label: coerceString(entry?.label, id),
          tooltip: coerceString(entry?.tooltip, ''),
          primary: coerceBool(entry?.primary),
          disabled: coerceBool(entry?.disabled)
        };
      }).filter(Boolean)
      : [];
    const opacity = this._prepareTextureOpacityContext(raw.opacity);
    const activeModeLabel = (() => {
      const active = modes.find((mode) => mode.active);
      if (active) return active.label;
      return modes[0]?.label || 'Brush';
    })();
    return {
      available: true,
      modeLabel: coerceString(raw.modeLabel, activeModeLabel),
      status: coerceString(raw.status, ''),
      hint: coerceString(raw.hint, ''),
      modes,
      actions: actions.length ? actions : null,
      opacity
    };
  }

  _prepareTextureOpacityContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 1;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const fallbackValue = Math.max(min, Math.min(max, 100));
    const value = clamp(raw.value, min, max, fallbackValue);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled: !!raw.disabled,
      hint: typeof raw.hint === 'string' ? raw.hint : ''
    };
  }

  _prepareTextureOffsetContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const buildAxis = (axisRaw = {}) => {
      const min = Number.isFinite(axisRaw.min) ? Number(axisRaw.min) : -500;
      const max = Number.isFinite(axisRaw.max) ? Number(axisRaw.max) : 500;
      const step = Number.isFinite(axisRaw.step) && Number(axisRaw.step) > 0 ? Number(axisRaw.step) : 1;
      const value = Number.isFinite(axisRaw.value) ? Number(axisRaw.value) : 0;
      const display = typeof axisRaw.display === 'string' ? axisRaw.display : `${Math.round(value)} px`;
      return {
        min,
        max,
        step,
        value,
        display
      };
    };
    const disabled = !!raw.disabled;
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const x = buildAxis(raw.x || {});
    const y = buildAxis(raw.y || {});
    return {
      available: true,
      hint,
      disabled,
      x: { ...x, disabled: !!(x.disabled || disabled) },
      y: { ...y, disabled: !!(y.disabled || disabled) }
    };
  }

  _prepareLayerOpacityContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const value = Number.isFinite(raw.value) ? Number(raw.value) : max;
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display
    };
  }

  _preparePathFeatherContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const normalizeLength = (lengthRaw = {}) => {
      const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
      const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
      const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
      const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
      const clamped = Math.min(max, Math.max(min, value));
      const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
      return {
        min,
        max,
        step,
        value: clamped,
        display,
        disabled: !!lengthRaw.disabled
      };
    };
    const normalizeEndpoint = (endpointRaw = {}) => {
      const enabled = !!endpointRaw.enabled;
      const length = normalizeLength(endpointRaw.length || {});
      return { enabled, length };
    };
    const start = normalizeEndpoint(raw.start);
    const end = normalizeEndpoint(raw.end);
    return {
      available: true,
      unitLabel,
      hint,
      start,
      end
    };
  }

  _prepareOpacityFeatherContext(raw) {
    if (!raw || typeof raw !== 'object' || raw.available === false) {
      return { available: false };
    }
    const unitLabel = typeof raw.unitLabel === 'string' && raw.unitLabel.trim().length ? raw.unitLabel.trim() : 'grid';
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    const normalizeEndpoint = (endpointRaw = {}) => {
      const enabled = !!endpointRaw.enabled;
      const lengthRaw = endpointRaw.length || {};
      const min = Number.isFinite(lengthRaw.min) ? Number(lengthRaw.min) : 0;
      const max = Number.isFinite(lengthRaw.max) ? Number(lengthRaw.max) : 10;
      const step = Number.isFinite(lengthRaw.step) && Number(lengthRaw.step) > 0 ? Number(lengthRaw.step) : 0.1;
      const value = Number.isFinite(lengthRaw.value) ? Number(lengthRaw.value) : 0;
      const clamped = Math.min(max, Math.max(min, value));
      const display = typeof lengthRaw.display === 'string' ? lengthRaw.display : `${clamped.toFixed(2)} ${unitLabel}`;
      return {
        enabled,
        length: {
          min,
          max,
          step,
          value: clamped,
          display,
          disabled: !!lengthRaw.disabled
        }
      };
    };
    const start = normalizeEndpoint(raw.start || {});
    const end = normalizeEndpoint(raw.end || {});
    return {
      available: true,
      unitLabel,
      hint,
      start,
      end
    };
  }

  _prepareDropShadowControls(raw, dropShadowState) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const disabled = !!raw.disabled || !!dropShadowState?.disabled;
    const coerceNumber = (value, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return num;
    };
    const coerceString = (val, fallback) => {
      if (val === undefined || val === null) return fallback;
      const str = String(val);
      return str.length ? str : fallback;
    };
    const coerceEntry = (entry, defaults) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      const entryDisabled = disabled || !!data.disabled;
      return {
        label: coerceString(data.label, defaults.label),
        value: coerceString(data.value ?? defaults.value, defaults.value),
        min: coerceNumber(data.min, defaults.min),
        max: coerceNumber(data.max, defaults.max),
        step: coerceNumber(data.step, defaults.step),
        display: coerceString(data.display, defaults.display),
        hint: coerceString(data.hint, ''),
        disabled: entryDisabled
      };
    };
    const alpha = coerceEntry(raw.alpha, { label: 'Opacity', value: '65', min: 0, max: 100, step: 1, display: '65%' });
    const dilation = coerceEntry(raw.dilation, { label: 'Spread', value: '1.6', min: 0, max: 20, step: 0.1, display: '1.6 px' });
    const blur = coerceEntry(raw.blur, { label: 'Blur', value: '1.8', min: 0, max: 12, step: 0.1, display: '1.8 px' });
    const offsetRaw = raw.offset && typeof raw.offset === 'object' ? raw.offset : {};
    const offset = {
      distance: Number(offsetRaw.distance ?? 0) || 0,
      angle: Number(offsetRaw.angle ?? 0) || 0,
      maxDistance: Number(offsetRaw.maxDistance ?? 40) || 40,
      displayDistance: coerceString(offsetRaw.displayDistance, '0.0 px'),
      displayAngle: coerceString(offsetRaw.displayAngle, '0°'),
      hint: coerceString(offsetRaw.hint, ''),
      disabled
    };
    const collapsed = !!raw.collapsed;
    const presets = Array.isArray(raw.presets)
      ? raw.presets.map((entry, index) => {
        const data = entry && typeof entry === 'object' ? entry : {};
        return {
          index,
          label: coerceString(data.label, String(index + 1)),
          saved: !!data.saved,
          active: !!data.active,
          tooltip: coerceString(data.tooltip, data.saved ? `Click to apply preset ${index + 1}.` : `Shift+Click to save preset ${index + 1}.`)
        };
      })
      : [];
    const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
    const context = {
      display: coerceString(contextRaw.display, ''),
      status: coerceString(contextRaw.status, ''),
      note: coerceString(contextRaw.note, ''),
      tileCount: coerceNumber(contextRaw.tileCount, 0) || 0,
      hasTiles: !!contextRaw.hasTiles,
      source: coerceString(contextRaw.source, '')
    };
    return {
      available: true,
      disabled,
      collapsed,
      presets,
      alpha,
      dilation,
      blur,
      offset,
      context
    };
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

  _preparePathAppearanceContext(raw) {
    const data = raw && typeof raw === 'object' ? raw : {};
    const layerOpacity = this._prepareLayerOpacityContext(data.layerOpacity);
    const textureOffset = this._prepareTextureOffsetContext(data.textureOffset);
    const scale = this._preparePathScaleContext(data.scale);
    const tension = this._preparePathTensionContext(data.tension);
    const hint = typeof data.hint === 'string' ? data.hint : '';
    return {
      available: !!(layerOpacity.available || textureOffset.available || scale.available || tension.available),
      hint,
      layerOpacity,
      textureOffset,
      scale,
      tension
    };
  }

  _preparePathScaleContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 100);
    const min = Number(raw.min ?? 10);
    const max = Number(raw.max ?? 250);
    const step = Number(raw.step ?? 1);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled
    };
  }

  _preparePathTensionContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 0);
    const min = Number(raw.min ?? 0);
    const max = Number(raw.max ?? 1);
    const step = Number(raw.step ?? 0.01);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      disabled
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
    try {
      const root = this.element;
      root?.classList?.add('fa-nexus-tool-options-root');
      if (root) root.dataset.faNexusToolOverlay = 'true';
    } catch (_) {}
    this._bindControls();
    this._restoreContentStyle();
    this._restoreScrollState();
    if (initial) {
      this._restoreWindowPosition();
      this._setupResizeObserver();
    }
    this._resetScrollNextRender = false;
  }

  _onClose(options = {}) {
    this._cleanupResizeObserver();
    this._persistWindowPosition();
    this._unbindControls();
    this._pendingScrollState = null;
    this._pendingContentStyle = null;
    this._resetScrollNextRender = false;
    try { this._controller?._handleWindowClosed(this); } catch (_) {}
    super._onClose(options);
  }

  _measureScrollState() {
    try {
      const container = this._getScrollContainer();
      if (!container) return null;
      return {
        top: Number(container.scrollTop) || 0,
        left: Number(container.scrollLeft) || 0
      };
    } catch (_) {
      return null;
    }
  }

  _restoreScrollState() {
    const container = this._getScrollContainer();
    if (!container) {
      this._pendingScrollState = null;
      return;
    }
    const state = this._pendingScrollState;
    if (state && typeof state === 'object') {
      if (Number.isFinite(state.top)) container.scrollTop = state.top;
      if (Number.isFinite(state.left)) container.scrollLeft = state.left;
    } else if (this._resetScrollNextRender) {
      container.scrollTop = 0;
      container.scrollLeft = 0;
    }
    this._pendingScrollState = null;
  }

  _getScrollContainer() {
    const root = this.element;
    if (!root) return null;
    return (
      root.querySelector('[data-fa-nexus-scroll-container]')
      || root.querySelector('.fa-nexus-tool-options__content')
      || root.querySelector('.fa-nexus-tool-options')
      || root.querySelector('.window-content')
      || root
    );
  }

  _measureContentStyle() {
    try {
      const content = this.element?.querySelector('.window-content');
      if (!content) return null;
      return content.getAttribute('style') ?? '';
    } catch (_) {
      return null;
    }
  }

  _restoreContentStyle() {
    const style = this._pendingContentStyle;
    this._pendingContentStyle = null;
    if (style === null || style === undefined) return;
    const content = this.element?.querySelector('.window-content');
    if (!content) return;
    if (style === '') content.removeAttribute('style');
    else content.setAttribute('style', style);
  }

  _bindControls() {
    this._unbindControls();
    try {
      const root = this.element;
      if (!root) return;
      const gridToggle = root.querySelector('#fa-nexus-grid-snap-toggle');
      if (gridToggle) {
        gridToggle.checked = !!this._gridSnapEnabled;
        const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
        const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
        gridToggle.disabled = !canToggle;
        gridToggle.addEventListener('change', this._boundGridSnapChange);
        this._gridSnapToggle = gridToggle;
      }
      const dropToggle = root.querySelector('#fa-nexus-drop-shadow-toggle');
      if (dropToggle) {
        const dropState = this._toolOptionState?.dropShadow || {};
        dropToggle.checked = !!dropState.enabled;
        dropToggle.disabled = !!dropState.disabled;
        dropToggle.addEventListener('change', this._boundDropShadowChange);
        this._dropShadowToggle = dropToggle;
      }
      this._bindDropShadowControls();
      this._bindTextureToolControls();
      this._bindTextureOpacityControl();
      this._bindTextureLayerControl();
      this._bindTextureOffsetControls();
      this._bindPathAppearanceControls();
      this._bindFlipControls();
      this._bindScaleControls();
      this._bindRotationControls();
      this._bindPathFeatherControls();
      this._bindOpacityFeatherControls();
      this._bindCustomToggles();
      this._bindShortcutsControls();
      const placeAsToggle = root.querySelector('[data-place-as-toggle]');
      if (placeAsToggle) {
        placeAsToggle.addEventListener('click', this._boundPlaceAsToggle);
        this._placeAsToggleButton = placeAsToggle;
      }
      const placeAsSearch = root.querySelector('#fa-nexus-place-as-search');
      if (placeAsSearch) {
        placeAsSearch.addEventListener('input', this._boundPlaceAsSearch);
        this._placeAsSearchInput = placeAsSearch;
      }
      const placeAsList = root.querySelector('[data-fa-nexus-place-as-list]');
      if (placeAsList) {
        placeAsList.addEventListener('click', this._boundPlaceAsOptionClick);
        this._placeAsList = placeAsList;
      }
      const placeAsLinked = root.querySelector('[data-place-as-linked]');
      if (placeAsLinked) {
        placeAsLinked.addEventListener('change', this._boundPlaceAsLinkedChange);
        this._placeAsLinkedToggle = placeAsLinked;
      }
      const hpMode = root.querySelector('[data-place-as-hp-mode]');
      if (hpMode) {
        hpMode.addEventListener('change', this._boundPlaceAsHpMode);
        this._placeAsHpModeSelect = hpMode;
      }
      const hpPercent = root.querySelector('[data-place-as-hp-percent]');
      if (hpPercent) {
        hpPercent.addEventListener('input', this._boundPlaceAsHpPercent);
        this._placeAsHpPercentInput = hpPercent;
      }
      const hpStatic = root.querySelector('[data-place-as-hp-static]');
      if (hpStatic) {
        hpStatic.addEventListener('input', this._boundPlaceAsHpStatic);
        this._placeAsHpStaticInput = hpStatic;
      }
      this._placeAsHpModeHint = root.querySelector('[data-place-as-hp-mode-hint]');
      this._placeAsHpPercentHint = root.querySelector('[data-place-as-hp-percent-hint]');
      this._placeAsHpStaticHint = root.querySelector('[data-place-as-hp-static-hint]');
      this._placeAsHpStaticError = root.querySelector('[data-place-as-hp-static-error]');
      this._placeAsHpPercentRow = root.querySelector('[data-place-as-hp-percent-row]');
      this._placeAsHpStaticRow = root.querySelector('[data-place-as-hp-static-row]');
      this._syncPlaceAsControls();
    } catch (_) {}
  }

  _unbindControls() {
    if (this._gridSnapToggle) {
      try { this._gridSnapToggle.removeEventListener('change', this._boundGridSnapChange); }
      catch (_) {}
      this._gridSnapToggle = null;
    }
    if (this._dropShadowToggle) {
      try { this._dropShadowToggle.removeEventListener('change', this._boundDropShadowChange); }
      catch (_) {}
      this._dropShadowToggle = null;
    }
    this._unbindDropShadowControls();
    this._unbindTextureToolControls();
    this._unbindTextureOpacityControl();
    this._unbindTextureLayerControl();
    this._unbindTextureOffsetControls();
    this._unbindPathAppearanceControls();
    this._unbindFlipControls();
    this._unbindScaleControls();
    this._unbindRotationControls();
    this._unbindPathFeatherControls();
    this._unbindOpacityFeatherControls();
    this._unbindShortcutsControls();
    if (this._customToggleBindings?.size) {
      for (const [toggle, handler] of this._customToggleBindings.entries()) {
        try { toggle.removeEventListener('change', handler); } catch (_) {}
      }
      this._customToggleBindings.clear();
    }
    if (this._placeAsToggleButton) {
      try { this._placeAsToggleButton.removeEventListener('click', this._boundPlaceAsToggle); }
      catch (_) {}
      this._placeAsToggleButton = null;
    }
    if (this._placeAsSearchInput) {
      try { this._placeAsSearchInput.removeEventListener('input', this._boundPlaceAsSearch); }
      catch (_) {}
      this._placeAsSearchInput = null;
    }
    if (this._placeAsList) {
      try { this._placeAsList.removeEventListener('click', this._boundPlaceAsOptionClick); }
      catch (_) {}
      this._placeAsList = null;
    }
    if (this._placeAsLinkedToggle) {
      try { this._placeAsLinkedToggle.removeEventListener('change', this._boundPlaceAsLinkedChange); }
      catch (_) {}
      this._placeAsLinkedToggle = null;
    }
    if (this._placeAsHpModeSelect) {
      try { this._placeAsHpModeSelect.removeEventListener('change', this._boundPlaceAsHpMode); }
      catch (_) {}
      this._placeAsHpModeSelect = null;
    }
    if (this._placeAsHpPercentInput) {
      try { this._placeAsHpPercentInput.removeEventListener('input', this._boundPlaceAsHpPercent); }
      catch (_) {}
      this._placeAsHpPercentInput = null;
    }
    if (this._placeAsHpStaticInput) {
      try { this._placeAsHpStaticInput.removeEventListener('input', this._boundPlaceAsHpStatic); }
      catch (_) {}
      this._placeAsHpStaticInput = null;
    }
    this._placeAsHpModeHint = null;
    this._placeAsHpPercentHint = null;
    this._placeAsHpStaticHint = null;
    this._placeAsHpStaticError = null;
    this._placeAsHpPercentRow = null;
    this._placeAsHpStaticRow = null;
  }

  _handleGridSnapChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    target.indeterminate = false;
    const next = !!target.checked;
    const controller = this._controller;
    if (!controller?.requestGridSnapToggle) {
      this.setGridSnapEnabled(next);
      return;
    }
    try {
      const result = controller.requestGridSnapToggle(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!this._gridSnapEnabled;
        }).catch(() => {
          target.checked = !!this._gridSnapEnabled;
        });
      } else if (result === false) {
        target.checked = !!this._gridSnapEnabled;
      }
    } catch (_) {
      target.checked = !!this._gridSnapEnabled;
    }
  }

  _handleDropShadowChange(event) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const next = !!target.checked;
    const controller = this._controller;
    if (!controller?.requestDropShadowToggle) {
      target.checked = !!this._toolOptionState?.dropShadow?.enabled;
      return;
    }
    try {
      const result = controller.requestDropShadowToggle(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!this._toolOptionState?.dropShadow?.enabled;
        }).catch(() => {
          target.checked = !!this._toolOptionState?.dropShadow?.enabled;
        });
      } else if (result === false) {
        target.checked = !!this._toolOptionState?.dropShadow?.enabled;
      }
    } catch (_) {
      target.checked = !!this._toolOptionState?.dropShadow?.enabled;
    }
  }

  setGridSnapEnabled(enabled) {
    const next = !!enabled;
    if (this._gridSnapEnabled === next) return;
    this._gridSnapEnabled = next;
    this._syncGridSnapControl();
  }

  setGridSnapAvailable(available) {
    const next = !!available;
    if (this._gridSnapAvailable === next) return;
    this._gridSnapAvailable = next;
    this._syncGridSnapControl();
  }

  _syncGridSnapControl() {
    const toggle = this._gridSnapToggle;
    if (!toggle) return;
    toggle.checked = !!this._gridSnapEnabled;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
    toggle.disabled = !canToggle;
  }

  _syncDropShadowControl() {
    const toggle = this._dropShadowToggle;
    if (!toggle) return;
    const dropState = this._toolOptionState?.dropShadow || {};
    toggle.checked = !!dropState.enabled;
    toggle.disabled = !!dropState.disabled;
  }

  _bindDropShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-drop-shadow-root]') || null;
    if (!root) {
      this._unbindDropShadowControls();
      return;
    }
    this._dropShadowRoot = root;
    this._dropShadowAlphaDisplay = root.querySelector('[data-fa-nexus-drop-shadow-alpha-display]') || null;
    this._dropShadowDilationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-dilation-display]') || null;
    this._dropShadowBlurDisplay = root.querySelector('[data-fa-nexus-drop-shadow-blur-display]') || null;
    this._dropShadowOffsetDistanceDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-distance-display]') || null;
    this._dropShadowOffsetAngleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-angle-display]') || null;
    this._dropShadowElevationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-elevation]') || null;
    this._dropShadowStatusDisplay = root.querySelector('[data-fa-nexus-drop-shadow-status]') || null;
    this._dropShadowNoteDisplay = root.querySelector('[data-fa-nexus-drop-shadow-note]') || null;
    this._dropShadowCollapseButton = root.querySelector('[data-fa-nexus-drop-shadow-toggle]') || null;
    if (this._dropShadowCollapseButton) {
      this._dropShadowCollapseButton.addEventListener('click', this._boundDropShadowCollapse);
    }
    this._dropShadowBody = root.querySelector('[data-fa-nexus-drop-shadow-body]') || null;
    this._dropShadowPresetsRoot = root.querySelector('[data-fa-nexus-drop-shadow-presets]') || null;
    if (this._dropShadowPresetsRoot) {
      this._dropShadowPresetButtons = Array.from(this._dropShadowPresetsRoot.querySelectorAll('[data-fa-nexus-drop-shadow-preset]'));
      for (const button of this._dropShadowPresetButtons) {
        button.addEventListener('click', this._boundDropShadowPresetClick);
        button.addEventListener('contextmenu', this._boundDropShadowPresetContext);
      }
    } else {
      this._dropShadowPresetButtons = [];
    }
    this._dropShadowResetButton = root.querySelector('[data-fa-nexus-drop-shadow-reset]') || null;
    if (this._dropShadowResetButton) {
      this._dropShadowResetButton.addEventListener('click', this._boundDropShadowReset);
    }

    const alphaSlider = root.querySelector('[data-fa-nexus-drop-shadow-alpha]');
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundDropShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundDropShadowAlphaCommit);
      this._dropShadowAlphaSlider = alphaSlider;
    }
    const dilationSlider = root.querySelector('[data-fa-nexus-drop-shadow-dilation]');
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundDropShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundDropShadowDilationCommit);
      this._dropShadowDilationSlider = dilationSlider;
    }
    const blurSlider = root.querySelector('[data-fa-nexus-drop-shadow-blur]');
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundDropShadowBlurInput);
      blurSlider.addEventListener('change', this._boundDropShadowBlurCommit);
      this._dropShadowBlurSlider = blurSlider;
    }
    const offsetControl = root.querySelector('[data-fa-nexus-drop-shadow-offset-control]');
    if (offsetControl) {
      offsetControl.addEventListener('pointerdown', this._boundDropShadowOffsetPointerDown);
      offsetControl.addEventListener('contextmenu', this._boundDropShadowOffsetContext);
      this._dropShadowOffsetControl = offsetControl;
      this._dropShadowOffsetMaxDistance = Number(offsetControl.dataset.maxDistance) || 40;
    }
    this._dropShadowOffsetCircle = root.querySelector('[data-fa-nexus-drop-shadow-offset-circle]') || null;
    this._dropShadowOffsetHandle = root.querySelector('[data-fa-nexus-drop-shadow-offset-handle]') || null;

    this._syncDropShadowControls();
  }

  _unbindDropShadowControls() {
    if (this._dropShadowAlphaSlider) {
      try {
        this._dropShadowAlphaSlider.removeEventListener('input', this._boundDropShadowAlphaInput);
        this._dropShadowAlphaSlider.removeEventListener('change', this._boundDropShadowAlphaCommit);
      } catch (_) {}
    }
    if (this._dropShadowDilationSlider) {
      try {
        this._dropShadowDilationSlider.removeEventListener('input', this._boundDropShadowDilationInput);
        this._dropShadowDilationSlider.removeEventListener('change', this._boundDropShadowDilationCommit);
      } catch (_) {}
    }
    if (this._dropShadowBlurSlider) {
      try {
        this._dropShadowBlurSlider.removeEventListener('input', this._boundDropShadowBlurInput);
        this._dropShadowBlurSlider.removeEventListener('change', this._boundDropShadowBlurCommit);
      } catch (_) {}
    }
    if (this._dropShadowOffsetControl) {
      try { this._dropShadowOffsetControl.removeEventListener('pointerdown', this._boundDropShadowOffsetPointerDown); } catch (_) {}
      try { this._dropShadowOffsetControl.removeEventListener('contextmenu', this._boundDropShadowOffsetContext); } catch (_) {}
    }
    if (this._dropShadowCollapseButton) {
      try { this._dropShadowCollapseButton.removeEventListener('click', this._boundDropShadowCollapse); } catch (_) {}
    }
    if (Array.isArray(this._dropShadowPresetButtons)) {
      for (const button of this._dropShadowPresetButtons) {
        try { button.removeEventListener('click', this._boundDropShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', this._boundDropShadowPresetContext); } catch (_) {}
      }
    }
    if (this._dropShadowResetButton) {
      try { this._dropShadowResetButton.removeEventListener('click', this._boundDropShadowReset); } catch (_) {}
    }
    this._releaseDropShadowOffsetPointer();
    this._dropShadowRoot = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowAlphaDisplay = null;
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowElevationDisplay = null;
    this._dropShadowStatusDisplay = null;
    this._dropShadowNoteDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
    this._dropShadowPresetsRoot = null;
    this._dropShadowPresetButtons = [];
    this._dropShadowResetButton = null;
  }

  _syncDropShadowControls() {
    const state = this._toolOptionState?.dropShadowControls;
    if (!this._dropShadowRoot || !state || !state.available) {
      return;
    }
    const assign = (slider, display, entry) => {
      if (!slider || !entry) return;
      if (entry.min !== undefined) slider.min = entry.min;
      if (entry.max !== undefined) slider.max = entry.max;
      if (entry.step !== undefined) slider.step = entry.step;
      if (entry.value !== undefined) slider.value = entry.value;
      slider.disabled = !!entry.disabled;
      if (display) display.textContent = entry.display ?? '';
    };
    const collapsed = !!state.collapsed;
    if (this._dropShadowRoot) {
      this._dropShadowRoot.classList.toggle('is-collapsed', collapsed);
    }
    if (this._dropShadowBody) {
      if (collapsed) this._dropShadowBody.setAttribute('aria-hidden', 'true');
      else this._dropShadowBody.removeAttribute('aria-hidden');
    }
    if (this._dropShadowCollapseButton) {
      this._dropShadowCollapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this._dropShadowCollapseButton.setAttribute('aria-label', collapsed ? 'Expand shadow settings' : 'Collapse shadow settings');
      this._dropShadowCollapseButton.classList.toggle('is-collapsed', collapsed);
      this._dropShadowCollapseButton.disabled = !!state.disabled;
    }
    assign(this._dropShadowAlphaSlider, this._dropShadowAlphaDisplay, state.alpha);
    assign(this._dropShadowDilationSlider, this._dropShadowDilationDisplay, state.dilation);
    assign(this._dropShadowBlurSlider, this._dropShadowBlurDisplay, state.blur);
    if (state.offset) {
      const disabled = !!state.offset.disabled;
      this._dropShadowOffsetMaxDistance = Number(state.offset.maxDistance) || this._dropShadowOffsetMaxDistance || 40;
      if (this._dropShadowOffsetControl) {
        this._dropShadowOffsetControl.dataset.maxDistance = String(this._dropShadowOffsetMaxDistance);
        this._dropShadowOffsetControl.dataset.disabled = disabled ? 'true' : 'false';
        this._dropShadowOffsetControl.classList.toggle('is-disabled', disabled);
      }
      if (disabled) this._releaseDropShadowOffsetPointer();
      if (this._dropShadowOffsetDistanceDisplay) {
        this._dropShadowOffsetDistanceDisplay.textContent = state.offset.displayDistance ?? '';
      }
      if (this._dropShadowOffsetAngleDisplay) {
      this._dropShadowOffsetAngleDisplay.textContent = state.offset.displayAngle ?? '';
      }
      this._positionDropShadowOffsetHandle(state.offset.distance, state.offset.angle, state.offset.maxDistance);
    }
    const presetEntries = Array.isArray(state.presets) ? state.presets : [];
    if (Array.isArray(this._dropShadowPresetButtons)) {
      for (const button of this._dropShadowPresetButtons) {
        const index = Number(button.dataset.faNexusDropShadowPreset);
        const entry = Number.isInteger(index) && presetEntries[index] ? presetEntries[index] : presetEntries.find?.((item) => item?.index === index);
        const saved = !!entry?.saved;
        const active = !!entry?.active;
        button.classList.toggle('is-empty', !saved);
        button.classList.toggle('is-active', active);
        button.disabled = !!state.disabled;
        button.title = entry?.tooltip || (saved ? 'Click to apply preset.' : 'Shift+Click to save preset.');
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    if (this._dropShadowResetButton) {
      this._dropShadowResetButton.disabled = !!state.disabled;
    }
    const context = state.context || {};
    if (this._dropShadowElevationDisplay) {
      if (context.display) {
        this._dropShadowElevationDisplay.textContent = `Elevation ${context.display}`;
        this._dropShadowElevationDisplay.classList.remove('is-hidden');
      } else {
        this._dropShadowElevationDisplay.textContent = '';
        this._dropShadowElevationDisplay.classList.add('is-hidden');
      }
    }
    if (this._dropShadowStatusDisplay) {
      this._dropShadowStatusDisplay.textContent = context.status || '';
      this._dropShadowStatusDisplay.classList.toggle('is-hidden', !context.status);
    }
    if (this._dropShadowNoteDisplay) {
      this._dropShadowNoteDisplay.textContent = context.note || '';
      this._dropShadowNoteDisplay.classList.toggle('is-hidden', !context.note);
    }
  }

  _handleDropShadowSlider(event, handlerName, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const value = target.value;
    const controller = this._controller;
    if (!controller) return;
    try {
      const result = controller.invokeToolHandler(handlerName, value, commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowCollapse(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try { controller.invokeToolHandler('toggleDropShadowCollapsed'); }
    catch (_) {}
  }

  _handleDropShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleDropShadowPreset', index, save);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusDropShadowPreset);
    if (!Number.isInteger(index)) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleDropShadowPreset', index, true);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetDropShadow');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetContext(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetDropShadowOffset');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowOffsetPointerDown(event) {
    if (!this._dropShadowOffsetControl || event.button !== 0) return;
    if (this._dropShadowOffsetControl.dataset.disabled === 'true') return;
    this._dropShadowOffsetPointerId = event.pointerId;
    this._dropShadowOffsetPointerActive = true;
    try { this._dropShadowOffsetControl.setPointerCapture(event.pointerId); } catch (_) {}
    window.addEventListener('pointermove', this._boundDropShadowOffsetPointerMove, { passive: false });
    window.addEventListener('pointerup', this._boundDropShadowOffsetPointerUp, { passive: false });
    window.addEventListener('pointercancel', this._boundDropShadowOffsetPointerUp, { passive: false });
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, false);
  }

  _handleDropShadowOffsetPointerMove(event) {
    if (!this._dropShadowOffsetPointerActive) return;
    if (this._dropShadowOffsetPointerId !== null && event.pointerId !== this._dropShadowOffsetPointerId) return;
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, false);
  }

  _handleDropShadowOffsetPointerUp(event) {
    if (!this._dropShadowOffsetPointerActive) return;
    if (this._dropShadowOffsetPointerId !== null && event.pointerId !== this._dropShadowOffsetPointerId) return;
    event.preventDefault();
    this._updateDropShadowOffsetFromPointer(event, true);
    this._releaseDropShadowOffsetPointer();
  }

  _releaseDropShadowOffsetPointer() {
    if (this._dropShadowOffsetPointerId !== null && this._dropShadowOffsetControl) {
      try { this._dropShadowOffsetControl.releasePointerCapture(this._dropShadowOffsetPointerId); } catch (_) {}
    }
    window.removeEventListener('pointermove', this._boundDropShadowOffsetPointerMove, false);
    window.removeEventListener('pointerup', this._boundDropShadowOffsetPointerUp, false);
    window.removeEventListener('pointercancel', this._boundDropShadowOffsetPointerUp, false);
    this._dropShadowOffsetPointerId = null;
    this._dropShadowOffsetPointerActive = false;
  }

  _updateDropShadowOffsetFromPointer(event, commit) {
    if (!this._dropShadowOffsetCircle || !this._controller) return;
    const rect = this._dropShadowOffsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const maxDistance = this._dropShadowOffsetMaxDistance || 40;
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    const distance = Math.min(maxDistance, Math.max(0, radial * maxDistance));
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (!Number.isFinite(angle)) angle = 0;
    angle = (angle + 360) % 360;
    this._positionDropShadowOffsetHandle(distance, angle, maxDistance);
    const result = this._controller.invokeToolHandler('setDropShadowOffset', distance, angle, !!commit);
    if (result?.then) {
      result.catch(() => {}).finally(() => this._syncDropShadowControls());
    } else {
      this._syncDropShadowControls();
    }
  }

  _positionDropShadowOffsetHandle(distance, angle, maxDistance) {
    if (!this._dropShadowOffsetHandle || !this._dropShadowOffsetCircle) return;
    const rect = this._dropShadowOffsetCircle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const radius = Math.min(rect.width, rect.height) / 2;
    if (radius <= 0) return;
    const effectiveMax = Number(maxDistance) || this._dropShadowOffsetMaxDistance || 40;
    const ratio = effectiveMax > 0 ? Math.min(1, Math.max(0, distance / effectiveMax)) : 0;
    const theta = (Number(angle) || 0) * (Math.PI / 180);
    const offsetX = Math.cos(theta) * radius * ratio;
    const offsetY = Math.sin(theta) * radius * ratio;
    this._dropShadowOffsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-x', `${offsetX}px`);
    this._dropShadowOffsetHandle.style.setProperty('--fa-nexus-drop-shadow-offset-y', `${offsetY}px`);
  }

  _bindTextureToolControls() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-tools-root]') || null;
    if (!root) {
      this._unbindTextureToolControls();
      return;
    }
    this._textureToolsRoot = root;
    this._textureModeLabel = root.querySelector('[data-fa-nexus-texture-mode-label]') || null;
    this._textureStatusDisplay = root.querySelector('[data-fa-nexus-texture-status]') || null;
    this._textureHintDisplay = root.querySelector('[data-fa-nexus-texture-hint]') || null;
    this._textureActionsRoot = root.querySelector('.fa-nexus-texture-tools__actions') || null;

    const modeButtons = Array.from(root.querySelectorAll('[data-fa-nexus-texture-mode]'));
    this._textureModeButtons = modeButtons;
    this._textureModeButtonMap = new Map();
    for (const button of modeButtons) {
      button.addEventListener('click', this._boundTextureModeClick);
      const id = button.dataset?.faNexusTextureMode || '';
      if (id) this._textureModeButtonMap.set(id, button);
    }

    const actionButtons = Array.from(root.querySelectorAll('[data-fa-nexus-texture-action]'));
    this._textureActionButtons = actionButtons;
    this._textureActionButtonMap = new Map();
    for (const button of actionButtons) {
      button.addEventListener('click', this._boundTextureActionClick);
      const id = button.dataset?.faNexusTextureAction || '';
      if (id) this._textureActionButtonMap.set(id, button);
    }

    this._syncTextureToolControls();
  }

  _unbindTextureToolControls() {
    if (this._textureModeButtons?.length) {
      for (const button of this._textureModeButtons) {
        try { button.removeEventListener('click', this._boundTextureModeClick); }
        catch (_) {}
      }
    }
    if (this._textureActionButtons?.length) {
      for (const button of this._textureActionButtons) {
        try { button.removeEventListener('click', this._boundTextureActionClick); }
        catch (_) {}
      }
    }
    this._textureModeButtons = [];
    this._textureModeButtonMap = new Map();
    this._textureActionButtons = [];
    this._textureActionButtonMap = new Map();
    this._textureToolsRoot = null;
    this._textureModeLabel = null;
    this._textureStatusDisplay = null;
    this._textureHintDisplay = null;
    this._textureActionsRoot = null;
  }

  _syncTextureToolControls() {
    if (!this._textureToolsRoot) return;
    const state = this._toolOptionState?.texturePaint || {};
    if (!state.available) {
      this._textureToolsRoot.hidden = true;
      return;
    }
    this._textureToolsRoot.hidden = false;
    if (this._textureModeLabel) {
      const label = state.modeLabel || '';
      if (this._textureModeLabel.textContent !== label) this._textureModeLabel.textContent = label;
    }
    if (this._textureStatusDisplay) {
      const status = state.status || '';
      this._textureStatusDisplay.textContent = status;
      this._textureStatusDisplay.hidden = !status;
    }
    if (this._textureHintDisplay) {
      const hint = state.hint || '';
      this._textureHintDisplay.textContent = hint;
      this._textureHintDisplay.hidden = !hint;
    }
    const modes = Array.isArray(state.modes) ? state.modes : [];
    for (const [id, button] of this._textureModeButtonMap.entries()) {
      const modeState = modes.find((mode) => mode.id === id) || null;
      if (!modeState) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      button.disabled = !!modeState.disabled;
      button.classList.toggle('is-active', !!modeState.active);
      button.setAttribute('aria-pressed', modeState.active ? 'true' : 'false');
      if (modeState.tooltip) button.title = modeState.tooltip;
      else button.removeAttribute('title');
      const labelEl = button.querySelector('span');
      if (labelEl && modeState.label && labelEl.textContent !== modeState.label) {
        labelEl.textContent = modeState.label;
      }
    }
    if (this._textureActionsRoot) {
      const hasActions = Array.isArray(state.actions) && state.actions.length > 0;
      this._textureActionsRoot.hidden = !hasActions;
    }
    const actions = Array.isArray(state.actions) ? state.actions : [];
    for (const [id, button] of this._textureActionButtonMap.entries()) {
      const actionState = actions.find((action) => action.id === id) || null;
      if (!actionState) {
        button.hidden = true;
        continue;
      }
      button.hidden = false;
      button.disabled = !!actionState.disabled;
      button.classList.toggle('is-primary', !!actionState.primary);
      if (actionState.tooltip) button.title = actionState.tooltip;
      else button.removeAttribute('title');
      const labelEl = button.querySelector('span');
      if (labelEl && actionState.label && labelEl.textContent !== actionState.label) {
        labelEl.textContent = actionState.label;
      }
    }
  }

  _handleTextureModeClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusTextureMode;
    if (!id) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureMode', id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureToolControls());
      } else {
        this._syncTextureToolControls();
      }
    } catch (_) {
      this._syncTextureToolControls();
    }
  }

  _handleTextureActionClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusTextureAction;
    if (!id) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handleTextureAction', id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureToolControls());
      } else {
        this._syncTextureToolControls();
      }
    } catch (_) {
      this._syncTextureToolControls();
    }
  }

  _bindTextureOpacityControl() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-opacity-root]') || null;
    if (!root) {
      this._unbindTextureOpacityControl();
      return;
    }
    this._textureOpacityRoot = root;
    const slider = root.querySelector('[data-fa-nexus-texture-opacity]');
    if (slider) {
      slider.addEventListener('input', this._boundTextureOpacityInput);
      slider.addEventListener('change', this._boundTextureOpacityCommit);
      this._textureOpacitySlider = slider;
    }
    this._textureOpacityDisplay = root.querySelector('[data-fa-nexus-texture-opacity-display]') || null;
    this._syncTextureOpacityControl();
  }

  _bindTextureLayerControl() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-layer-root]') || null;
    if (!root) {
      this._unbindTextureLayerControl();
      return;
    }
    this._textureLayerRoot = root;
    const slider = root.querySelector('[data-fa-nexus-texture-layer]');
    if (slider) {
      slider.addEventListener('input', this._boundTextureLayerInput);
      slider.addEventListener('change', this._boundTextureLayerCommit);
      this._textureLayerSlider = slider;
    }
    this._textureLayerDisplay = root.querySelector('[data-fa-nexus-texture-layer-display]') || null;
    this._syncTextureLayerControl();
  }

  _bindTextureOffsetControls() {
    const root = this.element?.querySelector('[data-fa-nexus-texture-offset-root]') || null;
    if (!root) {
      this._unbindTextureOffsetControls();
      return;
    }
    this._textureOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-texture-offset-x]');
    if (xSlider) {
      xSlider.addEventListener('input', this._boundTextureOffsetXInput);
      xSlider.addEventListener('change', this._boundTextureOffsetXCommit);
      this._textureOffsetXSlider = xSlider;
    }
    const ySlider = root.querySelector('[data-fa-nexus-texture-offset-y]');
    if (ySlider) {
      ySlider.addEventListener('input', this._boundTextureOffsetYInput);
      ySlider.addEventListener('change', this._boundTextureOffsetYCommit);
      this._textureOffsetYSlider = ySlider;
    }
    this._textureOffsetXDisplay = root.querySelector('[data-fa-nexus-texture-offset-x-display]') || null;
    this._textureOffsetYDisplay = root.querySelector('[data-fa-nexus-texture-offset-y-display]') || null;
    this._syncTextureOffsetControls();
  }

  _unbindTextureOpacityControl() {
    if (this._textureOpacitySlider) {
      try {
        this._textureOpacitySlider.removeEventListener('input', this._boundTextureOpacityInput);
        this._textureOpacitySlider.removeEventListener('change', this._boundTextureOpacityCommit);
      } catch (_) {}
    }
    this._textureOpacityRoot = null;
    this._textureOpacitySlider = null;
    this._textureOpacityDisplay = null;
  }

  _unbindTextureLayerControl() {
    if (this._textureLayerSlider) {
      try {
        this._textureLayerSlider.removeEventListener('input', this._boundTextureLayerInput);
        this._textureLayerSlider.removeEventListener('change', this._boundTextureLayerCommit);
      } catch (_) {}
    }
    this._textureLayerRoot = null;
    this._textureLayerSlider = null;
    this._textureLayerDisplay = null;
  }

  _unbindTextureOffsetControls() {
    if (this._textureOffsetXSlider) {
      try {
        this._textureOffsetXSlider.removeEventListener('input', this._boundTextureOffsetXInput);
        this._textureOffsetXSlider.removeEventListener('change', this._boundTextureOffsetXCommit);
      } catch (_) {}
    }
    if (this._textureOffsetYSlider) {
      try {
        this._textureOffsetYSlider.removeEventListener('input', this._boundTextureOffsetYInput);
        this._textureOffsetYSlider.removeEventListener('change', this._boundTextureOffsetYCommit);
      } catch (_) {}
    }
    this._textureOffsetRoot = null;
    this._textureOffsetXSlider = null;
    this._textureOffsetYSlider = null;
    this._textureOffsetXDisplay = null;
    this._textureOffsetYDisplay = null;
  }

  _syncTextureOpacityControl() {
    if (!this._textureOpacityRoot) return;
    const state = this._toolOptionState?.texturePaint?.opacity || { available: false };
    if (!state.available) {
      this._textureOpacityRoot.hidden = true;
      return;
    }
    this._textureOpacityRoot.hidden = false;
    if (this._textureOpacitySlider) {
      if (state.min !== undefined) this._textureOpacitySlider.min = String(state.min);
      if (state.max !== undefined) this._textureOpacitySlider.max = String(state.max);
      if (state.step !== undefined) this._textureOpacitySlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._textureOpacitySlider.value !== nextValue) this._textureOpacitySlider.value = nextValue;
      }
      this._textureOpacitySlider.disabled = !!state.disabled;
    }
    if (this._textureOpacityDisplay) {
      const display = state.display || '';
      if (this._textureOpacityDisplay.textContent !== display) this._textureOpacityDisplay.textContent = display;
    }
  }

  _syncTextureLayerControl() {
    if (!this._textureLayerRoot) return;
    const state = this._toolOptionState?.layerOpacity || { available: false };
    if (!state.available) {
      this._textureLayerRoot.hidden = true;
      return;
    }
    this._textureLayerRoot.hidden = false;
    if (this._textureLayerSlider) {
      if (state.min !== undefined) this._textureLayerSlider.min = String(state.min);
      if (state.max !== undefined) this._textureLayerSlider.max = String(state.max);
      if (state.step !== undefined) this._textureLayerSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._textureLayerSlider.value !== nextValue) this._textureLayerSlider.value = nextValue;
      }
    }
    if (this._textureLayerDisplay) {
      const display = state.display || '';
      if (this._textureLayerDisplay.textContent !== display) this._textureLayerDisplay.textContent = display;
    }
  }

  _syncTextureOffsetControls() {
    if (!this._textureOffsetRoot) return;
    const state = this._toolOptionState?.textureOffset || { available: false };
    if (!state.available) {
      this._textureOffsetRoot.hidden = true;
      return;
    }
    this._textureOffsetRoot.hidden = false;
    if (this._textureOffsetXSlider) {
      if (state.x?.min !== undefined) this._textureOffsetXSlider.min = String(state.x.min);
      if (state.x?.max !== undefined) this._textureOffsetXSlider.max = String(state.x.max);
      if (state.x?.step !== undefined) this._textureOffsetXSlider.step = String(state.x.step);
      if (state.x?.value !== undefined) {
        const nextX = String(state.x.value);
        if (this._textureOffsetXSlider.value !== nextX) this._textureOffsetXSlider.value = nextX;
      }
      this._textureOffsetXSlider.disabled = !!state.x?.disabled || !!state.disabled;
    }
    if (this._textureOffsetYSlider) {
      if (state.y?.min !== undefined) this._textureOffsetYSlider.min = String(state.y.min);
      if (state.y?.max !== undefined) this._textureOffsetYSlider.max = String(state.y.max);
      if (state.y?.step !== undefined) this._textureOffsetYSlider.step = String(state.y.step);
      if (state.y?.value !== undefined) {
        const nextY = String(state.y.value);
        if (this._textureOffsetYSlider.value !== nextY) this._textureOffsetYSlider.value = nextY;
      }
      this._textureOffsetYSlider.disabled = !!state.y?.disabled || !!state.disabled;
    }
    if (this._textureOffsetXDisplay) {
      const text = state.x?.display || '';
      if (this._textureOffsetXDisplay.textContent !== text) this._textureOffsetXDisplay.textContent = text;
    }
    if (this._textureOffsetYDisplay) {
      const text = state.y?.display || '';
      if (this._textureOffsetYDisplay.textContent !== text) this._textureOffsetYDisplay.textContent = text;
    }
  }

  _bindPathAppearanceControls() {
    this._bindPathOpacityControl();
    this._bindPathScaleControl();
    this._bindPathOffsetControls();
    this._bindPathTensionControls();
    this._syncPathAppearanceControls();
  }

  _unbindPathAppearanceControls() {
    this._unbindPathOpacityControl();
    this._unbindPathScaleControl();
    this._unbindPathOffsetControls();
    this._unbindPathTensionControls();
  }

  _syncPathAppearanceControls() {
    this._syncPathOpacityControl();
    this._syncPathScaleControl();
    this._syncPathOffsetControls();
    this._syncPathTensionControls();
  }

  _bindPathOpacityControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-opacity-root]') || null;
    if (!root) {
      this._unbindPathOpacityControl();
      return;
    }
    this._pathOpacityRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-opacity]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathOpacityInput);
      slider.addEventListener('change', this._boundPathOpacityCommit);
    }
    this._pathOpacitySlider = slider;
    this._pathOpacityDisplay = root.querySelector('[data-fa-nexus-path-opacity-display]') || null;
  }

  _unbindPathOpacityControl() {
    if (this._pathOpacitySlider) {
      try { this._pathOpacitySlider.removeEventListener('input', this._boundPathOpacityInput); } catch (_) {}
      try { this._pathOpacitySlider.removeEventListener('change', this._boundPathOpacityCommit); } catch (_) {}
    }
    this._pathOpacityRoot = null;
    this._pathOpacitySlider = null;
    this._pathOpacityDisplay = null;
  }

  _syncPathOpacityControl() {
    if (!this._pathOpacityRoot) return;
    const state = this._toolOptionState?.pathAppearance?.layerOpacity || { available: false };
    if (!state.available) {
      this._pathOpacityRoot.hidden = true;
      return;
    }
    this._pathOpacityRoot.hidden = false;
    if (this._pathOpacitySlider) {
      if (state.min !== undefined) this._pathOpacitySlider.min = String(state.min);
      if (state.max !== undefined) this._pathOpacitySlider.max = String(state.max);
      if (state.step !== undefined) this._pathOpacitySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathOpacitySlider.value !== next) this._pathOpacitySlider.value = next;
      }
      this._pathOpacitySlider.disabled = !!state.disabled;
    }
    if (this._pathOpacityDisplay) {
      const text = state.display || '';
      if (this._pathOpacityDisplay.textContent !== text) this._pathOpacityDisplay.textContent = text;
    }
  }

  _handlePathOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setLayerOpacity', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOpacityControl());
      else this._syncPathOpacityControl();
    } catch (_) {
      this._syncPathOpacityControl();
    }
  }

  _bindPathScaleControl() {
    const root = this.element?.querySelector('[data-fa-nexus-path-scale-root]') || null;
    if (!root) {
      this._unbindPathScaleControl();
      return;
    }
    this._pathScaleRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-scale]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathScaleInput);
      slider.addEventListener('change', this._boundPathScaleCommit);
    }
    this._pathScaleSlider = slider;
    this._pathScaleDisplay = root.querySelector('[data-fa-nexus-path-scale-display]') || null;
  }

  _unbindPathScaleControl() {
    if (this._pathScaleSlider) {
      try { this._pathScaleSlider.removeEventListener('input', this._boundPathScaleInput); } catch (_) {}
      try { this._pathScaleSlider.removeEventListener('change', this._boundPathScaleCommit); } catch (_) {}
    }
    this._pathScaleRoot = null;
    this._pathScaleSlider = null;
    this._pathScaleDisplay = null;
  }

  _syncPathScaleControl() {
    if (!this._pathScaleRoot) return;
    const state = this._toolOptionState?.pathAppearance?.scale || { available: false };
    if (!state.available) {
      this._pathScaleRoot.hidden = true;
      return;
    }
    this._pathScaleRoot.hidden = false;
    if (this._pathScaleSlider) {
      if (state.min !== undefined) this._pathScaleSlider.min = String(state.min);
      if (state.max !== undefined) this._pathScaleSlider.max = String(state.max);
      if (state.step !== undefined) this._pathScaleSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathScaleSlider.value !== next) this._pathScaleSlider.value = next;
      }
      this._pathScaleSlider.disabled = !!state.disabled;
    }
    if (this._pathScaleDisplay) {
      const text = state.display || '';
      if (this._pathScaleDisplay.textContent !== text) this._pathScaleDisplay.textContent = text;
    }
  }

  _handlePathScale(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setPathScale', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathScaleControl());
      else this._syncPathScaleControl();
    } catch (_) {
      this._syncPathScaleControl();
    }
  }

  _bindPathOffsetControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-offset-root]') || null;
    if (!root) {
      this._unbindPathOffsetControls();
      return;
    }
    this._pathOffsetRoot = root;
    const xSlider = root.querySelector('[data-fa-nexus-path-offset-x]') || null;
    if (xSlider) {
      xSlider.addEventListener('input', this._boundPathOffsetXInput);
      xSlider.addEventListener('change', this._boundPathOffsetXCommit);
    }
    this._pathOffsetXSlider = xSlider;
    const ySlider = root.querySelector('[data-fa-nexus-path-offset-y]') || null;
    if (ySlider) {
      ySlider.addEventListener('input', this._boundPathOffsetYInput);
      ySlider.addEventListener('change', this._boundPathOffsetYCommit);
    }
    this._pathOffsetYSlider = ySlider;
    this._pathOffsetXDisplay = root.querySelector('[data-fa-nexus-path-offset-x-display]') || null;
    this._pathOffsetYDisplay = root.querySelector('[data-fa-nexus-path-offset-y-display]') || null;
  }

  _unbindPathOffsetControls() {
    if (this._pathOffsetXSlider) {
      try { this._pathOffsetXSlider.removeEventListener('input', this._boundPathOffsetXInput); } catch (_) {}
      try { this._pathOffsetXSlider.removeEventListener('change', this._boundPathOffsetXCommit); } catch (_) {}
    }
    if (this._pathOffsetYSlider) {
      try { this._pathOffsetYSlider.removeEventListener('input', this._boundPathOffsetYInput); } catch (_) {}
      try { this._pathOffsetYSlider.removeEventListener('change', this._boundPathOffsetYCommit); } catch (_) {}
    }
    this._pathOffsetRoot = null;
    this._pathOffsetXSlider = null;
    this._pathOffsetYSlider = null;
    this._pathOffsetXDisplay = null;
    this._pathOffsetYDisplay = null;
  }

  _syncPathOffsetControls() {
    if (!this._pathOffsetRoot) return;
    const state = this._toolOptionState?.pathAppearance?.textureOffset || { available: false };
    if (!state.available) {
      this._pathOffsetRoot.hidden = true;
      return;
    }
    this._pathOffsetRoot.hidden = false;
    if (this._pathOffsetXSlider) {
      const x = state.x || {};
      if (x.min !== undefined) this._pathOffsetXSlider.min = String(x.min);
      if (x.max !== undefined) this._pathOffsetXSlider.max = String(x.max);
      if (x.step !== undefined) this._pathOffsetXSlider.step = String(x.step);
      if (x.value !== undefined) {
        const next = String(x.value);
        if (this._pathOffsetXSlider.value !== next) this._pathOffsetXSlider.value = next;
      }
      this._pathOffsetXSlider.disabled = !!x.disabled || !!state.disabled;
    }
    if (this._pathOffsetYSlider) {
      const y = state.y || {};
      if (y.min !== undefined) this._pathOffsetYSlider.min = String(y.min);
      if (y.max !== undefined) this._pathOffsetYSlider.max = String(y.max);
      if (y.step !== undefined) this._pathOffsetYSlider.step = String(y.step);
      if (y.value !== undefined) {
        const next = String(y.value);
        if (this._pathOffsetYSlider.value !== next) this._pathOffsetYSlider.value = next;
      }
      this._pathOffsetYSlider.disabled = !!y.disabled || !!state.disabled;
    }
    if (this._pathOffsetXDisplay) {
      const text = state.x?.display || '';
      if (this._pathOffsetXDisplay.textContent !== text) this._pathOffsetXDisplay.textContent = text;
    }
    if (this._pathOffsetYDisplay) {
      const text = state.y?.display || '';
      if (this._pathOffsetYDisplay.textContent !== text) this._pathOffsetYDisplay.textContent = text;
    }
  }

  _handlePathOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOffset', axis, value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathOffsetControls());
      else this._syncPathOffsetControls();
    } catch (_) {
      this._syncPathOffsetControls();
    }
  }

  _bindPathTensionControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-tension-root]') || null;
    if (!root) {
      this._unbindPathTensionControls();
      return;
    }
    this._pathTensionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-tension]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathTensionInput);
      slider.addEventListener('change', this._boundPathTensionCommit);
    }
    this._pathTensionSlider = slider;
    this._pathTensionDisplay = root.querySelector('[data-fa-nexus-path-tension-display]') || null;
  }

  _unbindPathTensionControls() {
    if (this._pathTensionSlider) {
      try { this._pathTensionSlider.removeEventListener('input', this._boundPathTensionInput); } catch (_) {}
      try { this._pathTensionSlider.removeEventListener('change', this._boundPathTensionCommit); } catch (_) {}
    }
    this._pathTensionRoot = null;
    this._pathTensionSlider = null;
    this._pathTensionDisplay = null;
  }

  _syncPathTensionControls() {
    if (!this._pathTensionRoot) return;
    const state = this._toolOptionState?.pathAppearance?.tension || { available: false };
    if (!state.available) {
      this._pathTensionRoot.hidden = true;
      return;
    }
    this._pathTensionRoot.hidden = false;
    if (this._pathTensionSlider) {
      if (state.min !== undefined) this._pathTensionSlider.min = String(state.min);
      if (state.max !== undefined) this._pathTensionSlider.max = String(state.max);
      if (state.step !== undefined) this._pathTensionSlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathTensionSlider.value !== next) this._pathTensionSlider.value = next;
      }
      this._pathTensionSlider.disabled = !!state.disabled;
    }
    if (this._pathTensionDisplay) {
      const text = state.display || '';
      if (this._pathTensionDisplay.textContent !== text) this._pathTensionDisplay.textContent = text;
    }
  }

  _handlePathTension(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setPathTensionValue', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathTensionControls());
      else this._syncPathTensionControls();
    } catch (_) {
      this._syncPathTensionControls();
    }
  }

  _handleTextureOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOpacity', value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureOpacityControl());
      } else {
        this._syncTextureOpacityControl();
      }
    } catch (_) {
      this._syncTextureOpacityControl();
    }
  }

  _handleTextureOffset(event, axis, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setTextureOffset', axis, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureOffsetControls());
      } else {
        this._syncTextureOffsetControls();
      }
    } catch (_) {
      this._syncTextureOffsetControls();
    }
  }

  _handleTextureLayerOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setLayerOpacity', value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncTextureLayerControl());
      } else {
        this._syncTextureLayerControl();
      }
    } catch (_) {
      this._syncTextureLayerControl();
    }
  }

  _bindFlipControls() {
    const root = this.element?.querySelector('[data-fa-nexus-flip-root]') || null;
    if (!root) {
      this._unbindFlipControls();
      return;
    }
    this._flipRoot = root;
    this._flipDisplay = root.querySelector('[data-fa-nexus-flip-display]') || null;
    this._flipPreviewDisplay = root.querySelector('[data-fa-nexus-flip-preview]') || null;

    const horizontalButton = root.querySelector('[data-fa-nexus-flip-horizontal]');
    if (horizontalButton) {
      horizontalButton.addEventListener('click', this._boundFlipHorizontal);
      this._flipHorizontalButton = horizontalButton;
    }
    const horizontalRandomButton = root.querySelector('[data-fa-nexus-flip-horizontal-random]');
    if (horizontalRandomButton) {
      horizontalRandomButton.addEventListener('click', this._boundFlipHorizontalRandom);
      this._flipHorizontalRandomButton = horizontalRandomButton;
    }
    const verticalButton = root.querySelector('[data-fa-nexus-flip-vertical]');
    if (verticalButton) {
      verticalButton.addEventListener('click', this._boundFlipVertical);
      this._flipVerticalButton = verticalButton;
    }
    const verticalRandomButton = root.querySelector('[data-fa-nexus-flip-vertical-random]');
    if (verticalRandomButton) {
      verticalRandomButton.addEventListener('click', this._boundFlipVerticalRandom);
      this._flipVerticalRandomButton = verticalRandomButton;
    }

    this._syncFlipControls();
  }

  _unbindFlipControls() {
    if (this._flipHorizontalButton) {
      try { this._flipHorizontalButton.removeEventListener('click', this._boundFlipHorizontal); } catch (_) {}
    }
    if (this._flipHorizontalRandomButton) {
      try { this._flipHorizontalRandomButton.removeEventListener('click', this._boundFlipHorizontalRandom); } catch (_) {}
    }
    if (this._flipVerticalButton) {
      try { this._flipVerticalButton.removeEventListener('click', this._boundFlipVertical); } catch (_) {}
    }
    if (this._flipVerticalRandomButton) {
      try { this._flipVerticalRandomButton.removeEventListener('click', this._boundFlipVerticalRandom); } catch (_) {}
    }
    this._flipRoot = null;
    this._flipDisplay = null;
    this._flipPreviewDisplay = null;
    this._flipHorizontalButton = null;
    this._flipVerticalButton = null;
    this._flipHorizontalRandomButton = null;
    this._flipVerticalRandomButton = null;
  }

  _syncFlipControls() {
    if (!this._flipRoot) return;
    const state = this._toolOptionState?.flip || {};
    if (!state.available) {
      this._flipRoot.hidden = true;
      return;
    }
    this._flipRoot.hidden = false;
    if (this._flipDisplay) {
      const text = state.display || 'None';
      if (this._flipDisplay.textContent !== text) this._flipDisplay.textContent = text;
    }
    if (this._flipPreviewDisplay) {
      const preview = state.previewDisplay || '';
      if (preview) {
        this._flipPreviewDisplay.textContent = preview;
        this._flipPreviewDisplay.hidden = false;
      } else {
        this._flipPreviewDisplay.textContent = '';
        this._flipPreviewDisplay.hidden = true;
      }
    }
    const horizontal = state.horizontal || {};
    const vertical = state.vertical || {};
    const syncAxisButton = (button, axisState) => {
      if (!button || !axisState) return;
      const active = !!axisState.active;
      const previewDiff = !!axisState.previewDiff;
      const aria = axisState.aria || axisState.label || 'Toggle mirroring';
      const tooltip = axisState.tooltip || '';
      button.classList.toggle('is-active', active);
      button.classList.toggle('has-preview-diff', previewDiff);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.disabled;
      const labelSpan = button.querySelector('span');
      if (labelSpan && axisState.label && labelSpan.textContent !== axisState.label) {
        labelSpan.textContent = axisState.label;
      }
    };
    const syncAxisRandomButton = (button, axisState, defaultAria) => {
      if (!button || !axisState) return;
      const enabled = !!axisState.randomEnabled;
      const label = axisState.randomLabel || 'Random';
      const tooltip = axisState.randomTooltip || '';
      const aria = axisState.randomAria || defaultAria;
      button.classList.toggle('is-active', enabled);
      button.classList.toggle('has-preview-diff', !!axisState.randomPreviewDiff);
      button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      button.setAttribute('aria-label', aria);
      if (tooltip) button.title = tooltip;
      else button.removeAttribute('title');
      button.disabled = !!axisState.randomDisabled;
      const labelSpan = button.querySelector('span');
      if (labelSpan && labelSpan.textContent !== label) {
        labelSpan.textContent = label;
      }
    };

    if (this._flipHorizontalButton) {
      syncAxisButton(this._flipHorizontalButton, horizontal);
    }
    if (this._flipHorizontalRandomButton) {
      syncAxisRandomButton(this._flipHorizontalRandomButton, horizontal, 'Toggle random horizontal mirroring');
    }
    if (this._flipVerticalButton) {
      syncAxisButton(this._flipVerticalButton, vertical);
    }
    if (this._flipVerticalRandomButton) {
      syncAxisRandomButton(this._flipVerticalRandomButton, vertical, 'Toggle random vertical mirroring');
    }
  }

  _bindScaleControls() {
    const root = this.element?.querySelector('[data-fa-nexus-scale-root]') || null;
    if (!root) {
      this._unbindScaleControls();
      return;
    }
    this._scaleRoot = root;
    this._scaleDisplay = root.querySelector('[data-fa-nexus-scale-display]') || null;

    const baseSlider = root.querySelector('[data-fa-nexus-scale-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundScaleInput);
      baseSlider.addEventListener('change', this._boundScaleInput);
      this._scaleBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-scale-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundScaleRandom);
      this._scaleRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-scale-strength-row]') || null;
    this._scaleStrengthRow = strengthRow;

    const strengthSlider = root.querySelector('[data-fa-nexus-scale-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundScaleStrength);
      strengthSlider.addEventListener('change', this._boundScaleStrength);
      this._scaleStrengthSlider = strengthSlider;
    }
    this._scaleStrengthDisplay = root.querySelector('[data-fa-nexus-scale-strength-label]') || null;

    this._syncScaleControls();
  }

  _unbindScaleControls() {
    if (this._scaleBaseSlider) {
      try {
        this._scaleBaseSlider.removeEventListener('input', this._boundScaleInput);
        this._scaleBaseSlider.removeEventListener('change', this._boundScaleInput);
      } catch (_) {}
    }
    if (this._scaleStrengthSlider) {
      try {
        this._scaleStrengthSlider.removeEventListener('input', this._boundScaleStrength);
        this._scaleStrengthSlider.removeEventListener('change', this._boundScaleStrength);
      } catch (_) {}
    }
    if (this._scaleRandomButton) {
      try { this._scaleRandomButton.removeEventListener('click', this._boundScaleRandom); }
      catch (_) {}
    }
    this._scaleRoot = null;
    this._scaleDisplay = null;
    this._scaleBaseSlider = null;
    this._scaleRandomButton = null;
    this._scaleStrengthRow = null;
    this._scaleStrengthSlider = null;
    this._scaleStrengthDisplay = null;
  }

  _syncScaleControls() {
    if (!this._scaleRoot) return;
    const state = this._toolOptionState?.scale || {};
    if (this._scaleDisplay) {
      const text = state.display || '';
      if (this._scaleDisplay.textContent !== text) this._scaleDisplay.textContent = text;
    }
    if (this._scaleBaseSlider) {
      if (state.min !== undefined) this._scaleBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._scaleBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._scaleBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._scaleBaseSlider.value !== nextValue) this._scaleBaseSlider.value = nextValue;
      }
      this._scaleBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._scaleRandomButton) {
      this._scaleRandomButton.hidden = !randomVisible;
      this._scaleRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._scaleRandomButton.classList.toggle('is-active', active);
      this._scaleRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._scaleRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._scaleRandomButton.title = state.randomTooltip;
      const labelSpan = this._scaleRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._scaleStrengthRow) {
      this._scaleStrengthRow.hidden = !strengthVisible;
    }
    if (this._scaleStrengthSlider) {
      if (state.strengthMin !== undefined) this._scaleStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._scaleStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._scaleStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._scaleStrengthSlider.value !== nextStrength) this._scaleStrengthSlider.value = nextStrength;
      }
      this._scaleStrengthSlider.disabled = !strengthVisible;
    }
    if (this._scaleStrengthDisplay) {
      const text = state.strengthDisplay || '';
      if (this._scaleStrengthDisplay.textContent !== text) this._scaleStrengthDisplay.textContent = text;
    }
  }

  _handleFlipHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontal');
  }

  _handleFlipVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVertical');
  }

  _handleFlipRandomHorizontal(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipHorizontalRandom');
  }

  _handleFlipRandomVertical(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('toggleFlipVerticalRandom');
  }

  _handleScaleInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setScale', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncScaleControls());
        } else {
          this._syncScaleControls();
        }
      } catch (_) {
        this._syncScaleControls();
      }
    }
  }

  _handleScaleStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setScaleRandomStrength', value);
    }
  }

  _handleScaleRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleScaleRandom');
    }
  }

  _bindRotationControls() {
    const root = this.element?.querySelector('[data-fa-nexus-rotation-root]') || null;
    if (!root) {
      this._unbindRotationControls();
      return;
    }
    this._rotationRoot = root;
    this._rotationDisplay = root.querySelector('[data-fa-nexus-rotation-display]') || null;

    const baseSlider = root.querySelector('[data-fa-nexus-rotation-base]');
    if (baseSlider) {
      baseSlider.addEventListener('input', this._boundRotationInput);
      baseSlider.addEventListener('change', this._boundRotationInput);
      this._rotationBaseSlider = baseSlider;
    }

    const randomButton = root.querySelector('[data-fa-nexus-rotation-random]');
    if (randomButton) {
      randomButton.addEventListener('click', this._boundRotationRandom);
      this._rotationRandomButton = randomButton;
    }

    const strengthRow = root.querySelector('[data-fa-nexus-rotation-strength-row]') || null;
    this._rotationStrengthRow = strengthRow;
    const strengthSlider = root.querySelector('[data-fa-nexus-rotation-strength]');
    if (strengthSlider) {
      strengthSlider.addEventListener('input', this._boundRotationStrength);
      strengthSlider.addEventListener('change', this._boundRotationStrength);
      this._rotationStrengthSlider = strengthSlider;
    }
    this._rotationStrengthDisplay = root.querySelector('[data-fa-nexus-rotation-strength-label]') || null;

    this._syncRotationControls();
  }

  _unbindRotationControls() {
    if (this._rotationBaseSlider) {
      try {
        this._rotationBaseSlider.removeEventListener('input', this._boundRotationInput);
        this._rotationBaseSlider.removeEventListener('change', this._boundRotationInput);
      } catch (_) {}
    }
    if (this._rotationStrengthSlider) {
      try {
        this._rotationStrengthSlider.removeEventListener('input', this._boundRotationStrength);
        this._rotationStrengthSlider.removeEventListener('change', this._boundRotationStrength);
      } catch (_) {}
    }
    if (this._rotationRandomButton) {
      try { this._rotationRandomButton.removeEventListener('click', this._boundRotationRandom); }
      catch (_) {}
    }
    this._rotationRoot = null;
    this._rotationDisplay = null;
    this._rotationBaseSlider = null;
    this._rotationRandomButton = null;
    this._rotationStrengthRow = null;
    this._rotationStrengthSlider = null;
    this._rotationStrengthDisplay = null;
  }

  _syncRotationControls() {
    if (!this._rotationRoot) return;
    const state = this._toolOptionState?.rotation || {};
    if (this._rotationDisplay) {
      const text = state.display || '';
      if (this._rotationDisplay.textContent !== text) this._rotationDisplay.textContent = text;
    }
    if (this._rotationBaseSlider) {
      if (state.min !== undefined) this._rotationBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._rotationBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._rotationBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._rotationBaseSlider.value !== nextValue) this._rotationBaseSlider.value = nextValue;
      }
      this._rotationBaseSlider.disabled = !!state.disabled;
    }
    const randomVisible = state.randomButtonVisible !== false;
    if (this._rotationRandomButton) {
      this._rotationRandomButton.hidden = !randomVisible;
      this._rotationRandomButton.classList.toggle('is-hidden', !randomVisible);
      const active = randomVisible && !!state.randomEnabled;
      this._rotationRandomButton.classList.toggle('is-active', active);
      this._rotationRandomButton.setAttribute('aria-pressed', active ? 'true' : 'false');
      this._rotationRandomButton.disabled = !randomVisible || !!state.disabled;
      if (state.randomTooltip) this._rotationRandomButton.title = state.randomTooltip;
      const labelSpan = this._rotationRandomButton.querySelector('span');
      if (labelSpan && state.randomLabel && labelSpan.textContent !== state.randomLabel) {
        labelSpan.textContent = state.randomLabel;
      }
    }
    const strengthVisible = randomVisible && !!state.randomEnabled;
    if (this._rotationStrengthRow) {
      this._rotationStrengthRow.hidden = !strengthVisible;
    }
    if (this._rotationStrengthSlider) {
      if (state.strengthMin !== undefined) this._rotationStrengthSlider.min = String(state.strengthMin);
      if (state.strengthMax !== undefined) this._rotationStrengthSlider.max = String(state.strengthMax);
      const step = state.strengthStep !== undefined ? state.strengthStep : 1;
      this._rotationStrengthSlider.step = String(step);
      if (state.strength !== undefined) {
        const nextStrength = String(state.strength);
        if (this._rotationStrengthSlider.value !== nextStrength) this._rotationStrengthSlider.value = nextStrength;
      }
      this._rotationStrengthSlider.disabled = !strengthVisible;
    }
    if (this._rotationStrengthDisplay) {
      const text = state.strengthDisplay || '';
      if (this._rotationStrengthDisplay.textContent !== text) this._rotationStrengthDisplay.textContent = text;
    }
  }

  _handleRotationInput(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const commit = event?.type === 'change';
    if (this._controller?.invokeToolHandler) {
      try {
        const result = this._controller.invokeToolHandler('setRotation', value, commit);
        if (result?.then) {
          result.catch(() => {}).finally(() => this._syncRotationControls());
        } else {
          this._syncRotationControls();
        }
      } catch (_) {
        this._syncRotationControls();
      }
    }
  }

  _handleRotationStrength(event) {
    const value = event?.currentTarget?.value ?? event?.target?.value;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setRotationRandomStrength', value);
    }
  }

  _handleRotationRandom(event) {
    event?.preventDefault?.();
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('toggleRotationRandom');
    }
  }

  _bindPathFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-feather]') || null;
    if (!root) {
      this._unbindPathFeatherControls();
      return;
    }
    this._pathFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-feather-start-toggle]') || null;
    const endToggle = root.querySelector('[data-fa-nexus-feather-end-toggle]') || null;
    if (startToggle) {
      startToggle.addEventListener('change', this._boundPathFeatherStartToggle);
      this._pathFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundPathFeatherEndToggle);
      this._pathFeatherEndToggle = endToggle;
    }
    this._pathFeatherStartSlider = root.querySelector('[data-fa-nexus-feather-start-length]') || null;
    this._pathFeatherEndSlider = root.querySelector('[data-fa-nexus-feather-end-length]') || null;
    if (this._pathFeatherStartSlider) {
      this._pathFeatherStartSlider.addEventListener('input', this._boundPathFeatherStartInput);
      this._pathFeatherStartSlider.addEventListener('change', this._boundPathFeatherStartCommit);
    }
    if (this._pathFeatherEndSlider) {
      this._pathFeatherEndSlider.addEventListener('input', this._boundPathFeatherEndInput);
      this._pathFeatherEndSlider.addEventListener('change', this._boundPathFeatherEndCommit);
    }
    this._pathFeatherStartValue = root.querySelector('[data-fa-nexus-feather-start-display]') || null;
    this._pathFeatherEndValue = root.querySelector('[data-fa-nexus-feather-end-display]') || null;
    this._pathFeatherHint = root.querySelector('[data-fa-nexus-feather-hint]') || null;
    this._syncPathFeatherControls();
  }

  _unbindPathFeatherControls() {
    if (this._pathFeatherStartToggle) {
      try { this._pathFeatherStartToggle.removeEventListener('change', this._boundPathFeatherStartToggle); }
      catch (_) {}
    }
    if (this._pathFeatherEndToggle) {
      try { this._pathFeatherEndToggle.removeEventListener('change', this._boundPathFeatherEndToggle); }
      catch (_) {}
    }
    if (this._pathFeatherStartSlider) {
      try {
        this._pathFeatherStartSlider.removeEventListener('input', this._boundPathFeatherStartInput);
        this._pathFeatherStartSlider.removeEventListener('change', this._boundPathFeatherStartCommit);
      } catch (_) {}
    }
    if (this._pathFeatherEndSlider) {
      try {
        this._pathFeatherEndSlider.removeEventListener('input', this._boundPathFeatherEndInput);
        this._pathFeatherEndSlider.removeEventListener('change', this._boundPathFeatherEndCommit);
      } catch (_) {}
    }
    this._pathFeatherRoot = null;
    this._pathFeatherStartToggle = null;
    this._pathFeatherEndToggle = null;
    this._pathFeatherStartSlider = null;
    this._pathFeatherEndSlider = null;
    this._pathFeatherStartValue = null;
    this._pathFeatherEndValue = null;
    this._pathFeatherHint = null;
  }

  _syncPathFeatherControls() {
    const state = this._toolOptionState?.pathFeather || { available: false };
    if (this._pathFeatherRoot) {
      this._pathFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._pathFeatherStartToggle && state.start) {
      this._pathFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._pathFeatherEndToggle && state.end) {
      this._pathFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._pathFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._pathFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherStartSlider.value !== next) this._pathFeatherStartSlider.value = next;
      }
      this._pathFeatherStartSlider.disabled = !!length.disabled;
      if (this._pathFeatherStartValue && length.display !== undefined) {
        this._pathFeatherStartValue.textContent = String(length.display);
      }
    }
    if (this._pathFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._pathFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._pathFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._pathFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._pathFeatherEndSlider.value !== next) this._pathFeatherEndSlider.value = next;
      }
      this._pathFeatherEndSlider.disabled = !!length.disabled;
      if (this._pathFeatherEndValue && length.display !== undefined) {
        this._pathFeatherEndValue.textContent = String(length.display);
      }
    }
    if (this._pathFeatherHint) {
      const text = state.hint || '';
      this._pathFeatherHint.textContent = text;
      this._pathFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handlePathFeatherToggle(event, endpoint) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherShrinkEnabled', endpoint, !!input.checked);
    }
  }

  _handlePathFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindOpacityFeatherControls() {
    const root = this.element?.querySelector('[data-fa-nexus-opacity-feather]') || null;
    if (!root) {
      this._unbindOpacityFeatherControls();
      return;
    }
    this._opacityFeatherRoot = root;
    const startToggle = root.querySelector('[data-fa-nexus-opacity-start-toggle]');
    const endToggle = root.querySelector('[data-fa-nexus-opacity-end-toggle]');
    if (startToggle) {
      startToggle.addEventListener('change', this._boundOpacityFeatherStartToggle);
      this._opacityFeatherStartToggle = startToggle;
    }
    if (endToggle) {
      endToggle.addEventListener('change', this._boundOpacityFeatherEndToggle);
      this._opacityFeatherEndToggle = endToggle;
    }
    const startSlider = root.querySelector('[data-fa-nexus-opacity-start-length]');
    const endSlider = root.querySelector('[data-fa-nexus-opacity-end-length]');
    if (startSlider) {
      startSlider.addEventListener('input', this._boundOpacityFeatherStartInput);
      startSlider.addEventListener('change', this._boundOpacityFeatherStartCommit);
      this._opacityFeatherStartSlider = startSlider;
    }
    if (endSlider) {
      endSlider.addEventListener('input', this._boundOpacityFeatherEndInput);
      endSlider.addEventListener('change', this._boundOpacityFeatherEndCommit);
      this._opacityFeatherEndSlider = endSlider;
    }
    this._opacityFeatherStartValue = root.querySelector('[data-fa-nexus-opacity-start-display]') || null;
    this._opacityFeatherEndValue = root.querySelector('[data-fa-nexus-opacity-end-display]') || null;
    this._opacityFeatherHint = root.querySelector('[data-fa-nexus-opacity-hint]') || null;
    this._syncOpacityFeatherControls();
  }

  _unbindOpacityFeatherControls() {
    if (this._opacityFeatherStartToggle) {
      try { this._opacityFeatherStartToggle.removeEventListener('change', this._boundOpacityFeatherStartToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherEndToggle) {
      try { this._opacityFeatherEndToggle.removeEventListener('change', this._boundOpacityFeatherEndToggle); }
      catch (_) {}
    }
    if (this._opacityFeatherStartSlider) {
      try {
        this._opacityFeatherStartSlider.removeEventListener('input', this._boundOpacityFeatherStartInput);
        this._opacityFeatherStartSlider.removeEventListener('change', this._boundOpacityFeatherStartCommit);
      } catch (_) {}
    }
    if (this._opacityFeatherEndSlider) {
      try {
        this._opacityFeatherEndSlider.removeEventListener('input', this._boundOpacityFeatherEndInput);
        this._opacityFeatherEndSlider.removeEventListener('change', this._boundOpacityFeatherEndCommit);
      } catch (_) {}
    }
    this._opacityFeatherRoot = null;
    this._opacityFeatherStartToggle = null;
    this._opacityFeatherEndToggle = null;
    this._opacityFeatherStartSlider = null;
    this._opacityFeatherEndSlider = null;
    this._opacityFeatherStartValue = null;
    this._opacityFeatherEndValue = null;
    this._opacityFeatherHint = null;
  }

  _syncOpacityFeatherControls() {
    const state = this._toolOptionState?.opacityFeather || { available: false };
    if (this._opacityFeatherRoot) {
      this._opacityFeatherRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    if (this._opacityFeatherStartToggle && state.start) {
      this._opacityFeatherStartToggle.checked = !!state.start.enabled;
    }
    if (this._opacityFeatherEndToggle && state.end) {
      this._opacityFeatherEndToggle.checked = !!state.end.enabled;
    }
    if (this._opacityFeatherStartSlider && state.start?.length) {
      const length = state.start.length;
      if (length.min !== undefined) this._opacityFeatherStartSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherStartSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherStartSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherStartSlider.value !== next) this._opacityFeatherStartSlider.value = next;
      }
      this._opacityFeatherStartSlider.disabled = !state.start.enabled || !!length.disabled;
      if (this._opacityFeatherStartValue && length.display !== undefined) {
        this._opacityFeatherStartValue.textContent = String(length.display);
      }
    }
    if (this._opacityFeatherEndSlider && state.end?.length) {
      const length = state.end.length;
      if (length.min !== undefined) this._opacityFeatherEndSlider.min = String(length.min);
      if (length.max !== undefined) this._opacityFeatherEndSlider.max = String(length.max);
      if (length.step !== undefined) this._opacityFeatherEndSlider.step = String(length.step);
      if (length.value !== undefined) {
        const next = String(length.value);
        if (this._opacityFeatherEndSlider.value !== next) this._opacityFeatherEndSlider.value = next;
      }
      this._opacityFeatherEndSlider.disabled = !state.end.enabled || !!length.disabled;
      if (this._opacityFeatherEndValue && length.display !== undefined) {
        this._opacityFeatherEndValue.textContent = String(length.display);
      }
    }
    if (this._opacityFeatherHint) {
      const text = state.hint || '';
      this._opacityFeatherHint.textContent = text;
      this._opacityFeatherHint.classList.toggle('is-hidden', !text);
    }
  }

  _handleOpacityFeatherToggle(event, endpoint) {
    const checkbox = event?.currentTarget || event?.target;
    if (!checkbox) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherEnabled', endpoint, !!checkbox.checked);
    }
  }

  _handleOpacityFeatherLength(event, endpoint, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    if (this._controller?.invokeToolHandler) {
      this._controller.invokeToolHandler('setOpacityFeatherLength', endpoint, slider.value, !!commit);
    }
  }

  _bindCustomToggles() {
    if (!this.element) return;
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      if (this._customToggleBindings.has(toggle)) continue;
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      if (!id) continue;
      const handler = (event) => {
        event.target.indeterminate = false;
        const next = !!event.target.checked;
        const result = this._controller?.requestCustomToggle?.(id, next);
        if (result && typeof result.then === 'function') {
          result.then((success) => {
            if (success === false) event.target.checked = !next;
          }).catch(() => {
            event.target.checked = !next;
          });
        } else if (result === false) {
          event.target.checked = !next;
        }
      };
      toggle.addEventListener('change', handler);
      this._customToggleBindings.set(toggle, handler);
    }
    this._syncCustomToggles();
  }

  _syncCustomToggles() {
    if (!this.element) return;
    const stateList = Array.isArray(this._toolOptionState?.customToggles)
      ? this._toolOptionState.customToggles
      : [];
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id) continue;
      stateMap.set(id, toggle);
    }
    const toggles = this.element.querySelectorAll('[data-fa-nexus-custom-toggle]');
    for (const toggle of toggles) {
      const id = toggle.getAttribute('data-fa-nexus-custom-toggle');
      const state = stateMap.get(id) || {};
      toggle.checked = !!state.enabled;
      toggle.disabled = !!state.disabled;
      if (state.tooltip) toggle.title = String(state.tooltip);
    }
  }

  _bindShortcutsControls() {
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
    const root = this.element?.querySelector('[data-fa-nexus-shortcuts-root]');
    if (!root) return;
    this._shortcutsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-shortcuts-toggle]');
    if (toggle) {
      toggle.addEventListener('click', this._boundShortcutsToggle);
      this._shortcutsToggle = toggle;
    }
    this._shortcutsContent = root.querySelector('[data-fa-nexus-shortcuts-content]');
    this._syncShortcutsControls();
  }

  _unbindShortcutsControls() {
    if (this._shortcutsToggle) {
      try { this._shortcutsToggle.removeEventListener('click', this._boundShortcutsToggle); }
      catch (_) {}
    }
    this._shortcutsRoot = null;
    this._shortcutsToggle = null;
    this._shortcutsContent = null;
  }

  _restoreShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, SHORTCUTS_SETTING_KEY);
      this._applyShortcutsSetting(saved);
    } catch (_) {
      // ignore malformed data
    }
  }

  _applyShortcutsSetting(raw) {
    const next = new Map();
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        const toolId = String(key || '');
        if (!toolId || !value) continue;
        next.set(toolId, true);
      }
    }

    let changed = next.size !== this._shortcutsCollapsedByTool.size;
    if (!changed) {
      for (const [toolId] of next) {
        if (!this._shortcutsCollapsedByTool.has(toolId)) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        for (const key of this._shortcutsCollapsedByTool.keys()) {
          if (!next.has(key)) {
            changed = true;
            break;
          }
        }
      }
    }

    if (!changed) {
      // Still ensure current collapsed flag reflects persisted data
      const activeId = this._activeTool?.id;
      this._shortcutsCollapsed = !!(activeId && next.has(activeId));
      this._syncShortcutsControls();
      return;
    }

    this._shortcutsCollapsedByTool.clear();
    for (const [toolId] of next) {
      this._shortcutsCollapsedByTool.set(toolId, true);
    }

    const activeId = this._activeTool?.id;
    this._shortcutsCollapsed = !!(activeId && this._shortcutsCollapsedByTool.has(activeId));
    this._syncShortcutsControls();
  }

  applyShortcutsSetting(raw) {
    this._applyShortcutsSetting(raw);
  }

  _persistShortcutsState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const payload = {};
      for (const [toolId] of this._shortcutsCollapsedByTool) {
        if (!toolId) continue;
        payload[toolId] = true;
      }
      const maybePromise = settings.set(MODULE_ID, SHORTCUTS_SETTING_KEY, payload);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {
      // ignore persistence errors
    }
  }

  _syncShortcutsControls() {
    const root = this._shortcutsRoot;
    if (!root) return;
    const collapsed = !!this._shortcutsCollapsed;
    root.classList.toggle('is-collapsed', collapsed);
    if (this._shortcutsToggle) {
      this._shortcutsToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    if (this._shortcutsContent) {
      this._shortcutsContent.hidden = collapsed;
    }
  }

  _handleShortcutsToggle(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._shortcutsCollapsed = !this._shortcutsCollapsed;
    const activeId = this._activeTool?.id;
    if (activeId) {
      if (this._shortcutsCollapsed) this._shortcutsCollapsedByTool.set(activeId, true);
      else this._shortcutsCollapsedByTool.delete(activeId);
      this._persistShortcutsState();
    }
    this._syncShortcutsControls();
  }

  _syncPlaceAsControls() {
    const state = this._toolOptionState?.placeAs || {};
    const toggle = this._placeAsToggleButton;
    if (toggle) {
      toggle.setAttribute('aria-expanded', state.open ? 'true' : 'false');
      const labelEl = toggle.querySelector('.fa-nexus-place-as__selection-label');
      if (labelEl) {
        const nextLabel = state.selectedLabel || 'Create new basic actor';
        if (labelEl.textContent !== nextLabel) labelEl.textContent = nextLabel;
      }
      const subtitle = state.selectedSubtitle || '';
      let subtitleEl = toggle.querySelector('.fa-nexus-place-as__selection-subtitle');
      if (subtitle) {
        if (!subtitleEl) {
          subtitleEl = document.createElement('span');
          subtitleEl.className = 'fa-nexus-place-as__selection-subtitle';
          subtitleEl.textContent = subtitle;
          const wrapper = toggle.querySelector('.fa-nexus-place-as__selection-text');
          if (wrapper) wrapper.appendChild(subtitleEl);
        } else if (subtitleEl.textContent !== subtitle) {
          subtitleEl.textContent = subtitle;
        }
        if (subtitleEl) subtitleEl.hidden = false;
      } else if (subtitleEl) {
        subtitleEl.textContent = '';
        subtitleEl.hidden = true;
      }
    }
    const container = this.element?.querySelector('.fa-nexus-place-as');
    if (container) container.classList.toggle('is-open', !!state.open);
    if (this._placeAsSearchInput) {
      this._placeAsSearchInput.value = state.searchValue || '';
      if (state.open) {
        const el = this._placeAsSearchInput;
        if (document.activeElement !== el) {
          try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
        }
        const len = el.value.length;
        try { el.setSelectionRange(len, len); } catch (_) {}
      }
    }
    if (this._placeAsLinkedToggle) {
      this._placeAsLinkedToggle.checked = !!state.linked;
      this._placeAsLinkedToggle.disabled = !!state.linkedDisabled;
      const label = this._placeAsLinkedToggle.closest('label');
      if (label && state.linkedTooltip) label.title = state.linkedTooltip;
    }
    if (this._placeAsList) {
      const selectedId = state.selectedId || '';
      const buttons = this._placeAsList.querySelectorAll('[data-place-as-option]');
      for (const button of buttons) {
        const id = button.getAttribute('data-place-as-option');
        button.classList.toggle('is-selected', !!selectedId && id === selectedId);
      }
    }
    const hpState = state.hp || {};
    if (this._placeAsHpModeSelect) {
      if (Array.isArray(hpState.modeOptions)) {
        const optionMap = new Map();
        for (const option of hpState.modeOptions) {
          if (!option) continue;
          optionMap.set(String(option.id), option);
        }
        for (const optionElement of this._placeAsHpModeSelect.options) {
          const entry = optionMap.get(optionElement.value);
          if (!entry) continue;
          optionElement.disabled = !!entry.disabled;
          if (entry.label && optionElement.textContent !== entry.label) {
            optionElement.textContent = entry.label;
          }
          optionElement.selected = !!entry.selected;
        }
      }
      if (hpState.mode) this._placeAsHpModeSelect.value = hpState.mode;
    }
    if (this._placeAsHpModeHint) {
      const hint = hpState.modeHint || '';
      this._placeAsHpModeHint.textContent = hint;
      this._placeAsHpModeHint.hidden = !hint;
    }
    if (this._placeAsHpPercentRow) {
      this._placeAsHpPercentRow.hidden = !hpState.showPercent;
    }
    if (this._placeAsHpPercentInput) {
      const percentFocused = document.activeElement === this._placeAsHpPercentInput;
      const percentValue = hpState.percentValue !== undefined && hpState.percentValue !== null
        ? String(hpState.percentValue)
        : '';
      if (!percentFocused && this._placeAsHpPercentInput.value !== percentValue) {
        this._placeAsHpPercentInput.value = percentValue;
      }
      this._placeAsHpPercentInput.disabled = !hpState.showPercent;
    }
    if (this._placeAsHpPercentHint) {
      const hint = hpState.percentHint || '';
      this._placeAsHpPercentHint.textContent = hint;
      this._placeAsHpPercentHint.hidden = !hpState.showPercent || !hint;
    }
    if (this._placeAsHpStaticRow) {
      this._placeAsHpStaticRow.hidden = !hpState.showStatic;
    }
    if (this._placeAsHpStaticInput) {
      const staticFocused = document.activeElement === this._placeAsHpStaticInput;
      const staticValue = typeof hpState.staticValue === 'string' ? hpState.staticValue : '';
      if (!staticFocused && this._placeAsHpStaticInput.value !== staticValue) {
        this._placeAsHpStaticInput.value = staticValue;
      }
      this._placeAsHpStaticInput.classList.toggle('has-error', !!hpState.staticError);
      if (hpState.staticError) {
        this._placeAsHpStaticInput.setAttribute('aria-invalid', 'true');
      } else {
        this._placeAsHpStaticInput.removeAttribute('aria-invalid');
      }
      this._placeAsHpStaticInput.disabled = !hpState.showStatic;
    }
    if (this._placeAsHpStaticHint) {
      const hint = hpState.staticHint || '';
      this._placeAsHpStaticHint.textContent = hint;
      this._placeAsHpStaticHint.hidden = !hpState.showStatic || !hint;
    }
    if (this._placeAsHpStaticError) {
      const error = hpState.staticError || '';
      this._placeAsHpStaticError.textContent = error;
      this._placeAsHpStaticError.hidden = !error;
    }
  }

  _handlePlaceAsSearch(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsSearch', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsOptionClick(event) {
    const button = event?.target?.closest?.('[data-place-as-option]');
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const optionId = button.getAttribute('data-place-as-option') || '';
    const result = this._controller?.invokeToolHandler?.('selectPlaceAsOption', optionId);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsLinked(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsLinked', checked);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsToggle(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    const result = this._controller?.invokeToolHandler?.('togglePlaceAsOpen');
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsHpMode(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpMode', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsHpPercent(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpPercent', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsHpStatic(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsHpStatic', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _persistWindowPosition() {
    if (this._restoringPosition) return;
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const pos = this.position;
      if (!pos) return;
      const state = {};
      if (Number.isFinite(pos.left)) state.left = pos.left;
      if (Number.isFinite(pos.top)) state.top = pos.top;
      if (Number.isFinite(pos.width)) state.width = pos.width;
      if (Number.isFinite(pos.height)) state.height = pos.height;
      if (!Object.keys(state).length) return;
      const maybePromise = settings.set(MODULE_ID, TOOL_WINDOW_SETTING_KEY, state);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {}
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

  _setupResizeObserver() {
    if (this._resizeObserver) return;
    try {
      const frame = this.element?.querySelector('.window-frame');
      if (!frame) return;

      this._resizeObserver = new ResizeObserver((entries) => {
        if (this._userResizing || !this._savedHeight) return;

        for (const entry of entries) {
          const { height } = entry.contentRect;
          if (Math.abs(height - this._savedHeight) > 10) { // Allow some tolerance
            // Height changed significantly, likely due to auto-sizing
            this._forceSavedHeight();
            break;
          }
        }
      });
      this._resizeObserver.observe(frame);

      // Listen for user resize events
      const handleResizeStart = () => { this._userResizing = true; };
      const handleResizeEnd = () => { 
        this._userResizing = false;
        // Update saved height after user resize
        this._savedHeight = this.position?.height || this._savedHeight;
      };

      frame.addEventListener('mousedown', (e) => {
        if (e.target.closest('.window-resizable-handle')) handleResizeStart();
      });
      frame.addEventListener('touchstart', (e) => {
        if (e.target.closest('.window-resizable-handle')) handleResizeStart();
      });
      document.addEventListener('mouseup', handleResizeEnd);
      document.addEventListener('touchend', handleResizeEnd);

    } catch (error) {
      Logger.warn('ToolOptionsWindow.resizeObserver.setupFailed', error);
    }
  }

  _cleanupResizeObserver() {
    if (this._resizeObserver) {
      try { this._resizeObserver.disconnect(); } catch (_) {}
      this._resizeObserver = null;
    }
    this._userResizing = false;
    this._savedHeight = null;
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

/**
 * Central controller that coordinates the tool options window across placement
 * managers and premium editors.
 */
class ToolOptionsController {
  constructor() {
    this._window = null;
    this._activeTools = new Map();
    this._gridSnapEnabled = this._readGridSnapSetting();
    this._settingsHook = null;
    this._settingsAvailable = this._canAccessSettings();
    this._ensureSettingsListener();
    this._toolOptions = new Map();
    this._stateListeners = new Set();
  }

  activateTool(toolId, { label } = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const entry = { id, label: label ? String(label) : id };
    this._activeTools.set(id, entry);
    const win = this._ensureWindow();
    const options = this._getToolState(id);
    if (options) win.setActiveToolOptions(options, { suppressRender: true });
    else win.setActiveToolOptions({}, { suppressRender: true });
    win.setActiveTool(entry);
    if (!win.rendered) win.render(true);
    else win.render(false);
    try { win.bringToFront?.(); } catch (_) {}
    this._notifyStateListeners();
  }

  updateTool(toolId, { label } = {}) {
    if (!toolId || !this._activeTools.has(String(toolId))) return;
    const id = String(toolId);
    const existing = this._activeTools.get(id);
    const next = {
      id,
      label: label ? String(label) : (existing?.label ?? id)
    };
    this._activeTools.set(id, next);
    if (this._window) this._window.setActiveTool(next);
    this._notifyStateListeners();
  }

  deactivateTool(toolId) {
    if (!toolId) return;
    const id = String(toolId);
    const current = this._window?.activeTool?.id ?? null;
    const removed = this._activeTools.delete(id);

    if (!removed) {
      this._notifyStateListeners();
      return;
    }

    if (!this._activeTools.size) {
      if (this._window?.rendered) {
        try { this._window.close({ animate: false }); } catch (_) {}
      } else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
        this._window = null;
      }
      this._notifyStateListeners();
      return;
    }

    if (current === id) {
      const [, lastEntry] = Array.from(this._activeTools).pop() || [];
      if (lastEntry) this._window?.setActiveTool(lastEntry);
      else if (this._window) {
        try { this._window.setActiveTool(null); } catch (_) {}
      }
    }
    this._notifyStateListeners();
  }

  _ensureWindow() {
    if (this._window) return this._window;
    const available = this.supportsGridSnap();
    this._window = new ToolOptionsWindow({
      controller: this,
      gridSnapEnabled: this._gridSnapEnabled,
      gridSnapAvailable: available,
      toolOptions: this._getToolState(null)
    });
    return this._window;
  }

  setToolOptions(toolId, payload = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const state = payload.state && typeof payload.state === 'object' ? payload.state : (typeof payload === 'object' ? payload : {});
    const handlers = payload.handlers && typeof payload.handlers === 'object' ? payload.handlers : {};
    const suppressRender = payload?.suppressRender !== undefined ? !!payload.suppressRender : true;
    this._toolOptions.set(id, { state, handlers });
    if (this._window && this._window.activeTool?.id === id) {
      this._window.setActiveToolOptions(state, { suppressRender });
    }
  }

  reopenWindow({ focus = true } = {}) {
    if (!this._activeTools.size) {
      this._notifyStateListeners();
      return false;
    }
    const win = this._ensureWindow();
    let entry = null;
    const activeId = win?.activeTool?.id;
    if (activeId && this._activeTools.has(activeId)) {
      entry = this._activeTools.get(activeId);
    } else {
      const entries = Array.from(this._activeTools.values());
      entry = entries.length ? entries[entries.length - 1] : null;
    }
    if (entry) {
      const state = this._getToolState(entry.id);
      if (state) win.setActiveToolOptions(state, { suppressRender: true });
      else win.setActiveToolOptions({}, { suppressRender: true });
      win.setActiveTool(entry);
    } else {
      win.setActiveToolOptions({}, { suppressRender: true });
      try { win.setActiveTool(null); } catch (_) {}
    }
    if (!win.rendered) win.render(true);
    else win.render(false);
    if (win?.minimized) {
      try { win.maximize(); } catch (_) {}
    }
    if (focus) {
      try { win.bringToFront?.(); } catch (_) {}
    }
    this._notifyStateListeners();
    return true;
  }

  requestDropShadowToggle(enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId).setDropShadowEnabled;
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  requestCustomToggle(toggleId, enabled) {
    const activeId = this._window?.activeTool?.id;
    if (!activeId || !toggleId) return false;
    const customHandlers = this._getToolHandlers(activeId).customToggles || {};
    const handler = customHandlers?.[toggleId];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(enabled);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  invokeToolHandler(handlerName, ...args) {
    if (!handlerName) return false;
    const activeId = this._window?.activeTool?.id;
    if (!activeId) return false;
    const handler = this._getToolHandlers(activeId)?.[handlerName];
    if (typeof handler !== 'function') return false;
    try {
      const result = handler(...args);
      if (result?.then) return result;
      return result;
    } catch (_) {
      return false;
    }
  }

  _getToolState(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.state || {};
  }

  _getToolHandlers(toolId) {
    if (!toolId) return {};
    return this._toolOptions.get(String(toolId))?.handlers || {};
  }

  supportsGridSnap() {
    this._ensureSettingsListener();
    const available = this._canAccessSettings();
    if (this._settingsAvailable !== available) {
      this._settingsAvailable = available;
      if (this._window) this._window.setGridSnapAvailable(available);
    }
    return available;
  }

  isGridSnapSettingAvailable() {
    return this._settingsAvailable;
  }

  async requestGridSnapToggle(enabled) {
    const next = !!enabled;
    const previous = !!this._gridSnapEnabled;
    const canPersist = this.supportsGridSnap();
    this._updateGridSnapState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.saveFailed', error);
      this._updateGridSnapState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update grid snapping. Please try again.');
      } catch (_) {}
      return false;
    }
  }

  _ensureSettingsListener() {
    if (this._settingsHook || !globalThis?.Hooks || typeof globalThis.Hooks.on !== 'function') return;
    const handler = (setting) => this._handleSettingUpdated(setting);
    try {
      globalThis.Hooks.on('updateSetting', handler);
      this._settingsHook = handler;
    } catch (error) {
      Logger.warn('ToolOptionsController.settingsHookFailed', error);
      this._settingsHook = null;
    }
  }

  _handleSettingUpdated(setting) {
    if (!setting || setting.namespace !== MODULE_ID) return;
    if (setting.key === GRID_SNAP_SETTING_KEY) {
      this._updateGridSnapState(!!setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === SHORTCUTS_SETTING_KEY) {
      this._window?.applyShortcutsSetting?.(setting.value);
    }
  }

  _updateGridSnapState(value, { syncWindow = false } = {}) {
    const next = !!value;
    if (this._gridSnapEnabled === next) {
      if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
      return;
    }
    this._gridSnapEnabled = next;
    if (syncWindow && this._window) this._window.setGridSnapEnabled(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapChanged', next);
    } catch (_) {}
  }

  _readGridSnapSetting() {
    if (!this._canAccessSettings()) return true;
    try {
      return !!game.settings.get(MODULE_ID, GRID_SNAP_SETTING_KEY);
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.readFailed', error);
      return true;
    }
  }

  _canAccessSettings() {
    const settings = globalThis?.game?.settings;
    return !!(settings && typeof settings.get === 'function' && typeof settings.set === 'function');
  }

  _handleWindowClosed(instance) {
    if (this._window === instance) {
      this._window = null;
    }
    this._notifyStateListeners();
  }

  addStateListener(listener) {
    if (typeof listener !== 'function') return () => {};
    this._stateListeners.add(listener);
    try {
      listener(this.getWindowState());
    } catch (_) {}
    return () => {
      this._stateListeners.delete(listener);
    };
  }

  getWindowState() {
    return this._collectStateSnapshot();
  }

  _collectStateSnapshot() {
    return {
      hasActiveTool: this._activeTools.size > 0,
      isWindowOpen: !!this._window,
      activeToolId: this._window?.activeTool?.id ?? null
    };
  }

  _notifyStateListeners() {
    if (!this._stateListeners.size) return;
    const snapshot = this._collectStateSnapshot();
    for (const listener of this._stateListeners) {
      try {
        listener(snapshot);
      } catch (_) {}
    }
  }
}

export const toolOptionsController = new ToolOptionsController();
export { ToolOptionsWindow };
