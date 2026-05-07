import {
  DEFAULT_TOOL_OPTION_SECTION_ORDER,
  inferToolOptionSectionsFromState,
  TOOL_OPTIONS_RENDERER_MODE
} from '../tool-options-descriptor.js';
import { getToolSectionLabel } from './shared.js';

export function buildCollapsedSectionState(raw) {
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
  return next;
}

export function sectionStatesEqual(current, next) {
  if (!(current instanceof Map) || !(next instanceof Map)) return false;
  if (next.size !== current.size) return false;
  for (const [toolId, nextSections] of next.entries()) {
    const currentSections = current.get(toolId);
    if (!(currentSections instanceof Set) || currentSections.size !== nextSections.size) return false;
    for (const sectionId of nextSections) {
      if (!currentSections.has(sectionId)) return false;
    }
  }
  return true;
}

export function serializeCollapsedSectionState(sectionCollapsedByTool) {
  const payload = {};
  if (!(sectionCollapsedByTool instanceof Map)) return payload;
  for (const [toolId, collapsedSections] of sectionCollapsedByTool.entries()) {
    if (!toolId || !(collapsedSections instanceof Set) || !collapsedSections.size) continue;
    payload[toolId] = {};
    for (const sectionId of collapsedSections) {
      if (!sectionId) continue;
      payload[toolId][sectionId] = true;
    }
  }
  return payload;
}

export function isSectionCollapsed(sectionCollapsedByTool, toolId, sectionId) {
  const id = String(toolId || '');
  const key = String(sectionId || '');
  if (!id || !key) return false;
  const collapsedSections = sectionCollapsedByTool instanceof Map
    ? sectionCollapsedByTool.get(id)
    : null;
  return collapsedSections instanceof Set ? collapsedSections.has(key) : false;
}

export function toggleSectionCollapseState(sectionCollapsedByTool, toolId, sectionId) {
  const id = String(toolId || '');
  const key = String(sectionId || '');
  if (!id || !key || !(sectionCollapsedByTool instanceof Map)) return false;

  let collapsedSections = sectionCollapsedByTool.get(id);
  let collapsed = false;
  if (!(collapsedSections instanceof Set)) {
    collapsedSections = new Set();
    sectionCollapsedByTool.set(id, collapsedSections);
  }

  if (collapsedSections.has(key)) {
    collapsedSections.delete(key);
    if (!collapsedSections.size) sectionCollapsedByTool.delete(id);
    collapsed = false;
  } else {
    collapsedSections.add(key);
    collapsed = true;
  }

  return collapsed;
}

function collectAvailableSectionIds(state = {}) {
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

export function getToolSectionLayout({
  toolId = null,
  activeToolId = null,
  getToolNormalized = null,
  getToolState = null,
  isSectionCollapsed: isCollapsed = null
} = {}) {
  const id = String(toolId || activeToolId || '');
  if (!id || typeof getToolNormalized !== 'function') return [];
  const normalized = getToolNormalized(id);
  if (!normalized) return [];
  const sectionIsCollapsed = (sectionId) => (
    typeof isCollapsed === 'function' ? !!isCollapsed(id, sectionId) : false
  );

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
          collapsed: collapsible ? sectionIsCollapsed(sectionId) : false,
          region,
          collapsible
        };
      })
      .filter((section) => !!section);
  }

  const state = typeof getToolState === 'function' ? getToolState(id) : {};
  const availableIds = collectAvailableSectionIds(state);
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
      collapsed: sectionIsCollapsed(sectionId)
    });
  }

  for (const [sectionId, section] of sectionMap.entries()) {
    if (layout.some((entry) => entry.id === sectionId)) continue;
    if (!availableIds.has(sectionId) && !seededIds.has(sectionId)) continue;
    layout.push({
      id: sectionId,
      label: section?.label || getToolSectionLabel(sectionId),
      collapsed: sectionIsCollapsed(sectionId)
    });
  }

  return layout;
}

export function didToolSectionLayoutChange(previousNormalized, nextNormalized) {
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
