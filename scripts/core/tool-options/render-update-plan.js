export const TOOL_OPTIONS_FORCE_RENDER_AVAILABILITY_PATHS = [
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

export const TOOL_OPTIONS_IN_PLACE_SYNC_METHODS = [
  '_syncGridSnapControl',
  '_syncDropShadowControl',
  '_syncDropShadowControls',
  '_syncDeclarativeSegmentedControls',
  '_syncEditorActions',
  '_syncDeclarativeToggleControls',
  '_syncDeclarativeRangeControls',
  '_syncDeclarativeRangePairControls',
  '_syncDeclarativeAxisPairControls',
  '_syncDeclarativeScalarRandomizedControls',
  '_syncDeclarativeStackOrderControls',
  '_syncPathAppearanceControls',
  '_syncCustomToggles',
  '_syncPlacementControls',
  '_syncFlipControls',
  '_syncScaleControls',
  '_syncRotationControls',
  '_syncPathShadowControls',
  '_syncPathFeatherControls',
  '_syncOpacityFeatherControls',
  '_syncShortcutsControls',
  '_syncPlaceAsControls',
  '_syncPortalControls',
  '_syncDynamicSections'
];

function valueAtPath(state, path) {
  let cursor = state;
  for (const segment of path) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = cursor[segment];
  }
  return typeof cursor === 'boolean' ? cursor : !!cursor;
}

export function buildToolOptionsPortalLayoutSignature(portalState, variant = '', { preparePortalControl } = {}) {
  if (typeof preparePortalControl !== 'function') return '';
  const prepared = preparePortalControl({
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
}

export function shouldForceToolOptionsRenderForStateChange(previousState = {}, nextState = {}, options = {}) {
  const prevRevision = previousState?.layoutRevision ?? null;
  const nextRevision = nextState?.layoutRevision ?? null;
  if (prevRevision !== nextRevision) return true;

  const gainedLayoutControl = TOOL_OPTIONS_FORCE_RENDER_AVAILABILITY_PATHS.some((path) => {
    const previous = valueAtPath(previousState, path);
    const next = valueAtPath(nextState, path);
    return !previous && !!next;
  });
  if (gainedLayoutControl) return true;

  return (
    buildToolOptionsPortalLayoutSignature(previousState?.doorControls, 'door', options)
    !== buildToolOptionsPortalLayoutSignature(nextState?.doorControls, 'door', options)
  ) || (
    buildToolOptionsPortalLayoutSignature(previousState?.windowControls, 'window', options)
    !== buildToolOptionsPortalLayoutSignature(nextState?.windowControls, 'window', options)
  );
}

export function syncToolOptionsWindowInPlace(windowLike) {
  for (const methodName of TOOL_OPTIONS_IN_PLACE_SYNC_METHODS) {
    const method = windowLike?.[methodName];
    if (typeof method !== 'function') {
      throw new Error(`Tool options sync method unavailable: ${methodName}`);
    }
    method.call(windowLike);
  }
}
