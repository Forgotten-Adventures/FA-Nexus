import { organizeContextMenu } from '../../core/ui/context-menu-sections.js';

function hasDocs(docs = []) {
  return Array.isArray(docs) && docs.length > 0;
}

function areAllDocsLocked(docs = []) {
  return hasDocs(docs) && docs.every((doc) => !!doc?.locked);
}

export function buildGroupContextMenuItems({
  elevationKey = '',
  docs = [],
  canUpdateAll = false,
  filtersApplied = false,
  canRenameGroup = false,
  canAddFolder = false,
  canEditElevationGroup = false,
  canConvertToFolder = false,
  flattenItem = null,
  onRenameGroup = null,
  onChangeElevation = null,
  onConvertToFolder = null,
  onAddFolder = null,
  removeFromGroupItem = null,
  onToggleLock = null
} = {}) {
  const allLocked = areAllDocsLocked(docs);
  return organizeContextMenu([
    {
      label: 'Rename',
      iconClass: 'fa-solid fa-i-cursor',
      disabled: !canRenameGroup,
      action: () => onRenameGroup?.(elevationKey),
      errorMessage: 'Failed to begin elevation group rename.'
    },
    {
      label: 'Change Elevation',
      iconClass: 'fa-solid fa-arrows-up-down',
      disabled: !canEditElevationGroup,
      title: filtersApplied ? 'Clear filters before changing a group elevation.' : '',
      action: () => onChangeElevation?.(elevationKey),
      errorMessage: 'Failed to begin elevation group edit.'
    },
    {
      label: 'Convert to Folder',
      iconClass: 'fa-solid fa-folder-tree',
      disabled: !canConvertToFolder,
      title: filtersApplied ? 'Clear filters before converting an Elevation to a Folder.' : '',
      action: () => onConvertToFolder?.(elevationKey),
      errorMessage: 'Failed to convert Elevation to Folder.'
    },
    {
      label: allLocked ? 'Unlock' : 'Lock',
      iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
      disabled: !canUpdateAll,
      action: () => onToggleLock?.(docs),
      errorMessage: 'Failed to update layer locks.'
    },
    {label:'Add Folder', iconClass:'fa-solid fa-folder-plus', disabled:!canAddFolder || filtersApplied,
      action:()=>onAddFolder?.(elevationKey)},
    removeFromGroupItem,
    flattenItem
  ]);
}

export function buildTileContextMenuItems({
  tileId = '',
  docs = [],
  clickedDoc = null,
  clickedTile = null,
  user = globalThis?.game?.user,
  canUpdateAll = false,
  hasNexusEdit = false,
  nexusEditDisabledReason = '',
  canResetBuildingScale = false,
  canMaskSingle = false,
  clickedHasMask = false,
  hasAnyMask = false,
  menuAnchor = null,
  canCreateSection = false,
  canCreateDepthLayer = false,
  flattenItem = null,
  onRename = null,
  onChangeElevation = null,
  onCreateSection = null,
  onCreateDepthLayer = null,
  onToggleLock = null,
  onOpenNexusTileEditor = null,
  onResetBuildingScale = null,
  onOpenTileMaskEditor = null,
  onClearTileMasks = null,
  onOpenTileSettings = null,
  removeFromGroupItem = null
} = {}) {
  const allLocked = areAllDocsLocked(docs);
  const items = [
    {
      label: 'Rename',
      iconClass: 'fa-solid fa-i-cursor',
      disabled: docs.length !== 1 || !clickedDoc?.canUserModify?.(user, 'update'),
      action: () => onRename?.(tileId),
      errorMessage: 'Failed to begin layer rename.'
    },
    {
      label: 'Change Elevation',
      iconClass: 'fa-solid fa-arrows-up-down',
      disabled: !canUpdateAll,
      action: () => onChangeElevation?.(docs, menuAnchor),
      errorMessage: 'Failed to change layer elevation.'
    },
    {
      label: 'Create Folder',
      iconClass: 'fa-solid fa-folder-plus',
      disabled: !canCreateSection,
      action: () => onCreateSection?.(docs),
      errorMessage: 'Failed to create Folder.'
    },
    {
      label: 'Promote to Elevation',
      iconClass: 'fa-solid fa-layer-group',
      disabled: !canCreateDepthLayer,
      action: () => onCreateDepthLayer?.(docs),
      errorMessage: 'Failed to promote layers to an Elevation.'
    },
    {
      label: allLocked ? 'Unlock' : 'Lock',
      iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
      disabled: !canUpdateAll,
      action: () => onToggleLock?.(docs),
      errorMessage: 'Failed to update layer locks.'
    },
    {
      label: 'Nexus Edit',
      iconClass: 'fa-solid fa-wand-magic-sparkles',
      disabled: !hasNexusEdit,
      ...(!hasNexusEdit && nexusEditDisabledReason ? { title: nexusEditDisabledReason } : {}),
      action: () => onOpenNexusTileEditor?.(clickedDoc),
      errorMessage: 'Failed to open FA Nexus editor.'
    },
    {
      label: clickedHasMask ? 'Edit Mask' : 'Apply Mask',
      iconClass: 'fa-solid fa-mask',
      disabled: !canMaskSingle,
      action: () => onOpenTileMaskEditor?.(clickedDoc),
      errorMessage: 'Failed to open FA Nexus mask editor.'
    },
    {
      label: 'Clear Mask',
      iconClass: 'fa-solid fa-eraser',
      disabled: !hasAnyMask || !canUpdateAll,
      action: () => onClearTileMasks?.(docs),
      errorMessage: 'Failed to clear tile mask.'
    },
    {
      label: 'Configure',
      iconClass: 'fa-solid fa-gear',
      disabled: docs.length !== 1 || !clickedTile,
      action: () => onOpenTileSettings?.(clickedTile),
      errorMessage: 'Failed to open layer configuration.'
    },
    flattenItem,
    canResetBuildingScale ? {
      label: 'Reset Building Scale', iconClass: 'fa-solid fa-arrows-to-circle',
      title: 'Restore this Building to 100% of its authored size, preserving its current position and rotation.',
      action: () => onResetBuildingScale?.(clickedDoc), errorMessage: 'Failed to reset Building scale.'
    } : null
  ];
  return organizeContextMenu([...items.filter(item => item && (!/Mask/.test(item.label) || canMaskSingle || hasAnyMask)), removeFromGroupItem]);
}

export function buildSectionContextMenuItems({
  sectionId = '',
  docs = [],
  canUpdateAll = false,
  canEditSection = false,
  canPromote = false,
  flattenItem = null,
  onRename = null,
  onPromote = null,
  onRemove = null,
  onAddFolder = null,
  onChangeElevation = null,
  removeFromGroupItem = null,
  onToggleLock = null
} = {}) {
  const allLocked = areAllDocsLocked(docs);
  return organizeContextMenu([
    {
      label: 'Rename',
      iconClass: 'fa-solid fa-i-cursor',
      disabled: !canEditSection,
      action: () => onRename?.(sectionId),
      errorMessage: 'Failed to rename Folder.'
    },
    {
      label: 'Promote to Elevation',
      iconClass: 'fa-solid fa-layer-group',
      disabled: !canPromote,
      action: () => onPromote?.(sectionId),
      errorMessage: 'Failed to promote Folder.'
    },
    {
      label: 'Remove Folder',
      iconClass: 'fa-solid fa-folder-minus',
      disabled: !canEditSection,
      action: () => onRemove?.(sectionId),
      errorMessage: 'Failed to remove Folder.'
    },
    {
      label: allLocked ? 'Unlock' : 'Lock',
      iconClass: allLocked ? 'fa-solid fa-lock-open' : 'fa-solid fa-lock',
      disabled: !canUpdateAll,
      action: () => onToggleLock?.(docs),
      errorMessage: 'Failed to update Folder layer locks.'
    },
    {label:'Change Elevation',iconClass:'fa-solid fa-arrows-up-down',disabled:!canUpdateAll,action:()=>onChangeElevation?.(docs)},
    {label:'Add Folder',iconClass:'fa-solid fa-folder-plus',disabled:!canEditSection,action:()=>onAddFolder?.(sectionId)},
    removeFromGroupItem,
    flattenItem
  ]);
}
