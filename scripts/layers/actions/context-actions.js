import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { TileFlattenManager } from '../../flatten/flatten-manager.js';
import { getFaNexusTileCapabilities } from '../../canvas/tile-capabilities.js';
import { getFaNexusTileEditMode, openFaNexusTileEditor } from '../../canvas/tile-hud-edit.js';
import { resolveTileDocumentById } from '../../canvas/tile-targets.js';

function orderDocs(docs = [], orderDocsByIds = null) {
  const ids = Array.isArray(docs) ? docs.map((doc) => doc?.id).filter(Boolean) : [];
  if (typeof orderDocsByIds === 'function') return orderDocsByIds(ids);
  return Array.isArray(docs) ? docs.filter(Boolean) : [];
}

export function getContextMenuTileDocs({
  tileId,
  viewState = null,
  selectedDocs = [],
  resolveTileDocument = null
} = {}) {
  const id = String(tileId || '').trim();
  if (!id) return [];
  const clickedDoc = resolveTileDocumentById(id, {
    viewState,
    resolveTileDocumentById: resolveTileDocument
  });
  if (!clickedDoc) return [];
  const selectedList = Array.isArray(selectedDocs) ? selectedDocs.filter(Boolean) : [];
  const selectedIds = new Set(selectedList.map((doc) => doc?.id).filter(Boolean));
  if (selectedIds.has(id) && selectedList.length > 1) return selectedList;
  return [clickedDoc];
}

export function getGroupContextMenuDocs({
  elevationKey,
  getMatchingElevationDocs = null,
  orderDocsByIds = null
} = {}) {
  const key = String(elevationKey || '').trim();
  if (!key || typeof getMatchingElevationDocs !== 'function') return [];
  const ids = getMatchingElevationDocs(key).map((doc) => doc?.id).filter(Boolean);
  if (typeof orderDocsByIds !== 'function') return getMatchingElevationDocs(key).filter(Boolean);
  return orderDocsByIds(ids);
}

export async function flattenContextMenuDocs({
  docs = [],
  orderDocsByIds = null,
  flattenManager = null,
  selectTileDocs = null,
  updateFlattenFooter = null
} = {}) {
  const orderedDocs = orderDocs(docs, orderDocsByIds);
  if (!orderedDocs.length) return;
  if (flattenManager?.isBusy?.()) {
    throw new Error('Another flattening or deconstruction operation is already in progress.');
  }
  try { selectTileDocs?.(orderedDocs); } catch (_) {}
  Logger.info('LayerManager.contextMenu.flatten.begin', {
    sceneId: canvas?.scene?.id || null,
    tileCount: orderedDocs.length
  });
  await flattenManager?.showFlattenDialog?.();
  try { updateFlattenFooter?.(); } catch (_) {}
}

export async function deconstructContextMenuDoc({
  doc = null,
  flattenManager = null,
  updateFlattenFooter = null
} = {}) {
  if (!doc) return;
  if (flattenManager?.isBusy?.()) {
    throw new Error('Another flattening or deconstruction operation is already in progress.');
  }
  Logger.info('LayerManager.contextMenu.deconstruct.begin', {
    sceneId: canvas?.scene?.id || null,
    tileId: doc?.id || null
  });
  try {
    await flattenManager?.confirmAndDeconstructTile?.(doc);
  } finally {
    try { updateFlattenFooter?.(); } catch (_) {}
  }
}

export function buildFlattenContextMenuItem({
  docs = [],
  orderDocsByIds = null,
  flattenManager = null,
  onFlatten = null,
  onDeconstruct = null
} = {}) {
  const orderedDocs = orderDocs(docs, orderDocsByIds);
  const busy = !!flattenManager?.isBusy?.();
  const singleDoc = orderedDocs.length === 1 ? orderedDocs[0] : null;
  const singleFlattened = !!singleDoc && !!getFaNexusTileCapabilities(singleDoc)?.hasFlattened;

  if (singleFlattened) {
    return {
      label: 'Deconstruct',
      iconClass: 'fa-solid fa-object-ungroup',
      disabled: busy || !canvas?.ready,
      action: () => onDeconstruct?.(singleDoc),
      errorMessage: 'Failed to deconstruct the targeted layer.'
    };
  }

  return {
    label: 'Flatten',
    iconClass: 'fa-solid fa-compress-arrows-alt',
    disabled: !TileFlattenManager.canFlattenSelection(orderedDocs) || busy,
    action: () => onFlatten?.(orderedDocs),
    errorMessage: 'Failed to flatten the targeted layers.'
  };
}

export async function openContextMenuNexusTileEditor(doc) {
  if (!doc) throw new Error('Tile document not available.');
  Logger.info('LayerManager.contextMenu.nexusEdit.begin', {
    sceneId: canvas?.scene?.id || null,
    tileId: doc?.id || null,
    mode: getFaNexusTileEditMode(doc)
  });
  await openFaNexusTileEditor(doc, { source: 'layer-manager-context-menu' });
}
