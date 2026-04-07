import { normalizeShortcutList } from './editor-shortcuts.js';

export const TOOL_OPTIONS_RENDERER_MODE = Object.freeze({
  LEGACY: 'legacy',
  DECLARATIVE: 'declarative'
});

export const DEFAULT_TOOL_OPTION_SECTION_ORDER = Object.freeze([
  { id: 'mode', label: 'Mode', keys: ['texturePaint', 'subtoolToggles', 'subtoolOptions'] },
  { id: 'session', label: 'Session', keys: ['editorActions', 'heightMap'] },
  { id: 'brush-geometry', label: 'Brush / Geometry', keys: ['textureBrush', 'assetScatter', 'pathAppearance', 'pathFeather', 'opacityFeather', 'heightBrush'] },
  { id: 'appearance', label: 'Appearance', keys: ['dropShadow', 'dropShadowControls', 'fillTexture', 'pathShadow', 'layerOpacity', 'rotation', 'scale', 'flip', 'textureOffset'] },
  { id: 'placement', label: 'Placement', keys: ['fillElevation', 'placementToggles', 'customToggles', 'placeAs', 'shapeStacking'] },
  { id: 'portals-selection', label: 'Portals / Selection', keys: ['doorControls', 'windowControls'] }
]);

function pickTruthyObject(source) {
  return source && typeof source === 'object' ? source : {};
}

function cloneSection(section = {}) {
  return {
    id: typeof section.id === 'string' ? section.id : '',
    label: typeof section.label === 'string' ? section.label : '',
    collapsed: !!section.collapsed,
    collapsible: section.collapsible !== false,
    showHeading: section.showHeading !== false,
    region: typeof section.region === 'string' && section.region.trim().length
      ? section.region.trim()
      : 'body',
    controls: Array.isArray(section.controls)
      ? section.controls
        .map((controlId) => String(controlId || ''))
        .filter((controlId) => controlId.length)
      : []
  };
}

function cloneControl(control = {}) {
  if (!control || typeof control !== 'object') return null;
  const id = typeof control.id === 'string' ? control.id : '';
  if (!id) return null;
  return {
    ...control,
    id,
    type: typeof control.type === 'string' && control.type.trim().length
      ? control.type.trim()
      : 'custom'
  };
}

function cloneControlsMap(controls = {}) {
  const next = {};
  if (!controls || typeof controls !== 'object') return next;
  for (const [rawId, rawControl] of Object.entries(controls)) {
    const fallbackId = typeof rawId === 'string' ? rawId : '';
    const control = cloneControl({
      ...(rawControl && typeof rawControl === 'object' ? rawControl : {}),
      id: rawControl?.id ?? fallbackId
    });
    if (!control?.id) continue;
    next[control.id] = control;
  }
  return next;
}

export function inferToolOptionSectionsFromState(legacyState = {}) {
  const sections = [];
  for (const entry of DEFAULT_TOOL_OPTION_SECTION_ORDER) {
    const hasContent = entry.keys.some((key) => {
      const value = legacyState?.[key];
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === 'object') return value.available !== false && Object.keys(value).length > 0;
      return !!value;
    });
    if (hasContent) sections.push({ id: entry.id, label: entry.label, collapsed: false });
  }
  return sections;
}

export function createNormalizedToolOptionsDescriptor({
  descriptor = {},
  legacyState = {},
  controls = null,
  handlers = {},
  sections = null,
  shortcuts = [],
  sessionState = {},
  renderState = {},
  persistedState = {},
  rendererMode = null
} = {}) {
  const safeLegacyState = pickTruthyObject(legacyState);
  const safeControls = cloneControlsMap(controls);
  const hasDeclarativeControls = Object.keys(safeControls).length > 0;
  const resolvedRendererMode = rendererMode === TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE
    ? TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE
    : (rendererMode === TOOL_OPTIONS_RENDERER_MODE.LEGACY
      ? TOOL_OPTIONS_RENDERER_MODE.LEGACY
      : (hasDeclarativeControls
        ? TOOL_OPTIONS_RENDERER_MODE.DECLARATIVE
        : TOOL_OPTIONS_RENDERER_MODE.LEGACY));
  return {
    rendererMode: resolvedRendererMode,
    descriptor: {
      toolId: typeof descriptor.toolId === 'string' ? descriptor.toolId : '',
      toolLabel: typeof descriptor.toolLabel === 'string' ? descriptor.toolLabel : '',
      activeMode: descriptor.activeMode ?? null,
      activeSubtool: descriptor.activeSubtool ?? null,
      polarity: pickTruthyObject(descriptor.polarity),
      dirty: !!descriptor.dirty,
      selectionSummary: descriptor.selectionSummary ?? null,
      helpTopicId: typeof descriptor.helpTopicId === 'string' ? descriptor.helpTopicId : ''
    },
    sections: Array.isArray(sections) && sections.length
      ? sections.map(cloneSection).filter((section) => section.id)
      : inferToolOptionSectionsFromState(safeLegacyState),
    controls: safeControls,
    legacyState: safeLegacyState,
    shortcuts: normalizeShortcutList(shortcuts),
    sessionState: pickTruthyObject(sessionState),
    renderState: pickTruthyObject(renderState),
    persistedState: pickTruthyObject(persistedState),
    handlers: pickTruthyObject(handlers)
  };
}

export function isNormalizedToolOptionsDescriptor(payload) {
  return !!payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && !!payload.descriptor
    && typeof payload.descriptor === 'object'
    && !!payload.handlers
    && typeof payload.handlers === 'object';
}

export function normalizeToolOptionsPayload(toolId, payload = {}) {
  const suppressRender = payload?.suppressRender !== undefined ? !!payload.suppressRender : true;
  if (!isNormalizedToolOptionsDescriptor(payload)) {
    const state = payload.state && typeof payload.state === 'object'
      ? payload.state
      : (typeof payload === 'object' ? payload : {});
    const handlers = payload.handlers && typeof payload.handlers === 'object' ? payload.handlers : {};
    return {
      state,
      handlers,
      suppressRender,
      normalized: null,
      toolId: String(toolId || '')
    };
  }
  const legacyState = payload.legacyState && typeof payload.legacyState === 'object'
    ? payload.legacyState
    : {};
  return {
    state: legacyState,
    handlers: payload.handlers && typeof payload.handlers === 'object' ? payload.handlers : {},
    suppressRender,
    normalized: payload,
    toolId: String(toolId || payload?.descriptor?.toolId || '')
  };
}
