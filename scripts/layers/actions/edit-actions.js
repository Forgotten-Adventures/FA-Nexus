import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function applyStatePatch(setter, patch) {
  if (typeof setter !== 'function' || !patch || typeof patch !== 'object') return;
  setter(patch);
}

function clearRenameState(setRenameState = null) {
  applyStatePatch(setRenameState, {
    renamingTileId: null,
    renameDraft: '',
    renameFocusPending: false
  });
}

function clearElevationGroupNameEditState(setElevationGroupNameEditState = null) {
  applyStatePatch(setElevationGroupNameEditState, {
    editingElevationGroupNameKey: null,
    editingElevationGroupNameDraft: '',
    editingElevationGroupNameFocusPending: false
  });
}

function clearElevationGroupElevationEditState(setElevationGroupElevationEditState = null) {
  applyStatePatch(setElevationGroupElevationEditState, {
    editingElevationGroupElevationKey: null,
    editingElevationGroupElevationDraft: '',
    editingElevationGroupElevationFocusPending: false
  });
}

export function isEditableLayerManagerElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.closest('.fa-nexus-layer-manager__rename-input')) return true;
  return !!element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

export function shouldHandleRenameHotkey({
  event = null,
  active = false,
  isPopout = false,
  renameSubmitting = false
} = {}) {
  if ((!active && !isPopout) || renameSubmitting) return false;
  const key = String(event?.key || '');
  const code = String(event?.code || '');
  if (key !== 'F2' && code !== 'F2') return false;
  if (event?.altKey || event?.ctrlKey || event?.metaKey || event?.shiftKey) return false;
  if (isEditableLayerManagerElement(event?.target) || isEditableLayerManagerElement(document?.activeElement)) return false;
  return true;
}

export function resolveRenameTargetId({
  root = null,
  lastClickedTileId = ''
} = {}) {
  const list = root?.querySelector?.('.fa-nexus-layer-manager__list');
  if (!list) return null;
  const resolveRowId = (selector) => {
    const row = list.querySelector(selector);
    return row?.dataset?.tileId || null;
  };
  if (lastClickedTileId) {
    const match = resolveRowId(`[data-tile-id="${CSS.escape(lastClickedTileId)}"]`);
    if (match) return match;
  }
  return resolveRowId('[data-tile-id].is-selected');
}

export function beginRename({
  tileId = '',
  resolveRenameDocument = null,
  user = game?.user,
  clearElevationGroupEditState = null,
  root = null,
  computeTileName = null,
  setRenameState = null,
  scheduleRender = null
} = {}) {
  const doc = resolveRenameDocument?.(tileId) || null;
  if (!doc) return false;
  if (!doc?.canUserModify?.(user, 'update')) {
    ui?.notifications?.warn?.('You do not have permission to rename this tile.');
    return false;
  }
  try { clearElevationGroupEditState?.(); } catch (_) {}
  const item = root?.querySelector?.(`[data-tile-id="${CSS.escape(tileId)}"]`);
  const currentLabel = item?.querySelector?.('.fa-nexus-layer-manager__name')?.textContent?.trim()
    || computeTileName?.({ document: doc }, 0)
    || '';
  applyStatePatch(setRenameState, {
    renamingTileId: tileId,
    renameDraft: currentLabel || '',
    renameFocusPending: true
  });
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export function cancelRename({
  renamingTileId = '',
  setRenameState = null,
  scheduleRender = null
} = {}) {
  if (!renamingTileId) return false;
  clearRenameState(setRenameState);
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export async function commitRename({
  inputEl = null,
  renamingTileId = '',
  renameSubmitting = false,
  resolveRenameDocument = null,
  readFlag = null,
  renameDraft = '',
  moduleId = '',
  user = game?.user,
  setRenameState = null,
  setRenameSubmitting = null,
  scheduleRender = null
} = {}) {
  const tileId = String(renamingTileId || '').trim();
  if (!tileId || renameSubmitting) return false;
  const doc = resolveRenameDocument?.(tileId) || null;
  if (!doc) {
    clearRenameState(setRenameState);
    try { scheduleRender?.(); } catch (_) {}
    return false;
  }

  const nextValue = String(inputEl?.value ?? renameDraft ?? '').trim();
  const currentValue = String(doc?._source?.name ?? doc?.name ?? '').trim();
  const legacyValue = String(readFlag?.(doc, 'name') || '').trim();
  applyStatePatch(setRenameState, { renameDraft: nextValue });
  try { setRenameSubmitting?.(true); } catch (_) {}

  try {
    if (!doc?.canUserModify?.(user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to rename this tile.');
      clearRenameState(setRenameState);
      try { scheduleRender?.(); } catch (_) {}
      return false;
    }
    const update = {};
    if (nextValue !== currentValue) update.name = nextValue;
    if (legacyValue) update[`flags.${moduleId}.-=name`] = null;
    if (Object.keys(update).length) {
      if (typeof doc.update !== 'function') throw new Error('Tile document does not support updates.');
      await doc.update(update);
    }
    clearRenameState(setRenameState);
    try { scheduleRender?.(); } catch (_) {}
    return true;
  } finally {
    try { setRenameSubmitting?.(false); } catch (_) {}
  }
}

export function handleRenameInputKeyDown({
  event = null,
  commitRename = null,
  cancelRename = null
} = {}) {
  if (!event) return false;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(commitRename?.(event.currentTarget)).catch((error) => {
      Logger.warn('LayerManager.rename.failed', { error: String(error?.message || error) });
      ui?.notifications?.error?.(`Failed to rename tile: ${error?.message || error}`);
    });
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelRename?.();
    return true;
  }
  return false;
}

export function beginElevationGroupNameEdit({
  elevationKey = '',
  scene = canvas?.scene,
  user = game?.user,
  clearRenameState = null,
  getSceneElevationGroupMetadata = null,
  getElevationGroupName = null,
  clearElevationGroupElevationEditState = null,
  setElevationGroupNameEditState = null,
  scheduleRender = null
} = {}) {
  const key = String(elevationKey || '').trim();
  if (!key) return false;
  if (!scene?.canUserModify?.(user, 'update')) {
    ui?.notifications?.warn?.('You do not have permission to rename elevation groups.');
    return false;
  }
  try { clearRenameState?.(); } catch (_) {}
  const metadata = getSceneElevationGroupMetadata?.(scene) || {};
  try { clearElevationGroupElevationEditState?.(); } catch (_) {}
  applyStatePatch(setElevationGroupNameEditState, {
    editingElevationGroupNameKey: key,
    editingElevationGroupNameDraft: getElevationGroupName?.(metadata, key) || '',
    editingElevationGroupNameFocusPending: true
  });
  Logger.info('LayerManager.elevationGroup.rename.begin', {
    sceneId: scene.id || null,
    elevationKey: key
  });
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export function cancelElevationGroupNameEdit({
  editingElevationGroupNameKey = '',
  setElevationGroupNameEditState = null,
  scheduleRender = null
} = {}) {
  if (!editingElevationGroupNameKey) return false;
  clearElevationGroupNameEditState(setElevationGroupNameEditState);
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export async function commitElevationGroupNameEdit({
  inputEl = null,
  editingElevationGroupNameKey = '',
  editingElevationGroupSubmitting = false,
  scene = canvas?.scene,
  user = game?.user,
  editingElevationGroupNameDraft = '',
  setElevationGroupNameEditState = null,
  setElevationGroupSubmitting = null,
  getSceneElevationGroupMetadata = null,
  getElevationGroupName = null,
  getFullGroupNode = null,
  cloneElevationGroupMetadata = null,
  setSceneElevationGroupMetadata = null,
  scheduleRender = null
} = {}) {
  const elevationKey = String(editingElevationGroupNameKey || '').trim();
  if (!elevationKey || editingElevationGroupSubmitting) return false;
  if (!scene) {
    clearElevationGroupNameEditState(setElevationGroupNameEditState);
    try { scheduleRender?.(); } catch (_) {}
    return false;
  }

  const nextValue = String(inputEl?.value ?? editingElevationGroupNameDraft ?? '').trim();
  const metadata = getSceneElevationGroupMetadata?.(scene) || {};
  const currentValue = getElevationGroupName?.(metadata, elevationKey) || '';
  applyStatePatch(setElevationGroupNameEditState, {
    editingElevationGroupNameDraft: nextValue
  });
  try { setElevationGroupSubmitting?.(true); } catch (_) {}

  try {
    if (!scene?.canUserModify?.(user, 'update')) {
      ui?.notifications?.warn?.('You do not have permission to rename elevation groups.');
      clearElevationGroupNameEditState(setElevationGroupNameEditState);
      try { scheduleRender?.(); } catch (_) {}
      return false;
    }
    if (nextValue === currentValue) {
      clearElevationGroupNameEditState(setElevationGroupNameEditState);
      try { scheduleRender?.(); } catch (_) {}
      return false;
    }
    const fullGroupNode = getFullGroupNode?.(elevationKey) || null;
    const nextMetadata = cloneElevationGroupMetadata?.(metadata) || {};
    if (!nextValue) delete nextMetadata[elevationKey];
    else {
      const nextEntry = {
        ...(nextMetadata[elevationKey] || {}),
        name: nextValue
      };
      if (fullGroupNode?.isSynthetic) nextEntry.synthetic = true;
      else delete nextEntry.synthetic;
      nextMetadata[elevationKey] = nextEntry;
    }
    await setSceneElevationGroupMetadata?.(scene, nextMetadata);
    Logger.info('LayerManager.elevationGroup.rename.commit', {
      sceneId: scene.id || null,
      elevationKey,
      name: nextValue || null
    });
    clearElevationGroupNameEditState(setElevationGroupNameEditState);
    try { scheduleRender?.(); } catch (_) {}
    return true;
  } catch (error) {
    applyStatePatch(setElevationGroupNameEditState, {
      editingElevationGroupNameFocusPending: true
    });
    try { scheduleRender?.(); } catch (_) {}
    throw error;
  } finally {
    try { setElevationGroupSubmitting?.(false); } catch (_) {}
  }
}

export function handleElevationGroupNameInputKeyDown({
  event = null,
  commitElevationGroupNameEdit = null,
  cancelElevationGroupNameEdit = null,
  getEditingElevationGroupNameKey = null
} = {}) {
  if (!event) return false;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(commitElevationGroupNameEdit?.(event.currentTarget)).catch((error) => {
      Logger.error('LayerManager.elevationGroup.rename.failed', {
        elevationKey: getEditingElevationGroupNameKey?.() || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Failed to rename elevation group: ${error?.message || error}`);
    });
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelElevationGroupNameEdit?.();
    return true;
  }
  return false;
}

export function beginElevationGroupElevationEdit({
  elevationKey = '',
  scene = canvas?.scene,
  user = game?.user,
  clearRenameState = null,
  clearElevationGroupNameEditState = null,
  setElevationGroupElevationEditState = null,
  initialElevation = null,
  formatElevation = null,
  scheduleRender = null
} = {}) {
  const key = String(elevationKey || '').trim();
  if (!key) return false;
  if (!scene?.canUserModify?.(user, 'update')) {
    ui?.notifications?.warn?.('You do not have permission to move elevation groups.');
    return false;
  }
  try { clearRenameState?.(); } catch (_) {}
  try { clearElevationGroupNameEditState?.(); } catch (_) {}
  const draftElevation = Number.isFinite(initialElevation) ? Number(initialElevation) : Number(key);
  applyStatePatch(setElevationGroupElevationEditState, {
    editingElevationGroupElevationKey: key,
    editingElevationGroupElevationDraft: formatElevation?.(draftElevation) || '0',
    editingElevationGroupElevationFocusPending: true
  });
  Logger.info('LayerManager.elevationGroup.move.begin', {
    sceneId: scene.id || null,
    elevationKey: key
  });
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export function cancelElevationGroupElevationEdit({
  editingElevationGroupElevationKey = '',
  setElevationGroupElevationEditState = null,
  scheduleRender = null
} = {}) {
  if (!editingElevationGroupElevationKey) return false;
  clearElevationGroupElevationEditState(setElevationGroupElevationEditState);
  try { scheduleRender?.(); } catch (_) {}
  return true;
}

export function handleElevationGroupElevationInputKeyDown({
  event = null,
  commitElevationGroupElevationEdit = null,
  cancelElevationGroupElevationEdit = null,
  getEditingElevationGroupElevationKey = null
} = {}) {
  if (!event) return false;
  if (event.key === 'Enter') {
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(commitElevationGroupElevationEdit?.(event.currentTarget)).catch((error) => {
      Logger.error('LayerManager.elevationGroup.move.failed', {
        elevationKey: getEditingElevationGroupElevationKey?.() || null,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Failed to move elevation group: ${error?.message || error}`);
    });
    return true;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    cancelElevationGroupElevationEdit?.();
    return true;
  }
  return false;
}
