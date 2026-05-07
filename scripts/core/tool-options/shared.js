import { DEFAULT_TOOL_OPTION_SECTION_ORDER } from '../tool-options-descriptor.js';

export const MODULE_ID = 'fa-nexus';
export const TOOL_WINDOW_SETTING_KEY = 'toolOptionsWindowPos';
export const GRID_SNAP_SETTING_KEY = 'gridSnap';
export const SHORTCUTS_SETTING_KEY = 'toolOptionsShortcuts';
export const SECTIONS_SETTING_KEY = 'toolOptionsSections';
export const DEFAULT_WINDOW_TITLE = 'Tool Options';
export const TOOL_OPTIONS_ACTIVITY_EVENT = 'fa-nexus:tool-options-activity';

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

export function getToolSectionLabel(sectionId) {
  const id = String(sectionId || '');
  if (!id) return '';
  return TOOL_SECTION_LABELS.get(id) || id;
}
