import { NexusLogger as Logger } from './nexus-logger.js';
import {
  GRID_SNAP_SUBDIV_SETTING_KEY,
  GRID_SNAP_SUBDIV_MIN,
  GRID_SNAP_SUBDIV_MAX,
  GRID_SNAP_SUBDIV_DEFAULT,
  normalizeGridSnapSubdivision,
  formatGridSnapSubdivisionLabel,
  readGridSnapSubdivisionSetting
} from './grid-snap-utils.js';
import { isHelpShortcut } from './editor-shortcuts.js';
import {
  DEFAULT_TOOL_OPTION_SECTION_ORDER,
  inferToolOptionSectionsFromState,
  normalizeToolOptionsPayload,
  TOOL_OPTIONS_RENDERER_MODE
} from './tool-options-descriptor.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = 'fa-nexus';
const TOOL_WINDOW_SETTING_KEY = 'toolOptionsWindowPos';
const GRID_SNAP_SETTING_KEY = 'gridSnap';
const SHORTCUTS_SETTING_KEY = 'toolOptionsShortcuts';
const SECTIONS_SETTING_KEY = 'toolOptionsSections';
const DEFAULT_WINDOW_TITLE = 'Tool Options';
const TOOL_OPTIONS_ACTIVITY_EVENT = 'fa-nexus:tool-options-activity';
const TOOL_SECTION_LABELS = new Map([
  ...DEFAULT_TOOL_OPTION_SECTION_ORDER.map((entry) => [String(entry?.id || ''), String(entry?.label || '')]),
  ['paint', 'Paint'],
  ['texture', 'Texture'],
  ['transform', 'Transform'],
  ['path', 'Path'],
  ['feathering', 'Feathering'],
  ['drop-shadow', 'Drop Shadow'],
  ['height-map', 'Height Map'],
  ['wall', 'Wall'],
  ['fill', 'Fill']
]);
const TOOL_HELP_COPY = Object.freeze({
  'asset-placement': Object.freeze({
    summary: 'Place single assets or paint scatter sessions with shared snap, rotation, elevation, and placement controls.',
    notes: Object.freeze([
      'Single placement drops one asset at a time, while scatter brush mode paints repeated stamps until you commit or cancel the session.',
      'Scatter edit sessions let you add new stamps, erase existing stamps, and merge the result back into the tile.',
      'Panel controls drive randomization, shading, mirroring, and transform ranges before placement.'
    ])
  }),
  'token-placement': Object.freeze({
    summary: 'Place tokens onto the canvas or actor sidebar targets with shared rotation, mirroring, grid snap, and place-as controls.',
    notes: Object.freeze([
      'Placement can target either the canvas or an actor row in the sidebar.',
      'Place As controls decide how new actors, links, names, and HP are derived for each drop.'
    ])
  }),
  'texture-paint': Object.freeze({
    summary: 'Paint or erase masked tiling directly on a tile, including shape selections and height-aware masking.',
    notes: Object.freeze([
      'Brush, fill, and selection tools all write into the current tile mask until you commit the session.',
      'Height Map turns the texture into a smart paint mask, so you can paint only the parts of the texture that read as raised or recessed instead of painting the whole image evenly.'
    ])
  }),
  'path-editor-v2': Object.freeze({
    summary: 'Draw, reshape, and re-edit path tiles with live previews, draw/curve modes, and path, placement, feathering, and shadow controls.',
    notes: Object.freeze([
      'Curve mode adds controlled points, while Draw mode sketches freehand segments.',
      'Edit Shapes reopens existing paths so you can move points, retune textures, and change stacking.',
      'In Edit Shapes, press X while hovering a non-endpoint to split the hovered open path at that point.',
      'Path, placement, feathering, and shadow panels all update the live preview before you commit.'
    ])
  }),
  'building-editor': Object.freeze({
    summary: 'Block out outer walls, inner walls, and portals, then refine shapes, stacking, and appearance in-place.',
    notes: Object.freeze([
      'Outer walls create closed geometry, while inner walls stay open and use the polygon lasso workflow.',
      'Edit Shapes lets you retune vertices, arcs, fill elevation, and stacking without starting over.',
      'In Edit Shapes, right-click a wall segment to target it for per-segment texture, offset, opacity, HSBC, and shadow overrides. Ctrl/Cmd+right-click adds more segments to the selection.',
      'Use the Portals tab after the wall geometry exists to add doors, windows, and gaps.'
    ])
  })
});

function normalizeHelpNotes(lines) {
  if (!Array.isArray(lines)) return [];
  return Array.from(new Set(
    lines
      .filter((line) => typeof line === 'string' && line.trim().length)
      .map((line) => line.trim())
  ));
}

function getToolHelpNotes(helpTopicId, { state = {}, hints = [] } = {}) {
  if (helpTopicId === 'building-editor' && state?.portalMode) {
    return [
      'Portal mode places the configured door or window on the hovered wall.',
      'Use the portal controls to tune the selected door or window without leaving the editor.',
      'Switch back to wall editing when you need to change geometry, fills, or stacking.'
    ];
  }

  const topicNotes = normalizeHelpNotes(TOOL_HELP_COPY[helpTopicId]?.notes || []);
  if (helpTopicId === 'asset-placement') {
    const dynamicNotes = [];
    for (const line of hints) {
      if (/^preview frozen\b/i.test(line)) dynamicNotes.push('Preview is currently frozen.');
      else if (/^editing scatter tile\b/i.test(line)) dynamicNotes.push('Editing an existing scatter tile instead of placing a new one.');
    }
    return normalizeHelpNotes([...dynamicNotes, ...topicNotes]);
  }

  if (helpTopicId === 'texture-paint') {
    const dynamicNotes = [];
    if (state?.rotation?.available === false && state?.scale?.available === false && state?.textureOffset?.available === false) {
      dynamicNotes.push('Standard tile mask sessions keep the same paint workflow but hide transform controls that do not apply.');
    }
    return normalizeHelpNotes([...dynamicNotes, ...topicNotes]);
  }

  if (topicNotes.length) return topicNotes;
  return normalizeHelpNotes(hints);
}

function getToolSectionLabel(sectionId) {
  const id = String(sectionId || '');
  if (!id) return '';
  return TOOL_SECTION_LABELS.get(id) || id;
}

class ToolHelpWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.DEFAULT_OPTIONS ?? {}),
    {
      id: 'fa-nexus-tool-help',
      tag: 'section',
      position: { width: 460, height: 'auto' },
      window: {
        title: 'Tool Help',
        icon: 'fas fa-circle-question',
        minimizable: true,
        resizable: true
      },
      classes: ['fa-nexus-tool-help-window']
    },
    { inplace: false }
  );

  static PARTS = foundry.utils.mergeObject(
    foundry.utils.deepClone(super.PARTS ?? {}),
    {
      body: { template: 'modules/fa-nexus/templates/tool-help-modal.hbs' }
    },
    { inplace: false }
  );

  constructor({ controller, helpContext = {} } = {}) {
    super();
    this._controller = controller;
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
  }

  setHelpContext(helpContext = {}, { suppressRender = false } = {}) {
    this._helpContext = helpContext && typeof helpContext === 'object' ? helpContext : {};
    if (this.rendered && !suppressRender) this.render(false);
  }

  _resolveWindowTitle() {
    const label = typeof this._helpContext?.toolLabel === 'string' ? this._helpContext.toolLabel.trim() : '';
    return label ? `${label} Help` : 'Tool Help';
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
    const help = this._helpContext && typeof this._helpContext === 'object' ? this._helpContext : {};
    return {
      toolLabel: typeof help.toolLabel === 'string' ? help.toolLabel : '',
      summary: typeof help.summary === 'string' ? help.summary : '',
      selectionSummary: help.selectionSummary ?? null,
      dirty: !!help.dirty,
      sections: Array.isArray(help.sections) ? help.sections : [],
      shortcuts: Array.isArray(help.shortcuts) ? help.shortcuts : [],
      notes: Array.isArray(help.notes) ? help.notes : []
    };
  }

  _onRender(initial, ctx) {
    super._onRender(initial, ctx);
    this._syncWindowTitle();
  }

  async _preClose(options = {}) {
    try { this._controller?._handleHelpWindowClosing(this); } catch (_) {}
    return super._preClose(options);
  }

  _onClose(options = {}) {
    try { this._controller?._handleHelpWindowClosed(this); } catch (_) {}
    return super._onClose(options);
  }
}

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
    this._userResizing = false;
    this._savedHeight = null;
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
    this._boundDropShadowPresetClick = (event) => this._handleDropShadowPresetClick(event);
    this._boundDropShadowPresetContext = (event) => this._handleDropShadowPresetContext(event);
    this._boundDropShadowReset = (event) => this._handleDropShadowReset(event);
    this._boundResettableContext = (event) => this._handleResettableContext(event);
    this._customToggleBindings = new Map();
    this._declarativeSegmentedControls = new Map();
    this._declarativeToggleControls = new Map();
    this._declarativeRangeControls = new Map();
    this._declarativeRangePairControls = new Map();
    this._declarativeAxisPairControls = new Map();
    this._declarativeScalarRandomizedControls = new Map();
    this._declarativeStackOrderControls = new Map();
    this._resettableContextRoot = null;
    this._sliderWheelRoot = null;
    this._boundSliderWheel = (event) => this._handleSliderWheel(event);
    this._boundDeclarativeToggleChange = (event) => this._handleDeclarativeToggleChange(event);
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

  _syncDropShadowPreview(preview) {
    const root = this._dropShadowPreviewRoot;
    const image = this._dropShadowPreviewImage;
    if (!root || !image) return;
    const hasPreview = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0;
    if (hasPreview) {
      if (image.src !== preview.src) image.src = preview.src;
      if (preview.alt !== undefined) image.alt = String(preview.alt || '');
      root.classList.remove('is-empty');
    } else {
      if (image.hasAttribute('src')) image.removeAttribute('src');
      image.alt = '';
      root.classList.add('is-empty');
    }
  }

  applyDropShadowPreview(preview) {
    if (!this._toolOptionState || typeof this._toolOptionState !== 'object') {
      this._toolOptionState = {};
    }
    const controls = this._toolOptionState.dropShadowControls && typeof this._toolOptionState.dropShadowControls === 'object'
      ? this._toolOptionState.dropShadowControls
      : {};
    if (preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0) {
      controls.preview = preview;
    } else {
      delete controls.preview;
    }
    this._toolOptionState.dropShadowControls = controls;
    if (this.rendered) this._syncDropShadowPreview(controls.preview || null);
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

  _shouldForceRenderForStateChange(previousState = {}, nextState = {}) {
    const prevRevision = previousState?.layoutRevision ?? null;
    const nextRevision = nextState?.layoutRevision ?? null;
    if (prevRevision !== nextRevision) return true;
    const buildPortalLayoutSignature = (portalState, variant = '') => {
      const prepared = this._prepareDeclarativePortalControl({
        id: `__${variant}-portal-layout-signature__`,
        type: 'portal-controls',
        variant,
        state: portalState
      }, `__${variant}-portal-layout-signature__`);
      if (!prepared) return '';
      return JSON.stringify({
        variant: prepared.variant,
        title: String(prepared.title || ''),
        selectionLabel: String(prepared.selectionLabel || ''),
        headerActions: Array.isArray(prepared.headerActions)
          ? prepared.headerActions.map((action) => ({
              id: String(action?.id || ''),
              hidden: !!action?.hidden
            }))
          : [],
        toggleGroups: Array.isArray(prepared.toggleGroups)
          ? prepared.toggleGroups.map((group) => ({
              id: String(group?.id || ''),
              visible: group?.visible !== false,
              items: Array.isArray(group?.items)
                ? group.items.map((item) => String(item?.id || ''))
                : []
            }))
          : [],
        selectGroups: Array.isArray(prepared.selectGroups)
          ? prepared.selectGroups.map((group) => ({
              id: String(group?.id || ''),
              visible: group?.visible !== false,
              items: Array.isArray(group?.items)
                ? group.items.map((item) => ({
                    id: String(item?.id || ''),
                    options: Array.isArray(item?.options)
                      ? item.options.map((option, index) => ({
                          value: String(option?.value ?? index),
                          label: String(option?.label || '')
                        }))
                      : []
                  }))
                : []
            }))
          : [],
        color: prepared.color ? {
          visible: prepared.color.visible !== false,
          target: prepared.color.target ? {
            id: String(prepared.color.target.id || ''),
            visible: prepared.color.target.visible !== false,
            items: Array.isArray(prepared.color.target.items)
              ? prepared.color.target.items.map((item) => ({
                  id: String(item?.id || ''),
                  label: String(item?.label || ''),
                  enabled: !!item?.enabled,
                  disabled: !!item?.disabled
                }))
              : []
          } : null,
          rows: Array.isArray(prepared.color.rows)
            ? prepared.color.rows.map((row) => ({
                id: String(row?.id || ''),
                label: String(row?.label || '')
              }))
            : []
        } : null,
        sections: Array.isArray(prepared.sections)
          ? prepared.sections.map((section) => ({
              id: String(section?.id || ''),
              visible: section?.visible !== false,
              summary: String(section?.summary || ''),
              picker: section?.picker ? {
                id: String(section.picker.id || ''),
                hidden: !!section.picker.hidden
              } : null,
              settings: section?.settings ? {
                id: String(section.settings.id || ''),
                visible: section.settings.visible !== false,
                rows: Array.isArray(section.settings.rows)
                  ? section.settings.rows.map((row) => ({
                      id: String(row?.id || ''),
                      label: String(row?.label || ''),
                      valueMode: String(row?.valueMode || ''),
                      hasHint: !!row?.hint
                    }))
                  : []
              } : null
            }))
          : []
      });
    };
    const paths = [
      ['scale', 'available'],
      ['rotation', 'available'],
      ['pathAppearance', 'available'],
      ['pathAppearance', 'layerOpacity', 'available'],
      ['pathAppearance', 'scale', 'available'],
      ['pathAppearance', 'textureOffset', 'available'],
      ['pathAppearance', 'tension', 'available'],
      ['pathAppearance', 'freehandSimplify', 'available'],
      ['pathAppearance', 'showWidthTangents', 'available'],
      ['pathShadow', 'available'],
      ['pathFeather', 'available'],
      ['opacityFeather', 'available'],
      ['dropShadowControls', 'available'],
      ['dropShadow', 'available'],
      ['flip', 'available'],
      ['placeAs', 'naming', 'available'],
      ['shapeStacking', 'available']
    ];
    const valueAtPath = (state, path) => {
      let cursor = state;
      for (const segment of path) {
        if (!cursor || typeof cursor !== 'object') return undefined;
        cursor = cursor[segment];
      }
      return typeof cursor === 'boolean' ? cursor : !!cursor;
    };
    return paths.some((path) => {
      const previous = valueAtPath(previousState, path);
      const next = valueAtPath(nextState, path);
      return !previous && !!next;
    }) || (
      buildPortalLayoutSignature(previousState?.doorControls, 'door')
      !== buildPortalLayoutSignature(nextState?.doorControls, 'door')
    ) || (
      buildPortalLayoutSignature(previousState?.windowControls, 'window')
      !== buildPortalLayoutSignature(nextState?.windowControls, 'window')
    );
  }

  setActiveToolOptions(options = {}, { suppressRender = false } = {}) {
    const nextState = options && typeof options === 'object' ? options : {};
    const previousState = this._toolOptionState && typeof this._toolOptionState === 'object'
      ? this._toolOptionState
      : {};
    this._activeNormalizedOptions = this._activeTool?.id
      ? (this._controller?._getToolNormalized?.(this._activeTool.id) || null)
      : null;
    const forceRender = suppressRender && this.rendered && this._shouldForceRenderForStateChange(previousState, nextState);
    this._toolOptionState = nextState;
    if (this.rendered && (!suppressRender || forceRender)) this.render(false);
    else if (this.rendered) {
      this._syncGridSnapControl();
      this._syncDropShadowControl();
      this._syncDropShadowControls();
      this._syncDeclarativeSegmentedControls();
      this._syncEditorActions();
      this._syncDeclarativeToggleControls();
      this._syncDeclarativeRangeControls();
      this._syncDeclarativeRangePairControls();
      this._syncDeclarativeAxisPairControls();
      this._syncDeclarativeScalarRandomizedControls();
      this._syncDeclarativeStackOrderControls();
      this._syncPathAppearanceControls();
      this._syncCustomToggles();
      this._syncPlacementControls();
      this._syncFlipControls();
      this._syncScaleControls();
      this._syncRotationControls();
      this._syncPathShadowControls();
      this._syncPathFeatherControls();
      this._syncOpacityFeatherControls();
      this._syncShortcutsControls();
      this._syncPlaceAsControls();
      this._syncPortalControls();
      this._syncDynamicSections();
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

  refreshToolSections() {
    this._syncDynamicSections();
  }

  _shouldUseDynamicSections() {
    const activeId = this._activeTool?.id;
    const normalized = activeId ? this._controller?._getToolNormalized?.(activeId) : null;
    if (!normalized) return false;
    return normalized.rendererMode !== TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE;
  }

  _blockMatchesSelector(block, selector) {
    if (!block || typeof block.matches !== 'function') return false;
    if (block.matches(selector)) return true;
    if (typeof block.querySelector !== 'function') return false;
    return !!block.querySelector(selector);
  }

  _classifyToolOptionBlock(block) {
    if (!block || typeof block.matches !== 'function') return null;
    if (this._blockMatchesSelector(block, '#fa-nexus-drop-shadow-toggle, [data-fa-nexus-drop-shadow-root]')) return 'appearance';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-subtools-root], [data-fa-nexus-subtool-options-root], [data-fa-nexus-texture-tools-root]')) return 'mode';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-editor-actions-root]')) return 'session';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-path-simplify-root], [data-fa-nexus-path-feather], [data-fa-nexus-opacity-feather]')) return 'brush-geometry';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-placement-root]')) return 'placement';
    if (this._blockMatchesSelector(block, '[data-fa-nexus-path-opacity-root], [data-fa-nexus-path-scale-root], [data-fa-nexus-path-offset-root], [data-fa-nexus-path-tension-root], [data-fa-nexus-show-width-tangents-root], [data-fa-nexus-scale-root], [data-fa-nexus-rotation-root], [data-fa-nexus-flip-root], [data-fa-nexus-path-shadow]')) return 'appearance';
    if (block.matches('.fa-nexus-tool-options__toggle') && this._blockMatchesSelector(block, '[data-fa-nexus-custom-toggle]')) return 'placement';
    return null;
  }

  _getDynamicSectionLayout(sectionIds = []) {
    const activeId = this._activeTool?.id;
    const controllerLayout = Array.isArray(this._controller?.getToolSectionLayout?.(activeId))
      ? this._controller.getToolSectionLayout(activeId)
      : [];
    const ordered = new Map();
    for (const section of controllerLayout) {
      const sectionId = String(section?.id || '');
      if (!sectionId) continue;
      ordered.set(sectionId, {
        id: sectionId,
        label: typeof section?.label === 'string' && section.label.trim().length
          ? section.label.trim()
          : getToolSectionLabel(sectionId),
        collapsed: !!section?.collapsed
      });
    }
    for (const rawId of sectionIds) {
      const sectionId = String(rawId || '');
      if (!sectionId || ordered.has(sectionId)) continue;
      ordered.set(sectionId, {
        id: sectionId,
        label: getToolSectionLabel(sectionId),
        collapsed: !!this._controller?._isSectionCollapsed?.(activeId, sectionId)
      });
    }
    return Array.from(ordered.values());
  }

  _createToolSection(section = {}) {
    const sectionId = String(section?.id || '');
    if (!sectionId) return null;
    const label = typeof section?.label === 'string' && section.label.trim().length
      ? section.label.trim()
      : getToolSectionLabel(sectionId);
    const collapsed = !!section?.collapsed;

    const root = document.createElement('section');
    root.className = 'fa-nexus-tool-options__section fa-nexus-tool-section';
    root.setAttribute('data-fa-nexus-tool-section', sectionId);
    if (collapsed) root.classList.add('is-collapsed');

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'fa-nexus-tool-section__toggle';
    toggle.setAttribute('data-fa-nexus-section-toggle', sectionId);
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${label}`;

    const icon = document.createElement('i');
    icon.className = 'fas fa-chevron-down';
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('span');
    text.className = 'fa-nexus-tool-section__label';
    text.textContent = label;

    toggle.append(icon, text);

    const body = document.createElement('div');
    body.className = 'fa-nexus-tool-section__body';
    body.setAttribute('data-fa-nexus-section-body', sectionId);
    if (collapsed) body.setAttribute('aria-hidden', 'true');

    root.append(toggle, body);
    return root;
  }

  _rebuildDynamicSections() {
    if (!this._shouldUseDynamicSections()) return;
    const content = this.element?.querySelector('[data-fa-nexus-scroll-container]');
    if (!content) return;
    const directChildren = Array.from(content.children).filter((node) => node?.nodeType === 1);
    const mainSection = directChildren.find((node) => (
      node.matches?.('.fa-nexus-tool-options__section')
      && !node.classList.contains('fa-nexus-place-as')
      && !node.hasAttribute('data-fa-nexus-tool-section')
      && !node.querySelector?.('.fa-nexus-tool-options__empty')
    ));
    if (!mainSection) return;

    const blocks = Array.from(mainSection.children).filter((node) => node?.nodeType === 1);
    if (!blocks.length) return;

    const grouped = new Map();
    for (const block of blocks) {
      const sectionId = this._classifyToolOptionBlock(block) || 'placement';
      if (!grouped.has(sectionId)) grouped.set(sectionId, []);
      grouped.get(sectionId).push(block);
    }
    if (!grouped.size) return;

    const layout = this._getDynamicSectionLayout(Array.from(grouped.keys()));
    if (!layout.length) return;

    const fragment = document.createDocumentFragment();
    let hasRenderedSection = false;
    for (const section of layout) {
      const nodes = grouped.get(section.id);
      if (!Array.isArray(nodes) || !nodes.length) continue;
      const sectionRoot = this._createToolSection(section);
      const body = sectionRoot?.querySelector?.('[data-fa-nexus-section-body]');
      if (!sectionRoot || !body) continue;
      for (const node of nodes) body.appendChild(node);
      fragment.appendChild(sectionRoot);
      hasRenderedSection = true;
    }
    if (!hasRenderedSection) return;

    content.insertBefore(fragment, mainSection);
    mainSection.remove();
  }

  _bindToolSectionControls() {
    this._sectionRoots.clear();
    this._sectionToggleButtons.clear();
    this._sectionBodies.clear();
    const root = this.element;
    if (!root) return;
    const sections = root.querySelectorAll('[data-fa-nexus-tool-section]');
    for (const sectionRoot of sections) {
      const sectionId = String(sectionRoot.getAttribute('data-fa-nexus-tool-section') || '');
      if (!sectionId) continue;
      this._sectionRoots.set(sectionId, sectionRoot);
      const toggle = sectionRoot.querySelector('[data-fa-nexus-section-toggle]');
      if (toggle) {
        toggle.addEventListener('click', this._boundSectionToggle);
        this._sectionToggleButtons.set(sectionId, toggle);
      }
      const body = sectionRoot.querySelector('[data-fa-nexus-section-body]');
      if (body) this._sectionBodies.set(sectionId, body);
    }
    this._syncDynamicSections();
  }

  _unbindToolSectionControls() {
    for (const toggle of this._sectionToggleButtons.values()) {
      try { toggle.removeEventListener('click', this._boundSectionToggle); } catch (_) {}
    }
    this._sectionRoots.clear();
    this._sectionToggleButtons.clear();
    this._sectionBodies.clear();
  }

  _syncDynamicSections() {
    const activeId = this._activeTool?.id;
    if (!activeId || !this._sectionRoots.size) return;
    for (const [sectionId, sectionRoot] of this._sectionRoots.entries()) {
      const collapsed = !!this._controller?._isSectionCollapsed?.(activeId, sectionId);
      sectionRoot.classList.toggle('is-collapsed', collapsed);
      const toggle = this._sectionToggleButtons.get(sectionId);
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${getToolSectionLabel(sectionId)}`;
      }
      const body = this._sectionBodies.get(sectionId);
      if (body) body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
  }

  _handleSectionToggle(event) {
    const button = event?.currentTarget || event?.target?.closest?.('[data-fa-nexus-section-toggle]');
    const sectionId = String(button?.getAttribute?.('data-fa-nexus-section-toggle') || '');
    const activeId = this._activeTool?.id;
    if (!sectionId || !activeId) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this._controller?.toggleSectionCollapse?.(activeId, sectionId);
    this._syncDynamicSections();
  }

  async _prepareContext() {
    const tool = this._activeTool;
    const canToggleGridSnap = !!(this._controller?.supportsGridSnap?.() && this._gridSnapAvailable);
    const gridSnapResolution = this._prepareGridSnapResolution();
    const options = this._toolOptionState || {};
    const help = this._controller?.getToolHelpContext?.(tool?.id) || { available: false };
    const normalized = this._activeNormalizedOptions
      || (tool?.id ? this._controller?._getToolNormalized?.(tool.id) || null : null);
    if (normalized?.rendererMode === TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE) {
      return this._prepareDeclarativeContext({
        tool,
        normalized,
        help,
        canToggleGridSnap,
        gridSnapResolution
      });
    }
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
    const mapToggle = (toggle) => ({
      id: String(toggle?.id || ''),
      group: typeof toggle?.group === 'string' ? toggle.group : '',
      label: String(toggle?.label || ''),
      tooltip: String(toggle?.tooltip || ''),
      onLabel: typeof toggle?.onLabel === 'string' ? toggle.onLabel : '',
      offLabel: typeof toggle?.offLabel === 'string' ? toggle.offLabel : '',
      enabled: !!toggle?.enabled,
      disabled: !!toggle?.disabled
    });
    const mapAction = (action) => ({
      id: String(action?.id || ''),
      label: String(action?.label || ''),
      tooltip: String(action?.tooltip || ''),
      primary: !!action?.primary,
      disabled: !!action?.disabled
    });
    const allToggleList = Array.isArray(options.customToggles)
      ? options.customToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : [];
    const subtoolToggleList = Array.isArray(options.subtoolToggles)
      ? options.subtoolToggles.map(mapToggle).filter((toggle) => toggle.id.length)
      : allToggleList.filter((toggle) => toggle.group === 'subtool');
    const subtoolOptionToggleList = allToggleList.filter((toggle) => toggle.group === 'subtool-option');
    const nonSubtoolToggleList = allToggleList.filter((toggle) => !['subtool', 'subtool-option', 'height-map'].includes(toggle.group));
    const placementToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group === 'placement');
    const customToggleList = nonSubtoolToggleList.filter((toggle) => toggle.group !== 'placement');
    const editorActionList = Array.isArray(options.editorActions)
      ? options.editorActions.map(mapAction).filter((action) => action.id.length)
      : [];
    const placeAs = options.placeAs && typeof options.placeAs === 'object' ? options.placeAs : null;
    const scale = this._prepareScaleContext(options.scale);
    const rotation = this._prepareRotationContext(options.rotation);
    const flip = this._prepareFlipContext(options.flip);
    const pathShadow = this._preparePathShadowContext(options.pathShadow);
    const pathAppearance = this._preparePathAppearanceContext(options.pathAppearance);
    const pathFeather = this._preparePathFeatherContext(options.pathFeather);
    const opacityFeather = this._prepareOpacityFeatherContext(options.opacityFeather);
    const shapeStacking = this._prepareShapeStackingContext(options.shapeStacking);
    return {
      isDeclarative: false,
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      gridSnapResolution,
      showDropShadowToggle: !!dropShadow.available,
      dropShadowEnabled: !!dropShadow.enabled,
      dropShadowDisabled: !!dropShadow.disabled,
      dropShadowTooltip,
      dropShadowHint: dropShadowHint,
      dropShadowControls,
      help,
      shortcuts,
      hasSubtoolToggles: subtoolToggleList.length > 0,
      subtoolToggles: subtoolToggleList,
      hasSubtoolOptions: subtoolOptionToggleList.length > 0,
      subtoolOptions: subtoolOptionToggleList,
      hasEditorActions: editorActionList.length > 0,
      editorActions: editorActionList,
      hasPlacementToggles: placementToggleList.length > 0,
      placementToggles: placementToggleList,
      hasCustomToggles: customToggleList.length > 0,
      customToggles: customToggleList,
      flip,
      scale,
      placeAs: placeAs || { available: false },
      rotation,
      pathShadow,
      pathAppearance,
      pathFeather,
      opacityFeather,
      shapeStacking
    };
  }

  _prepareDeclarativeContext({
    tool = null,
    normalized = null,
    help = { available: false },
    canToggleGridSnap = false,
    gridSnapResolution = { available: false }
  } = {}) {
    const sections = Array.isArray(normalized?.sections) ? normalized.sections : [];
    const controls = normalized?.controls && typeof normalized.controls === 'object'
      ? normalized.controls
      : {};
    const preparedSections = [];
    for (const rawSection of sections) {
      const sectionId = String(rawSection?.id || '');
      if (!sectionId) continue;
      const label = typeof rawSection?.label === 'string' && rawSection.label.trim().length
        ? rawSection.label.trim()
        : getToolSectionLabel(sectionId);
      const region = typeof rawSection?.region === 'string' && rawSection.region.trim().length
        ? rawSection.region.trim()
        : 'body';
      const preparedControls = [];
      for (const controlId of Array.isArray(rawSection?.controls) ? rawSection.controls : []) {
        const preparedControl = this._prepareDeclarativeControl(controls[controlId]);
        if (preparedControl) preparedControls.push(preparedControl);
      }
      if (!preparedControls.length) continue;
      const collapsible = region === 'body' && rawSection?.collapsible !== false;
      const headerToggle = this._prepareDeclarativeSectionHeaderToggle({
        label,
        controls: preparedControls
      });
      const sectionControls = headerToggle
        ? preparedControls.map((control) => {
          if (control?.id !== headerToggle.controlId) return control;
          const nextControl = {
            ...control,
            toggleInSectionHeader: true
          };
          if (collapsible && nextControl.controls && typeof nextControl.controls === 'object') {
            const collapse = nextControl.controls.collapse && typeof nextControl.controls.collapse === 'object'
              ? nextControl.controls.collapse
              : {};
            nextControl.controls = {
              ...nextControl.controls,
              collapsed: false,
              collapse: {
                ...collapse,
                available: false,
                collapsed: false
              }
            };
          }
          return nextControl;
        })
        : preparedControls;
      preparedSections.push({
        id: sectionId,
        label,
        region,
        collapsible,
        collapsed: collapsible ? !!this._controller?._isSectionCollapsed?.(tool?.id, sectionId) : false,
        showHeading: rawSection?.showHeading !== false,
        headerToggle,
        controls: sectionControls
      });
    }

    const headerSections = preparedSections.filter((section) => section.region === 'header');
    const bodySections = preparedSections.filter((section) => section.region !== 'header' && section.region !== 'footer');
    const footerSections = preparedSections.filter((section) => section.region === 'footer');
    const placeAs = normalized?.legacyState?.placeAs && typeof normalized.legacyState.placeAs === 'object'
      ? normalized.legacyState.placeAs
      : null;

    return {
      isDeclarative: true,
      hasActiveTool: !!tool,
      activeToolId: tool?.id ?? null,
      activeToolLabel: tool?.label ?? '',
      gridSnapEnabled: !!this._gridSnapEnabled,
      gridSnapAvailable: canToggleGridSnap,
      gridSnapResolution,
      help,
      placeAs: placeAs || { available: false },
      declarative: {
        hasHeaderSections: headerSections.length > 0,
        hasBodySections: bodySections.length > 0,
        hasFooterSections: footerSections.length > 0,
        headerSections,
        bodySections,
        footerSections
      }
    };
  }

  _prepareDeclarativeSectionHeaderToggle({
    label = '',
    controls = []
  } = {}) {
    if (!Array.isArray(controls) || controls.length !== 1) return null;
    const control = controls[0];
    if (!control || control.type !== 'drop-shadow') return null;
    const toggle = control.toggle && typeof control.toggle === 'object' ? control.toggle : null;
    if (!toggle?.available) return null;
    const tooltip = typeof toggle.tooltip === 'string' && toggle.tooltip.length
      ? toggle.tooltip
      : (typeof toggle.hint === 'string' ? toggle.hint : '');
    return {
      controlId: String(control.id || ''),
      checked: !!toggle.enabled,
      disabled: !!toggle.disabled,
      text: 'Enabled',
      ariaLabel: typeof toggle.label === 'string' && toggle.label.trim().length
        ? toggle.label.trim()
        : (label ? `Toggle ${label}` : 'Toggle drop shadow'),
      tooltip
    };
  }

  _prepareDeclarativeControl(control = null) {
    if (!control || typeof control !== 'object') return null;
    const id = String(control.id || '');
    const type = String(control.type || '');
    if (!id || !type) return null;

    const mapToggle = (toggle) => ({
      id: String(toggle?.id || ''),
      group: typeof toggle?.group === 'string' ? toggle.group : '',
      label: String(toggle?.label || ''),
      tooltip: String(toggle?.tooltip || ''),
      onLabel: typeof toggle?.onLabel === 'string' ? toggle.onLabel : '',
      offLabel: typeof toggle?.offLabel === 'string' ? toggle.offLabel : '',
      enabled: !!toggle?.enabled,
      disabled: !!toggle?.disabled,
      icon: typeof toggle?.icon === 'string' ? toggle.icon : ''
    });
    const mapAction = (action) => ({
      id: String(action?.id || ''),
      label: String(action?.label || ''),
      tooltip: String(action?.tooltip || ''),
      primary: !!action?.primary,
      disabled: !!action?.disabled
    });

    if (type === 'segmented') {
      const options = Array.isArray(control.options)
        ? control.options.map(mapToggle).filter((option) => option.id.length)
        : [];
      if (!options.length) return null;
      return {
        ...control,
        id,
        type,
        inputType: control.multiple ? 'checkbox' : 'radio',
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        options
      };
    }

    if (type === 'toggle-list') {
      const items = Array.isArray(control.items)
        ? control.items.map(mapToggle).filter((item) => item.id.length)
        : [];
      if (!items.length) return null;
      return {
        ...control,
        id,
        type,
        inputType: 'checkbox',
        items
      };
    }

    if (type === 'action-row') {
      const actions = Array.isArray(control.actions)
        ? control.actions.map(mapAction).filter((action) => action.id.length)
        : [];
      if (!actions.length) return null;
      return {
        ...control,
        id,
        type,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        actions
      };
    }

    if (type === 'hint') {
      const text = typeof control.text === 'string' ? control.text.trim() : '';
      if (!text.length) return null;
      return {
        ...control,
        id,
        type,
        text
      };
    }

    if (type === 'toggle') {
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        tooltip: typeof control.tooltip === 'string' ? control.tooltip : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        value: !!control.value,
        disabled: !!control.disabled,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        ...(control.handlerArg !== undefined ? { handlerArg: control.handlerArg } : {})
      };
    }

    if (type === 'range') {
      const state = this._prepareDeclarativeRangeState(control);
      if (!state) return null;
      const rawHeaderToggle = control.headerToggle && typeof control.headerToggle === 'object'
        ? control.headerToggle
        : null;
      const headerToggle = rawHeaderToggle
        ? {
            label: typeof rawHeaderToggle.label === 'string' && rawHeaderToggle.label.trim().length
              ? rawHeaderToggle.label.trim()
              : '',
            value: !!rawHeaderToggle.value,
            disabled: !!rawHeaderToggle.disabled,
            tooltip: typeof rawHeaderToggle.tooltip === 'string' ? rawHeaderToggle.tooltip : '',
            ariaLabel: typeof rawHeaderToggle.ariaLabel === 'string' && rawHeaderToggle.ariaLabel.trim().length
              ? rawHeaderToggle.ariaLabel.trim()
              : '',
            handlerId: typeof rawHeaderToggle.handlerId === 'string' ? rawHeaderToggle.handlerId : '',
            ...(rawHeaderToggle.handlerArg !== undefined ? { handlerArg: rawHeaderToggle.handlerArg } : {})
          }
        : null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        ariaLabel: typeof control.ariaLabel === 'string' && control.ariaLabel.trim().length
          ? control.ariaLabel.trim()
          : '',
        compact: !!control.compact,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        ...(control.handlerArg !== undefined ? { handlerArg: control.handlerArg } : {}),
        tooltip: typeof control.tooltip === 'string' ? control.tooltip : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        inputOnly: !!control.inputOnly,
        headerToggle,
        ...state
      };
    }

    if (type === 'range-pair') {
      const items = Array.isArray(control.items)
        ? control.items
          .map((item) => {
            const itemId = typeof item?.id === 'string' && item.id.trim().length ? item.id.trim() : '';
            if (!itemId) return null;
            const state = this._prepareDeclarativeRangeState(item);
            if (!state) return null;
            return {
              ...item,
              id: itemId,
              label: typeof item.label === 'string' && item.label.trim().length
                ? item.label.trim()
                : itemId.toUpperCase(),
              ariaLabel: typeof item.ariaLabel === 'string' && item.ariaLabel.trim().length
                ? item.ariaLabel.trim()
                : '',
              handlerArg: item.handlerArg ?? itemId,
              ...state
            };
          })
          .filter(Boolean)
        : [];
      if (!items.length) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : id,
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        hint: typeof control.hint === 'string' ? control.hint : '',
        items
      };
    }

    if (type === 'axis-toggle-pair') {
      const state = this._prepareFlipContext(control.state);
      if (!state.available) return null;
      const axes = ['horizontal', 'vertical']
        .map((axisId) => {
          const axis = state[axisId];
          if (!axis || typeof axis !== 'object') return null;
          return {
            id: axisId,
            ...axis,
            handlerId: typeof control[`${axisId}HandlerId`] === 'string' ? control[`${axisId}HandlerId`] : '',
            randomHandlerId: typeof control[`${axisId}RandomHandlerId`] === 'string' ? control[`${axisId}RandomHandlerId`] : ''
          };
        })
        .filter(Boolean);
      if (!axes.length) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : 'Flip / Mirror',
        display: state.display,
        previewDisplay: state.previewDisplay,
        hint: state.randomHint,
        axes
      };
    }

    if (type === 'scalar-randomized') {
      const variant = control.variant === 'rotation' ? 'rotation' : 'scale';
      const state = variant === 'rotation'
        ? this._prepareRotationContext(control.state)
        : this._prepareScaleContext(control.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type,
        variant,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        ariaLabel: typeof control.ariaLabel === 'string' && control.ariaLabel.trim().length
          ? control.ariaLabel.trim()
          : (variant === 'rotation' ? 'Rotation' : 'Scale'),
        strengthLabel: typeof control.strengthLabel === 'string' && control.strengthLabel.trim().length
          ? control.strengthLabel.trim()
          : 'Strength',
        strengthAriaLabel: typeof control.strengthAriaLabel === 'string' && control.strengthAriaLabel.trim().length
          ? control.strengthAriaLabel.trim()
          : (variant === 'rotation' ? 'Random rotation strength' : 'Random scale strength'),
        handlerId: typeof control.handlerId === 'string' ? control.handlerId : '',
        randomHandlerId: typeof control.randomHandlerId === 'string' ? control.randomHandlerId : '',
        strengthHandlerId: typeof control.strengthHandlerId === 'string' ? control.strengthHandlerId : '',
        randomMinHandlerId: typeof control.randomMinHandlerId === 'string' ? control.randomMinHandlerId : '',
        randomMaxHandlerId: typeof control.randomMaxHandlerId === 'string' ? control.randomMaxHandlerId : '',
        hint: typeof control.hint === 'string' ? control.hint : state.randomHint,
        min: state.min,
        max: state.max,
        step: state.step,
        value: state.value,
        display: state.display,
        disabled: !!state.disabled,
        defaultValue: state.defaultValue,
        randomEnabled: !!state.randomEnabled,
        randomButtonVisible: state.randomButtonVisible !== false,
        randomMode: state.randomMode,
        randomAria: state.randomAria,
        randomLabel: state.randomLabel,
        randomTooltip: state.randomTooltip,
        randomMin: state.randomMin,
        randomMax: state.randomMax,
        randomMinDisplay: state.randomMinDisplay,
        randomMaxDisplay: state.randomMaxDisplay,
        randomMinDefault: state.randomMinDefault,
        randomMaxDefault: state.randomMaxDefault,
        randomMinAriaLabel: state.randomMinAriaLabel,
        randomMaxAriaLabel: state.randomMaxAriaLabel,
        strength: state.strength,
        strengthMin: state.strengthMin,
        strengthMax: state.strengthMax,
        strengthStep: state.strengthStep,
        strengthDisplay: state.strengthDisplay,
        strengthDefault: state.strengthDefault
      };
    }

    if (type === 'stack-order') {
      const state = this._prepareShapeStackingContext(control.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type,
        label: typeof control.label === 'string' && control.label.trim().length
          ? control.label.trim()
          : 'Selected Shape',
        orderLabel: state.orderLabel,
        elevationLabel: state.elevationLabel,
        hint: state.hint,
        pushTopLabel: typeof control.pushTopLabel === 'string' && control.pushTopLabel.trim().length
          ? control.pushTopLabel.trim()
          : 'Push to Top',
        pushBottomLabel: typeof control.pushBottomLabel === 'string' && control.pushBottomLabel.trim().length
          ? control.pushBottomLabel.trim()
          : 'Push to Bottom',
        pushTopHandlerId: typeof control.pushTopHandlerId === 'string' ? control.pushTopHandlerId : '',
        pushBottomHandlerId: typeof control.pushBottomHandlerId === 'string' ? control.pushBottomHandlerId : '',
        pushTopDisabled: !!state.pushTopDisabled,
        pushBottomDisabled: !!state.pushBottomDisabled
      };
    }

    if (type === 'drop-shadow') {
      const prepared = this._prepareDeclarativeDropShadowControl(control, id);
      if (!prepared) return null;
      return prepared;
    }

    if (type === 'portal-controls') {
      const prepared = this._prepareDeclarativePortalControl(control, id);
      if (!prepared) return null;
      return prepared;
    }

    return null;
  }

  _prepareDeclarativeRangeState(raw = {}) {
    if (!raw || typeof raw !== 'object' || raw.available === false) return null;
    const clamp = (value, min, max, fallback) => {
      const num = Number(value);
      if (!Number.isFinite(num)) return fallback;
      return Math.min(max, Math.max(min, num));
    };
    const min = Number.isFinite(raw.min) ? Number(raw.min) : 0;
    const max = Number.isFinite(raw.max) ? Number(raw.max) : 100;
    const step = Number.isFinite(raw.step) && Number(raw.step) > 0 ? Number(raw.step) : 1;
    const fallbackValue = Number.isFinite(raw.defaultValue)
      ? Number(raw.defaultValue)
      : (Number.isFinite(raw.value) ? Number(raw.value) : min);
    const value = clamp(raw.value, min, max, fallbackValue);
    const display = typeof raw.display === 'string' && raw.display.length
      ? raw.display
      : String(value);
    const defaultValue = Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null;
    return {
      min,
      max,
      step,
      value,
      display,
      defaultValue,
      disabled: !!raw.disabled
    };
  }

  _prepareGridSnapResolution() {
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = !!(this._gridSnapAvailable && (controllerAllows !== false));
    if (!available) return { available: false };
    if (this._activeTool?.id === 'token.placement') {
      return { available: false };
    }
    const value = this._normalizeGridSnapSubdivision(this._gridSnapSubdivisions);
    return {
      available: true,
      min: GRID_SNAP_SUBDIV_MIN,
      max: GRID_SNAP_SUBDIV_MAX,
      step: 1,
      value,
      display: this._formatGridSnapResolutionDisplay(value),
      hint: 'Snap to: Full, 1/2, 1/3, 1/4, 1/5',
      disabled: false
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
    const randomMode = raw.randomMode === 'range' ? 'range' : 'strength';
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 100;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const randomMinSeed = clamp(raw.randomMin, min, max, value);
    const randomMaxSeed = clamp(raw.randomMax, min, max, randomMinSeed);
    const randomMin = Math.min(randomMinSeed, randomMaxSeed);
    const randomMax = Math.max(randomMinSeed, randomMaxSeed);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}%`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : `±${Math.round(strength)}%`;
    const randomMinDisplay = typeof raw.randomMinDisplay === 'string'
      ? raw.randomMinDisplay
      : `${Math.round(randomMin)}%`;
    const randomMaxDisplay = typeof raw.randomMaxDisplay === 'string'
      ? raw.randomMaxDisplay
      : `${Math.round(randomMax)}%`;
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random scale' : 'Enable random scale');
    const randomAria = typeof raw.randomAria === 'string'
      ? raw.randomAria
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
      disabled: !!raw.disabled,
      defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
      randomEnabled,
      randomMode,
      randomAria,
      randomMin,
      randomMax,
      randomMinDisplay,
      randomMaxDisplay,
      randomMinDefault: Number.isFinite(raw.randomMinDefault) ? Number(raw.randomMinDefault) : null,
      randomMaxDefault: Number.isFinite(raw.randomMaxDefault) ? Number(raw.randomMaxDefault) : null,
      randomMinAriaLabel: typeof raw.randomMinAriaLabel === 'string' ? raw.randomMinAriaLabel : 'Minimum random scale',
      randomMaxAriaLabel: typeof raw.randomMaxAriaLabel === 'string' ? raw.randomMaxAriaLabel : 'Maximum random scale',
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      strengthDefault: Number.isFinite(raw.strengthDefault) ? Number(raw.strengthDefault) : null,
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
    const randomMode = raw.randomMode === 'range' ? 'range' : 'strength';
    const strengthMin = Number.isFinite(raw.strengthMin) ? Number(raw.strengthMin) : 0;
    const strengthMax = Number.isFinite(raw.strengthMax) ? Number(raw.strengthMax) : 180;
    const strengthStep = Number.isFinite(raw.strengthStep) && Number(raw.strengthStep) > 0 ? Number(raw.strengthStep) : 1;
    const strength = clamp(raw.strength, strengthMin, strengthMax, strengthMin);
    const randomMinSeed = clamp(raw.randomMin, min, max, value);
    const randomMaxSeed = clamp(raw.randomMax, min, max, randomMinSeed);
    const randomMin = Math.min(randomMinSeed, randomMaxSeed);
    const randomMax = Math.max(randomMinSeed, randomMaxSeed);
    const display = typeof raw.display === 'string' ? raw.display : `${Math.round(value)}°`;
    const strengthDisplay = typeof raw.strengthDisplay === 'string'
      ? raw.strengthDisplay
      : (strength > 0 ? `±${Math.round(strength)}°` : '±0°');
    const randomMinDisplay = typeof raw.randomMinDisplay === 'string'
      ? raw.randomMinDisplay
      : `${Math.round(randomMin)}°`;
    const randomMaxDisplay = typeof raw.randomMaxDisplay === 'string'
      ? raw.randomMaxDisplay
      : `${Math.round(randomMax)}°`;
    const randomLabel = typeof raw.randomLabel === 'string' ? raw.randomLabel : 'Random';
    const randomTooltip = typeof raw.randomTooltip === 'string'
      ? raw.randomTooltip
      : (randomEnabled ? 'Disable random rotation' : 'Enable random rotation');
    const randomAria = typeof raw.randomAria === 'string'
      ? raw.randomAria
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
      disabled: !!raw.disabled,
      defaultValue: Number.isFinite(raw.defaultValue) ? Number(raw.defaultValue) : null,
      randomEnabled,
      randomMode,
      randomAria,
      randomMin,
      randomMax,
      randomMinDisplay,
      randomMaxDisplay,
      randomMinDefault: Number.isFinite(raw.randomMinDefault) ? Number(raw.randomMinDefault) : null,
      randomMaxDefault: Number.isFinite(raw.randomMaxDefault) ? Number(raw.randomMaxDefault) : null,
      randomMinAriaLabel: typeof raw.randomMinAriaLabel === 'string' ? raw.randomMinAriaLabel : 'Minimum random rotation',
      randomMaxAriaLabel: typeof raw.randomMaxAriaLabel === 'string' ? raw.randomMaxAriaLabel : 'Maximum random rotation',
      strength,
      strengthMin,
      strengthMax,
      strengthStep,
      strengthDisplay,
      strengthDefault: Number.isFinite(raw.strengthDefault) ? Number(raw.strengthDefault) : null,
      randomLabel,
      randomTooltip,
      randomHint,
      randomButtonVisible
    };
  }

  _prepareShapeStackingContext(raw) {
    const shapeStackingRaw = raw && typeof raw === 'object' ? raw : null;
    return shapeStackingRaw && shapeStackingRaw.available
      ? {
          available: true,
          hasSelection: !!shapeStackingRaw.hasSelection,
          orderLabel: typeof shapeStackingRaw.orderLabel === 'string' ? shapeStackingRaw.orderLabel : '',
          elevationLabel: typeof shapeStackingRaw.elevationLabel === 'string' ? shapeStackingRaw.elevationLabel : '',
          pushTopDisabled: !!shapeStackingRaw.pushTopDisabled,
          pushBottomDisabled: !!shapeStackingRaw.pushBottomDisabled,
          hint: typeof shapeStackingRaw.hint === 'string' ? shapeStackingRaw.hint : ''
        }
      : { available: false };
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

  _preparePathShadowContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) {
      return { available: false };
    }
    const coerceNumber = (value, fallback) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : fallback;
    };
    const coerceString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
    const coerceBool = (value) => !!value;
    const normalizeSlider = (config = {}, defaults = {}) => ({
      min: coerceNumber(config.min, defaults.min ?? 0),
      max: coerceNumber(config.max, defaults.max ?? 1),
      step: coerceNumber(config.step, defaults.step ?? 0.1),
      value: coerceNumber(config.value, defaults.value ?? 0),
      display: coerceString(config.display, defaults.display ?? String(coerceNumber(config.value, defaults.value ?? 0))),
      disabled: coerceBool(config.disabled),
      hint: coerceString(config.hint, '')
    });
    const normalizePreset = (entry, index) => {
      const data = entry && typeof entry === 'object' ? entry : {};
      const saved = coerceBool(data.saved);
      const idx = Number.isInteger(data.index) ? Number(data.index) : index;
      const label = coerceString(data.label, String(index + 1));
      const baseTooltip = saved
        ? `Click to apply preset ${index + 1}.`
        : `Shift+Click to save preset ${index + 1}.`;
      const tooltip = coerceString(data.tooltip, baseTooltip);
      return {
        index: idx,
        label,
        saved,
        active: coerceBool(data.active),
        tooltip
      };
    };
    return {
      available: true,
      enabled: coerceBool(raw.enabled),
      disabled: coerceBool(raw.disabled),
      editMode: coerceBool(raw.editMode),
      editAvailable: raw.editAvailable !== false,
      editDisabled: coerceBool(raw.editDisabled),
      editReset: (() => {
        const resetRaw = raw.editReset && typeof raw.editReset === 'object' ? raw.editReset : null;
        if (!resetRaw) return null;
        return {
          disabled: coerceBool(resetRaw.disabled),
          tooltip: coerceString(resetRaw.tooltip, '')
        };
      })(),
      activePreset: Number.isInteger(raw.activePreset) ? Number(raw.activePreset) : -1,
      presets: Array.isArray(raw.presets) ? raw.presets.map((entry, index) => normalizePreset(entry, index)) : [],
      presetsHint: coerceString(raw.presetsHint, ''),
      reset: (() => {
        const resetRaw = raw.reset && typeof raw.reset === 'object' ? raw.reset : {};
        return {
          disabled: coerceBool(resetRaw.disabled),
          tooltip: coerceString(resetRaw.tooltip, '')
        };
      })(),
      context: (() => {
        const contextRaw = raw.context && typeof raw.context === 'object' ? raw.context : {};
        return {
          display: coerceString(contextRaw.display, '0'),
          note: coerceString(contextRaw.note, '')
        };
      })(),
      scale: normalizeSlider(raw.scale, {
        min: 10,
        max: 250,
        step: 1,
        value: 100,
        display: '100%',
        disabled: false
      }),
      offset: normalizeSlider(raw.offset, { min: 0, max: 0, step: 0.01, value: 0, display: '0' }),
      alpha: normalizeSlider(raw.alpha, { min: 0, max: 1, step: 0.01, value: 1, display: '100%' }),
      blur: normalizeSlider(raw.blur, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' }),
      dilation: normalizeSlider(raw.dilation, { min: 0, max: 5, step: 0.1, value: 0, display: '0 px' })
    };
  }

  _prepareDeclarativeDropShadowControl(control, id) {
    const variant = control?.variant === 'path' ? 'path' : 'default';
    if (variant === 'path') {
      const state = this._preparePathShadowContext(control?.state);
      if (!state.available) return null;
      return {
        ...control,
        id,
        type: 'drop-shadow',
        variant,
        toggle: {
          available: true,
          enabled: !!state.enabled,
          disabled: !!state.disabled,
          label: typeof control.toggleLabel === 'string' && control.toggleLabel.trim().length
            ? control.toggleLabel.trim()
            : 'Path Shadow',
          tooltip: typeof control.toggleTooltip === 'string' ? control.toggleTooltip : '',
          hint: typeof control.toggleHint === 'string' ? control.toggleHint : '',
          handlerId: typeof control.toggleHandlerId === 'string' && control.toggleHandlerId.length
            ? control.toggleHandlerId
            : 'setPathShadowEnabled'
        },
        controls: {
          available: true,
          label: typeof control.controlsLabel === 'string' && control.controlsLabel.trim().length
            ? control.controlsLabel.trim()
            : 'Shadow Settings',
          collapsed: false,
          collapse: {
            available: false,
            collapsed: false,
            disabled: !!state.disabled,
            handlerId: ''
          },
          context: {
            display: String(state.context?.display || ''),
            status: '',
            note: String(state.context?.note || '')
          },
          presetHandlerId: typeof control.presetHandlerId === 'string' && control.presetHandlerId.length
            ? control.presetHandlerId
            : 'handlePathShadowPreset',
          presets: Array.isArray(state.presets) ? state.presets : [],
          reset: {
            label: typeof control.resetLabel === 'string' && control.resetLabel.trim().length
              ? control.resetLabel.trim()
              : 'Reset Shadow',
            disabled: !!state.reset?.disabled,
            tooltip: typeof state.reset?.tooltip === 'string' ? state.reset.tooltip : '',
            handlerId: typeof control.resetHandlerId === 'string' && control.resetHandlerId.length
              ? control.resetHandlerId
              : 'resetPathShadowSettings'
          },
          edit: {
            available: state.editAvailable !== false,
            enabled: !!state.editMode,
            disabled: !state.enabled || !!state.editDisabled,
            label: typeof control.editLabel === 'string' && control.editLabel.trim().length
              ? control.editLabel.trim()
              : 'Edit Shadow',
            handlerId: typeof control.editHandlerId === 'string' && control.editHandlerId.length
              ? control.editHandlerId
              : 'setPathShadowEditMode',
            reset: state.editReset
              ? {
                  label: typeof control.editResetLabel === 'string' && control.editResetLabel.trim().length
                    ? control.editResetLabel.trim()
                    : 'Reset',
                  disabled: !!state.editReset.disabled,
                  tooltip: typeof state.editReset.tooltip === 'string' ? state.editReset.tooltip : '',
                  handlerId: typeof control.editResetHandlerId === 'string' && control.editResetHandlerId.length
                    ? control.editResetHandlerId
                    : 'resetPathShadowEdit'
                }
              : null
          },
          scale: state.scale
            ? {
                ...state.scale,
                label: typeof control.scaleLabel === 'string' && control.scaleLabel.trim().length
                  ? control.scaleLabel.trim()
                  : 'Scale',
                handlerId: typeof control.scaleHandlerId === 'string' && control.scaleHandlerId.length
                  ? control.scaleHandlerId
                  : 'setPathShadowScale'
              }
            : null,
          offset: state.offset
            ? {
                ...state.offset,
                mode: 'scalar',
                label: typeof control.offsetLabel === 'string' && control.offsetLabel.trim().length
                  ? control.offsetLabel.trim()
                  : 'Offset',
                handlerId: typeof control.offsetHandlerId === 'string' && control.offsetHandlerId.length
                  ? control.offsetHandlerId
                  : 'setPathShadowOffset',
                resetHandlerId: ''
              }
            : null,
          alpha: state.alpha
            ? {
                ...state.alpha,
                label: 'Opacity',
                handlerId: typeof control.alphaHandlerId === 'string' && control.alphaHandlerId.length
                  ? control.alphaHandlerId
                  : 'setPathShadowAlpha'
              }
            : null,
          blur: state.blur
            ? {
                ...state.blur,
                label: 'Blur',
                handlerId: typeof control.blurHandlerId === 'string' && control.blurHandlerId.length
                  ? control.blurHandlerId
                  : 'setPathShadowBlur'
              }
            : null,
          dilation: state.dilation
            ? {
                ...state.dilation,
                label: 'Dilation',
                handlerId: typeof control.dilationHandlerId === 'string' && control.dilationHandlerId.length
                  ? control.dilationHandlerId
                  : 'setPathShadowDilation'
              }
            : null,
          preview: null
        }
      };
    }

    const toggleRaw = control?.toggle && typeof control.toggle === 'object' ? control.toggle : {};
    const controlsState = this._prepareDropShadowControls(control?.controls, toggleRaw);
    if (!toggleRaw.available && !controlsState.available) return null;
    return {
      ...control,
      id,
      type: 'drop-shadow',
      variant,
      toggle: {
        available: !!toggleRaw.available,
        enabled: !!toggleRaw.enabled,
        disabled: !!toggleRaw.disabled,
        label: typeof control?.toggleLabel === 'string' && control.toggleLabel.trim().length
          ? control.toggleLabel.trim()
          : 'Drop Shadow',
        tooltip: typeof toggleRaw.tooltip === 'string' ? toggleRaw.tooltip : '',
        hint: typeof toggleRaw.hint === 'string' ? toggleRaw.hint : '',
        handlerId: typeof control?.toggleHandlerId === 'string' && control.toggleHandlerId.length
          ? control.toggleHandlerId
          : 'setDropShadowEnabled'
      },
      controls: {
        ...controlsState,
        label: typeof control?.controlsLabel === 'string' && control.controlsLabel.trim().length
          ? control.controlsLabel.trim()
          : 'Shadow Settings',
        presetHandlerId: typeof control?.presetHandlerId === 'string' && control.presetHandlerId.length
          ? control.presetHandlerId
          : 'handleDropShadowPreset',
        collapse: {
          available: true,
          collapsed: !!controlsState.collapsed,
          disabled: !!controlsState.disabled,
          handlerId: typeof control?.collapseHandlerId === 'string' && control.collapseHandlerId.length
            ? control.collapseHandlerId
            : 'toggleDropShadowCollapsed'
        },
        reset: {
          label: typeof control?.resetLabel === 'string' && control.resetLabel.trim().length
            ? control.resetLabel.trim()
            : 'Reset',
          disabled: !!controlsState.disabled,
          tooltip: 'Reset shadow settings to defaults',
          handlerId: typeof control?.resetHandlerId === 'string' && control.resetHandlerId.length
            ? control.resetHandlerId
            : 'resetDropShadow'
        },
        edit: {
          available: false,
          enabled: false,
          disabled: true,
          label: '',
          handlerId: '',
          reset: null
        },
        scale: null,
        offset: controlsState.offset
          ? {
              ...controlsState.offset,
              mode: 'polar',
              label: 'Offset',
              handlerId: typeof control?.offsetHandlerId === 'string' && control.offsetHandlerId.length
                ? control.offsetHandlerId
                : 'setDropShadowOffset',
              resetHandlerId: typeof control?.offsetResetHandlerId === 'string' && control.offsetResetHandlerId.length
                ? control.offsetResetHandlerId
                : 'resetDropShadowOffset',
              offsetMaxHandlerId: typeof control?.offsetMaxHandlerId === 'string' && control.offsetMaxHandlerId.length
                ? control.offsetMaxHandlerId
                : (controlsState.offset.offsetMaxHandlerId || '')
            }
          : null,
        alpha: controlsState.alpha
          ? {
              ...controlsState.alpha,
              handlerId: typeof control?.alphaHandlerId === 'string' && control.alphaHandlerId.length
                ? control.alphaHandlerId
                : 'setDropShadowAlpha'
            }
          : null,
        blur: controlsState.blur
          ? {
              ...controlsState.blur,
              handlerId: typeof control?.blurHandlerId === 'string' && control.blurHandlerId.length
                ? control.blurHandlerId
                : 'setDropShadowBlur'
            }
          : null,
        dilation: controlsState.dilation
          ? {
              ...controlsState.dilation,
              handlerId: typeof control?.dilationHandlerId === 'string' && control.dilationHandlerId.length
                ? control.dilationHandlerId
                : 'setDropShadowDilation'
            }
          : null
      }
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
      maxDistanceMin: coerceNumber(offsetRaw.maxDistanceMin, 1),
      maxDistanceLimit: coerceNumber(offsetRaw.maxDistanceLimit, 512),
      maxDistanceStep: coerceNumber(offsetRaw.maxDistanceStep, 1),
      maxDistanceHint: coerceString(offsetRaw.maxDistanceHint, ''),
      offsetMaxHandlerId: coerceString(offsetRaw.offsetMaxHandlerId, ''),
      mode: coerceString(offsetRaw.mode, ''),
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
      context,
      preview: raw.preview && typeof raw.preview === 'object' ? raw.preview : null
    };
  }

  _prepareDeclarativePortalControl(control, id) {
    const inferredVariant = (() => {
      if (control?.variant === 'door' || control?.type === 'door-controls') return 'door';
      if (control?.variant === 'window' || control?.type === 'window-controls') return 'window';
      return '';
    })();
    if (!inferredVariant) return null;
    const raw = control?.state && typeof control.state === 'object' ? control.state : null;
    if (!raw?.available) return null;

    const coerceString = (value, fallback = '') => {
      if (value === undefined || value === null) return fallback;
      const text = String(value);
      return text.length ? text : fallback;
    };
    const coerceNumber = (value, fallback = 0) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    const disabled = !!raw.disabled;

    const makeOptions = (entries = [], fallbackValue) => {
      const list = Array.isArray(entries) ? entries : [];
      return list.map((entry, index) => {
        const data = entry && typeof entry === 'object' ? entry : {};
        const fallback = typeof fallbackValue === 'function' ? fallbackValue(data, index) : index;
        const value = data.value ?? data.id ?? fallback;
        return {
          value: String(value),
          label: coerceString(data.label, String(index + 1)),
          selected: !!data.selected
        };
      });
    };

    const makeAction = ({
      id: actionId,
      handlerId,
      title = '',
      icon = '',
      label = '',
      disabled: actionDisabled = false,
      primary = false
    } = {}) => ({
      id: String(actionId || ''),
      handlerId: String(handlerId || ''),
      title: coerceString(title, ''),
      icon: coerceString(icon, ''),
      label: coerceString(label, ''),
      disabled: !!actionDisabled,
      primary: !!primary
    });

    const makeToggle = ({ id: toggleId, label, title = '', checked = false, disabled: toggleDisabled = false, handlerId } = {}) => ({
      id: String(toggleId || ''),
      label: coerceString(label, ''),
      title: coerceString(title, ''),
      checked: !!checked,
      disabled: !!toggleDisabled,
      handlerId: String(handlerId || '')
    });

    const makeSelect = ({
      id: selectId,
      label,
      handlerId,
      value,
      options = [],
      disabled: selectDisabled = false,
      valueMode = 'string'
    } = {}) => {
      const selectedValue = String(value ?? '');
      return {
        id: String(selectId || ''),
        label: coerceString(label, ''),
        handlerId: String(handlerId || ''),
        value: selectedValue,
        disabled: !!selectDisabled,
        valueMode,
        options: (Array.isArray(options) ? options : []).map((option) => ({
          value: String(option?.value ?? ''),
          label: coerceString(option?.label, ''),
          selected: String(option?.value ?? '') === selectedValue || !!option?.selected
        }))
      };
    };

    const makeRow = ({
      id: rowId,
      label,
      handlerId,
      min,
      max,
      step,
      value,
      defaultValue,
      display = '',
      disabled: rowDisabled = false,
      hint = ''
    } = {}) => ({
      id: String(rowId || ''),
      label: coerceString(label, ''),
      handlerId: String(handlerId || ''),
      min: coerceNumber(min, 0),
      max: coerceNumber(max, 0),
      step: coerceNumber(step, 1),
      value: coerceNumber(value, 0),
      defaultValue: defaultValue === undefined ? undefined : coerceNumber(defaultValue, 0),
      display: coerceString(display, ''),
      disabled: !!rowDisabled,
      hint: coerceString(hint, ''),
      valueMode: 'number'
    });

    const makeColorTarget = ({
      id: targetId,
      handlerId,
      groupName,
      visible = true,
      items = []
    } = {}) => ({
      id: String(targetId || ''),
      handlerId: String(handlerId || ''),
      groupName: coerceString(groupName, ''),
      visible: visible !== false,
      items: (Array.isArray(items) ? items : []).map((item) => ({
        id: String(item?.id || ''),
        groupName: coerceString(groupName, ''),
        label: coerceString(item?.label, ''),
        title: coerceString(item?.tooltip ?? item?.title, ''),
        enabled: !!item?.enabled,
        disabled: !!item?.disabled
      }))
    });

    const makePickerActions = ({
      id: pickerId,
      icon,
      label,
      pickHandlerId,
      clearHandlerId,
      title = '',
      clearTitle = 'Clear',
      hidden = false
    } = {}) => {
      const pickId = `${pickerId}-pick`;
      const clearId = `${pickerId}-clear`;
      return {
        visible: !hidden,
        pickAction: makeAction({
          id: pickId,
          handlerId: pickHandlerId,
          title,
          icon,
          label,
          disabled
        }),
        clearAction: makeAction({
          id: clearId,
          handlerId: clearHandlerId,
          title: clearTitle,
          label: 'Clear',
          disabled
        })
      };
    };

    const actionMap = Object.create(null);
    const toggleMap = Object.create(null);
    const selectMap = Object.create(null);
    const settingMap = Object.create(null);
    const toggleGroupMap = Object.create(null);
    const selectGroupMap = Object.create(null);
    const sectionMap = Object.create(null);

    const registerAction = (action) => {
      if (action?.id) actionMap[action.id] = action;
      return action;
    };
    const registerToggleGroup = (group) => {
      if (group?.id) toggleGroupMap[group.id] = group;
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        if (item?.id) toggleMap[item.id] = item;
      }
      return group;
    };
    const registerSelectGroup = (group) => {
      if (group?.id) selectGroupMap[group.id] = group;
      for (const item of Array.isArray(group?.items) ? group.items : []) {
        if (item?.id) selectMap[item.id] = item;
      }
      return group;
    };
    const registerSettingRows = (rows) => {
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row?.id) settingMap[row.id] = row;
      }
    };
    const registerSection = (section) => {
      if (section?.id) sectionMap[section.id] = section;
      if (section?.picker?.pickAction) registerAction(section.picker.pickAction);
      if (section?.picker?.clearAction) registerAction(section.picker.clearAction);
      registerSettingRows(section?.settings?.rows);
      return section;
    };

    const selectionLabel = coerceString(raw.selectionLabel, '');
    const selectionDisabled = disabled || !raw.hasSelection;

    if (inferredVariant === 'door') {
      const animations = makeOptions(raw.animations, (_, index) => index);
      const directions = makeOptions(raw.directions, (_, index) => (index === 0 ? -1 : 1));
      const selectedAnimation = coerceString(
        raw.selectedAnimation,
        animations.find((option) => option.selected)?.value || ''
      );
      const selectedDirection = String(coerceNumber(raw.direction, 1) === -1 ? -1 : 1);
      const frame = raw.frameSettings && typeof raw.frameSettings === 'object' ? raw.frameSettings : null;
      const colorTarget = raw.colorTarget && typeof raw.colorTarget === 'object' ? raw.colorTarget : null;
      const hsbc = raw.hsbc && typeof raw.hsbc === 'object' ? raw.hsbc : null;

      const headerActions = [
        registerAction(makeAction({
          id: 'apply-selected-to-defaults',
          handlerId: 'applyDoorDefaults',
          title: 'Use the selected door as the default for new placements',
          icon: 'fas fa-arrow-up-right-dots',
          label: 'Use Selected as Defaults',
          disabled: selectionDisabled
        })),
        registerAction(makeAction({
          id: 'apply-defaults-to-selected',
          handlerId: 'applyDoorDefaultsToSelected',
          title: 'Apply the current door defaults to the selected door',
          icon: 'fas fa-file-import',
          label: 'Apply Defaults to Selected',
          disabled: selectionDisabled,
          primary: true
        })),
        registerAction(makeAction({
          id: 'clear-selection',
          handlerId: 'clearPortalSelection',
          title: 'Clear current portal selection',
          icon: 'fas fa-times',
          label: 'Clear Selection',
          disabled: selectionDisabled
        }))
      ];

      const toggleGroups = [
        registerToggleGroup({
          id: 'primary',
          visible: true,
          items: [
            makeToggle({
              id: 'flip',
              label: 'Flip Texture',
              title: 'Mirror the selected door texture',
              checked: !!raw.flip,
              disabled,
              handlerId: 'setDoorFlip'
            }),
            makeToggle({
              id: 'double',
              label: 'Double Door',
              title: 'Spawn a paired door leaf',
              checked: !!raw.double,
              disabled,
              handlerId: 'setDoorDouble'
            }),
            makeToggle({
              id: 'direction-flip',
              label: 'Flip Hinge',
              title: 'Swap door endpoints (hinge flip)',
              checked: !!raw.directionFlip,
              disabled,
              handlerId: 'setDoorDirectionFlip'
            })
          ]
        })
      ];

      const selectGroups = [
        registerSelectGroup({
          id: 'primary',
          visible: true,
          items: [
            makeSelect({
              id: 'animation',
              label: 'Animation',
              handlerId: 'setDoorAnimation',
              value: selectedAnimation,
              options: animations,
              disabled
            }),
            makeSelect({
              id: 'direction',
              label: 'Open Direction',
              handlerId: 'setDoorDirection',
              value: selectedDirection,
              options: directions,
              disabled,
              valueMode: 'door-direction'
            })
          ]
        })
      ];

      const sections = [
        registerSection({
          id: 'door-texture',
          label: 'Door Texture',
          visible: !raw.hideTexturePickers,
          collapsed: !!this._isPortalSectionCollapsed?.(id, 'door-texture'),
          summary: coerceString(raw.textureLabel, 'None'),
          picker: makePickerActions({
            id: 'door-texture',
            icon: 'fas fa-door-closed',
            label: coerceString(raw.textureLabel, 'Pick Door Texture'),
            pickHandlerId: 'pickDoorTexture',
            clearHandlerId: 'clearDoorTexture',
            hidden: !!raw.hideTexturePickers
          }),
          settings: null
        }),
        registerSection({
          id: 'door-frame',
          label: 'Door Frame',
          visible: !raw.hideTexturePickers || !!frame,
          collapsed: !!this._isPortalSectionCollapsed?.(id, 'door-frame'),
          summary: coerceString(raw.frameLabel, 'None'),
          picker: makePickerActions({
            id: 'door-frame',
            icon: 'fas fa-border-all',
            label: coerceString(raw.frameLabel, 'Pick Door Frame'),
            pickHandlerId: 'pickDoorFrameTexture',
            clearHandlerId: 'clearDoorFrameTexture',
            hidden: !!raw.hideTexturePickers
          }),
          settings: {
            id: 'door-frame',
            visible: !!frame,
            rows: frame ? [
              makeRow({
                id: 'door-frame-scale',
                label: 'Scale',
                handlerId: 'setDoorFrameScale',
                min: frame.scaleMin,
                max: frame.scaleMax,
                step: frame.scaleStep,
                value: frame.scale,
                defaultValue: frame.scaleDefault,
                display: frame.scaleDisplay,
                disabled
              }),
              makeRow({
                id: 'door-frame-offset-x',
                label: 'Offset X',
                handlerId: 'setDoorFrameOffsetX',
                min: frame.offsetMin,
                max: frame.offsetMax,
                step: frame.offsetStep,
                value: frame.offsetX,
                defaultValue: frame.offsetXDefault,
                display: frame.offsetXDisplay,
                disabled
              }),
              makeRow({
                id: 'door-frame-offset-y',
                label: 'Offset Y',
                handlerId: 'setDoorFrameOffsetY',
                min: frame.offsetMin,
                max: frame.offsetMax,
                step: frame.offsetStep,
                value: frame.offsetY,
                defaultValue: frame.offsetYDefault,
                display: frame.offsetYDisplay,
                disabled
              }),
              makeRow({
                id: 'door-frame-rotation',
                label: 'Rotation',
                handlerId: 'setDoorFrameRotation',
                min: frame.rotationMin,
                max: frame.rotationMax,
                step: frame.rotationStep,
                value: frame.rotation,
                defaultValue: frame.rotationDefault,
                display: frame.rotationDisplay,
                disabled: disabled || !!frame.rotationDisabled,
                hint: coerceString(frame.rotationHint, '')
              })
            ] : []
          }
        })
      ];

      const colorSection = registerSection({
        id: 'color',
        label: 'Color',
        visible: !!(colorTarget?.available && hsbc?.available),
        collapsed: !!this._isPortalSectionCollapsed?.(id, 'color'),
        picker: null,
        settings: null
      });

      const color = {
        ...colorSection,
        label: 'Color',
        hint: coerceString(hsbc?.hint, ''),
        target: makeColorTarget({
          id: 'door-color-target',
          handlerId: 'setDoorHsbcTarget',
          groupName: `fa-nexus-portal-color-${id}`,
          visible: !!colorTarget?.available,
          items: Array.isArray(colorTarget?.options) ? colorTarget.options : []
        }),
        rows: hsbc?.available ? [
          makeRow({
            id: 'door-hsbc-hue',
            label: 'Hue',
            handlerId: 'setDoorHsbcHue',
            min: hsbc?.hue?.min,
            max: hsbc?.hue?.max,
            step: hsbc?.hue?.step,
            value: hsbc?.hue?.value,
            defaultValue: hsbc?.hue?.defaultValue,
            display: hsbc?.hue?.display,
            disabled: disabled || !!hsbc?.hue?.disabled,
            hint: coerceString(hsbc?.hue?.tooltip || hsbc?.hint, '')
          }),
          makeRow({
            id: 'door-hsbc-saturation',
            label: 'Saturation',
            handlerId: 'setDoorHsbcSaturation',
            min: hsbc?.saturation?.min,
            max: hsbc?.saturation?.max,
            step: hsbc?.saturation?.step,
            value: hsbc?.saturation?.value,
            defaultValue: hsbc?.saturation?.defaultValue,
            display: hsbc?.saturation?.display,
            disabled: disabled || !!hsbc?.saturation?.disabled,
            hint: coerceString(hsbc?.saturation?.tooltip || hsbc?.hint, '')
          }),
          makeRow({
            id: 'door-hsbc-brightness',
            label: 'Brightness',
            handlerId: 'setDoorHsbcBrightness',
            min: hsbc?.brightness?.min,
            max: hsbc?.brightness?.max,
            step: hsbc?.brightness?.step,
            value: hsbc?.brightness?.value,
            defaultValue: hsbc?.brightness?.defaultValue,
            display: hsbc?.brightness?.display,
            disabled: disabled || !!hsbc?.brightness?.disabled,
            hint: coerceString(hsbc?.brightness?.tooltip || hsbc?.hint, '')
          }),
          makeRow({
            id: 'door-hsbc-contrast',
            label: 'Contrast',
            handlerId: 'setDoorHsbcContrast',
            min: hsbc?.contrast?.min,
            max: hsbc?.contrast?.max,
            step: hsbc?.contrast?.step,
            value: hsbc?.contrast?.value,
            defaultValue: hsbc?.contrast?.defaultValue,
            display: hsbc?.contrast?.display,
            disabled: disabled || !!hsbc?.contrast?.disabled,
            hint: coerceString(hsbc?.contrast?.tooltip || hsbc?.hint, '')
          })
        ] : []
      };
      registerSettingRows(color.rows);

      return {
        ...control,
        id,
        type: 'portal-controls',
        variant: inferredVariant,
        title: 'Door Options',
        selectionLabel,
        selectionHint: coerceString(raw.selectionHint, ''),
        headerActions,
        toggleGroups,
        selectGroups,
        color,
        sections,
        actionMap,
        toggleMap,
        selectMap,
        settingMap,
        toggleGroupMap,
        selectGroupMap,
        sectionMap
      };
    }

    const animations = makeOptions(raw.animations, (_, index) => index);
    const directions = makeOptions(raw.directions, (_, index) => (index === 0 ? -1 : 1));
    const selectedAnimation = coerceString(
      raw.selectedAnimation,
      animations.find((option) => option.selected)?.value || ''
    );
    const selectedDirection = String(coerceNumber(raw.direction, 1) === -1 ? -1 : 1);
    const sill = raw.sillSettings && typeof raw.sillSettings === 'object' ? raw.sillSettings : null;
    const texture = raw.textureSettings && typeof raw.textureSettings === 'object' ? raw.textureSettings : null;
    const frame = raw.frameSettings && typeof raw.frameSettings === 'object' ? raw.frameSettings : null;
    const colorTarget = raw.colorTarget && typeof raw.colorTarget === 'object' ? raw.colorTarget : null;
    const hsbc = raw.hsbc && typeof raw.hsbc === 'object' ? raw.hsbc : null;

    const headerActions = [
      registerAction(makeAction({
        id: 'apply-selected-to-defaults',
        handlerId: 'applyWindowDefaults',
        title: 'Use the selected window as the default for new placements',
        icon: 'fas fa-arrow-up-right-dots',
        label: 'Use Selected as Defaults',
        disabled: selectionDisabled
      })),
      registerAction(makeAction({
        id: 'apply-defaults-to-selected',
        handlerId: 'applyWindowDefaultsToSelected',
        title: 'Apply the current window defaults to the selected window',
        icon: 'fas fa-file-import',
        label: 'Apply Defaults to Selected',
        disabled: selectionDisabled,
        primary: true
      })),
      registerAction(makeAction({
        id: 'clear-selection',
        handlerId: 'clearPortalSelection',
        title: 'Clear current portal selection',
        icon: 'fas fa-times',
        label: 'Clear Selection',
        disabled: selectionDisabled
      }))
    ];

    const toggleGroups = [
      registerToggleGroup({
        id: 'primary',
        visible: true,
        items: [
          makeToggle({
            id: 'animated',
            label: 'Animated Window',
            title: 'Use Foundry animated window instead of static texture',
            checked: !!raw.animated,
            disabled,
            handlerId: 'setWindowAnimated'
          }),
          makeToggle({
            id: 'flip',
            label: 'Flip Texture',
            title: 'Mirror window glass texture',
            checked: !!raw.flip,
            disabled,
            handlerId: 'setWindowFlip'
          })
        ]
      }),
      registerToggleGroup({
        id: 'animated-secondary',
        visible: !!raw.animated,
        items: [
          makeToggle({
            id: 'double',
            label: 'Double',
            title: 'Animate both panes',
            checked: !!raw.double,
            disabled,
            handlerId: 'setWindowDouble'
          }),
          makeToggle({
            id: 'direction-flip',
            label: 'Flip Hinge',
            title: 'Swap window endpoints (hinge flip)',
            checked: !!raw.directionFlip,
            disabled,
            handlerId: 'setWindowDirectionFlip'
          })
        ]
      })
    ];

    const selectGroups = [
      registerSelectGroup({
        id: 'animated',
        visible: !!raw.animated,
        items: [
          makeSelect({
            id: 'animation',
            label: 'Animation',
            handlerId: 'setWindowAnimation',
            value: selectedAnimation,
            options: animations,
            disabled
          }),
          makeSelect({
            id: 'direction',
            label: 'Open Direction',
            handlerId: 'setWindowDirection',
            value: selectedDirection,
            options: directions,
            disabled,
            valueMode: 'number'
          })
        ]
      })
    ];

    const sections = [
      registerSection({
        id: 'window-sill',
        label: 'Window Sill',
        visible: !raw.hideTexturePickers || !!sill,
        collapsed: !!this._isPortalSectionCollapsed?.(id, 'window-sill'),
        summary: coerceString(raw.sillLabel, 'None'),
        picker: makePickerActions({
          id: 'window-sill',
          icon: 'fas fa-layer-group',
          label: coerceString(raw.sillLabel, 'Pick Sill'),
          pickHandlerId: 'pickWindowSillTexture',
          clearHandlerId: 'clearWindowSillTexture',
          hidden: !!raw.hideTexturePickers
        }),
        settings: {
          id: 'window-sill',
          visible: !!sill,
          rows: sill ? [
            makeRow({
              id: 'window-sill-scale',
              label: 'Scale',
              handlerId: 'setWindowSillScale',
              min: sill.scaleMin,
              max: sill.scaleMax,
              step: sill.scaleStep,
              value: sill.scale,
              defaultValue: sill.scaleDefault,
              display: sill.scaleDisplay,
              disabled
            }),
            makeRow({
              id: 'window-sill-offset-x',
              label: 'Offset X',
              handlerId: 'setWindowSillOffsetX',
              min: sill.offsetMin,
              max: sill.offsetMax,
              step: sill.offsetStep,
              value: sill.offsetX,
              defaultValue: sill.offsetXDefault,
              display: sill.offsetXDisplay,
              disabled
            }),
            makeRow({
              id: 'window-sill-offset-y',
              label: 'Offset Y',
              handlerId: 'setWindowSillOffsetY',
              min: sill.offsetMin,
              max: sill.offsetMax,
              step: sill.offsetStep,
              value: sill.offsetY,
              defaultValue: sill.offsetYDefault,
              display: sill.offsetYDisplay,
              disabled
            })
          ] : []
        }
      }),
      registerSection({
        id: 'window-texture',
        label: 'Window Texture',
        visible: !raw.hideTexturePickers || (!raw.animated && !!texture),
        collapsed: !!this._isPortalSectionCollapsed?.(id, 'window-texture'),
        summary: coerceString(raw.textureLabel, 'None'),
        picker: makePickerActions({
          id: 'window-texture',
          icon: 'fas fa-border-all',
          label: coerceString(raw.textureLabel, 'Pick Window Texture'),
          pickHandlerId: 'pickWindowTexture',
          clearHandlerId: 'clearWindowTexture',
          hidden: !!raw.hideTexturePickers
        }),
        settings: {
          id: 'window-texture',
          visible: !raw.animated && !!texture,
          rows: texture ? [
            makeRow({
              id: 'window-texture-scale',
              label: 'Scale',
              handlerId: 'setWindowTextureScale',
              min: texture.scaleMin,
              max: texture.scaleMax,
              step: texture.scaleStep,
              value: texture.scale,
              defaultValue: texture.scaleDefault,
              display: texture.scaleDisplay,
              disabled
            }),
            makeRow({
              id: 'window-texture-offset-x',
              label: 'Offset X',
              handlerId: 'setWindowTextureOffsetX',
              min: texture.offsetMin,
              max: texture.offsetMax,
              step: texture.offsetStep,
              value: texture.offsetX,
              defaultValue: texture.offsetXDefault,
              display: texture.offsetXDisplay,
              disabled
            }),
            makeRow({
              id: 'window-texture-offset-y',
              label: 'Offset Y',
              handlerId: 'setWindowTextureOffsetY',
              min: texture.offsetMin,
              max: texture.offsetMax,
              step: texture.offsetStep,
              value: texture.offsetY,
              defaultValue: texture.offsetYDefault,
              display: texture.offsetYDisplay,
              disabled
            })
          ] : []
        }
      }),
      registerSection({
        id: 'window-frame',
        label: 'Window Frame',
        visible: !raw.hideTexturePickers || !!frame,
        collapsed: !!this._isPortalSectionCollapsed?.(id, 'window-frame'),
        summary: coerceString(raw.frameLabel, 'None'),
        picker: makePickerActions({
          id: 'window-frame',
          icon: 'fas fa-columns',
          label: coerceString(raw.frameLabel, 'Pick Window Frame'),
          pickHandlerId: 'pickWindowFrameTexture',
          clearHandlerId: 'clearWindowFrameTexture',
          hidden: !!raw.hideTexturePickers
        }),
        settings: {
          id: 'window-frame',
          visible: !!frame,
          rows: frame ? [
            makeRow({
              id: 'window-frame-scale',
              label: 'Scale',
              handlerId: 'setWindowFrameScale',
              min: frame.scaleMin,
              max: frame.scaleMax,
              step: frame.scaleStep,
              value: frame.scale,
              defaultValue: frame.scaleDefault,
              display: frame.scaleDisplay,
              disabled
            }),
            makeRow({
              id: 'window-frame-offset-x',
              label: 'Offset X',
              handlerId: 'setWindowFrameOffsetX',
              min: frame.offsetMin,
              max: frame.offsetMax,
              step: frame.offsetStep,
              value: frame.offsetX,
              defaultValue: frame.offsetXDefault,
              display: frame.offsetXDisplay,
              disabled
            }),
            makeRow({
              id: 'window-frame-offset-y',
              label: 'Offset Y',
              handlerId: 'setWindowFrameOffsetY',
              min: frame.offsetMin,
              max: frame.offsetMax,
              step: frame.offsetStep,
              value: frame.offsetY,
              defaultValue: frame.offsetYDefault,
              display: frame.offsetYDisplay,
              disabled
            }),
            makeRow({
              id: 'window-frame-rotation',
              label: 'Rotation',
              handlerId: 'setWindowFrameRotation',
              min: frame.rotationMin,
              max: frame.rotationMax,
              step: frame.rotationStep,
              value: frame.rotation,
              defaultValue: frame.rotationDefault,
              display: frame.rotationDisplay,
              disabled: disabled || !!frame.rotationDisabled,
              hint: coerceString(frame.rotationHint, '')
            })
          ] : []
        }
      })
    ];

    const colorSection = registerSection({
      id: 'color',
      label: 'Color',
      visible: !!(colorTarget?.available && hsbc?.available),
      collapsed: !!this._isPortalSectionCollapsed?.(id, 'color'),
      picker: null,
      settings: null
    });

    const color = {
      ...colorSection,
      label: 'Color',
      hint: coerceString(hsbc?.hint, ''),
      target: makeColorTarget({
        id: 'window-color-target',
        handlerId: 'setWindowHsbcTarget',
        groupName: `fa-nexus-portal-color-${id}`,
        visible: !!colorTarget?.available,
        items: Array.isArray(colorTarget?.options) ? colorTarget.options : []
      }),
      rows: hsbc?.available ? [
        makeRow({
          id: 'window-hsbc-hue',
          label: 'Hue',
          handlerId: 'setWindowHsbcHue',
          min: hsbc?.hue?.min,
          max: hsbc?.hue?.max,
          step: hsbc?.hue?.step,
          value: hsbc?.hue?.value,
          defaultValue: hsbc?.hue?.defaultValue,
          display: hsbc?.hue?.display,
          disabled: disabled || !!hsbc?.hue?.disabled,
          hint: coerceString(hsbc?.hue?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'window-hsbc-saturation',
          label: 'Saturation',
          handlerId: 'setWindowHsbcSaturation',
          min: hsbc?.saturation?.min,
          max: hsbc?.saturation?.max,
          step: hsbc?.saturation?.step,
          value: hsbc?.saturation?.value,
          defaultValue: hsbc?.saturation?.defaultValue,
          display: hsbc?.saturation?.display,
          disabled: disabled || !!hsbc?.saturation?.disabled,
          hint: coerceString(hsbc?.saturation?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'window-hsbc-brightness',
          label: 'Brightness',
          handlerId: 'setWindowHsbcBrightness',
          min: hsbc?.brightness?.min,
          max: hsbc?.brightness?.max,
          step: hsbc?.brightness?.step,
          value: hsbc?.brightness?.value,
          defaultValue: hsbc?.brightness?.defaultValue,
          display: hsbc?.brightness?.display,
          disabled: disabled || !!hsbc?.brightness?.disabled,
          hint: coerceString(hsbc?.brightness?.tooltip || hsbc?.hint, '')
        }),
        makeRow({
          id: 'window-hsbc-contrast',
          label: 'Contrast',
          handlerId: 'setWindowHsbcContrast',
          min: hsbc?.contrast?.min,
          max: hsbc?.contrast?.max,
          step: hsbc?.contrast?.step,
          value: hsbc?.contrast?.value,
          defaultValue: hsbc?.contrast?.defaultValue,
          display: hsbc?.contrast?.display,
          disabled: disabled || !!hsbc?.contrast?.disabled,
          hint: coerceString(hsbc?.contrast?.tooltip || hsbc?.hint, '')
        })
      ] : []
    };
    registerSettingRows(color.rows);

    return {
      ...control,
      id,
      type: 'portal-controls',
      variant: inferredVariant,
      title: 'Window Options',
      selectionLabel,
      selectionHint: coerceString(raw.selectionHint, ''),
      headerActions,
      toggleGroups,
      selectGroups,
      color,
      sections,
      actionMap,
      toggleMap,
      selectMap,
      settingMap,
      toggleGroupMap,
      selectGroupMap,
      sectionMap
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
    const freehandSimplify = this._prepareFreehandSimplifyContext(data.freehandSimplify);
    const showWidthTangents = this._prepareShowWidthTangentsContext(data.showWidthTangents);
    const hint = typeof data.hint === 'string' ? data.hint : '';
    return {
      available: !!(layerOpacity.available || textureOffset.available || scale.available || tension.available || freehandSimplify.available || showWidthTangents.available),
      hint,
      layerOpacity,
      textureOffset,
      scale,
      tension,
      freehandSimplify,
      showWidthTangents
    };
  }

  _prepareShowWidthTangentsContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    return {
      available: true,
      enabled: !!raw.enabled,
      label: typeof raw.label === 'string' ? raw.label : 'Show Width Tangents',
      tooltip: typeof raw.tooltip === 'string' ? raw.tooltip : 'Display width adjustment handles.',
      disabled: !!raw.disabled
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

  _prepareFreehandSimplifyContext(raw) {
    if (!raw || typeof raw !== 'object' || !raw.available) return { available: false };
    const value = Number(raw.value ?? 0);
    const min = Number(raw.min ?? 0);
    const max = Number(raw.max ?? 1);
    const step = Number(raw.step ?? 0.01);
    const disabled = !!raw.disabled;
    const display = typeof raw.display === 'string' ? raw.display : value.toFixed(2);
    const hint = typeof raw.hint === 'string' ? raw.hint : '';
    return {
      available: true,
      min,
      max,
      step,
      value,
      display,
      hint,
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

  _ensurePlaceAsNamingSection() {
    const naming = this._toolOptionState?.placeAs?.naming || {};
    if (!naming?.available) return;
    const root = this.element;
    if (!root) return;
    const hasToggle = !!(
      root.querySelector('[data-place-as-append-number]')
      || root.querySelector('[data-place-as-prepend-adjective]')
      || root.querySelector('.fa-nexus-place-as__naming')
    );
    if (hasToggle) return;

    // The tool state can update while a render is in-flight, leaving the DOM in an older layout.
    // If the state expects the naming section but the DOM doesn't have it, force a follow-up render.
    const revision = this._toolOptionState?.layoutRevision ?? null;
    if (revision !== this._placeAsNamingRerenderRevision) {
      this._placeAsNamingRerenderRevision = revision;
      this._placeAsNamingRerenderCount = 0;
    }
    if (this._placeAsNamingRerenderCount >= 2) return;
    if (this._placeAsNamingRerenderJob) return;
    this._placeAsNamingRerenderCount += 1;
    this._placeAsNamingRerenderJob = setTimeout(() => {
      this._placeAsNamingRerenderJob = null;
      try {
        if (this.rendered) this.render(false);
      } catch (_) {}
    }, 0);
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

  _emitToolPanelActivity() {
    try {
      const target = this.element || document;
      target?.dispatchEvent?.(new CustomEvent(TOOL_OPTIONS_ACTIVITY_EVENT, {
        bubbles: true,
        detail: {
          active: !!this._toolPanelActivityActive,
          toolId: this._activeTool?.id ?? null
        }
      }));
    } catch (_) {}
  }

  _setToolPanelActivity(active) {
    const next = !!active;
    if (this._toolPanelActivityActive === next) {
      if (next) this._emitToolPanelActivity();
      return next;
    }
    this._toolPanelActivityActive = next;
    this._emitToolPanelActivity();
    return next;
  }

  _syncToolPanelActivityState() {
    const root = this.element;
    if (!root) return this._setToolPanelActivity(false);
    const hovered = !!root.matches?.(':hover');
    return this._setToolPanelActivity(hovered);
  }

  _handleToolPanelFocusOut(event) {
    const relatedTarget = event?.relatedTarget;
    if (relatedTarget && this.element?.contains?.(relatedTarget)) return;
    const defer = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (callback) => setTimeout(callback, 0);
    defer(() => this._syncToolPanelActivityState());
  }

  _bindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    const isNumberInput = display.type === 'number';
    if (inputHandler && !isNumberInput) display.addEventListener('input', inputHandler);
    if (commitHandler) {
      display.addEventListener('change', commitHandler);
      if (isNumberInput) {
        const existingHandler = display._faNexusCommitKeydown;
        if (existingHandler) {
          try { display.removeEventListener('keydown', existingHandler); } catch (_) {}
        }
        const keydownHandler = (event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          try { display._faNexusForceSyncOnCommit = true; } catch (_) {}
          commitHandler(event);
        };
        display.addEventListener('keydown', keydownHandler);
        display._faNexusCommitKeydown = keydownHandler;
      }
    }
  }

  _unbindDisplayInput(display, inputHandler, commitHandler) {
    if (!display || display.tagName !== 'INPUT') return;
    if (inputHandler) {
      try { display.removeEventListener('input', inputHandler); } catch (_) {}
    }
    if (commitHandler) {
      try { display.removeEventListener('change', commitHandler); } catch (_) {}
    }
    const keydownHandler = display._faNexusCommitKeydown;
    if (keydownHandler) {
      try { display.removeEventListener('keydown', keydownHandler); } catch (_) {}
      try { delete display._faNexusCommitKeydown; } catch (_) {}
    }
    try { delete display._faNexusForceSyncOnCommit; } catch (_) {}
  }

  _applyDefaultValue(target, value) {
    if (!target || typeof target.setAttribute !== 'function') return;
    const hasValue = value !== undefined && value !== null && value !== '';
    if (!hasValue || (typeof value === 'number' && !Number.isFinite(value))) {
      try { target.removeAttribute('data-fa-nexus-default-value'); } catch (_) {}
      return;
    }
    try { target.setAttribute('data-fa-nexus-default-value', String(value)); } catch (_) {}
  }

  _readNumericControlValue(target) {
    if (!target) return null;
    const value = typeof target.value === 'string' ? target.value : '';
    if (target.type === 'number') {
      if (!value.trim()) return null;
      if (target.validity?.badInput) return null;
    }
    return value;
  }

  _readDeclarativeNumericValue(input, {
    controlId = '',
    commit = false,
    sync = null,
    logTag = 'ToolOptions.declarative.invalidNumericInput'
  } = {}) {
    const value = this._readNumericControlValue(input);
    if (value !== null) return value;
    Logger.warn(logTag, {
      controlId: String(controlId || ''),
      commit: !!commit,
      inputType: String(input?.type || ''),
      rawValue: typeof input?.value === 'string' ? input.value : null
    });
    if (typeof sync === 'function') sync.call(this);
    return null;
  }

  _inferStepDecimals(step) {
    const numeric = Number(step);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric >= 1) return 0;
    const text = String(step);
    const dot = text.indexOf('.');
    if (dot === -1) return 0;
    const decimals = text.length - dot - 1;
    return decimals > 0 ? decimals : 0;
  }

  _normalizeNumericInputValue(value, step) {
    if (value === '' || value === null || value === undefined) return value;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    const decimals = this._inferStepDecimals(step);
    if (decimals === null) return numeric;
    return Number(numeric.toFixed(decimals));
  }

  _syncDisplayValue(display, data = {}, { disabled = false } = {}) {
    if (!display) return;
    const text = data.display || '';
    if (display.tagName === 'INPUT') {
      const isFocused = (typeof document !== 'undefined' && document.activeElement === display);
      const forceSync = display._faNexusForceSyncOnCommit === true;
      const rawValue = data.value ?? '';
      const normalizedValue = (display.type === 'number')
        ? this._normalizeNumericInputValue(rawValue, data.step ?? display.step)
        : rawValue;
      const nextValue = normalizedValue === null || normalizedValue === undefined ? '' : String(normalizedValue);
      if ((forceSync || !isFocused) && display.value !== nextValue) display.value = nextValue;
      if (forceSync) {
        try { delete display._faNexusForceSyncOnCommit; } catch (_) {}
      }
      if (data.min !== undefined) display.min = String(data.min);
      if (data.max !== undefined) display.max = String(data.max);
      if (data.step !== undefined) display.step = String(data.step);
      this._applyDefaultValue(display, data.defaultValue);
      display.disabled = !!data.disabled || !!disabled;
      if (text) display.title = text;
      else display.removeAttribute('title');
    } else if (display.textContent !== text) {
      display.textContent = text;
    }
  }

  _bindControls() {
    this._unbindControls();
    try {
      const root = this.element;
      if (!root) return;
      root.addEventListener('contextmenu', this._boundResettableContext);
      root.addEventListener('wheel', this._boundSliderWheel, { passive: false });
      root.addEventListener('keydown', this._boundWindowKeyDown);
      root.addEventListener('pointerenter', this._boundToolPanelPointerEnter);
      root.addEventListener('pointerleave', this._boundToolPanelPointerLeave);
      root.addEventListener('focusin', this._boundToolPanelFocusIn);
      root.addEventListener('focusout', this._boundToolPanelFocusOut);
      this._resettableContextRoot = root;
      this._sliderWheelRoot = root;
      this._helpKeyRoot = root;
      this._toolPanelActivityRoot = root;
      this._bindToolSectionControls();
      const helpButton = root.querySelector('[data-fa-nexus-help-open]');
      if (helpButton) {
        helpButton.addEventListener('click', this._boundHelpOpen);
        this._helpButton = helpButton;
      }
      const gridToggle = root.querySelector('#fa-nexus-grid-snap-toggle');
      if (gridToggle) {
        gridToggle.checked = !!this._gridSnapEnabled;
        const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
        const canToggle = this._gridSnapAvailable && (controllerAllows !== false);
        gridToggle.disabled = !canToggle;
        gridToggle.addEventListener('change', this._boundGridSnapChange);
        this._gridSnapToggle = gridToggle;
      }
      this._bindGridSnapResolutionControl();
      const dropToggle = root.querySelector('#fa-nexus-drop-shadow-toggle');
      if (dropToggle) {
        const dropState = this._toolOptionState?.dropShadow || {};
        dropToggle.checked = !!dropState.enabled;
        dropToggle.disabled = !!dropState.disabled;
        dropToggle.addEventListener('change', this._boundDropShadowChange);
        this._dropShadowToggle = dropToggle;
      }
      this._bindDropShadowControls();
      this._bindDeclarativeSegmentedControls();
      this._bindEditorActions();
      this._bindDeclarativeToggleControls();
      this._bindDeclarativeRangeControls();
      this._bindDeclarativeRangePairControls();
      this._bindDeclarativeAxisPairControls();
      this._bindDeclarativeScalarRandomizedControls();
      this._bindDeclarativeStackOrderControls();
      this._bindPathAppearanceControls();
      this._bindFlipControls();
      this._bindScaleControls();
      this._bindRotationControls();
      this._bindPathShadowControls();
      this._bindPathFeatherControls();
      this._bindOpacityFeatherControls();
      this._bindCustomToggles();
      this._bindPlacementControls();
      this._syncPortalControls();
      this._bindShortcutsControls();
      const placeAsToggle = root.querySelector('[data-place-as-toggle]');
      if (placeAsToggle) {
        placeAsToggle.addEventListener('click', this._boundPlaceAsToggle);
        this._placeAsToggleButton = placeAsToggle;
      }
      const placeAsFilter = root.querySelector('[data-place-as-filter]');
      if (placeAsFilter) {
        placeAsFilter.addEventListener('click', this._boundPlaceAsFilter);
        this._placeAsFilterButton = placeAsFilter;
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
      const placeAsActorType = root.querySelector('[data-place-as-actor-type]');
      if (placeAsActorType) {
        placeAsActorType.addEventListener('change', this._boundPlaceAsActorTypeChange);
        this._placeAsActorTypeSelect = placeAsActorType;
      }
      const placeAsAppendNumber = root.querySelector('[data-place-as-append-number]');
      if (placeAsAppendNumber) {
        placeAsAppendNumber.addEventListener('change', this._boundPlaceAsAppendNumberChange);
        this._placeAsAppendNumberToggle = placeAsAppendNumber;
      }
      const placeAsPrependAdjective = root.querySelector('[data-place-as-prepend-adjective]');
      if (placeAsPrependAdjective) {
        placeAsPrependAdjective.addEventListener('change', this._boundPlaceAsPrependAdjectiveChange);
        this._placeAsPrependAdjectiveToggle = placeAsPrependAdjective;
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
      this._placeAsActorTypeHint = root.querySelector('[data-place-as-actor-type-hint]');
      this._placeAsHpPercentHint = root.querySelector('[data-place-as-hp-percent-hint]');
      this._placeAsHpStaticHint = root.querySelector('[data-place-as-hp-static-hint]');
      this._placeAsHpStaticError = root.querySelector('[data-place-as-hp-static-error]');
      this._placeAsHpPercentRow = root.querySelector('[data-place-as-hp-percent-row]');
      this._placeAsHpStaticRow = root.querySelector('[data-place-as-hp-static-row]');
      this._syncPlaceAsControls();
      this._syncToolPanelActivityState();
    } catch (_) {}
  }

  _unbindControls() {
    if (this._toolPanelActivityRoot) {
      try { this._toolPanelActivityRoot.removeEventListener('pointerenter', this._boundToolPanelPointerEnter); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('pointerleave', this._boundToolPanelPointerLeave); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('focusin', this._boundToolPanelFocusIn); } catch (_) {}
      try { this._toolPanelActivityRoot.removeEventListener('focusout', this._boundToolPanelFocusOut); } catch (_) {}
      this._toolPanelActivityRoot = null;
    }
    if (this._resettableContextRoot) {
      try { this._resettableContextRoot.removeEventListener('contextmenu', this._boundResettableContext); }
      catch (_) {}
      this._resettableContextRoot = null;
    }
    if (this._sliderWheelRoot) {
      try { this._sliderWheelRoot.removeEventListener('wheel', this._boundSliderWheel); } catch (_) {}
      this._sliderWheelRoot = null;
    }
    if (this._helpKeyRoot) {
      try { this._helpKeyRoot.removeEventListener('keydown', this._boundWindowKeyDown); } catch (_) {}
      this._helpKeyRoot = null;
    }
    if (this._helpButton) {
      try { this._helpButton.removeEventListener('click', this._boundHelpOpen); } catch (_) {}
      this._helpButton = null;
    }
    if (this._gridSnapToggle) {
      try { this._gridSnapToggle.removeEventListener('change', this._boundGridSnapChange); }
      catch (_) {}
      this._gridSnapToggle = null;
    }
    this._unbindGridSnapResolutionControl();
    if (this._dropShadowToggle) {
      try { this._dropShadowToggle.removeEventListener('change', this._boundDropShadowChange); }
      catch (_) {}
      this._dropShadowToggle = null;
    }
    this._unbindDropShadowControls();
    this._unbindDeclarativeSegmentedControls();
    this._unbindEditorActions();
    this._unbindDeclarativeToggleControls();
    this._unbindDeclarativeRangeControls();
    this._unbindDeclarativeRangePairControls();
    this._unbindDeclarativeAxisPairControls();
    this._unbindDeclarativeScalarRandomizedControls();
    this._unbindDeclarativeStackOrderControls();
    this._unbindPathAppearanceControls();
    this._unbindFlipControls();
    this._unbindScaleControls();
    this._unbindRotationControls();
    this._unbindPathShadowControls();
    this._unbindPathFeatherControls();
    this._unbindOpacityFeatherControls();
    this._unbindPlacementControls();
    this._unbindToolSectionControls();
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
    if (this._placeAsFilterButton) {
      try { this._placeAsFilterButton.removeEventListener('click', this._boundPlaceAsFilter); }
      catch (_) {}
      this._placeAsFilterButton = null;
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
    if (this._placeAsActorTypeSelect) {
      try { this._placeAsActorTypeSelect.removeEventListener('change', this._boundPlaceAsActorTypeChange); }
      catch (_) {}
      this._placeAsActorTypeSelect = null;
    }
    if (this._placeAsAppendNumberToggle) {
      try { this._placeAsAppendNumberToggle.removeEventListener('change', this._boundPlaceAsAppendNumberChange); }
      catch (_) {}
      this._placeAsAppendNumberToggle = null;
    }
    if (this._placeAsPrependAdjectiveToggle) {
      try { this._placeAsPrependAdjectiveToggle.removeEventListener('change', this._boundPlaceAsPrependAdjectiveChange); }
      catch (_) {}
      this._placeAsPrependAdjectiveToggle = null;
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
    this._placeAsActorTypeHint = null;
    this._placeAsHpPercentHint = null;
    this._placeAsHpStaticHint = null;
    this._placeAsHpStaticError = null;
    this._placeAsHpPercentRow = null;
    this._placeAsHpStaticRow = null;
  }

  _handleResettableContext(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const input = target.closest('input[type="range"], input[type="number"]');
    if (!input || input.disabled) return;
    const defaultValue = input.dataset?.faNexusDefaultValue;
    if (defaultValue === undefined || defaultValue === null || defaultValue === '') return;
    event.preventDefault();
    event.stopPropagation();
    if (input.value !== String(defaultValue)) {
      input.value = String(defaultValue);
    }
    try {
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (_) {}
  }

  _handleSliderWheel(event) {
    if (!event || event.defaultPrevented) return;
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    const slider = target.closest('input[type="range"]');
    if (!slider || slider.disabled) return;
    if (typeof slider.matches === 'function' && slider.matches('[data-fa-nexus-grid-snap-slider]')) return;
    if (event.ctrlKey) {
      const delta = Number(event.deltaY) || Number(event.deltaX) || 0;
      if (!delta) return;
      const min = Number(slider.min ?? 0);
      const max = Number(slider.max ?? 0);
      let step = Number(slider.step ?? 1);
      if (!Number.isFinite(step) || step <= 0) step = 1;
      const direction = delta < 0 ? 1 : -1;
      const current = Number(slider.value);
      const base = Number.isFinite(current) ? current : min;
      let next = base + (step * direction);
      const clampMin = Number.isFinite(min) ? min : 0;
      const clampMax = Number.isFinite(max) ? max : clampMin;
      next = Math.min(clampMax, Math.max(clampMin, next));
      const decimals = this._inferStepDecimals(step);
      if (decimals !== null) next = Number(next.toFixed(decimals));
      if (next !== base) {
        slider.value = String(next);
        try { slider.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const container = this._getScrollContainer();
    if (container) {
      const deltaY = Number(event.deltaY) || 0;
      const deltaX = Number(event.deltaX) || 0;
      if (deltaY) container.scrollTop += deltaY;
      if (deltaX) container.scrollLeft += deltaX;
    }
    event.preventDefault();
    event.stopPropagation();
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
    const control = this._getPreparedDropShadowControl();
    const fallbackState = control?.toggle || this._getDropShadowLegacyToggleState();
    const handlerId = typeof control?.toggle?.handlerId === 'string' ? control.toggle.handlerId : '';
    const controller = this._controller;
    if (!controller) {
      target.checked = !!fallbackState.enabled;
      return;
    }
    try {
      const result = handlerId
        ? controller.invokeToolHandler?.(handlerId, next)
        : controller.requestDropShadowToggle?.(next);
      if (result?.then) {
        result.then((success) => {
          if (!success) target.checked = !!fallbackState.enabled;
        }).catch(() => {
          target.checked = !!fallbackState.enabled;
        });
      } else if (result === false) {
        target.checked = !!fallbackState.enabled;
      }
    } catch (_) {
      target.checked = !!fallbackState.enabled;
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
    this._syncGridSnapResolutionControl();
  }

  _normalizeGridSnapSubdivision(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _formatGridSnapResolutionDisplay(value) {
    return formatGridSnapSubdivisionLabel(value);
  }

  _syncGridSnapResolutionControl() {
    const root = this._gridSnapResolutionRoot;
    if (!root) return;
    const slider = this._gridSnapResolutionSlider;
    const display = this._gridSnapResolutionDisplay;
    const controllerAllows = this._controller?.isGridSnapSettingAvailable?.();
    const available = this._gridSnapAvailable && (controllerAllows !== false);
    root.classList.toggle('is-disabled', !available);
    if (slider) {
      slider.disabled = !available;
      slider.value = String(this._gridSnapSubdivisions);
      this._applyDefaultValue(slider, GRID_SNAP_SUBDIV_DEFAULT);
    }
    if (display) {
      const formattedValue = this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions);
      this._syncDisplayValue(display, {
        min: slider?.min,
        max: slider?.max,
        step: slider?.step,
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT),
        disabled: !available
      }, { disabled: !available });
    }
  }

  _bindGridSnapResolutionControl() {
    const root = this.element?.querySelector('[data-fa-nexus-grid-snap-root]');
    if (!root) {
      this._unbindGridSnapResolutionControl();
      return;
    }
    this._gridSnapResolutionRoot = root;
    const slider = root.querySelector('[data-fa-nexus-grid-snap-slider]');
    this._gridSnapResolutionSlider = slider || null;
    this._gridSnapResolutionDisplay = root.querySelector('[data-fa-nexus-grid-snap-display]') || null;
    if (slider) {
      slider.value = String(this._gridSnapSubdivisions);
      slider.addEventListener('input', this._boundGridSnapResolutionInput);
      slider.addEventListener('change', this._boundGridSnapResolutionCommit);
    }
    this._bindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._syncGridSnapResolutionControl();
  }

  _unbindGridSnapResolutionControl() {
    if (this._gridSnapResolutionSlider) {
      try {
        this._gridSnapResolutionSlider.removeEventListener('input', this._boundGridSnapResolutionInput);
        this._gridSnapResolutionSlider.removeEventListener('change', this._boundGridSnapResolutionCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._gridSnapResolutionDisplay, this._boundGridSnapResolutionInput, this._boundGridSnapResolutionCommit);
    this._gridSnapResolutionSlider = null;
    this._gridSnapResolutionDisplay = null;
    this._gridSnapResolutionRoot = null;
  }

  _handleGridSnapResolutionInput(event, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const value = this._normalizeGridSnapSubdivision(target.value);
    this._gridSnapSubdivisions = value;
    if (this._gridSnapResolutionDisplay) {
      const formattedValue = this._formatGridSnapResolutionDisplay(value);
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT)
      });
    }
    if (!commit) return;
    const controller = this._controller;
    if (!controller?.requestGridSnapSubdivisionChange) return;
    try {
      const result = controller.requestGridSnapSubdivisionChange(value);
      if (result?.then) {
        result.catch(() => this._resetGridSnapResolutionControl());
      } else if (result === false) {
        this._resetGridSnapResolutionControl();
      }
    } catch (_) {
      this._resetGridSnapResolutionControl();
    }
  }

  _resetGridSnapResolutionControl() {
    const controllerValue = this._controller?.getGridSnapSubdivisions?.();
    if (controllerValue === undefined || controllerValue === null) return;
    this._gridSnapSubdivisions = this._normalizeGridSnapSubdivision(controllerValue);
    if (this._gridSnapResolutionSlider) {
      this._gridSnapResolutionSlider.value = String(this._gridSnapSubdivisions);
    }
    if (this._gridSnapResolutionDisplay) {
      const formattedValue = this._formatGridSnapResolutionDisplay(this._gridSnapSubdivisions);
      this._syncDisplayValue(this._gridSnapResolutionDisplay, {
        value: formattedValue,
        display: formattedValue,
        defaultValue: this._formatGridSnapResolutionDisplay(GRID_SNAP_SUBDIV_DEFAULT)
      });
    }
  }

  setGridSnapSubdivisions(value) {
    const normalized = this._normalizeGridSnapSubdivision(value);
    if (this._gridSnapSubdivisions === normalized) return;
    this._gridSnapSubdivisions = normalized;
    this._syncGridSnapResolutionControl();
  }

  _getPreparedDropShadowControl() {
    const controlId = String(
      this._dropShadowControlId
      || this._dropShadowToggle?.getAttribute?.('data-fa-nexus-drop-shadow-toggle-input')
      || ''
    );
    if (!controlId) return null;
    const control = this._getPreparedDeclarativeControl(controlId);
    return control?.type === 'drop-shadow' ? control : null;
  }

  _getDropShadowLegacyToggleState() {
    const state = this._toolOptionState?.dropShadow;
    return state && typeof state === 'object' ? state : {};
  }

  _getDropShadowControlsState() {
    const control = this._getPreparedDropShadowControl();
    if (control?.controls && typeof control.controls === 'object') return control.controls;
    const state = this._toolOptionState?.dropShadowControls;
    return state && typeof state === 'object' ? state : null;
  }

  _syncDropShadowControl() {
    const toggle = this._dropShadowToggle;
    if (!toggle) return;
    const control = this._getPreparedDropShadowControl();
    const state = control?.toggle || this._getDropShadowLegacyToggleState();
    toggle.checked = !!state.enabled;
    toggle.disabled = !!state.disabled;
  }

  _bindDropShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-drop-shadow-root]') || null;
    if (!root) {
      this._unbindDropShadowControls();
      return;
    }
    if (this._dropShadowRoot === root) {
      this._syncDropShadowControl();
      this._syncDropShadowControls();
      return;
    }
    this._unbindDropShadowControls();
    this._dropShadowRoot = root;
    this._dropShadowControlId = String(root.getAttribute('data-fa-nexus-drop-shadow-root') || '');
    this._dropShadowScaleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-scale-display]') || null;
    this._dropShadowAlphaDisplay = root.querySelector('[data-fa-nexus-drop-shadow-alpha-display]') || null;
    this._dropShadowDilationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-dilation-display]') || null;
    this._dropShadowBlurDisplay = root.querySelector('[data-fa-nexus-drop-shadow-blur-display]') || null;
    this._dropShadowOffsetDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-display]') || null;
    this._dropShadowOffsetDistanceDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-distance-display]') || null;
    this._dropShadowOffsetAngleDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-angle-display]') || null;
    this._dropShadowOffsetMaxDisplay = root.querySelector('[data-fa-nexus-drop-shadow-offset-max-display]') || null;
    this._dropShadowElevationDisplay = root.querySelector('[data-fa-nexus-drop-shadow-elevation]') || null;
    this._dropShadowStatusDisplay = root.querySelector('[data-fa-nexus-drop-shadow-status]') || null;
    this._dropShadowNoteDisplay = root.querySelector('[data-fa-nexus-drop-shadow-note]') || null;
    this._dropShadowCollapseButton = root.querySelector('[data-fa-nexus-drop-shadow-toggle]') || null;
    if (this._dropShadowCollapseButton) {
      this._dropShadowCollapseButton.addEventListener('click', this._boundDropShadowCollapse);
    }
    this._dropShadowBody = root.querySelector('[data-fa-nexus-drop-shadow-body]') || null;
    this._dropShadowEditRoot = root.querySelector('[data-fa-nexus-drop-shadow-edit-row]')
      || root.querySelector('[data-fa-nexus-drop-shadow-edit-root]')
      || null;
    this._dropShadowEditToggle = root.querySelector('[data-fa-nexus-drop-shadow-edit]') || null;
    if (this._dropShadowEditToggle) {
      this._dropShadowEditToggle.addEventListener('change', this._boundDropShadowEditToggle);
    }
    this._dropShadowEditResetButton = root.querySelector('[data-fa-nexus-drop-shadow-edit-reset]') || null;
    if (this._dropShadowEditResetButton) {
      this._dropShadowEditResetButton.addEventListener('click', this._boundDropShadowEditReset);
    }
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

    const scaleSlider = root.querySelector('[data-fa-nexus-drop-shadow-scale]');
    if (scaleSlider) {
      scaleSlider.addEventListener('input', this._boundDropShadowScaleInput);
      scaleSlider.addEventListener('change', this._boundDropShadowScaleCommit);
      this._dropShadowScaleSlider = scaleSlider;
    }
    this._bindDisplayInput(this._dropShadowScaleDisplay, this._boundDropShadowScaleInput, this._boundDropShadowScaleCommit);
    const alphaSlider = root.querySelector('[data-fa-nexus-drop-shadow-alpha]');
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundDropShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundDropShadowAlphaCommit);
      this._dropShadowAlphaSlider = alphaSlider;
    }
    this._bindDisplayInput(this._dropShadowAlphaDisplay, this._boundDropShadowAlphaInput, this._boundDropShadowAlphaCommit);
    const dilationSlider = root.querySelector('[data-fa-nexus-drop-shadow-dilation]');
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundDropShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundDropShadowDilationCommit);
      this._dropShadowDilationSlider = dilationSlider;
    }
    this._bindDisplayInput(this._dropShadowDilationDisplay, this._boundDropShadowDilationInput, this._boundDropShadowDilationCommit);
    const blurSlider = root.querySelector('[data-fa-nexus-drop-shadow-blur]');
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundDropShadowBlurInput);
      blurSlider.addEventListener('change', this._boundDropShadowBlurCommit);
      this._dropShadowBlurSlider = blurSlider;
    }
    this._bindDisplayInput(this._dropShadowBlurDisplay, this._boundDropShadowBlurInput, this._boundDropShadowBlurCommit);
    const offsetSlider = root.querySelector('[data-fa-nexus-drop-shadow-offset]');
    if (offsetSlider) {
      offsetSlider.addEventListener('input', this._boundDropShadowOffsetInput);
      offsetSlider.addEventListener('change', this._boundDropShadowOffsetCommit);
      this._dropShadowOffsetSlider = offsetSlider;
    }
    this._bindDisplayInput(this._dropShadowOffsetDisplay, this._boundDropShadowOffsetInput, this._boundDropShadowOffsetCommit);
    const offsetControl = root.querySelector('[data-fa-nexus-drop-shadow-offset-control]');
    if (offsetControl) {
      offsetControl.addEventListener('pointerdown', this._boundDropShadowOffsetPointerDown);
      offsetControl.addEventListener('contextmenu', this._boundDropShadowOffsetContext);
      this._dropShadowOffsetControl = offsetControl;
      this._dropShadowOffsetMaxDistance = Number(offsetControl.dataset.maxDistance) || 40;
    }
    this._bindDisplayInput(
      this._dropShadowOffsetMaxDisplay,
      null,
      this._boundDropShadowOffsetMaxCommit
    );
    if (this._dropShadowOffsetMaxDisplay) {
      this._dropShadowOffsetMaxDisplay.addEventListener('input', this._boundDropShadowOffsetMaxInput);
    }
    this._dropShadowOffsetCircle = root.querySelector('[data-fa-nexus-drop-shadow-offset-circle]') || null;
    this._dropShadowPreviewRoot = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview]') || null;
    this._dropShadowPreviewImage = root.querySelector('[data-fa-nexus-drop-shadow-offset-preview-image]') || null;
    this._dropShadowOffsetHandle = root.querySelector('[data-fa-nexus-drop-shadow-offset-handle]') || null;

    this._syncDropShadowControl();
    this._syncDropShadowControls();
  }

  _unbindDropShadowControls() {
    if (this._dropShadowScaleSlider) {
      try {
        this._dropShadowScaleSlider.removeEventListener('input', this._boundDropShadowScaleInput);
        this._dropShadowScaleSlider.removeEventListener('change', this._boundDropShadowScaleCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowScaleDisplay, this._boundDropShadowScaleInput, this._boundDropShadowScaleCommit);
    if (this._dropShadowAlphaSlider) {
      try {
        this._dropShadowAlphaSlider.removeEventListener('input', this._boundDropShadowAlphaInput);
        this._dropShadowAlphaSlider.removeEventListener('change', this._boundDropShadowAlphaCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowAlphaDisplay, this._boundDropShadowAlphaInput, this._boundDropShadowAlphaCommit);
    if (this._dropShadowDilationSlider) {
      try {
        this._dropShadowDilationSlider.removeEventListener('input', this._boundDropShadowDilationInput);
        this._dropShadowDilationSlider.removeEventListener('change', this._boundDropShadowDilationCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowDilationDisplay, this._boundDropShadowDilationInput, this._boundDropShadowDilationCommit);
    if (this._dropShadowBlurSlider) {
      try {
        this._dropShadowBlurSlider.removeEventListener('input', this._boundDropShadowBlurInput);
        this._dropShadowBlurSlider.removeEventListener('change', this._boundDropShadowBlurCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowBlurDisplay, this._boundDropShadowBlurInput, this._boundDropShadowBlurCommit);
    if (this._dropShadowOffsetSlider) {
      try {
        this._dropShadowOffsetSlider.removeEventListener('input', this._boundDropShadowOffsetInput);
        this._dropShadowOffsetSlider.removeEventListener('change', this._boundDropShadowOffsetCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._dropShadowOffsetDisplay, this._boundDropShadowOffsetInput, this._boundDropShadowOffsetCommit);
    this._unbindDisplayInput(
      this._dropShadowOffsetMaxDisplay,
      null,
      this._boundDropShadowOffsetMaxCommit
    );
    if (this._dropShadowOffsetMaxDisplay) {
      try { this._dropShadowOffsetMaxDisplay.removeEventListener('input', this._boundDropShadowOffsetMaxInput); } catch (_) {}
    }
    if (this._dropShadowOffsetControl) {
      try { this._dropShadowOffsetControl.removeEventListener('pointerdown', this._boundDropShadowOffsetPointerDown); } catch (_) {}
      try { this._dropShadowOffsetControl.removeEventListener('contextmenu', this._boundDropShadowOffsetContext); } catch (_) {}
    }
    if (this._dropShadowCollapseButton) {
      try { this._dropShadowCollapseButton.removeEventListener('click', this._boundDropShadowCollapse); } catch (_) {}
    }
    if (this._dropShadowEditToggle) {
      try { this._dropShadowEditToggle.removeEventListener('change', this._boundDropShadowEditToggle); } catch (_) {}
    }
    if (this._dropShadowEditResetButton) {
      try { this._dropShadowEditResetButton.removeEventListener('click', this._boundDropShadowEditReset); } catch (_) {}
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
    this._dropShadowControlId = '';
    this._dropShadowScaleSlider = null;
    this._dropShadowAlphaSlider = null;
    this._dropShadowDilationSlider = null;
    this._dropShadowBlurSlider = null;
    this._dropShadowOffsetSlider = null;
    this._dropShadowOffsetControl = null;
    this._dropShadowOffsetCircle = null;
    this._dropShadowPreviewRoot = null;
    this._dropShadowPreviewImage = null;
    this._dropShadowOffsetHandle = null;
    this._dropShadowScaleDisplay = null;
    this._dropShadowAlphaDisplay = null;
    this._dropShadowDilationDisplay = null;
    this._dropShadowBlurDisplay = null;
    this._dropShadowOffsetDisplay = null;
    this._dropShadowOffsetDistanceDisplay = null;
    this._dropShadowOffsetAngleDisplay = null;
    this._dropShadowOffsetMaxDisplay = null;
    this._dropShadowElevationDisplay = null;
    this._dropShadowStatusDisplay = null;
    this._dropShadowNoteDisplay = null;
    this._dropShadowCollapseButton = null;
    this._dropShadowBody = null;
    this._dropShadowEditRoot = null;
    this._dropShadowEditToggle = null;
    this._dropShadowEditResetButton = null;
    this._dropShadowPresetsRoot = null;
    this._dropShadowPresetButtons = [];
    this._dropShadowResetButton = null;
  }

  _syncDropShadowControls() {
    this._syncDropShadowControl();
    const state = this._getDropShadowControlsState();
    const available = !!state?.available;
    if (this._dropShadowRoot) {
      this._dropShadowRoot.classList.toggle('is-hidden', !available);
    }
    if (!this._dropShadowRoot || !available) return;

    const assign = (slider, display, entry) => {
      if (!slider || !entry) return;
      if (entry.min !== undefined) slider.min = entry.min;
      if (entry.max !== undefined) slider.max = entry.max;
      if (entry.step !== undefined) slider.step = entry.step;
      if (entry.value !== undefined) slider.value = entry.value;
      slider.disabled = !!entry.disabled;
      if (display) this._syncDisplayValue(display, entry);
    };
    const collapsed = !!(state.collapse?.collapsed ?? state.collapsed);
    if (this._dropShadowRoot) {
      this._dropShadowRoot.classList.toggle('is-collapsed', collapsed);
    }
    if (this._dropShadowBody) {
      if (collapsed) this._dropShadowBody.setAttribute('aria-hidden', 'true');
      else this._dropShadowBody.removeAttribute('aria-hidden');
    }
    if (this._dropShadowCollapseButton) {
      const collapseAvailable = state.collapse?.available !== false;
      this._dropShadowCollapseButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      this._dropShadowCollapseButton.setAttribute('aria-label', collapsed ? 'Expand shadow settings' : 'Collapse shadow settings');
      this._dropShadowCollapseButton.classList.toggle('is-collapsed', collapsed);
      this._dropShadowCollapseButton.classList.toggle('is-hidden', !collapseAvailable);
      this._dropShadowCollapseButton.disabled = !collapseAvailable || !!(state.collapse?.disabled ?? state.disabled);
      this._dropShadowCollapseButton.title = collapsed ? 'Expand shadow settings' : 'Collapse shadow settings';
    }
    if (this._dropShadowEditRoot) {
      this._dropShadowEditRoot.classList.toggle('is-hidden', !state.edit?.available);
    }
    if (this._dropShadowEditToggle) {
      this._dropShadowEditToggle.checked = !!state.edit?.enabled;
      this._dropShadowEditToggle.disabled = !state.edit?.available || !!state.edit?.disabled;
    }
    if (this._dropShadowEditResetButton) {
      const editReset = state.edit?.reset || null;
      this._dropShadowEditResetButton.classList.toggle('is-hidden', !editReset);
      if (editReset) {
        this._dropShadowEditResetButton.disabled = !!editReset.disabled;
        this._dropShadowEditResetButton.textContent = editReset.label || 'Reset';
        if (editReset.tooltip) this._dropShadowEditResetButton.title = editReset.tooltip;
        else this._dropShadowEditResetButton.removeAttribute('title');
      }
    }
    assign(this._dropShadowScaleSlider, this._dropShadowScaleDisplay, state.scale);
    assign(this._dropShadowAlphaSlider, this._dropShadowAlphaDisplay, state.alpha);
    assign(this._dropShadowDilationSlider, this._dropShadowDilationDisplay, state.dilation);
    assign(this._dropShadowBlurSlider, this._dropShadowBlurDisplay, state.blur);
    if (state.offset) {
      const disabled = !!state.offset.disabled;
      if (state.offset.mode === 'polar' && this._dropShadowOffsetControl) {
        this._dropShadowOffsetMaxDistance = Number(state.offset.maxDistance) || this._dropShadowOffsetMaxDistance || 40;
        this._dropShadowOffsetControl.dataset.maxDistance = String(this._dropShadowOffsetMaxDistance);
        this._dropShadowOffsetControl.dataset.disabled = disabled ? 'true' : 'false';
        this._dropShadowOffsetControl.classList.toggle('is-disabled', disabled);
      } else if (this._dropShadowOffsetControl) {
        this._dropShadowOffsetControl.dataset.disabled = 'true';
        this._dropShadowOffsetControl.classList.add('is-disabled');
      }
      if (state.offset.mode === 'polar') {
        if (disabled) this._releaseDropShadowOffsetPointer();
        if (this._dropShadowOffsetDistanceDisplay) {
          this._dropShadowOffsetDistanceDisplay.textContent = state.offset.displayDistance ?? '';
        }
        if (this._dropShadowOffsetAngleDisplay) {
          this._dropShadowOffsetAngleDisplay.textContent = state.offset.displayAngle ?? '';
        }
        if (state.offset.offsetMaxHandlerId && this._dropShadowOffsetMaxDisplay) {
          this._syncDisplayValue(this._dropShadowOffsetMaxDisplay, {
            value: Math.round(Number(state.offset.maxDistance) || 0),
            min: state.offset.maxDistanceMin,
            max: state.offset.maxDistanceLimit,
            step: state.offset.maxDistanceStep,
            display: state.offset.maxDistanceHint || '',
            disabled
          }, { disabled });
        }
        this._positionDropShadowOffsetHandle(state.offset.distance, state.offset.angle, state.offset.maxDistance);
      } else {
        this._releaseDropShadowOffsetPointer();
        assign(this._dropShadowOffsetSlider, this._dropShadowOffsetDisplay, state.offset);
      }
    } else {
      this._releaseDropShadowOffsetPointer();
      if (this._dropShadowOffsetSlider) this._dropShadowOffsetSlider.disabled = true;
      if (this._dropShadowOffsetDisplay) this._dropShadowOffsetDisplay.disabled = true;
      if (this._dropShadowOffsetDistanceDisplay) this._dropShadowOffsetDistanceDisplay.textContent = '';
      if (this._dropShadowOffsetAngleDisplay) this._dropShadowOffsetAngleDisplay.textContent = '';
      if (this._dropShadowOffsetMaxDisplay) {
        this._syncDisplayValue(this._dropShadowOffsetMaxDisplay, { value: '', disabled: true }, { disabled: true });
      }
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
        if (entry?.label) button.textContent = entry.label;
        button.title = entry?.tooltip || (saved ? 'Click to apply preset.' : 'Shift+Click to save preset.');
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    }
    if (this._dropShadowResetButton) {
      const reset = state.reset || null;
      this._dropShadowResetButton.disabled = !!reset?.disabled;
      this._dropShadowResetButton.textContent = reset?.label || 'Reset';
      if (reset?.tooltip) this._dropShadowResetButton.title = reset.tooltip;
      else this._dropShadowResetButton.removeAttribute('title');
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
    this._syncDropShadowPreview(state.preview || null);
  }

  _handleDropShadowOffsetMaxSlider(event, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const control = this._getPreparedDropShadowControl();
    const rawMaxHandler = control?.controls?.offset?.offsetMaxHandlerId;
    const handlerId = (typeof rawMaxHandler === 'string' && rawMaxHandler.length)
      ? rawMaxHandler
      : (control ? '' : 'setDropShadowOffsetMax');
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, target.value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowSlider(event, key, commit) {
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.[key]?.handlerId === 'string'
      ? control.controls[key].handlerId
      : ({
          alpha: 'setDropShadowAlpha',
          dilation: 'setDropShadowDilation',
          blur: 'setDropShadowBlur'
        }[key] || '');
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, target.value, !!commit);
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.collapse?.handlerId === 'string'
      ? control.controls.collapse.handlerId
      : 'toggleDropShadowCollapsed';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowEditToggle(event) {
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.edit?.handlerId === 'string'
      ? control.controls.edit.handlerId
      : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try {
      const result = this._controller.invokeToolHandler(handlerId, enabled);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
  }

  _handleDropShadowEditReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.edit?.reset?.handlerId === 'string'
      ? control.controls.edit.reset.handlerId
      : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDropShadowControls());
      } else {
        this._syncDropShadowControls();
      }
    } catch (_) {
      this._syncDropShadowControls();
    }
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.presetHandlerId === 'string'
      ? control.controls.presetHandlerId
      : 'handleDropShadowPreset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, index, save);
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.presetHandlerId === 'string'
      ? control.controls.presetHandlerId
      : 'handleDropShadowPreset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, index, true);
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.reset?.handlerId === 'string'
      ? control.controls.reset.handlerId
      : 'resetDropShadow';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId);
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.offset?.resetHandlerId === 'string'
      ? control.controls.offset.resetHandlerId
      : 'resetDropShadowOffset';
    if (!handlerId) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId);
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
    const control = this._getPreparedDropShadowControl();
    const handlerId = typeof control?.controls?.offset?.handlerId === 'string'
      ? control.controls.offset.handlerId
      : 'setDropShadowOffset';
    if (!handlerId) return;
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
    const result = this._controller.invokeToolHandler(handlerId, distance, angle, !!commit);
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

  _bindDeclarativeSegmentedControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-segmented-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-segmented-control') || '');
      if (!controlId) continue;
      const optionRefs = new Map();
      const inputs = Array.from(root.querySelectorAll('[data-fa-nexus-segmented-input]'));
      for (const input of inputs) {
        const key = String(input.getAttribute('data-fa-nexus-segmented-input') || '');
        if (!key.startsWith(`${controlId}:`)) continue;
        const optionId = key.slice(controlId.length + 1);
        if (!optionId) continue;
        input.addEventListener('change', this._boundDeclarativeSegmentedChange);
        const optionRoot = input.closest('.fa-nexus-declarative-segmented__option') || null;
        optionRefs.set(optionId, {
          input,
          root: optionRoot,
          label: optionRoot?.querySelector('span') || null
        });
      }
      this._declarativeSegmentedControls.set(controlId, { root, optionRefs });
    }
    this._syncDeclarativeSegmentedControls();
  }

  _unbindDeclarativeSegmentedControls() {
    if (!this._declarativeSegmentedControls?.size) return;
    for (const { optionRefs } of this._declarativeSegmentedControls.values()) {
      for (const refs of optionRefs?.values?.() || []) {
        try { refs?.input?.removeEventListener('change', this._boundDeclarativeSegmentedChange); } catch (_) {}
      }
    }
    this._declarativeSegmentedControls.clear();
  }

  _syncDeclarativeSegmentedControls() {
    if (!this._declarativeSegmentedControls?.size) return;
    for (const [controlId, refs] of this._declarativeSegmentedControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'segmented' || !control.handlerId) {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      const stateMap = new Map();
      for (const option of Array.isArray(control.options) ? control.options : []) {
        if (!option?.id) continue;
        stateMap.set(option.id, option);
      }
      for (const [optionId, optionRefs] of refs.optionRefs.entries()) {
        const state = stateMap.get(optionId) || null;
        const optionRoot = optionRefs?.root || null;
        const input = optionRefs?.input || null;
        if (!state) {
          if (optionRoot) optionRoot.hidden = true;
          continue;
        }
        if (optionRoot) {
          optionRoot.hidden = false;
          optionRoot.classList.toggle('is-active', !!state.enabled);
          optionRoot.classList.toggle('is-disabled', !!state.disabled);
          if (state.tooltip) optionRoot.title = state.tooltip;
          else optionRoot.removeAttribute('title');
        }
        if (input) {
          input.checked = !!state.enabled;
          input.disabled = !!state.disabled;
          if (state.tooltip) input.title = state.tooltip;
          else input.removeAttribute('title');
        }
        if (optionRefs?.label && optionRefs.label.textContent !== state.label) {
          optionRefs.label.textContent = state.label;
        }
      }
    }
  }

  _handleDeclarativeSegmentedChange(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const key = String(input.getAttribute?.('data-fa-nexus-segmented-input') || '');
    const separator = key.indexOf(':');
    if (separator <= 0) return;
    const controlId = key.slice(0, separator);
    const optionId = key.slice(separator + 1);
    if (!controlId || !optionId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    if (control.inputType === 'radio' && !input.checked) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const finalize = () => {
      this._syncDeclarativeSegmentedControls();
      this._syncEditorActions();
    };
    try {
      const result = control.inputType === 'checkbox'
        ? controller.invokeToolHandler(handlerId, optionId, !!input.checked)
        : controller.invokeToolHandler(handlerId, optionId);
      if (result?.then) {
        result.catch(() => {}).finally(finalize);
      } else {
        finalize();
      }
    } catch (_) {
      finalize();
    }
  }

  _bindEditorActions() {
    this._unbindEditorActions();
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-editor-actions-root]'));
    for (const [index, root] of roots.entries()) {
      const controlId = String(root.getAttribute('data-fa-nexus-editor-actions-root') || '');
      const rowKey = controlId || `__legacy__${index}`;
      if (!rowKey) continue;
      const buttons = Array.from(root.querySelectorAll('[data-fa-nexus-editor-action]'));
      const buttonMap = new Map();
      for (const button of buttons) {
        button.addEventListener('click', this._boundEditorActionClick);
        const id = button.dataset?.faNexusEditorAction || '';
        if (id) buttonMap.set(id, button);
      }
      this._declarativeActionRows.set(rowKey, {
        controlId,
        root,
        buttons,
        buttonMap
      });
    }
    this._syncEditorActions();
  }

  _unbindEditorActions() {
    if (this._declarativeActionRows?.size) {
      for (const { buttons } of this._declarativeActionRows.values()) {
        for (const button of buttons || []) {
          try { button.removeEventListener('click', this._boundEditorActionClick); }
          catch (_) {}
        }
      }
      this._declarativeActionRows.clear();
    }
  }

  _syncEditorActions() {
    if (!this._declarativeActionRows?.size) return;
    for (const refs of this._declarativeActionRows.values()) {
      const controlId = String(refs?.controlId || '');
      const control = controlId ? this._getPreparedDeclarativeControl(controlId) : null;
      const root = refs?.root || null;
      if (!root) continue;
      const actions = controlId
        ? (control?.type === 'action-row' && Array.isArray(control.actions) ? control.actions : [])
        : (Array.isArray(this._toolOptionState?.editorActions) ? this._toolOptionState.editorActions : []);
      if (!actions.length) {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      const stateMap = new Map();
      for (const entry of actions) {
        const id = String(entry?.id || '');
        if (!id) continue;
        stateMap.set(id, {
          id,
          label: String(entry?.label || ''),
          tooltip: String(entry?.tooltip || ''),
          primary: !!entry?.primary,
          disabled: !!entry?.disabled
        });
      }
      for (const button of refs.buttons || []) {
        const id = button.dataset?.faNexusEditorAction || '';
        const actionState = stateMap.get(id);
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
  }

  _handleEditorActionClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const id = button.dataset?.faNexusEditorAction;
    if (!id) return;
    const controlId = button.closest?.('[data-fa-nexus-editor-actions-root]')?.getAttribute?.('data-fa-nexus-editor-actions-root') || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' && control.handlerId.length
      ? control.handlerId
      : 'handleEditorAction';
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler(handlerId, id);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncEditorActions());
      } else {
        this._syncEditorActions();
      }
    } catch (_) {
      this._syncEditorActions();
    }
  }

  _bindDeclarativeToggleControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-toggle-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-toggle-control') || '');
      if (!controlId) continue;
      const input = root.querySelector(`[data-fa-nexus-toggle-input="${controlId}"]`);
      if (input) input.addEventListener('change', this._boundDeclarativeToggleChange);
      this._declarativeToggleControls.set(controlId, {
        root,
        input,
        label: root.querySelector('[data-fa-nexus-toggle-label]') || null,
        hint: root.querySelector('[data-fa-nexus-toggle-hint]') || null
      });
    }
    this._syncDeclarativeToggleControls();
  }

  _unbindDeclarativeToggleControls() {
    if (this._declarativeToggleControls?.size) {
      for (const { input } of this._declarativeToggleControls.values()) {
        if (!input) continue;
        try { input.removeEventListener('change', this._boundDeclarativeToggleChange); } catch (_) {}
      }
      this._declarativeToggleControls.clear();
    }
  }

  _syncDeclarativeToggleControls() {
    if (!this._declarativeToggleControls?.size) return;
    for (const [controlId, refs] of this._declarativeToggleControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'toggle') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.input) {
        refs.input.checked = !!control.value;
        refs.input.disabled = !!control.disabled;
        if (control.tooltip) refs.input.title = control.tooltip;
        else refs.input.removeAttribute('title');
      }
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (control.tooltip) root.title = control.tooltip;
      else root.removeAttribute('title');
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeToggleChange(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-toggle-input')
      || input.closest?.('[data-fa-nexus-toggle-control]')?.getAttribute?.('data-fa-nexus-toggle-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    const hasHandlerArg = control?.handlerArg !== undefined;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = hasHandlerArg
        ? controller.invokeToolHandler(handlerId, control.handlerArg, !!input.checked)
        : controller.invokeToolHandler(handlerId, !!input.checked);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeToggleControls());
      } else {
        this._syncDeclarativeToggleControls();
      }
    } catch (_) {
      this._syncDeclarativeToggleControls();
    }
  }

  _getPreparedDeclarativeControl(controlId) {
    const id = String(controlId || '');
    if (!id) return null;
    const normalized = this._activeNormalizedOptions
      || (this._activeTool?.id ? this._controller?._getToolNormalized?.(this._activeTool.id) || null : null);
    const controls = normalized?.controls && typeof normalized.controls === 'object'
      ? normalized.controls
      : {};
    return this._prepareDeclarativeControl(controls[id]);
  }

  _bindDeclarativeRangeControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-range-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-range-control') || '');
      if (!controlId) continue;
      const slider = root.querySelector(`[data-fa-nexus-range-slider="${controlId}"]`);
      const display = root.querySelector(`[data-fa-nexus-range-display="${controlId}"]`);
      const toggle = root.querySelector(`[data-fa-nexus-range-toggle="${controlId}"]`);
      if (slider) {
        slider.addEventListener('input', this._boundDeclarativeRangeInput);
        slider.addEventListener('change', this._boundDeclarativeRangeCommit);
      }
      if (toggle) {
        toggle.addEventListener('change', this._boundDeclarativeRangeToggle);
      }
      this._bindDisplayInput(display, this._boundDeclarativeRangeInput, this._boundDeclarativeRangeCommit);
      this._declarativeRangeControls.set(controlId, {
        root,
        slider,
        display,
        label: root.querySelector('[data-fa-nexus-range-label]') || null,
        toggle,
        toggleLabel: root.querySelector('[data-fa-nexus-range-toggle-label]') || null,
        hint: root.querySelector('[data-fa-nexus-range-hint]') || null
      });
    }
    this._syncDeclarativeRangeControls();
  }

  _unbindDeclarativeRangeControls() {
    if (this._declarativeRangeControls?.size) {
      for (const { slider, display, toggle } of this._declarativeRangeControls.values()) {
        if (slider) {
          try {
            slider.removeEventListener('input', this._boundDeclarativeRangeInput);
            slider.removeEventListener('change', this._boundDeclarativeRangeCommit);
          } catch (_) {}
        }
        if (toggle) {
          try { toggle.removeEventListener('change', this._boundDeclarativeRangeToggle); } catch (_) {}
        }
        this._unbindDisplayInput(display, this._boundDeclarativeRangeInput, this._boundDeclarativeRangeCommit);
      }
      this._declarativeRangeControls.clear();
    }
  }

  _syncDeclarativeRangeControls() {
    if (!this._declarativeRangeControls?.size) return;
    for (const [controlId, refs] of this._declarativeRangeControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'range') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.label) {
        if (control.tooltip) refs.label.title = control.tooltip;
        else refs.label.removeAttribute('title');
      }
      if (refs.toggle) {
        const headerToggle = control.headerToggle && typeof control.headerToggle === 'object'
          ? control.headerToggle
          : null;
        if (headerToggle) {
          refs.toggle.checked = !!headerToggle.value;
          refs.toggle.disabled = !!headerToggle.disabled;
          if (headerToggle.tooltip) refs.toggle.title = headerToggle.tooltip;
          else refs.toggle.removeAttribute('title');
          if (headerToggle.ariaLabel) refs.toggle.setAttribute('aria-label', headerToggle.ariaLabel);
          else refs.toggle.removeAttribute('aria-label');
          if (refs.toggleLabel && refs.toggleLabel.textContent !== headerToggle.label) {
            refs.toggleLabel.textContent = headerToggle.label || '';
          }
        } else {
          refs.toggle.checked = false;
          refs.toggle.disabled = true;
          refs.toggle.removeAttribute('title');
          refs.toggle.removeAttribute('aria-label');
          if (refs.toggleLabel) refs.toggleLabel.textContent = '';
        }
      }
      if (control.tooltip) root.title = control.tooltip;
      else root.removeAttribute('title');
      if (refs.slider) {
        refs.slider.min = String(control.min);
        refs.slider.max = String(control.max);
        refs.slider.step = String(control.step);
        const nextValue = String(control.value);
        if (refs.slider.value !== nextValue) refs.slider.value = nextValue;
        refs.slider.disabled = !!control.disabled;
        if (control.ariaLabel) refs.slider.setAttribute('aria-label', control.ariaLabel);
        if (control.tooltip) refs.slider.title = control.tooltip;
        else refs.slider.removeAttribute('title');
        this._applyDefaultValue(refs.slider, control.defaultValue);
      }
      if (refs.display) {
        this._syncDisplayValue(refs.display, control);
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeRangeInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-range-slider')
      || input.getAttribute?.('data-fa-nexus-range-display')
      || input.closest?.('[data-fa-nexus-range-control]')?.getAttribute?.('data-fa-nexus-range-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId) return;
    const hasHandlerArg = control?.handlerArg !== undefined;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId,
      commit,
      sync: this._syncDeclarativeRangeControls,
      logTag: 'ToolOptions.declarativeRange.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = hasHandlerArg
        ? controller.invokeToolHandler(handlerId, control.handlerArg, value, !!commit)
        : controller.invokeToolHandler(handlerId, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangeControls());
      } else {
        this._syncDeclarativeRangeControls();
      }
    } catch (_) {
      this._syncDeclarativeRangeControls();
    }
  }

  _handleDeclarativeRangeToggle(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-range-toggle')
      || input.closest?.('[data-fa-nexus-range-control]')?.getAttribute?.('data-fa-nexus-range-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const headerToggle = control?.headerToggle && typeof control.headerToggle === 'object'
      ? control.headerToggle
      : null;
    const handlerId = typeof headerToggle?.handlerId === 'string' ? headerToggle.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const hasHandlerArg = headerToggle?.handlerArg !== undefined;
    try {
      const result = hasHandlerArg
        ? this._controller.invokeToolHandler(handlerId, headerToggle.handlerArg, !!input.checked)
        : this._controller.invokeToolHandler(handlerId, !!input.checked);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangeControls());
      } else {
        this._syncDeclarativeRangeControls();
      }
    } catch (_) {
      this._syncDeclarativeRangeControls();
    }
  }

  _bindDeclarativeRangePairControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-range-pair-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-range-pair-control') || '');
      if (!controlId) continue;
      const itemRoots = new Map();
      const rows = Array.from(root.querySelectorAll('[data-fa-nexus-range-pair-item]'));
      for (const row of rows) {
        const itemId = String(row.getAttribute('data-fa-nexus-range-pair-item') || '');
        if (!itemId) continue;
        const slider = row.querySelector(`[data-fa-nexus-range-pair-slider="${controlId}:${itemId}"]`);
        const display = row.querySelector(`[data-fa-nexus-range-pair-display="${controlId}:${itemId}"]`);
        if (slider) {
          slider.addEventListener('input', this._boundDeclarativeRangePairInput);
          slider.addEventListener('change', this._boundDeclarativeRangePairCommit);
        }
        this._bindDisplayInput(display, this._boundDeclarativeRangePairInput, this._boundDeclarativeRangePairCommit);
        itemRoots.set(itemId, {
          row,
          slider,
          display
        });
      }
      this._declarativeRangePairControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-range-pair-label]') || null,
        hint: root.querySelector('[data-fa-nexus-range-pair-hint]') || null,
        items: itemRoots
      });
    }
    this._syncDeclarativeRangePairControls();
  }

  _unbindDeclarativeRangePairControls() {
    if (this._declarativeRangePairControls?.size) {
      for (const { items } of this._declarativeRangePairControls.values()) {
        for (const { slider, display } of items.values()) {
          if (slider) {
            try {
              slider.removeEventListener('input', this._boundDeclarativeRangePairInput);
              slider.removeEventListener('change', this._boundDeclarativeRangePairCommit);
            } catch (_) {}
          }
          this._unbindDisplayInput(display, this._boundDeclarativeRangePairInput, this._boundDeclarativeRangePairCommit);
        }
      }
      this._declarativeRangePairControls.clear();
    }
  }

  _syncDeclarativeRangePairControls() {
    if (!this._declarativeRangePairControls?.size) return;
    for (const [controlId, refs] of this._declarativeRangePairControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'range-pair') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      const itemMap = new Map(Array.isArray(control.items) ? control.items.map((item) => [item.id, item]) : []);
      for (const [itemId, itemRefs] of refs.items.entries()) {
        const item = itemMap.get(itemId) || null;
        const row = itemRefs?.row || null;
        if (!row) continue;
        if (!item) {
          row.hidden = true;
          continue;
        }
        row.hidden = false;
        if (itemRefs.slider) {
          itemRefs.slider.min = String(item.min);
          itemRefs.slider.max = String(item.max);
          itemRefs.slider.step = String(item.step);
          const nextValue = String(item.value);
          if (itemRefs.slider.value !== nextValue) itemRefs.slider.value = nextValue;
          itemRefs.slider.disabled = !!item.disabled;
          if (item.ariaLabel) itemRefs.slider.setAttribute('aria-label', item.ariaLabel);
          this._applyDefaultValue(itemRefs.slider, item.defaultValue);
        }
        if (itemRefs.display) {
          this._syncDisplayValue(itemRefs.display, item);
        }
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeRangePairInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlKey = input.getAttribute?.('data-fa-nexus-range-pair-slider')
      || input.getAttribute?.('data-fa-nexus-range-pair-display')
      || '';
    const [controlId, itemId] = String(controlKey || '').split(':');
    if (!controlId || !itemId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    const item = Array.isArray(control?.items) ? control.items.find((entry) => entry.id === itemId) || null : null;
    if (!handlerId || !item) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId: `${controlId}:${itemId}`,
      commit,
      sync: this._syncDeclarativeRangePairControls,
      logTag: 'ToolOptions.declarativeRangePair.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = controller.invokeToolHandler(handlerId, item.handlerArg, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeRangePairControls());
      } else {
        this._syncDeclarativeRangePairControls();
      }
    } catch (_) {
      this._syncDeclarativeRangePairControls();
    }
  }

  _bindDeclarativeAxisPairControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-axis-pair-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-axis-pair-control') || '');
      if (!controlId) continue;
      const axes = new Map();
      const rows = Array.from(root.querySelectorAll('[data-fa-nexus-axis-pair-axis]'));
      for (const row of rows) {
        const axisKey = String(row.getAttribute('data-fa-nexus-axis-pair-axis') || '');
        const [rowControlId, axisId] = axisKey.split(':');
        if (rowControlId !== controlId || !axisId) continue;
        const button = row.querySelector(`[data-fa-nexus-axis-pair-button="${controlId}:${axisId}"]`);
        const randomButton = row.querySelector(`[data-fa-nexus-axis-pair-random="${controlId}:${axisId}"]`);
        if (button) button.addEventListener('click', this._boundDeclarativeAxisPairToggle);
        if (randomButton) randomButton.addEventListener('click', this._boundDeclarativeAxisPairRandomToggle);
        axes.set(axisId, {
          row,
          button,
          randomButton
        });
      }
      this._declarativeAxisPairControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-axis-pair-label]') || null,
        display: root.querySelector('[data-fa-nexus-axis-pair-display]') || null,
        preview: root.querySelector('[data-fa-nexus-axis-pair-preview]') || null,
        hint: root.querySelector('[data-fa-nexus-axis-pair-hint]') || null,
        axes
      });
    }
    this._syncDeclarativeAxisPairControls();
  }

  _unbindDeclarativeAxisPairControls() {
    if (this._declarativeAxisPairControls?.size) {
      for (const { axes } of this._declarativeAxisPairControls.values()) {
        for (const { button, randomButton } of axes.values()) {
          if (button) {
            try { button.removeEventListener('click', this._boundDeclarativeAxisPairToggle); } catch (_) {}
          }
          if (randomButton) {
            try { randomButton.removeEventListener('click', this._boundDeclarativeAxisPairRandomToggle); } catch (_) {}
          }
        }
      }
      this._declarativeAxisPairControls.clear();
    }
  }

  _syncDeclarativeAxisPairControls() {
    if (!this._declarativeAxisPairControls?.size) return;
    for (const [controlId, refs] of this._declarativeAxisPairControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'axis-toggle-pair') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.display) {
        const text = control.display || 'None';
        if (refs.display.textContent !== text) refs.display.textContent = text;
      }
      if (refs.preview) {
        const preview = control.previewDisplay || '';
        refs.preview.textContent = preview;
        refs.preview.hidden = !preview;
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
      const axisMap = new Map(Array.isArray(control.axes) ? control.axes.map((axis) => [axis.id, axis]) : []);
      const syncAxisButton = (button, axisState) => {
        if (!button || !axisState) return;
        const active = !!axisState.active;
        const previewDiff = !!axisState.previewDiff;
        button.classList.toggle('is-active', active);
        button.classList.toggle('has-preview-diff', previewDiff);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.setAttribute('aria-label', axisState.aria || axisState.label || 'Toggle');
        if (axisState.tooltip) button.title = axisState.tooltip;
        else button.removeAttribute('title');
        button.disabled = !!axisState.disabled || !axisState.handlerId;
        const label = button.querySelector('[data-fa-nexus-button-label]')
          || Array.from(button.querySelectorAll('span')).find((span) => !span.classList.contains('fa-nexus-flip__button-icon'))
          || null;
        if (label && label.textContent !== axisState.label) label.textContent = axisState.label;
      };
      const syncAxisRandomButton = (button, axisState) => {
        if (!button || !axisState) return;
        const visible = !!axisState.randomButtonVisible;
        button.hidden = !visible;
        if (!visible) return;
        const enabled = !!axisState.randomEnabled;
        button.classList.toggle('is-active', enabled);
        button.classList.toggle('has-preview-diff', !!axisState.randomPreviewDiff);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.setAttribute('aria-label', axisState.randomAria || 'Toggle random');
        if (axisState.randomTooltip) button.title = axisState.randomTooltip;
        else button.removeAttribute('title');
        button.disabled = !!axisState.randomDisabled || !axisState.randomHandlerId;
        const label = button.querySelector('span');
        const nextLabel = axisState.randomLabel || 'Random';
        if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
      };
      for (const [axisId, axisRefs] of refs.axes.entries()) {
        const axisState = axisMap.get(axisId) || null;
        const row = axisRefs?.row || null;
        if (!row) continue;
        if (!axisState) {
          row.hidden = true;
          continue;
        }
        row.hidden = false;
        syncAxisButton(axisRefs.button, axisState);
        syncAxisRandomButton(axisRefs.randomButton, axisState);
      }
    }
  }

  _handleDeclarativeAxisPairToggle(event, random = false) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const axisKey = random
      ? target.getAttribute?.('data-fa-nexus-axis-pair-random')
      : target.getAttribute?.('data-fa-nexus-axis-pair-button');
    const [controlId, axisId] = String(axisKey || '').split(':');
    if (!controlId || !axisId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const axis = Array.isArray(control?.axes) ? control.axes.find((entry) => entry.id === axisId) || null : null;
    const handlerId = random ? axis?.randomHandlerId : axis?.handlerId;
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeAxisPairControls());
      } else {
        this._syncDeclarativeAxisPairControls();
      }
    } catch (_) {
      this._syncDeclarativeAxisPairControls();
    }
  }

  _bindDeclarativeScalarRandomizedControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-scalar-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-scalar-control') || '');
      if (!controlId) continue;
      const slider = root.querySelector(`[data-fa-nexus-scalar-slider="${controlId}"]`);
      const display = root.querySelector(`[data-fa-nexus-scalar-display="${controlId}"]`);
      const randomButton = root.querySelector(`[data-fa-nexus-scalar-random="${controlId}"]`);
      const randomRangeShell = root.querySelector(`[data-fa-nexus-scalar-random-range-shell="${controlId}"]`);
      const randomMinSlider = root.querySelector(`[data-fa-nexus-scalar-random-min-slider="${controlId}"]`);
      const randomMaxSlider = root.querySelector(`[data-fa-nexus-scalar-random-max-slider="${controlId}"]`);
      const randomMinDisplay = root.querySelector(`[data-fa-nexus-scalar-random-min-display="${controlId}"]`);
      const randomMaxDisplay = root.querySelector(`[data-fa-nexus-scalar-random-max-display="${controlId}"]`);
      const strengthSlider = root.querySelector(`[data-fa-nexus-scalar-strength-slider="${controlId}"]`);
      const strengthDisplay = root.querySelector(`[data-fa-nexus-scalar-strength-display="${controlId}"]`);
      if (slider) {
        slider.addEventListener('input', this._boundDeclarativeScalarRandomizedInput);
        slider.addEventListener('change', this._boundDeclarativeScalarRandomizedCommit);
      }
      this._bindDisplayInput(display, this._boundDeclarativeScalarRandomizedInput, this._boundDeclarativeScalarRandomizedCommit);
      if (randomButton) randomButton.addEventListener('click', this._boundDeclarativeScalarRandomizedRandom);
      if (randomMinSlider) {
        randomMinSlider.addEventListener('input', this._boundDeclarativeScalarRandomizedMin);
        randomMinSlider.addEventListener('change', this._boundDeclarativeScalarRandomizedMin);
      }
      if (randomMaxSlider) {
        randomMaxSlider.addEventListener('input', this._boundDeclarativeScalarRandomizedMax);
        randomMaxSlider.addEventListener('change', this._boundDeclarativeScalarRandomizedMax);
      }
      this._bindDisplayInput(randomMinDisplay, this._boundDeclarativeScalarRandomizedMin, this._boundDeclarativeScalarRandomizedMin);
      this._bindDisplayInput(randomMaxDisplay, this._boundDeclarativeScalarRandomizedMax, this._boundDeclarativeScalarRandomizedMax);
      if (strengthSlider) {
        strengthSlider.addEventListener('input', this._boundDeclarativeScalarRandomizedStrengthInput);
        strengthSlider.addEventListener('change', this._boundDeclarativeScalarRandomizedStrengthCommit);
      }
      this._bindDisplayInput(strengthDisplay, this._boundDeclarativeScalarRandomizedStrengthInput, this._boundDeclarativeScalarRandomizedStrengthCommit);
      this._declarativeScalarRandomizedControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-scalar-label]') || null,
        slider,
        display,
        randomButton,
        randomRangeShell,
        randomMinSlider,
        randomMaxSlider,
        randomMinDisplay,
        randomMaxDisplay,
        strengthRow: root.querySelector(`[data-fa-nexus-scalar-strength-row="${controlId}"]`) || null,
        strengthLabel: root.querySelector(`[data-fa-nexus-scalar-strength-label="${controlId}"]`) || null,
        strengthSlider,
        strengthDisplay,
        hint: root.querySelector('[data-fa-nexus-scalar-hint]') || null
      });
    }
    this._syncDeclarativeScalarRandomizedControls();
  }

  _unbindDeclarativeScalarRandomizedControls() {
    if (this._declarativeScalarRandomizedControls?.size) {
      for (const {
        slider,
        display,
        randomButton,
        randomMinSlider,
        randomMaxSlider,
        randomMinDisplay,
        randomMaxDisplay,
        strengthSlider,
        strengthDisplay
      } of this._declarativeScalarRandomizedControls.values()) {
        if (slider) {
          try {
            slider.removeEventListener('input', this._boundDeclarativeScalarRandomizedInput);
            slider.removeEventListener('change', this._boundDeclarativeScalarRandomizedCommit);
          } catch (_) {}
        }
        this._unbindDisplayInput(display, this._boundDeclarativeScalarRandomizedInput, this._boundDeclarativeScalarRandomizedCommit);
        if (randomButton) {
          try { randomButton.removeEventListener('click', this._boundDeclarativeScalarRandomizedRandom); } catch (_) {}
        }
        if (randomMinSlider) {
          try {
            randomMinSlider.removeEventListener('input', this._boundDeclarativeScalarRandomizedMin);
            randomMinSlider.removeEventListener('change', this._boundDeclarativeScalarRandomizedMin);
          } catch (_) {}
        }
        if (randomMaxSlider) {
          try {
            randomMaxSlider.removeEventListener('input', this._boundDeclarativeScalarRandomizedMax);
            randomMaxSlider.removeEventListener('change', this._boundDeclarativeScalarRandomizedMax);
          } catch (_) {}
        }
        this._unbindDisplayInput(randomMinDisplay, this._boundDeclarativeScalarRandomizedMin, this._boundDeclarativeScalarRandomizedMin);
        this._unbindDisplayInput(randomMaxDisplay, this._boundDeclarativeScalarRandomizedMax, this._boundDeclarativeScalarRandomizedMax);
        if (strengthSlider) {
          try {
            strengthSlider.removeEventListener('input', this._boundDeclarativeScalarRandomizedStrengthInput);
            strengthSlider.removeEventListener('change', this._boundDeclarativeScalarRandomizedStrengthCommit);
          } catch (_) {}
        }
        this._unbindDisplayInput(strengthDisplay, this._boundDeclarativeScalarRandomizedStrengthInput, this._boundDeclarativeScalarRandomizedStrengthCommit);
      }
      this._declarativeScalarRandomizedControls.clear();
    }
  }

  _syncDeclarativeScalarRandomizedRangeShell(shell, control) {
    if (!shell || !control) return;
    const min = Number(control.min);
    const max = Number(control.max);
    const lower = Number(control.randomMin);
    const upper = Number(control.randomMax);
    const span = Math.max(0.0001, max - min);
    const start = ((lower - min) / span) * 100;
    const end = ((upper - min) / span) * 100;
    shell.style.setProperty('--fa-nexus-range-start', `${Math.max(0, Math.min(100, start))}%`);
    shell.style.setProperty('--fa-nexus-range-end', `${Math.max(0, Math.min(100, end))}%`);
  }

  _syncDeclarativeScalarRandomizedControls() {
    if (!this._declarativeScalarRandomizedControls?.size) return;
    for (const [controlId, refs] of this._declarativeScalarRandomizedControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'scalar-randomized') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.slider) {
        refs.slider.min = String(control.min);
        refs.slider.max = String(control.max);
        refs.slider.step = String(control.step);
        const nextValue = String(control.value);
        if (refs.slider.value !== nextValue) refs.slider.value = nextValue;
        refs.slider.disabled = !!control.disabled;
        refs.slider.setAttribute('aria-label', control.ariaLabel || control.label);
        this._applyDefaultValue(refs.slider, control.defaultValue);
      }
      if (refs.display) {
        this._syncDisplayValue(refs.display, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.value,
          display: control.display,
          defaultValue: control.defaultValue,
          disabled: control.disabled
        });
      }
      const randomVisible = control.randomButtonVisible !== false;
      if (refs.randomButton) {
        refs.randomButton.hidden = !randomVisible;
        refs.randomButton.classList.toggle('is-active', randomVisible && !!control.randomEnabled);
        refs.randomButton.setAttribute('aria-pressed', randomVisible && control.randomEnabled ? 'true' : 'false');
        refs.randomButton.setAttribute('aria-label', control.randomAria || control.randomTooltip || control.randomLabel || 'Toggle random');
        if (control.randomTooltip) refs.randomButton.title = control.randomTooltip;
        else refs.randomButton.removeAttribute('title');
        refs.randomButton.disabled = !randomVisible || !!control.disabled || !control.randomHandlerId;
        const label = refs.randomButton.querySelector('span');
        const nextLabel = control.randomLabel || 'Random';
        if (label && label.textContent !== nextLabel) label.textContent = nextLabel;
      }
      const rangeMode = control.randomMode === 'range';
      const rangeVisible = randomVisible && !!control.randomEnabled && rangeMode;
      const strengthVisible = randomVisible && !!control.randomEnabled && !rangeMode;
      if (refs.randomRangeShell) {
        refs.randomRangeShell.hidden = !rangeVisible;
        if (rangeVisible) this._syncDeclarativeScalarRandomizedRangeShell(refs.randomRangeShell, control);
      }
      if (refs.randomMinSlider) {
        refs.randomMinSlider.min = String(control.min);
        refs.randomMinSlider.max = String(control.max);
        refs.randomMinSlider.step = String(control.step);
        const nextValue = String(control.randomMin);
        if (refs.randomMinSlider.value !== nextValue) refs.randomMinSlider.value = nextValue;
        refs.randomMinSlider.disabled = !rangeVisible || !control.randomMinHandlerId;
        refs.randomMinSlider.setAttribute('aria-label', control.randomMinAriaLabel || 'Minimum');
        this._applyDefaultValue(refs.randomMinSlider, control.randomMinDefault);
      }
      if (refs.randomMaxSlider) {
        refs.randomMaxSlider.min = String(control.min);
        refs.randomMaxSlider.max = String(control.max);
        refs.randomMaxSlider.step = String(control.step);
        const nextValue = String(control.randomMax);
        if (refs.randomMaxSlider.value !== nextValue) refs.randomMaxSlider.value = nextValue;
        refs.randomMaxSlider.disabled = !rangeVisible || !control.randomMaxHandlerId;
        refs.randomMaxSlider.setAttribute('aria-label', control.randomMaxAriaLabel || 'Maximum');
        this._applyDefaultValue(refs.randomMaxSlider, control.randomMaxDefault);
      }
      if (refs.randomMinDisplay) {
        this._syncDisplayValue(refs.randomMinDisplay, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.randomMin,
          display: control.randomMinDisplay,
          defaultValue: control.randomMinDefault,
          disabled: !rangeVisible || !control.randomMinHandlerId
        });
      }
      if (refs.randomMaxDisplay) {
        this._syncDisplayValue(refs.randomMaxDisplay, {
          min: control.min,
          max: control.max,
          step: control.step,
          value: control.randomMax,
          display: control.randomMaxDisplay,
          defaultValue: control.randomMaxDefault,
          disabled: !rangeVisible || !control.randomMaxHandlerId
        });
      }
      if (refs.strengthRow) refs.strengthRow.hidden = !strengthVisible;
      if (refs.strengthLabel && refs.strengthLabel.textContent !== control.strengthLabel) refs.strengthLabel.textContent = control.strengthLabel;
      if (refs.strengthSlider) {
        refs.strengthSlider.min = String(control.strengthMin);
        refs.strengthSlider.max = String(control.strengthMax);
        refs.strengthSlider.step = String(control.strengthStep);
        const nextValue = String(control.strength);
        if (refs.strengthSlider.value !== nextValue) refs.strengthSlider.value = nextValue;
        refs.strengthSlider.disabled = !strengthVisible || !control.strengthHandlerId;
        refs.strengthSlider.setAttribute('aria-label', control.strengthAriaLabel || control.strengthLabel);
        this._applyDefaultValue(refs.strengthSlider, control.strengthDefault);
      }
      if (refs.strengthDisplay) {
        this._syncDisplayValue(refs.strengthDisplay, {
          min: control.strengthMin,
          max: control.strengthMax,
          step: control.strengthStep,
          value: control.strength,
          display: control.strengthDisplay,
          defaultValue: control.strengthDefault,
          disabled: !strengthVisible || !control.strengthHandlerId
        });
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeScalarRandomizedInput(event, commit) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-scalar-slider')
      || input.getAttribute?.('data-fa-nexus-scalar-display')
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.handlerId === 'string' ? control.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId,
      commit,
      sync: this._syncDeclarativeScalarRandomizedControls,
      logTag: 'ToolOptions.declarativeScalar.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, value, !!commit);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeScalarRandomizedControls());
      } else {
        this._syncDeclarativeScalarRandomizedControls();
      }
    } catch (_) {
      this._syncDeclarativeScalarRandomizedControls();
    }
  }

  _handleDeclarativeScalarRandomizedStrength(event) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.('data-fa-nexus-scalar-strength-slider')
      || input.getAttribute?.('data-fa-nexus-scalar-strength-display')
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.strengthHandlerId === 'string' ? control.strengthHandlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId,
      sync: this._syncDeclarativeScalarRandomizedControls,
      logTag: 'ToolOptions.declarativeScalarStrength.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, value);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeScalarRandomizedControls());
      } else {
        this._syncDeclarativeScalarRandomizedControls();
      }
    } catch (_) {
      this._syncDeclarativeScalarRandomizedControls();
    }
  }

  _handleDeclarativeScalarRandomizedRange(event, boundary) {
    const input = event?.currentTarget || event?.target;
    if (!input) return;
    const controlId = input.getAttribute?.(`data-fa-nexus-scalar-random-${boundary}-slider`)
      || input.getAttribute?.(`data-fa-nexus-scalar-random-${boundary}-display`)
      || input.closest?.('[data-fa-nexus-scalar-control]')?.getAttribute?.('data-fa-nexus-scalar-control')
      || '';
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = boundary === 'min'
      ? (typeof control?.randomMinHandlerId === 'string' ? control.randomMinHandlerId : '')
      : (typeof control?.randomMaxHandlerId === 'string' ? control.randomMaxHandlerId : '');
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const value = this._readDeclarativeNumericValue(input, {
      controlId: `${controlId}:${boundary}`,
      sync: this._syncDeclarativeScalarRandomizedControls,
      logTag: 'ToolOptions.declarativeScalarRange.invalidNumericInput'
    });
    if (value === null) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, value);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeScalarRandomizedControls());
      } else {
        this._syncDeclarativeScalarRandomizedControls();
      }
    } catch (_) {
      this._syncDeclarativeScalarRandomizedControls();
    }
  }

  _handleDeclarativeScalarRandomizedRandom(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    const controlId = String(target?.getAttribute?.('data-fa-nexus-scalar-random') || '');
    if (!controlId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = typeof control?.randomHandlerId === 'string' ? control.randomHandlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeScalarRandomizedControls());
      } else {
        this._syncDeclarativeScalarRandomizedControls();
      }
    } catch (_) {
      this._syncDeclarativeScalarRandomizedControls();
    }
  }

  _bindDeclarativeStackOrderControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-stack-order-control]'));
    for (const root of roots) {
      const controlId = String(root.getAttribute('data-fa-nexus-stack-order-control') || '');
      if (!controlId) continue;
      const topButton = root.querySelector(`[data-fa-nexus-stack-order-top="${controlId}"]`);
      const bottomButton = root.querySelector(`[data-fa-nexus-stack-order-bottom="${controlId}"]`);
      if (topButton) topButton.addEventListener('click', this._boundDeclarativeStackOrderTop);
      if (bottomButton) bottomButton.addEventListener('click', this._boundDeclarativeStackOrderBottom);
      this._declarativeStackOrderControls.set(controlId, {
        root,
        label: root.querySelector('[data-fa-nexus-stack-order-label]') || null,
        orderValue: root.querySelector('[data-fa-nexus-stack-order-value]') || null,
        elevationValue: root.querySelector('[data-fa-nexus-stack-order-elevation]') || null,
        topButton,
        bottomButton,
        hint: root.querySelector('[data-fa-nexus-stack-order-hint]') || null
      });
    }
    this._syncDeclarativeStackOrderControls();
  }

  _unbindDeclarativeStackOrderControls() {
    if (this._declarativeStackOrderControls?.size) {
      for (const { topButton, bottomButton } of this._declarativeStackOrderControls.values()) {
        if (topButton) {
          try { topButton.removeEventListener('click', this._boundDeclarativeStackOrderTop); } catch (_) {}
        }
        if (bottomButton) {
          try { bottomButton.removeEventListener('click', this._boundDeclarativeStackOrderBottom); } catch (_) {}
        }
      }
      this._declarativeStackOrderControls.clear();
    }
  }

  _syncDeclarativeStackOrderControls() {
    if (!this._declarativeStackOrderControls?.size) return;
    for (const [controlId, refs] of this._declarativeStackOrderControls.entries()) {
      const control = this._getPreparedDeclarativeControl(controlId);
      const root = refs?.root || null;
      if (!root) continue;
      if (!control || control.type !== 'stack-order') {
        root.hidden = true;
        continue;
      }
      root.hidden = false;
      if (refs.label && refs.label.textContent !== control.label) refs.label.textContent = control.label;
      if (refs.orderValue) {
        const text = control.orderLabel || '';
        refs.orderValue.textContent = text;
        refs.orderValue.hidden = !text;
      }
      if (refs.elevationValue) {
        const text = control.elevationLabel || '';
        refs.elevationValue.textContent = text;
        refs.elevationValue.hidden = !text;
      }
      if (refs.topButton) {
        refs.topButton.disabled = !!control.pushTopDisabled || !control.pushTopHandlerId;
        const label = refs.topButton.querySelector('span');
        if (label && label.textContent !== control.pushTopLabel) label.textContent = control.pushTopLabel;
      }
      if (refs.bottomButton) {
        refs.bottomButton.disabled = !!control.pushBottomDisabled || !control.pushBottomHandlerId;
        const label = refs.bottomButton.querySelector('span');
        if (label && label.textContent !== control.pushBottomLabel) label.textContent = control.pushBottomLabel;
      }
      if (refs.hint) {
        const text = control.hint || '';
        refs.hint.textContent = text;
        refs.hint.hidden = !text;
      }
    }
  }

  _handleDeclarativeStackOrderAction(event, direction = 'top') {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const target = event?.currentTarget || event?.target;
    if (!target) return;
    const controlId = String(
      direction === 'bottom'
        ? (target.getAttribute?.('data-fa-nexus-stack-order-bottom') || '')
        : (target.getAttribute?.('data-fa-nexus-stack-order-top') || '')
    );
    if (!controlId) return;
    const control = this._getPreparedDeclarativeControl(controlId);
    const handlerId = direction === 'bottom' ? control?.pushBottomHandlerId : control?.pushTopHandlerId;
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncDeclarativeStackOrderControls());
      } else {
        this._syncDeclarativeStackOrderControls();
      }
    } catch (_) {
      this._syncDeclarativeStackOrderControls();
    }
  }

  _bindPathAppearanceControls() {
    this._bindPathOpacityControl();
    this._bindPathScaleControl();
    this._bindPathOffsetControls();
    this._bindPathTensionControls();
    this._bindPathSimplifyControls();
    this._bindShowWidthTangentsControls();
    this._syncPathAppearanceControls();
  }

  _unbindPathAppearanceControls() {
    this._unbindPathOpacityControl();
    this._unbindPathScaleControl();
    this._unbindPathOffsetControls();
    this._unbindPathTensionControls();
    this._unbindPathSimplifyControls();
    this._unbindShowWidthTangentsControls();
  }

  _syncPathAppearanceControls() {
    this._syncPathOpacityControl();
    this._syncPathScaleControl();
    this._syncPathOffsetControls();
    this._syncPathTensionControls();
    this._syncPathSimplifyControls();
    this._syncShowWidthTangentsControls();
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
    this._bindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
  }

  _unbindPathOpacityControl() {
    if (this._pathOpacitySlider) {
      try { this._pathOpacitySlider.removeEventListener('input', this._boundPathOpacityInput); } catch (_) {}
      try { this._pathOpacitySlider.removeEventListener('change', this._boundPathOpacityCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathOpacityDisplay, this._boundPathOpacityInput, this._boundPathOpacityCommit);
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
      this._applyDefaultValue(this._pathOpacitySlider, state.defaultValue);
      this._pathOpacitySlider.disabled = !!state.disabled;
    }
    if (this._pathOpacityDisplay) {
      this._syncDisplayValue(this._pathOpacityDisplay, state);
    }
  }

  _handlePathOpacity(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = this._readNumericControlValue(slider);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    if (value === null) {
      this._syncPathOpacityControl();
      return;
    }
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
    this._bindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
  }

  _unbindPathScaleControl() {
    if (this._pathScaleSlider) {
      try { this._pathScaleSlider.removeEventListener('input', this._boundPathScaleInput); } catch (_) {}
      try { this._pathScaleSlider.removeEventListener('change', this._boundPathScaleCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathScaleDisplay, this._boundPathScaleInput, this._boundPathScaleCommit);
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
      this._applyDefaultValue(this._pathScaleSlider, state.defaultValue);
      this._pathScaleSlider.disabled = !!state.disabled;
    }
    if (this._pathScaleDisplay) {
      this._syncDisplayValue(this._pathScaleDisplay, state);
    }
  }

  _handlePathScale(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = this._readNumericControlValue(slider);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    if (value === null) {
      this._syncPathScaleControl();
      return;
    }
    try {
      const result = controller.invokeToolHandler('setPathScale', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathScaleControl());
      else this._syncPathScaleControl();
    } catch (_) {
      this._syncPathScaleControl();
    }
  }

  _handlePathScaleWheel(event) {
    if (!event) return;
    const slider = event.currentTarget || this._pathScaleSlider;
    if (!slider || slider.disabled) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
    const state = this._toolOptionState?.pathAppearance?.scale || {};
    const min = Number(slider.min ?? state.min ?? 0);
    const max = Number(slider.max ?? state.max ?? 0);
    const rawStep = Number(slider.step ?? state.step ?? 1);
    const baseStep = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : 1;
    const fine = event.ctrlKey || event.metaKey;
    const coarse = event.shiftKey;
    const step = Math.max(0.01, (fine ? baseStep / 10 : baseStep) * (coarse ? 5 : 1));
    const current = Number(slider.value);
    const safeCurrent = Number.isFinite(current) ? current : Number(state.value ?? min) || min;
    const direction = event.deltaY < 0 ? 1 : -1;
    const clamp = (val, lo, hi) => Math.min(hi, Math.max(lo, val));
    const nextValue = clamp(Math.round((safeCurrent + (direction * step)) * 100) / 100, Number.isFinite(min) ? min : safeCurrent, Number.isFinite(max) && max > 0 ? max : safeCurrent);
    slider.value = String(nextValue);
    this._handlePathScale({ currentTarget: slider }, true);
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
    this._bindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._bindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
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
    this._unbindDisplayInput(this._pathOffsetXDisplay, this._boundPathOffsetXInput, this._boundPathOffsetXCommit);
    this._unbindDisplayInput(this._pathOffsetYDisplay, this._boundPathOffsetYInput, this._boundPathOffsetYCommit);
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
      this._applyDefaultValue(this._pathOffsetXSlider, x.defaultValue);
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
      this._applyDefaultValue(this._pathOffsetYSlider, y.defaultValue);
      this._pathOffsetYSlider.disabled = !!y.disabled || !!state.disabled;
    }
    if (this._pathOffsetXDisplay) {
      this._syncDisplayValue(this._pathOffsetXDisplay, state.x || {}, { disabled: state.disabled });
    }
    if (this._pathOffsetYDisplay) {
      this._syncDisplayValue(this._pathOffsetYDisplay, state.y || {}, { disabled: state.disabled });
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
    this._bindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
  }

  _unbindPathTensionControls() {
    if (this._pathTensionSlider) {
      try { this._pathTensionSlider.removeEventListener('input', this._boundPathTensionInput); } catch (_) {}
      try { this._pathTensionSlider.removeEventListener('change', this._boundPathTensionCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathTensionDisplay, this._boundPathTensionInput, this._boundPathTensionCommit);
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
      this._applyDefaultValue(this._pathTensionSlider, state.defaultValue);
      this._pathTensionSlider.disabled = !!state.disabled;
    }
    if (this._pathTensionDisplay) {
      this._syncDisplayValue(this._pathTensionDisplay, state);
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

  _bindPathSimplifyControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-simplify-root]') || null;
    if (!root) {
      this._unbindPathSimplifyControls();
      return;
    }
    this._pathSimplifyRoot = root;
    const slider = root.querySelector('[data-fa-nexus-path-simplify]') || null;
    if (slider) {
      slider.addEventListener('input', this._boundPathSimplifyInput);
      slider.addEventListener('change', this._boundPathSimplifyCommit);
    }
    this._pathSimplifySlider = slider;
    this._pathSimplifyDisplay = root.querySelector('[data-fa-nexus-path-simplify-display]') || null;
    this._bindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
  }

  _unbindPathSimplifyControls() {
    if (this._pathSimplifySlider) {
      try { this._pathSimplifySlider.removeEventListener('input', this._boundPathSimplifyInput); } catch (_) {}
      try { this._pathSimplifySlider.removeEventListener('change', this._boundPathSimplifyCommit); } catch (_) {}
    }
    this._unbindDisplayInput(this._pathSimplifyDisplay, this._boundPathSimplifyInput, this._boundPathSimplifyCommit);
    this._pathSimplifyRoot = null;
    this._pathSimplifySlider = null;
    this._pathSimplifyDisplay = null;
  }

  _syncPathSimplifyControls() {
    if (!this._pathSimplifyRoot) return;
    const state = this._toolOptionState?.pathAppearance?.freehandSimplify || { available: false };
    if (!state.available) {
      this._pathSimplifyRoot.hidden = true;
      return;
    }
    this._pathSimplifyRoot.hidden = false;
    if (this._pathSimplifySlider) {
      if (state.min !== undefined) this._pathSimplifySlider.min = String(state.min);
      if (state.max !== undefined) this._pathSimplifySlider.max = String(state.max);
      if (state.step !== undefined) this._pathSimplifySlider.step = String(state.step);
      if (state.value !== undefined) {
        const next = String(state.value);
        if (this._pathSimplifySlider.value !== next) this._pathSimplifySlider.value = next;
      }
      this._applyDefaultValue(this._pathSimplifySlider, state.defaultValue);
      this._pathSimplifySlider.disabled = !!state.disabled;
    }
    if (this._pathSimplifyDisplay) {
      this._syncDisplayValue(this._pathSimplifyDisplay, state);
    }
  }

  _handlePathSimplify(event, commit) {
    const slider = event?.currentTarget || event?.target;
    if (!slider) return;
    const value = slider.value;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setFreehandSimplify', value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => this._syncPathSimplifyControls());
      else this._syncPathSimplifyControls();
    } catch (_) {
      this._syncPathSimplifyControls();
    }
  }

  _bindShowWidthTangentsControls() {
    const root = this.element?.querySelector('[data-fa-nexus-show-width-tangents-root]') || null;
    if (!root) {
      this._unbindShowWidthTangentsControls();
      return;
    }
    this._showWidthTangentsRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-show-width-tangents]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundShowWidthTangentsChange);
    }
    this._showWidthTangentsToggle = toggle;
  }

  _unbindShowWidthTangentsControls() {
    if (this._showWidthTangentsToggle) {
      try { this._showWidthTangentsToggle.removeEventListener('change', this._boundShowWidthTangentsChange); } catch (_) {}
    }
    this._showWidthTangentsRoot = null;
    this._showWidthTangentsToggle = null;
  }

  _syncShowWidthTangentsControls() {
    if (!this._showWidthTangentsRoot) return;
    const state = this._toolOptionState?.pathAppearance?.showWidthTangents || { available: false };
    if (!state.available) {
      this._showWidthTangentsRoot.hidden = true;
      return;
    }
    this._showWidthTangentsRoot.hidden = false;
    if (this._showWidthTangentsToggle) {
      this._showWidthTangentsToggle.checked = !!state.enabled;
      this._showWidthTangentsToggle.disabled = !!state.disabled;
    }
  }

  _handleShowWidthTangentsChange(event) {
    const toggle = event?.currentTarget || event?.target;
    if (!toggle) return;
    const enabled = toggle.checked;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('setShowWidthTangents', enabled);
      if (result?.then) result.catch(() => {}).finally(() => this._syncShowWidthTangentsControls());
      else this._syncShowWidthTangentsControls();
    } catch (_) {
      this._syncShowWidthTangentsControls();
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
      const labelSpan = button.querySelector('[data-fa-nexus-button-label]')
        || Array.from(button.querySelectorAll('span')).find((span) => !span.classList.contains('fa-nexus-flip__button-icon'))
        || null;
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
    this._bindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);

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
    this._bindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);

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
    this._unbindDisplayInput(this._scaleDisplay, this._boundScaleInput, this._boundScaleInput);
    this._unbindDisplayInput(this._scaleStrengthDisplay, this._boundScaleStrength, this._boundScaleStrength);
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
      this._syncDisplayValue(this._scaleDisplay, state);
    }
    if (this._scaleBaseSlider) {
      if (state.min !== undefined) this._scaleBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._scaleBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._scaleBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._scaleBaseSlider.value !== nextValue) this._scaleBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._scaleBaseSlider, state.defaultValue);
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
      this._applyDefaultValue(this._scaleStrengthSlider, state.strengthDefault);
      this._scaleStrengthSlider.disabled = !strengthVisible;
    }
    if (this._scaleStrengthDisplay) {
      this._syncDisplayValue(this._scaleStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
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
    this._bindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);

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
    this._bindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);

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
    this._unbindDisplayInput(this._rotationDisplay, this._boundRotationInput, this._boundRotationInput);
    this._unbindDisplayInput(this._rotationStrengthDisplay, this._boundRotationStrength, this._boundRotationStrength);
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
      this._syncDisplayValue(this._rotationDisplay, state);
    }
    if (this._rotationBaseSlider) {
      if (state.min !== undefined) this._rotationBaseSlider.min = String(state.min);
      if (state.max !== undefined) this._rotationBaseSlider.max = String(state.max);
      if (state.step !== undefined) this._rotationBaseSlider.step = String(state.step);
      if (state.value !== undefined) {
        const nextValue = String(state.value);
        if (this._rotationBaseSlider.value !== nextValue) this._rotationBaseSlider.value = nextValue;
      }
      this._applyDefaultValue(this._rotationBaseSlider, state.defaultValue);
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
      this._applyDefaultValue(this._rotationStrengthSlider, state.strengthDefault);
      this._rotationStrengthSlider.disabled = !strengthVisible;
    }
    if (this._rotationStrengthDisplay) {
      this._syncDisplayValue(this._rotationStrengthDisplay, {
        min: state.strengthMin,
        max: state.strengthMax,
        step: state.strengthStep,
        value: state.strength,
        display: state.strengthDisplay || '',
        defaultValue: state.strengthDefault
      });
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

  _bindPathShadowControls() {
    const root = this.element?.querySelector('[data-fa-nexus-path-shadow]') || null;
    if (!root) {
      this._unbindPathShadowControls();
      return;
    }
    if (this._pathShadowRoot === root) {
      this._syncPathShadowControls();
      return;
    }
    this._unbindPathShadowControls();
    this._pathShadowRoot = root;
    const toggle = root.querySelector('[data-fa-nexus-path-shadow-toggle]') || null;
    if (toggle) {
      toggle.addEventListener('change', this._boundPathShadowToggle);
      this._pathShadowToggle = toggle;
    }
    const editToggle = root.querySelector('[data-fa-nexus-path-shadow-edit]') || null;
    if (editToggle) {
      editToggle.addEventListener('change', this._boundPathShadowEditToggle);
      this._pathShadowEditToggle = editToggle;
    }
    this._pathShadowEditRoot = root.querySelector('[data-fa-nexus-path-shadow-edit-row]')
      || root.querySelector('[data-fa-nexus-path-shadow-edit-root]')
      || (editToggle ? editToggle.closest('label') : null);
    this._pathShadowPresetsRoot = root.querySelector('[data-fa-nexus-path-shadow-presets]') || null;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetButtons = Array.from(this._pathShadowPresetsRoot.querySelectorAll('[data-fa-nexus-path-shadow-preset]'));
      for (const button of this._pathShadowPresetButtons) {
        button.addEventListener('click', this._boundPathShadowPresetClick);
        button.addEventListener('contextmenu', this._boundPathShadowPresetContext);
      }
    } else {
      this._pathShadowPresetButtons = [];
    }
    this._pathShadowResetButton = root.querySelector('[data-fa-nexus-path-shadow-reset]') || null;
    if (this._pathShadowResetButton) {
      this._pathShadowResetButton.addEventListener('click', this._boundPathShadowReset);
    }
    this._pathShadowEditResetButton = root.querySelector('[data-fa-nexus-path-shadow-edit-reset]') || null;
    if (this._pathShadowEditResetButton) {
      this._pathShadowEditResetButton.addEventListener('click', this._boundPathShadowEditReset);
    }
    this._pathShadowElevationDisplay = root.querySelector('[data-fa-nexus-path-shadow-elevation]') || null;
    this._pathShadowNoteDisplay = root.querySelector('[data-fa-nexus-path-shadow-note]') || null;
    const scaleSlider = root.querySelector('[data-fa-nexus-path-shadow-scale]') || null;
    if (scaleSlider) {
      scaleSlider.addEventListener('input', this._boundPathShadowScaleInput);
      scaleSlider.addEventListener('change', this._boundPathShadowScaleCommit);
      this._pathShadowScaleSlider = scaleSlider;
    }
    const offsetSlider = root.querySelector('[data-fa-nexus-path-shadow-offset]') || null;
    if (offsetSlider) {
      offsetSlider.addEventListener('input', this._boundPathShadowOffsetInput);
      offsetSlider.addEventListener('change', this._boundPathShadowOffsetCommit);
      this._pathShadowOffsetSlider = offsetSlider;
    }
    const alphaSlider = root.querySelector('[data-fa-nexus-path-shadow-alpha]') || null;
    if (alphaSlider) {
      alphaSlider.addEventListener('input', this._boundPathShadowAlphaInput);
      alphaSlider.addEventListener('change', this._boundPathShadowAlphaCommit);
      this._pathShadowAlphaSlider = alphaSlider;
    }
    const blurSlider = root.querySelector('[data-fa-nexus-path-shadow-blur]') || null;
    if (blurSlider) {
      blurSlider.addEventListener('input', this._boundPathShadowBlurInput);
      blurSlider.addEventListener('change', this._boundPathShadowBlurCommit);
      this._pathShadowBlurSlider = blurSlider;
    }
    const dilationSlider = root.querySelector('[data-fa-nexus-path-shadow-dilation]') || null;
    if (dilationSlider) {
      dilationSlider.addEventListener('input', this._boundPathShadowDilationInput);
      dilationSlider.addEventListener('change', this._boundPathShadowDilationCommit);
      this._pathShadowDilationSlider = dilationSlider;
    }
    this._pathShadowScaleDisplay = root.querySelector('[data-fa-nexus-path-shadow-scale-display]') || null;
    this._pathShadowOffsetDisplay = root.querySelector('[data-fa-nexus-path-shadow-offset-display]') || null;
    this._pathShadowAlphaDisplay = root.querySelector('[data-fa-nexus-path-shadow-alpha-display]') || null;
    this._pathShadowBlurDisplay = root.querySelector('[data-fa-nexus-path-shadow-blur-display]') || null;
    this._pathShadowDilationDisplay = root.querySelector('[data-fa-nexus-path-shadow-dilation-display]') || null;
    this._bindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._bindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._bindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._bindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._bindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._syncPathShadowControls();
  }

  _unbindPathShadowControls() {
    if (this._pathShadowToggle) {
      try { this._pathShadowToggle.removeEventListener('change', this._boundPathShadowToggle); }
      catch (_) {}
    }
    if (this._pathShadowEditToggle) {
      try { this._pathShadowEditToggle.removeEventListener('change', this._boundPathShadowEditToggle); }
      catch (_) {}
    }
    if (Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        try { button.removeEventListener('click', this._boundPathShadowPresetClick); } catch (_) {}
        try { button.removeEventListener('contextmenu', this._boundPathShadowPresetContext); } catch (_) {}
      }
    }
    if (this._pathShadowResetButton) {
      try { this._pathShadowResetButton.removeEventListener('click', this._boundPathShadowReset); }
      catch (_) {}
    }
    if (this._pathShadowEditResetButton) {
      try { this._pathShadowEditResetButton.removeEventListener('click', this._boundPathShadowEditReset); }
      catch (_) {}
    }
    if (this._pathShadowScaleSlider) {
      try {
        this._pathShadowScaleSlider.removeEventListener('input', this._boundPathShadowScaleInput);
        this._pathShadowScaleSlider.removeEventListener('change', this._boundPathShadowScaleCommit);
      } catch (_) {}
    }
    if (this._pathShadowOffsetSlider) {
      try {
        this._pathShadowOffsetSlider.removeEventListener('input', this._boundPathShadowOffsetInput);
        this._pathShadowOffsetSlider.removeEventListener('change', this._boundPathShadowOffsetCommit);
      } catch (_) {}
    }
    if (this._pathShadowAlphaSlider) {
      try {
        this._pathShadowAlphaSlider.removeEventListener('input', this._boundPathShadowAlphaInput);
        this._pathShadowAlphaSlider.removeEventListener('change', this._boundPathShadowAlphaCommit);
      } catch (_) {}
    }
    if (this._pathShadowBlurSlider) {
      try {
        this._pathShadowBlurSlider.removeEventListener('input', this._boundPathShadowBlurInput);
        this._pathShadowBlurSlider.removeEventListener('change', this._boundPathShadowBlurCommit);
      } catch (_) {}
    }
    if (this._pathShadowDilationSlider) {
      try {
        this._pathShadowDilationSlider.removeEventListener('input', this._boundPathShadowDilationInput);
        this._pathShadowDilationSlider.removeEventListener('change', this._boundPathShadowDilationCommit);
      } catch (_) {}
    }
    this._unbindDisplayInput(this._pathShadowScaleDisplay, this._boundPathShadowScaleInput, this._boundPathShadowScaleCommit);
    this._unbindDisplayInput(this._pathShadowOffsetDisplay, this._boundPathShadowOffsetInput, this._boundPathShadowOffsetCommit);
    this._unbindDisplayInput(this._pathShadowAlphaDisplay, this._boundPathShadowAlphaInput, this._boundPathShadowAlphaCommit);
    this._unbindDisplayInput(this._pathShadowBlurDisplay, this._boundPathShadowBlurInput, this._boundPathShadowBlurCommit);
    this._unbindDisplayInput(this._pathShadowDilationDisplay, this._boundPathShadowDilationInput, this._boundPathShadowDilationCommit);
    this._pathShadowRoot = null;
    this._pathShadowToggle = null;
    this._pathShadowEditToggle = null;
    this._pathShadowEditRoot = null;
    this._pathShadowPresetsRoot = null;
    this._pathShadowPresetButtons = [];
    this._pathShadowResetButton = null;
    this._pathShadowEditResetButton = null;
    this._pathShadowScaleSlider = null;
    this._pathShadowOffsetSlider = null;
    this._pathShadowAlphaSlider = null;
    this._pathShadowBlurSlider = null;
    this._pathShadowDilationSlider = null;
    this._pathShadowScaleDisplay = null;
    this._pathShadowOffsetDisplay = null;
    this._pathShadowAlphaDisplay = null;
    this._pathShadowBlurDisplay = null;
    this._pathShadowDilationDisplay = null;
    this._pathShadowElevationDisplay = null;
    this._pathShadowNoteDisplay = null;
  }

  _syncPathShadowControls() {
    const state = this._toolOptionState?.pathShadow || { available: false };
    if (this._pathShadowRoot) {
      this._pathShadowRoot.classList.toggle('is-hidden', !state.available);
    }
    if (!state.available) return;
    const editAvailable = state.editAvailable !== false;
    if (this._pathShadowEditRoot) {
      this._pathShadowEditRoot.classList.toggle('is-hidden', !editAvailable);
    }
    if (this._pathShadowToggle) {
      this._pathShadowToggle.checked = !!state.enabled;
      this._pathShadowToggle.disabled = !!state.disabled;
    }
    if (this._pathShadowEditToggle) {
      this._pathShadowEditToggle.checked = !!state.editMode;
      this._pathShadowEditToggle.disabled = !state.enabled || !!state.editDisabled || !editAvailable;
    }
    if (this._pathShadowElevationDisplay) {
      const displayValue = state.context?.display ?? '0';
      this._pathShadowElevationDisplay.textContent = `Elevation ${displayValue}`;
    }
    if (this._pathShadowNoteDisplay) {
      const note = state.context?.note ?? '';
      if (note) {
        this._pathShadowNoteDisplay.textContent = note;
        this._pathShadowNoteDisplay.classList.remove('is-hidden');
      } else {
        this._pathShadowNoteDisplay.textContent = '';
        this._pathShadowNoteDisplay.classList.add('is-hidden');
      }
    }
    const hasPresets = Array.isArray(state.presets) && state.presets.length > 0;
    if (this._pathShadowPresetsRoot) {
      this._pathShadowPresetsRoot.classList.toggle('is-hidden', !hasPresets);
    }
    if (hasPresets && Array.isArray(this._pathShadowPresetButtons) && this._pathShadowPresetButtons.length) {
      for (const button of this._pathShadowPresetButtons) {
        const index = Number(button.dataset.faNexusPathShadowPreset);
        const preset = state.presets.find((entry) => Number(entry?.index) === index)
          ?? state.presets[index] ?? null;
        const saved = !!preset?.saved;
        const active = !!preset?.active;
        button.classList.toggle('is-active', active);
        button.classList.toggle('is-empty', !saved);
        if (preset?.label) button.textContent = preset.label;
        if (preset?.tooltip) button.title = preset.tooltip;
        button.disabled = !!state.disabled;
      }
    }
    if (this._pathShadowResetButton) {
      const disabled = !!state.reset?.disabled;
      this._pathShadowResetButton.disabled = disabled;
      const tooltip = state.reset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowResetButton.title = tooltip;
    }
    if (this._pathShadowEditResetButton) {
      const disabled = !!state.editReset?.disabled;
      this._pathShadowEditResetButton.disabled = disabled;
      const tooltip = state.editReset?.tooltip;
      if (tooltip && tooltip.length) this._pathShadowEditResetButton.title = tooltip;
    }
    if (this._pathShadowScaleSlider && state.scale) {
      const cfg = state.scale;
      if (cfg.min !== undefined) this._pathShadowScaleSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowScaleSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowScaleSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowScaleSlider.value !== next) this._pathShadowScaleSlider.value = next;
      }
      this._pathShadowScaleSlider.disabled = !!cfg.disabled;
      if (this._pathShadowScaleDisplay) {
        this._syncDisplayValue(this._pathShadowScaleDisplay, cfg);
      }
    }
    if (this._pathShadowOffsetSlider && state.offset) {
      const cfg = state.offset;
      if (cfg.min !== undefined) this._pathShadowOffsetSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowOffsetSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowOffsetSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowOffsetSlider.value !== next) this._pathShadowOffsetSlider.value = next;
      }
      this._pathShadowOffsetSlider.disabled = !!cfg.disabled;
      if (this._pathShadowOffsetDisplay) {
        this._syncDisplayValue(this._pathShadowOffsetDisplay, cfg);
      }
    }
    if (this._pathShadowAlphaSlider && state.alpha) {
      const cfg = state.alpha;
      if (cfg.min !== undefined) this._pathShadowAlphaSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowAlphaSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowAlphaSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowAlphaSlider.value !== next) this._pathShadowAlphaSlider.value = next;
      }
      this._pathShadowAlphaSlider.disabled = !!cfg.disabled;
      if (this._pathShadowAlphaDisplay) {
        this._syncDisplayValue(this._pathShadowAlphaDisplay, cfg);
      }
    }
    if (this._pathShadowBlurSlider && state.blur) {
      const cfg = state.blur;
      if (cfg.min !== undefined) this._pathShadowBlurSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowBlurSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowBlurSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowBlurSlider.value !== next) this._pathShadowBlurSlider.value = next;
      }
      this._pathShadowBlurSlider.disabled = !!cfg.disabled;
      if (this._pathShadowBlurDisplay) {
        this._syncDisplayValue(this._pathShadowBlurDisplay, cfg);
      }
    }
    if (this._pathShadowDilationSlider && state.dilation) {
      const cfg = state.dilation;
      if (cfg.min !== undefined) this._pathShadowDilationSlider.min = String(cfg.min);
      if (cfg.max !== undefined) this._pathShadowDilationSlider.max = String(cfg.max);
      if (cfg.step !== undefined) this._pathShadowDilationSlider.step = String(cfg.step);
      if (cfg.value !== undefined) {
        const next = String(cfg.value);
        if (this._pathShadowDilationSlider.value !== next) this._pathShadowDilationSlider.value = next;
      }
      this._pathShadowDilationSlider.disabled = !!cfg.disabled;
      if (this._pathShadowDilationDisplay) {
        this._syncDisplayValue(this._pathShadowDilationDisplay, cfg);
      }
    }
  }

  _handlePathShadowToggle(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEnabled', enabled); }
    catch (_) {}
  }

  _handlePathShadowEdit(event) {
    if (!this._controller?.invokeToolHandler) return;
    const enabled = !!(event?.currentTarget?.checked ?? event?.target?.checked);
    try { this._controller.invokeToolHandler('setPathShadowEditMode', enabled); }
    catch (_) {}
  }

  _handlePathShadowSlider(event, handlerId, commit) {
    if (!this._controller?.invokeToolHandler) return;
    const value = event?.currentTarget?.value ?? event?.target?.value;
    const numeric = Number(value);
    const payload = Number.isFinite(numeric) ? numeric : value;
    try { this._controller.invokeToolHandler(handlerId, payload, !!commit); }
    catch (_) {}
  }

  _handlePathShadowPresetClick(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const save = !!(event?.shiftKey || event?.altKey || event?.metaKey);
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, save);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowPresetContext(event) {
    const button = event?.currentTarget || event?.target;
    if (!button) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const index = Number(button.dataset.faNexusPathShadowPreset);
    if (!Number.isInteger(index)) return;
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('handlePathShadowPreset', index, true);
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowSettings');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
    }
  }

  _handlePathShadowEditReset(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const controller = this._controller;
    if (!controller?.invokeToolHandler) return;
    try {
      const result = controller.invokeToolHandler('resetPathShadowEdit');
      if (result?.then) {
        result.catch(() => {}).finally(() => this._syncPathShadowControls());
      } else {
        this._syncPathShadowControls();
      }
    } catch (_) {
      this._syncPathShadowControls();
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
    this._bindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._bindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
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
    this._unbindDisplayInput(this._pathFeatherStartValue, this._boundPathFeatherStartInput, this._boundPathFeatherStartCommit);
    this._unbindDisplayInput(this._pathFeatherEndValue, this._boundPathFeatherEndInput, this._boundPathFeatherEndCommit);
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
      this._applyDefaultValue(this._pathFeatherStartSlider, length.defaultValue);
      this._pathFeatherStartSlider.disabled = !!length.disabled;
      if (this._pathFeatherStartValue) {
        this._syncDisplayValue(this._pathFeatherStartValue, length);
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
      this._applyDefaultValue(this._pathFeatherEndSlider, length.defaultValue);
      this._pathFeatherEndSlider.disabled = !!length.disabled;
      if (this._pathFeatherEndValue) {
        this._syncDisplayValue(this._pathFeatherEndValue, length);
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
    this._bindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._bindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
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
    this._unbindDisplayInput(this._opacityFeatherStartValue, this._boundOpacityFeatherStartInput, this._boundOpacityFeatherStartCommit);
    this._unbindDisplayInput(this._opacityFeatherEndValue, this._boundOpacityFeatherEndInput, this._boundOpacityFeatherEndCommit);
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
      this._applyDefaultValue(this._opacityFeatherStartSlider, length.defaultValue);
      this._opacityFeatherStartSlider.disabled = !state.start.enabled || !!length.disabled;
      if (this._opacityFeatherStartValue) {
        this._syncDisplayValue(this._opacityFeatherStartValue, length, { disabled: !state.start.enabled });
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
      this._applyDefaultValue(this._opacityFeatherEndSlider, length.defaultValue);
      this._opacityFeatherEndSlider.disabled = !state.end.enabled || !!length.disabled;
      if (this._opacityFeatherEndValue) {
        this._syncDisplayValue(this._opacityFeatherEndValue, length, { disabled: !state.end.enabled });
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
    const stateList = [];
    if (Array.isArray(this._toolOptionState?.customToggles)) {
      stateList.push(...this._toolOptionState.customToggles);
    }
    if (Array.isArray(this._toolOptionState?.subtoolToggles)) {
      stateList.push(...this._toolOptionState.subtoolToggles);
    }
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
      let state = stateMap.get(id) || null;
      if (!state) {
        const controlId = toggle.closest?.('[data-fa-nexus-declarative-control]')?.getAttribute?.('data-fa-nexus-declarative-control') || '';
        const control = this._getPreparedDeclarativeControl(controlId);
        if (control?.type === 'segmented') {
          state = Array.isArray(control.options) ? control.options.find((option) => option.id === id) || null : null;
        } else if (control?.type === 'toggle-list') {
          state = Array.isArray(control.items) ? control.items.find((item) => item.id === id) || null : null;
        }
      }
      state = state || {};
      toggle.checked = !!state.enabled;
      toggle.disabled = !!state.disabled;
      if (state.tooltip) toggle.title = String(state.tooltip);
      const optionRoot = toggle.closest('.fa-nexus-declarative-segmented__option');
      if (optionRoot) {
        optionRoot.classList.toggle('is-active', !!state.enabled);
        optionRoot.classList.toggle('is-disabled', !!state.disabled);
        if (state.tooltip) optionRoot.title = String(state.tooltip);
      }
    }
  }

  _handlePlacementPush(event, direction = 'top') {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const handlerId = direction === 'bottom' ? 'pushSelectedWallToBottom' : 'pushSelectedWallToTop';
    try { this._controller?.invokeToolHandler?.(handlerId); }
    catch (_) {}
  }

  _bindPlacementControls() {
    const root = this.element?.querySelector('[data-fa-nexus-placement-root]');
    if (!root) {
      this._unbindPlacementControls();
      return;
    }
    this._placementRoot = root;
    this._placementSwitchRoots = Array.from(root.querySelectorAll('[data-fa-nexus-switch]') || []);
    const pushTop = root.querySelector('[data-fa-nexus-stack-top]');
    if (pushTop) {
      pushTop.addEventListener('click', this._boundPlacementPushTop);
      this._placementPushTopButton = pushTop;
    }
    const pushBottom = root.querySelector('[data-fa-nexus-stack-bottom]');
    if (pushBottom) {
      pushBottom.addEventListener('click', this._boundPlacementPushBottom);
      this._placementPushBottomButton = pushBottom;
    }
    this._placementOrderDisplay = root.querySelector('[data-fa-nexus-placement-order]') || null;
    this._placementHint = root.querySelector('[data-fa-nexus-placement-hint]') || null;
    this._placementStateLabels = Array.from(root.querySelectorAll('[data-fa-nexus-switch-state]') || []);
    this._syncPlacementControls();
  }

  _unbindPlacementControls() {
    if (this._placementPushTopButton) {
      try { this._placementPushTopButton.removeEventListener('click', this._boundPlacementPushTop); }
      catch (_) {}
      this._placementPushTopButton = null;
    }
    if (this._placementPushBottomButton) {
      try { this._placementPushBottomButton.removeEventListener('click', this._boundPlacementPushBottom); }
      catch (_) {}
      this._placementPushBottomButton = null;
    }
    this._placementRoot = null;
    this._placementOrderDisplay = null;
    this._placementHint = null;
    this._placementStateLabels = [];
    this._placementSwitchRoots = [];
  }

  _syncPlacementControls() {
    if (!this._placementRoot) return;
    const stateList = Array.isArray(this._toolOptionState?.customToggles)
      ? this._toolOptionState.customToggles
      : [];
    const stateMap = new Map();
    for (const toggle of stateList) {
      if (!toggle || typeof toggle !== 'object') continue;
      const id = String(toggle.id || '');
      if (!id.length) continue;
      stateMap.set(id, toggle);
    }
    if (Array.isArray(this._placementSwitchRoots)) {
      for (const root of this._placementSwitchRoots) {
        const id = root?.dataset?.faNexusSwitch || root?.getAttribute?.('data-fa-nexus-switch') || '';
        if (!id) continue;
        const state = stateMap.get(id) || {};
        const input = root.querySelector('input[type="checkbox"]');
        if (input) {
          input.checked = !!state.enabled;
          input.disabled = !!state.disabled;
        }
        root.classList.toggle('is-on', !!state.enabled);
        root.classList.toggle('is-disabled', !!state.disabled);
      }
    }
    if (Array.isArray(this._placementStateLabels)) {
      for (const label of this._placementStateLabels) {
        const rawId = label?.dataset?.faNexusSwitchState || label?.getAttribute?.('data-fa-nexus-switch-state') || '';
        if (!rawId) continue;
        const baseId = rawId.replace(/-on$|-off$/, '');
        const state = stateMap.get(baseId) || {};
        const isOn = !!state.enabled;
        const onLabel = typeof state.onLabel === 'string' && state.onLabel.length ? state.onLabel : 'On';
        const offLabel = typeof state.offLabel === 'string' && state.offLabel.length ? state.offLabel : 'Off';
        const wantOn = rawId.endsWith('-on');
        const text = wantOn ? onLabel : offLabel;
        if (label.textContent !== text) label.textContent = text;
        label.classList.toggle('is-active', (wantOn && isOn) || (!wantOn && !isOn));
      }
    }
    const stacking = this._toolOptionState?.shapeStacking || { available: false };
    const available = !!stacking.available;
    if (this._placementPushTopButton) {
      this._placementPushTopButton.disabled = !available || !!stacking.pushTopDisabled;
    }
    if (this._placementPushBottomButton) {
      this._placementPushBottomButton.disabled = !available || !!stacking.pushBottomDisabled;
    }
    if (this._placementOrderDisplay) {
      const text = available ? (stacking.orderLabel || '') : '';
      this._placementOrderDisplay.textContent = text;
      this._placementOrderDisplay.classList.toggle('is-hidden', !text);
    }
    if (this._placementHint) {
      const hint = available ? (stacking.hint || '') : '';
      this._placementHint.textContent = hint;
      this._placementHint.classList.toggle('is-hidden', !hint);
    }
  }

  _getPreparedPortalControl(controlId = '') {
    const id = String(controlId || '');
    if (!id) return null;
    const control = this._getPreparedDeclarativeControl(id);
    return control?.type === 'portal-controls' ? control : null;
  }

  _getPreparedPortalControlFromEvent(event) {
    const root = event?.currentTarget?.closest?.('[data-fa-nexus-portal-root]')
      || event?.target?.closest?.('[data-fa-nexus-portal-root]')
      || null;
    if (!root) return null;
    return this._getPreparedPortalControl(root.getAttribute('data-fa-nexus-portal-root') || '');
  }

  _coercePortalControlValue(value, mode = 'string') {
    switch (mode) {
      case 'number': {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : 0;
      }
      case 'door-direction': {
        const numeric = Number(value);
        return numeric === -1 ? -1 : 1;
      }
      default:
        return value ?? '';
    }
  }

  _getPortalSectionCollapseKey(controlId = '', sectionId = '') {
    const activeId = String(this._activeTool?.id || '');
    const controlKey = String(controlId || '');
    const sectionKey = String(sectionId || '');
    if (!activeId || !controlKey || !sectionKey) return '';
    return `${activeId}::${controlKey}::${sectionKey}`;
  }

  _isPortalSectionCollapsed(controlId = '', sectionId = '') {
    const key = this._getPortalSectionCollapseKey(controlId, sectionId);
    return key ? !!this._portalSectionCollapsedByKey.get(key) : false;
  }

  _togglePortalSectionCollapsed(controlId = '', sectionId = '') {
    const key = this._getPortalSectionCollapseKey(controlId, sectionId);
    if (!key) return false;
    const next = !this._portalSectionCollapsedByKey.get(key);
    if (next) this._portalSectionCollapsedByKey.set(key, true);
    else this._portalSectionCollapsedByKey.delete(key);
    return next;
  }

  _syncPortalControls() {
    if (!this.element) return;
    const roots = Array.from(this.element.querySelectorAll('[data-fa-nexus-portal-root]'));
    for (const root of roots) {
      const controlId = root.getAttribute('data-fa-nexus-portal-root') || '';
      const control = this._getPreparedPortalControl(controlId);
      if (!control) {
        root.style.display = 'none';
        continue;
      }
      root.style.display = '';
      if (!root._faPortalBound) {
        root._faPortalBound = true;
        for (const button of root.querySelectorAll('[data-fa-nexus-portal-action]')) {
          button.addEventListener('click', (event) => this._handlePortalAction(event));
        }
        for (const input of root.querySelectorAll('[data-fa-nexus-portal-toggle]')) {
          input.addEventListener('change', (event) => this._handlePortalToggle(event));
        }
        for (const select of root.querySelectorAll('[data-fa-nexus-portal-select]')) {
          select.addEventListener('change', (event) => this._handlePortalSelect(event));
        }
        for (const input of root.querySelectorAll('[data-fa-nexus-portal-color-target]')) {
          input.addEventListener('change', (event) => this._handlePortalColorTarget(event));
        }
        for (const slider of root.querySelectorAll('[data-fa-nexus-portal-setting-input]')) {
          slider.addEventListener('input', (event) => this._handlePortalSetting(event, false));
          slider.addEventListener('change', (event) => this._handlePortalSetting(event, true));
        }
        for (const display of root.querySelectorAll('[data-fa-nexus-portal-setting-display]')) {
          this._bindDisplayInput(display, null, (event) => this._handlePortalSetting(event, true));
        }
        for (const button of root.querySelectorAll('[data-fa-nexus-portal-section-toggle]')) {
          button.addEventListener('click', (event) => this._handlePortalSectionToggle(event));
        }
      }
      this._syncPortalControlRoot(root, control);
    }
  }

  _schedulePortalControlsSync() {
    if (this._portalControlsSyncTimer) {
      try { clearTimeout(this._portalControlsSyncTimer); } catch (_) {}
      this._portalControlsSyncTimer = null;
    }
    this._portalControlsSyncTimer = setTimeout(() => {
      this._portalControlsSyncTimer = null;
      this._syncPortalControls();
    }, 75);
  }

  _syncPortalControlRoot(root, control) {
    const selection = root.querySelector('[data-fa-nexus-portal-selection]');
    if (selection) selection.textContent = control.selectionLabel || '';
    const selectionHint = root.querySelector('[data-fa-nexus-portal-selection-hint]');
    if (selectionHint) {
      const value = control.selectionHint || '';
      selectionHint.textContent = value;
      selectionHint.style.display = value ? '' : 'none';
    }

    const actionLabelNodes = root.querySelectorAll('[data-fa-nexus-portal-action-label]');
    for (const node of actionLabelNodes) {
      const actionId = node.getAttribute('data-fa-nexus-portal-action-label') || '';
      const action = control.actionMap?.[actionId];
      if (!action) continue;
      if (node.textContent !== action.label) node.textContent = action.label;
    }
    for (const button of root.querySelectorAll('[data-fa-nexus-portal-action]')) {
      const actionId = button.getAttribute('data-fa-nexus-portal-action') || '';
      const action = control.actionMap?.[actionId];
      if (!action) continue;
      button.disabled = !!action.disabled;
      if (action.title) button.title = action.title;
      else button.removeAttribute('title');
    }

    for (const groupRoot of root.querySelectorAll('[data-fa-nexus-portal-toggle-group]')) {
      const groupId = groupRoot.getAttribute('data-fa-nexus-portal-toggle-group') || '';
      const group = control.toggleGroupMap?.[groupId];
      groupRoot.style.display = group?.visible === false ? 'none' : '';
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-toggle]')) {
      const toggleId = input.getAttribute('data-fa-nexus-portal-toggle') || '';
      const toggle = control.toggleMap?.[toggleId];
      if (!toggle) continue;
      input.checked = !!toggle.checked;
      input.disabled = !!toggle.disabled;
      if (toggle.title) input.closest('label')?.setAttribute('title', toggle.title);
    }

    for (const groupRoot of root.querySelectorAll('[data-fa-nexus-portal-select-group]')) {
      const groupId = groupRoot.getAttribute('data-fa-nexus-portal-select-group') || '';
      const group = control.selectGroupMap?.[groupId];
      groupRoot.style.display = group?.visible === false ? 'none' : '';
    }
    for (const select of root.querySelectorAll('[data-fa-nexus-portal-select]')) {
      const selectId = select.getAttribute('data-fa-nexus-portal-select') || '';
      const config = control.selectMap?.[selectId];
      if (!config) continue;
      select.disabled = !!config.disabled;
      const nextValue = String(config.value ?? '');
      const hasOption = Array.from(select.options || []).some((option) => option?.value === nextValue);
      if (select.value !== nextValue && hasOption) {
        select.value = nextValue;
      } else if (select.value !== nextValue && !select.options.length) {
        select.value = nextValue;
      }
    }

    const colorRoot = root.querySelector('[data-fa-nexus-portal-color]');
    if (colorRoot) {
      colorRoot.style.display = control.color?.visible === false ? 'none' : '';
    }
    const colorTargetGroup = root.querySelector('[data-fa-nexus-portal-color-target-group]');
    if (colorTargetGroup) {
      colorTargetGroup.style.display = control.color?.target?.visible === false ? 'none' : '';
    }
    for (const input of root.querySelectorAll('[data-fa-nexus-portal-color-target]')) {
      const targetId = input.getAttribute('data-fa-nexus-portal-color-target') || '';
      const item = Array.isArray(control.color?.target?.items)
        ? control.color.target.items.find((entry) => entry?.id === targetId) || null
        : null;
      if (!item) continue;
      input.checked = !!item.enabled;
      input.disabled = !!item.disabled;
      const optionRoot = input.closest('.fa-nexus-declarative-segmented__option');
      if (optionRoot) {
        optionRoot.classList.toggle('is-active', !!item.enabled);
        optionRoot.classList.toggle('is-disabled', !!item.disabled);
        if (item.title) optionRoot.title = item.title;
        else optionRoot.removeAttribute('title');
      }
    }

    for (const sectionRoot of root.querySelectorAll('[data-fa-nexus-portal-section]')) {
      const sectionId = sectionRoot.getAttribute('data-fa-nexus-portal-section') || '';
      const section = sectionId === 'color'
        ? (control.color && typeof control.color === 'object'
          ? control.color
          : null)
        : control.sectionMap?.[sectionId];
      sectionRoot.style.display = section?.visible === false ? 'none' : '';
      const collapsed = !!section?.collapsed;
      sectionRoot.classList.toggle('is-collapsed', collapsed);
      const toggle = sectionRoot.querySelector('[data-fa-nexus-portal-section-toggle]');
      if (toggle) {
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.title = `${collapsed ? 'Expand' : 'Collapse'} ${section?.label || ''}`.trim();
      }
      const body = sectionRoot.querySelector('[data-fa-nexus-portal-section-body]');
      if (body) body.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
    }
    for (const settingsRoot of root.querySelectorAll('[data-fa-nexus-portal-settings]')) {
      const settingsId = settingsRoot.getAttribute('data-fa-nexus-portal-settings') || '';
      const section = Object.values(control.sectionMap || {}).find?.((entry) => entry?.settings?.id === settingsId) || null;
      settingsRoot.style.display = section?.settings?.visible === false ? 'none' : '';
    }
    for (const slider of root.querySelectorAll('[data-fa-nexus-portal-setting-input]')) {
      const rowId = slider.getAttribute('data-fa-nexus-portal-setting-input') || '';
      const row = control.settingMap?.[rowId];
      if (!row) continue;
      if (row.min !== undefined) slider.min = String(row.min);
      if (row.max !== undefined) slider.max = String(row.max);
      if (row.step !== undefined) slider.step = String(row.step);
      const next = String(row.value ?? '');
      if (slider.value !== next) slider.value = next;
      this._applyDefaultValue(slider, row.defaultValue);
      slider.disabled = !!row.disabled;
      if (row.hint) slider.title = row.hint;
      else slider.removeAttribute('title');
    }
    for (const display of root.querySelectorAll('[data-fa-nexus-portal-setting-display]')) {
      const rowId = display.getAttribute('data-fa-nexus-portal-setting-display') || '';
      const row = control.settingMap?.[rowId];
      if (!row) continue;
      this._syncDisplayValue(display, row, { disabled: row.disabled });
    }
  }

  _handlePortalAction(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = event?.currentTarget || event?.target;
    const actionId = button?.getAttribute?.('data-fa-nexus-portal-action') || '';
    if (!actionId) return;
    const control = this._getPreparedPortalControlFromEvent(event);
    const action = control?.actionMap?.[actionId];
    const handlerId = typeof action?.handlerId === 'string' ? action.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId);
      if (result?.then) result.catch(() => {}).finally(() => {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      });
      else {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      }
    } catch (_) {
      this._syncPortalControls();
      this._schedulePortalControlsSync();
    }
  }

  _handlePortalToggle(event) {
    const input = event?.currentTarget || event?.target;
    const toggleId = input?.getAttribute?.('data-fa-nexus-portal-toggle') || '';
    if (!toggleId) return;
    const control = this._getPreparedPortalControlFromEvent(event);
    const toggle = control?.toggleMap?.[toggleId];
    const handlerId = typeof toggle?.handlerId === 'string' ? toggle.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, !!input.checked);
      if (result?.then) result.catch(() => {}).finally(() => {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      });
      else {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      }
    } catch (_) {
      this._syncPortalControls();
      this._schedulePortalControlsSync();
    }
  }

  _handlePortalColorTarget(event) {
    const input = event?.currentTarget || event?.target;
    if (!input?.checked) return;
    const targetId = input.getAttribute?.('data-fa-nexus-portal-color-target') || '';
    if (!targetId) return;
    const control = this._getPreparedPortalControlFromEvent(event);
    const handlerId = typeof control?.color?.target?.handlerId === 'string' ? control.color.target.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    try {
      const result = this._controller.invokeToolHandler(handlerId, targetId);
      if (result?.then) result.catch(() => {}).finally(() => {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      });
      else {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      }
    } catch (_) {
      this._syncPortalControls();
      this._schedulePortalControlsSync();
    }
  }

  _handlePortalSelect(event) {
    const select = event?.currentTarget || event?.target;
    const selectId = select?.getAttribute?.('data-fa-nexus-portal-select') || '';
    if (!selectId) return;
    const control = this._getPreparedPortalControlFromEvent(event);
    const config = control?.selectMap?.[selectId];
    const handlerId = typeof config?.handlerId === 'string' ? config.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const value = this._coercePortalControlValue(select.value, config.valueMode);
    try {
      const result = this._controller.invokeToolHandler(handlerId, value);
      if (result?.then) result.catch(() => {}).finally(() => {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      });
      else {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      }
    } catch (_) {
      this._syncPortalControls();
      this._schedulePortalControlsSync();
    }
  }

  _handlePortalSectionToggle(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const button = event?.currentTarget || event?.target;
    const sectionId = button?.getAttribute?.('data-fa-nexus-portal-section-toggle') || '';
    const root = button?.closest?.('[data-fa-nexus-portal-root]') || null;
    const controlId = root?.getAttribute?.('data-fa-nexus-portal-root') || '';
    if (!controlId || !sectionId) return;
    this._togglePortalSectionCollapsed(controlId, sectionId);
    this._syncPortalControls();
  }

  _handlePortalSetting(event, commit) {
    const input = event?.currentTarget || event?.target;
    const rowId = input?.getAttribute?.('data-fa-nexus-portal-setting-input')
      || input?.getAttribute?.('data-fa-nexus-portal-setting-display')
      || '';
    if (!rowId) return;
    const control = this._getPreparedPortalControlFromEvent(event);
    const row = control?.settingMap?.[rowId];
    const handlerId = typeof row?.handlerId === 'string' ? row.handlerId : '';
    if (!handlerId || !this._controller?.invokeToolHandler) return;
    const value = this._coercePortalControlValue(input.value, row.valueMode);
    try {
      const result = this._controller.invokeToolHandler(handlerId, value, !!commit);
      if (result?.then) result.catch(() => {}).finally(() => {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      });
      else {
        this._syncPortalControls();
        this._schedulePortalControlsSync();
      }
    } catch (_) {
      this._syncPortalControls();
      this._schedulePortalControlsSync();
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

  _shouldIgnoreWindowShortcut(event) {
    try {
      const target = event?.target ?? document?.activeElement ?? null;
      if (!target || target === document.body) return false;
      if (target.dataset?.faNexusHotkeys === 'allow') return false;
      if (typeof target.isContentEditable === 'boolean' && target.isContentEditable) return true;
      const tag = target.tagName ? String(target.tagName).toLowerCase() : '';
      if (!tag) return false;
      if (tag === 'textarea' || tag === 'select') return true;
      if (tag !== 'input') return false;
      const type = typeof target.type === 'string' ? target.type.toLowerCase() : '';
      const allowTypes = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden'];
      if (!type) return true;
      return !allowTypes.includes(type);
    } catch (_) {
      return false;
    }
  }

  _handleHelpOpen(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    this._controller?.openActiveToolHelp?.({ focus: true });
  }

  _handleWindowKeyDown(event) {
    if (!isHelpShortcut(event)) return;
    if (this._shouldIgnoreWindowShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    this._controller?.openActiveToolHelp?.({ focus: true });
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
    const actorTypeState = state.actorType || {};
    if (this._placeAsActorTypeSelect) {
      const actorTypeOptions = Array.isArray(actorTypeState.options)
        ? actorTypeState.options.filter((option) => !!option?.id)
        : [];
      const currentValues = Array.from(this._placeAsActorTypeSelect.options, (option) => option.value);
      const nextValues = actorTypeOptions.map((option) => String(option.id));
      const needsRebuild = currentValues.length !== nextValues.length
        || currentValues.some((value, index) => value !== nextValues[index]);
      if (needsRebuild) {
        const fragment = document.createDocumentFragment();
        for (const entry of actorTypeOptions) {
          const optionElement = document.createElement('option');
          optionElement.value = String(entry.id);
          optionElement.textContent = entry.label || String(entry.id);
          optionElement.selected = !!entry.selected;
          optionElement.disabled = !!entry.disabled;
          fragment.appendChild(optionElement);
        }
        this._placeAsActorTypeSelect.replaceChildren(fragment);
      } else {
        const optionMap = new Map();
        for (const option of actorTypeOptions) {
          optionMap.set(String(option.id), option);
        }
        for (const optionElement of this._placeAsActorTypeSelect.options) {
          const entry = optionMap.get(optionElement.value);
          if (!entry) continue;
          optionElement.disabled = !!entry.disabled;
          optionElement.selected = !!entry.selected;
          if (entry.label && optionElement.textContent !== entry.label) {
            optionElement.textContent = entry.label;
          }
        }
      }
      if (actorTypeState.value) this._placeAsActorTypeSelect.value = actorTypeState.value;
      this._placeAsActorTypeSelect.disabled = !!actorTypeState.disabled;
    }
    if (this._placeAsActorTypeHint) {
      const hint = actorTypeState.hint || '';
      this._placeAsActorTypeHint.textContent = hint;
      this._placeAsActorTypeHint.hidden = !hint;
    }
    const namingState = state.naming || {};
    if (this._placeAsAppendNumberToggle) {
      this._placeAsAppendNumberToggle.checked = !!namingState.appendNumber;
      this._placeAsAppendNumberToggle.disabled = !namingState.available;
      const label = this._placeAsAppendNumberToggle.closest('label');
      if (label && namingState.appendNumberTooltip) label.title = namingState.appendNumberTooltip;
    }
    if (this._placeAsPrependAdjectiveToggle) {
      this._placeAsPrependAdjectiveToggle.checked = !!namingState.prependAdjective;
      this._placeAsPrependAdjectiveToggle.disabled = !namingState.available;
      const label = this._placeAsPrependAdjectiveToggle.closest('label');
      if (label && namingState.prependAdjectiveTooltip) label.title = namingState.prependAdjectiveTooltip;
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

  _handlePlaceAsActorType(event) {
    const value = event?.currentTarget?.value ?? '';
    const result = this._controller?.invokeToolHandler?.('setPlaceAsActorType', value);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsAppendNumber(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsAppendNumber', checked);
    if (result?.then) {
      result.finally(() => this._syncPlaceAsControls());
    } else {
      this._syncPlaceAsControls();
    }
  }

  _handlePlaceAsPrependAdjective(event) {
    const checked = !!event?.currentTarget?.checked;
    const result = this._controller?.invokeToolHandler?.('setPlaceAsPrependAdjective', checked);
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

  _handlePlaceAsFilter(event) {
    if (event) {
      event.preventDefault?.();
      event.stopPropagation?.();
    }
    this._controller?.invokeToolHandler?.('openCompendiumFilterDialog');
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
    this._helpWindow = null;
    this._activeTools = new Map();
    this._sectionCollapsedByTool = new Map();
    this._needsGridSnapResync = false;
    this._gridSnapEnabled = this._readGridSnapSetting();
    this._needsGridSnapSubdivResync = false;
    this._gridSnapSubdivisions = this._readGridSnapSubdivisionSetting();
    this._settingsHook = null;
    this._settingsAvailable = this._canAccessSettings();
    this._restoreSectionState();
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
    this._syncHelpWindow({ suppressRender: false });
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
    this._syncHelpWindow({ suppressRender: false });
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
      if (this._helpWindow?.rendered) {
        try { this._helpWindow.close({ animate: false }); } catch (_) {}
      } else {
        this._helpWindow = null;
      }
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
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
  }

  _ensureWindow() {
    if (this._window) return this._window;
    const available = this.supportsGridSnap();
    this._window = new ToolOptionsWindow({
      controller: this,
      gridSnapEnabled: this._gridSnapEnabled,
      gridSnapAvailable: available,
      gridSnapSubdivisions: this._gridSnapSubdivisions,
      toolOptions: this._getToolState(null)
    });
    return this._window;
  }

  setToolOptions(toolId, payload = {}) {
    if (!toolId) return;
    const id = String(toolId);
    const previous = this._toolOptions.get(id);
    const normalized = normalizeToolOptionsPayload(id, payload);
    this._toolOptions.set(id, {
      state: normalized.state,
      handlers: normalized.handlers,
      normalized: normalized.normalized
    });
    if (this._window && this._window.activeTool?.id === id) {
      this._window.setActiveToolOptions(normalized.state, { suppressRender: normalized.suppressRender });
      const needsLayoutRender = this._window.rendered
        && this._didSectionLayoutChange(previous?.normalized || null, normalized.normalized || null);
      if (needsLayoutRender && normalized.suppressRender) {
        this._window.render(false);
      } else {
        this._window.refreshToolSections?.();
      }
    }
    if (this._helpWindow && this._getActiveToolId() === id) {
      this._syncHelpWindow({ suppressRender: normalized.suppressRender });
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
    this._syncHelpWindow({ suppressRender: false });
    this._notifyStateListeners();
    return true;
  }

  getGridSnapSubdivisions() {
    return this._gridSnapSubdivisions;
  }

  isGridSnapEnabled() {
    return !!this._gridSnapEnabled;
  }

  toggleGridSnapShortcut() {
    return this.requestGridSnapToggle(!this._gridSnapEnabled);
  }

  nudgeGridSnapSubdivision(delta = 0) {
    const next = this._normalizeGridSnapSubdivisionValue(this._gridSnapSubdivisions + (Number(delta) || 0));
    if (next === this._gridSnapSubdivisions) return true;
    return this.requestGridSnapSubdivisionChange(next);
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

  updateDropShadowPreview(toolId, preview) {
    if (!toolId) return;
    const id = String(toolId);
    if (!this._toolOptions.has(id)) return;
    const entry = this._toolOptions.get(id);
    if (!entry || typeof entry !== 'object') return;
    const state = entry.state && typeof entry.state === 'object' ? entry.state : {};
    const controls = state.dropShadowControls && typeof state.dropShadowControls === 'object'
      ? state.dropShadowControls
      : {};
    const normalized = preview && typeof preview === 'object' && typeof preview.src === 'string' && preview.src.length > 0
      ? {
          src: preview.src,
          width: Number.isFinite(preview.width) ? Number(preview.width) : null,
          height: Number.isFinite(preview.height) ? Number(preview.height) : null,
          signature: typeof preview.signature === 'string' ? preview.signature : null,
          updatedAt: Number.isFinite(preview.updatedAt) ? Number(preview.updatedAt) : Date.now(),
          alt: typeof preview.alt === 'string' ? preview.alt : ''
        }
      : null;
    if (normalized) controls.preview = normalized;
    else delete controls.preview;
    state.dropShadowControls = controls;
    entry.state = state;
    this._toolOptions.set(id, entry);
    if (this._window?.activeTool?.id === id) {
      this._window.applyDropShadowPreview(normalized);
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

  _getToolNormalized(toolId) {
    if (!toolId) return null;
    return this._toolOptions.get(String(toolId))?.normalized || null;
  }

  _getActiveToolId() {
    const activeId = this._window?.activeTool?.id;
    if (activeId) return activeId;
    const keys = Array.from(this._activeTools.keys());
    return keys.length ? keys[keys.length - 1] : null;
  }

  _getToolLabel(toolId) {
    const id = String(toolId || '');
    if (!id) return '';
    const active = this._activeTools.get(id);
    if (active?.label) return String(active.label);
    const normalized = this._getToolNormalized(id);
    const descriptorLabel = normalized?.descriptor?.toolLabel;
    return typeof descriptorLabel === 'string' && descriptorLabel.trim().length
      ? descriptorLabel.trim()
      : id;
  }

  _sectionStatesEqual(next) {
    if (!(next instanceof Map)) return false;
    if (next.size !== this._sectionCollapsedByTool.size) return false;
    for (const [toolId, nextSections] of next.entries()) {
      const currentSections = this._sectionCollapsedByTool.get(toolId);
      if (!(currentSections instanceof Set) || currentSections.size !== nextSections.size) return false;
      for (const sectionId of nextSections) {
        if (!currentSections.has(sectionId)) return false;
      }
    }
    return true;
  }

  _restoreSectionState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.get !== 'function') return;
    try {
      const saved = settings.get(MODULE_ID, SECTIONS_SETTING_KEY);
      this._applySectionSetting(saved);
    } catch (_) {
      // ignore malformed data
    }
  }

  _applySectionSetting(raw) {
    const next = new Map();
    if (raw && typeof raw === 'object') {
      for (const [toolKey, sectionValue] of Object.entries(raw)) {
        const toolId = String(toolKey || '');
        if (!toolId || !sectionValue || typeof sectionValue !== 'object') continue;
        const collapsedSections = new Set();
        for (const [sectionKey, collapsed] of Object.entries(sectionValue)) {
          const sectionId = String(sectionKey || '');
          if (!sectionId || !collapsed) continue;
          collapsedSections.add(sectionId);
        }
        if (collapsedSections.size) next.set(toolId, collapsedSections);
      }
    }

    if (this._sectionStatesEqual(next)) return false;

    this._sectionCollapsedByTool.clear();
    for (const [toolId, collapsedSections] of next.entries()) {
      this._sectionCollapsedByTool.set(toolId, collapsedSections);
    }
    return true;
  }

  applySectionSetting(raw) {
    const changed = this._applySectionSetting(raw);
    if (changed) this._window?.refreshToolSections?.();
  }

  _persistSectionState() {
    const settings = globalThis?.game?.settings;
    if (!settings || typeof settings.set !== 'function') return;
    try {
      const payload = {};
      for (const [toolId, collapsedSections] of this._sectionCollapsedByTool.entries()) {
        if (!toolId || !(collapsedSections instanceof Set) || !collapsedSections.size) continue;
        payload[toolId] = {};
        for (const sectionId of collapsedSections) {
          if (!sectionId) continue;
          payload[toolId][sectionId] = true;
        }
      }
      const maybePromise = settings.set(MODULE_ID, SECTIONS_SETTING_KEY, payload);
      if (maybePromise?.catch) maybePromise.catch(() => {});
    } catch (_) {
      // ignore persistence errors
    }
  }

  _isSectionCollapsed(toolId, sectionId) {
    const id = String(toolId || '');
    const key = String(sectionId || '');
    if (!id || !key) return false;
    const collapsedSections = this._sectionCollapsedByTool.get(id);
    return collapsedSections instanceof Set ? collapsedSections.has(key) : false;
  }

  toggleSectionCollapse(toolId, sectionId) {
    const id = String(toolId || '');
    const key = String(sectionId || '');
    if (!id || !key) return false;

    let collapsedSections = this._sectionCollapsedByTool.get(id);
    let collapsed = false;
    if (!(collapsedSections instanceof Set)) {
      collapsedSections = new Set();
      this._sectionCollapsedByTool.set(id, collapsedSections);
    }

    if (collapsedSections.has(key)) {
      collapsedSections.delete(key);
      if (!collapsedSections.size) this._sectionCollapsedByTool.delete(id);
      collapsed = false;
    } else {
      collapsedSections.add(key);
      collapsed = true;
    }

    this._persistSectionState();
    return collapsed;
  }

  _collectAvailableSectionIds(state = {}) {
    const sections = new Set();
    const customToggles = Array.isArray(state?.customToggles) ? state.customToggles : [];
    const hasCustomToggleGroup = (group) => customToggles.some((toggle) => String(toggle?.group || '') === group);
    const nonPlacementCustomToggles = customToggles.filter((toggle) => {
      const group = String(toggle?.group || '');
      return !['subtool', 'subtool-option', 'height-map'].includes(group);
    });

    if ((Array.isArray(state?.subtoolToggles) && state.subtoolToggles.length) || hasCustomToggleGroup('subtool') || hasCustomToggleGroup('subtool-option')) {
      sections.add('mode');
    }
    if (Array.isArray(state?.editorActions) && state.editorActions.length) {
      sections.add('session');
    }
    if (state?.pathFeather?.available || state?.opacityFeather?.available || state?.pathAppearance?.freehandSimplify?.available) {
      sections.add('brush-geometry');
    }
    if (state?.dropShadow?.available || state?.dropShadowControls?.available || state?.pathAppearance?.available || state?.scale?.available || state?.rotation?.available || state?.flip?.available || state?.pathShadow?.available) {
      sections.add('appearance');
    }
    if ((Array.isArray(state?.placementToggles) && state.placementToggles.length) || hasCustomToggleGroup('placement') || nonPlacementCustomToggles.length || state?.shapeStacking?.available) {
      sections.add('placement');
    }

    return sections;
  }

  getToolSectionLayout(toolId = null) {
    const id = String(toolId || this._getActiveToolId() || '');
    if (!id) return [];
    const normalized = this._getToolNormalized(id);
    if (!normalized) return [];
    if (normalized.rendererMode === TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE) {
      return (Array.isArray(normalized.sections) ? normalized.sections : [])
        .map((section) => {
          const sectionId = String(section?.id || '');
          if (!sectionId) return null;
          const region = typeof section?.region === 'string' && section.region.trim().length
            ? section.region.trim()
            : 'body';
          const collapsible = region === 'body' && section?.collapsible !== false;
          return {
            id: sectionId,
            label: typeof section?.label === 'string' && section.label.trim().length
              ? section.label.trim()
              : getToolSectionLabel(sectionId),
            collapsed: collapsible ? this._isSectionCollapsed(id, sectionId) : false,
            region,
            collapsible
          };
        })
        .filter((section) => !!section);
    }

    const state = this._getToolState(id);
    const availableIds = this._collectAvailableSectionIds(state);
    const seedSections = Array.isArray(normalized?.sections) && normalized.sections.length
      ? normalized.sections
      : inferToolOptionSectionsFromState(state);
    const seededIds = new Set();
    const sectionMap = new Map();

    for (const rawSection of seedSections) {
      const sectionId = String(rawSection?.id || '');
      if (!sectionId) continue;
      seededIds.add(sectionId);
      sectionMap.set(sectionId, {
        id: sectionId,
        label: typeof rawSection?.label === 'string' && rawSection.label.trim().length
          ? rawSection.label.trim()
          : getToolSectionLabel(sectionId)
      });
    }

    for (const sectionId of availableIds) {
      if (sectionMap.has(sectionId)) continue;
      sectionMap.set(sectionId, { id: sectionId, label: getToolSectionLabel(sectionId) });
    }

    const layout = [];
    for (const entry of DEFAULT_TOOL_OPTION_SECTION_ORDER) {
      const sectionId = String(entry?.id || '');
      if (!sectionId || !sectionMap.has(sectionId)) continue;
      if (!availableIds.has(sectionId) && !seededIds.has(sectionId)) continue;
      const section = sectionMap.get(sectionId);
      layout.push({
        id: sectionId,
        label: section?.label || getToolSectionLabel(sectionId),
        collapsed: this._isSectionCollapsed(id, sectionId)
      });
    }

    for (const [sectionId, section] of sectionMap.entries()) {
      if (layout.some((entry) => entry.id === sectionId)) continue;
      if (!availableIds.has(sectionId) && !seededIds.has(sectionId)) continue;
      layout.push({
        id: sectionId,
        label: section?.label || getToolSectionLabel(sectionId),
        collapsed: this._isSectionCollapsed(id, sectionId)
      });
    }

    return layout;
  }

  _didSectionLayoutChange(previousNormalized, nextNormalized) {
    const toLayout = (normalized) => (
      Array.isArray(normalized?.sections)
        ? normalized.sections
          .map((section) => ({
            id: String(section?.id || ''),
            region: typeof section?.region === 'string' ? section.region : 'body',
            controls: Array.isArray(section?.controls)
              ? section.controls
                .map((controlId) => String(controlId || ''))
                .filter((controlId) => controlId.length)
              : []
          }))
          .filter((section) => section.id.length)
        : []
    );
    const previousLayout = toLayout(previousNormalized);
    const nextLayout = toLayout(nextNormalized);
    if (!!previousNormalized !== !!nextNormalized) return true;
    if (previousNormalized?.rendererMode !== nextNormalized?.rendererMode) return true;
    if (previousLayout.length !== nextLayout.length) return true;
    for (let i = 0; i < previousLayout.length; i += 1) {
      const previousSection = previousLayout[i];
      const nextSection = nextLayout[i];
      if (previousSection.id !== nextSection.id) return true;
      if (previousSection.region !== nextSection.region) return true;
      if (previousSection.controls.length !== nextSection.controls.length) return true;
      for (let j = 0; j < previousSection.controls.length; j += 1) {
        if (previousSection.controls[j] !== nextSection.controls[j]) return true;
      }
    }
    return false;
  }

  getToolHelpContext(toolId = null) {
    const id = String(toolId || this._getActiveToolId() || '');
    if (!id) return { available: false };
    const normalized = this._getToolNormalized(id);
    const state = this._getToolState(id);
    const descriptor = normalized?.descriptor && typeof normalized.descriptor === 'object'
      ? normalized.descriptor
      : {};
    const helpTopicId = typeof descriptor.helpTopicId === 'string' ? descriptor.helpTopicId : '';
    const topicCopy = TOOL_HELP_COPY[helpTopicId] || {};
    const toolLabel = this._getToolLabel(id);
    const selectionSummary = descriptor.selectionSummary ?? null;
    const hints = (() => {
      const raw = state?.hints;
      if (Array.isArray(raw)) {
        return raw
          .filter((line) => typeof line === 'string' && line.trim().length)
          .map((line) => line.trim());
      }
      if (typeof raw === 'string' && raw.trim().length) return [raw.trim()];
      return [];
    })();
    const shortcuts = Array.isArray(normalized?.shortcuts)
      ? normalized.shortcuts
        .filter((entry) => entry && typeof entry === 'object' && !entry.hidden)
        .map((entry) => ({
          action: typeof entry.action === 'string' ? entry.action : '',
          binding: typeof entry.binding === 'string' ? entry.binding : '',
          label: typeof entry.label === 'string' ? entry.label : '',
          description: typeof entry.description === 'string' ? entry.description : ''
        }))
        .filter((entry) => entry.action || entry.binding || entry.label)
      : [];
    const sections = this.getToolSectionLayout(id)
      .map((section) => ({
        id: typeof section?.id === 'string' ? section.id : '',
        label: typeof section?.label === 'string' ? section.label : ''
      }))
      .filter((section) => section.id && section.label);
    const notes = getToolHelpNotes(helpTopicId, { state, hints });
    const summary = typeof topicCopy.summary === 'string' ? topicCopy.summary : '';
    const available = !!(summary || shortcuts.length || notes.length || sections.length);
    return {
      available,
      toolId: id,
      toolLabel,
      helpTopicId,
      summary,
      selectionSummary,
      dirty: !!descriptor.dirty,
      sections,
      shortcuts,
      notes
    };
  }

  openActiveToolHelp({ focus = true } = {}) {
    const helpContext = this.getToolHelpContext();
    if (!helpContext?.available) return false;
    if (!this._helpWindow) {
      this._helpWindow = new ToolHelpWindow({
        controller: this,
        helpContext
      });
    } else {
      this._helpWindow.setHelpContext(helpContext, { suppressRender: true });
    }
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
    else this._helpWindow.render(false);
    if (focus) {
      try { this._helpWindow.bringToFront?.(); } catch (_) {}
    }
    return true;
  }

  _syncHelpWindow({ suppressRender = false } = {}) {
    if (!this._helpWindow) return;
    if (this._helpWindow.state === ApplicationV2.RENDER_STATES.CLOSING) return;
    const helpContext = this.getToolHelpContext();
    if (!helpContext?.available) {
      if (this._helpWindow.rendered) {
        try { this._helpWindow.close({ animate: false }); } catch (_) {}
      } else {
        this._helpWindow = null;
      }
      return;
    }
    this._helpWindow.setHelpContext(helpContext, { suppressRender });
    if (!this._helpWindow.rendered) this._helpWindow.render(true);
  }

  supportsGridSnap() {
    this._ensureSettingsListener();
    const available = this._canAccessSettings();
    const availabilityChanged = this._settingsAvailable !== available;
    if (availabilityChanged) {
      this._settingsAvailable = available;
      if (!available) {
        if (this._window) this._window.setGridSnapAvailable(false);
      }
    }
    if (available && (availabilityChanged || this._needsGridSnapResync)) {
      const stored = this._readGridSnapSetting();
      this._updateGridSnapState(stored, { syncWindow: true });
    }
    if (available && (availabilityChanged || this._needsGridSnapSubdivResync)) {
      const storedSubdiv = this._readGridSnapSubdivisionSetting();
      this._updateGridSnapSubdivisionsState(storedSubdiv, { syncWindow: true });
    }
    if (this._window) this._window.setGridSnapAvailable(available);
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

  async requestGridSnapSubdivisionChange(value) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    const canPersist = this.supportsGridSnap();
    const previous = this._gridSnapSubdivisions;
    if (next === previous) {
      if (!canPersist) return true;
      try {
        await game.settings.set(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY, next);
        return true;
      } catch (error) {
        Logger.warn('ToolOptionsController.gridSnapSubdiv.saveFailed', error);
        try {
          ui?.notifications?.warn?.('Failed to update snap density. Please try again.');
        } catch (_) {}
        return false;
      }
    }
    this._updateGridSnapSubdivisionsState(next, { syncWindow: true });
    if (!canPersist) return true;
    try {
      await game.settings.set(MODULE_ID, GRID_SNAP_SUBDIV_SETTING_KEY, next);
      return true;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.saveFailed', error);
      this._updateGridSnapSubdivisionsState(previous, { syncWindow: true });
      try {
        ui?.notifications?.warn?.('Failed to update snap density. Please try again.');
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
    if (setting.key === GRID_SNAP_SUBDIV_SETTING_KEY) {
      this._updateGridSnapSubdivisionsState(setting.value, { syncWindow: true });
      return;
    }
    if (setting.key === SECTIONS_SETTING_KEY) {
      this.applySectionSetting(setting.value);
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

  _normalizeGridSnapSubdivisionValue(value) {
    return normalizeGridSnapSubdivision(value);
  }

  _updateGridSnapSubdivisionsState(value, { syncWindow = false } = {}) {
    const next = this._normalizeGridSnapSubdivisionValue(value);
    if (this._gridSnapSubdivisions === next) {
      if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
      return;
    }
    this._gridSnapSubdivisions = next;
    if (syncWindow && this._window) this._window.setGridSnapSubdivisions(next);
    try {
      const hooks = globalThis?.Hooks;
      hooks?.callAll?.('fa-nexus:gridSnapSubdivisionsChanged', { value: next });
    } catch (_) {}
  }

  _readGridSnapSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapResync = true;
      return true;
    }
    try {
      const value = !!game.settings.get(MODULE_ID, GRID_SNAP_SETTING_KEY);
      this._needsGridSnapResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnap.readFailed', error);
      this._needsGridSnapResync = true;
      return true;
    }
  }

  _readGridSnapSubdivisionSetting() {
    if (!this._canAccessSettings()) {
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
    }
    try {
      const value = readGridSnapSubdivisionSetting();
      this._needsGridSnapSubdivResync = false;
      return value;
    } catch (error) {
      Logger.warn('ToolOptionsController.gridSnapSubdiv.readFailed', error);
      this._needsGridSnapSubdivResync = true;
      return GRID_SNAP_SUBDIV_DEFAULT;
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
    if (this._helpWindow?.rendered) {
      try { this._helpWindow.close({ animate: false }); } catch (_) {}
    } else {
      this._helpWindow = null;
    }
    this._notifyStateListeners();
  }

  _handleHelpWindowClosing(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
  }

  _handleHelpWindowClosed(instance) {
    if (this._helpWindow === instance) this._helpWindow = null;
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
