import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function orderDocs(docs = [], orderDocsByIds = null) {
  const ids = Array.isArray(docs) ? docs.map((doc) => doc?.id).filter(Boolean) : [];
  if (typeof orderDocsByIds === 'function') return orderDocsByIds(ids);
  return Array.isArray(docs) ? docs.filter(Boolean) : [];
}

function buildResolvedMoveState(resolvedMoves = [], elevationGroupKey = null) {
  const groups = new Map();
  const movedGroupsBySource = new Map();
  const movedDocIds = new Set();

  for (const move of Array.isArray(resolvedMoves) ? resolvedMoves : []) {
    if (!move?.id) continue;
    const targetKey = elevationGroupKey(move.elevation);
    let bucket = groups.get(targetKey);
    if (!bucket) {
      bucket = { elevation: move.elevation, items: [] };
      groups.set(targetKey, bucket);
    }
    bucket.items.push(move);

    const sourceKey = elevationGroupKey(move.currentElevation);
    let moveState = movedGroupsBySource.get(sourceKey);
    if (!moveState) {
      moveState = { ids: new Set(), targetKey };
      movedGroupsBySource.set(sourceKey, moveState);
    }
    moveState.ids.add(move.id);
    movedDocIds.add(move.id);
  }

  return { groups, movedGroupsBySource, movedDocIds };
}

function buildElevationUpdates(groups = new Map(), {
  computeNextSortAtElevation = null,
  elevationGroupKey = null
} = {}) {
  const updates = [];
  for (const bucket of groups.values()) {
    let nextSort = computeNextSortAtElevation(bucket.elevation);
    if (!Number.isFinite(nextSort)) nextSort = 0;
    nextSort += Math.max(0, bucket.items.length - 1) * 2;
    for (const move of bucket.items) {
      const currentSort = Number(move.doc?.sort ?? 0) || 0;
      const currentKey = elevationGroupKey(move.currentElevation);
      if (currentKey !== elevationGroupKey(bucket.elevation) || currentSort !== nextSort) {
        updates.push({
          _id: move.id,
          elevation: bucket.elevation,
          sort: nextSort
        });
      }
      nextSort -= 2;
    }
  }
  return updates;
}

function collectCompleteElevationGroupMoves(movedGroupsBySource = new Map(), {
  getFullElevationDocs = null
} = {}) {
  const completeMoves = [];
  for (const [sourceKey, moveState] of movedGroupsBySource.entries()) {
    const fullDocs = getFullElevationDocs?.(sourceKey) || [];
    const fullIds = fullDocs.map((doc) => doc?.id).filter(Boolean);
    if (!fullIds.length || fullIds.length !== moveState.ids.size) continue;
    if (!fullIds.every((id) => moveState.ids.has(id))) continue;
    if (moveState.targetKey === sourceKey) continue;
    completeMoves.push({ sourceKey, targetKey: moveState.targetKey });
  }
  return completeMoves;
}

function isPrefixedBandElevationGroupKey(value, parseElevationInput = null) {
  const key = String(value || '').trim();
  const match = /^(foreground|ground):([^:]+):(.+)$/.exec(key);
  if (!match) return false;
  return Number.isFinite(parseElevationInput?.(match[3]));
}

function buildTargetElevationGroupKey({
  sourceKey = '',
  targetElevation,
  parseElevationInput = null,
  elevationGroupKey = null
} = {}) {
  const targetElevationKey = elevationGroupKey?.(targetElevation);
  if (!targetElevationKey) return '';
  const key = String(sourceKey || '').trim();
  if (!isPrefixedBandElevationGroupKey(key, parseElevationInput)) return targetElevationKey;
  const match = /^(foreground|ground):([^:]+):(.+)$/.exec(key);
  return `${match[1]}:${match[2]}:${targetElevationKey}`;
}

export async function promptDocsElevationChange({
  docs = [],
  anchor = null,
  orderDocsByIds = null,
  user = game?.user,
  formatElevation = null,
  parseElevationInput = null,
  positionApplicationNearCursor = null,
  applyDocsElevationChange = null
} = {}) {
  const orderedDocs = orderDocs(docs, orderDocsByIds);
  if (!orderedDocs.length) return;
  const blockedDocs = orderedDocs.filter((doc) => !doc?.canUserModify?.(user, 'update'));
  if (blockedDocs.length) {
    throw new Error('You do not have permission to move every targeted layer.');
  }
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2?.wait) {
    throw new Error('DialogV2.wait is unavailable for layer elevation changes.');
  }
  const uniqueElevations = Array.from(new Set(orderedDocs.map((doc) => formatElevation(Number(doc?.elevation ?? 0)))));
  const initialValue = uniqueElevations.length === 1 ? uniqueElevations[0] : '';
  const inputId = `fa-nexus-layer-manager-elevation-${Date.now()}`;
  const tileCount = orderedDocs.length;
  const result = await DialogV2.wait({
    window: {
      title: tileCount === 1 ? 'Change Layer Elevation' : 'Change Layer Elevation'
    },
    position: {
      width: 320,
      height: 'auto'
    },
    modal: true,
    content: `
      <form class="standard-form">
        <p>Move ${tileCount} layer${tileCount === 1 ? '' : 's'} to an exact elevation.</p>
        <div class="form-group">
          <label for="${inputId}">Elevation</label>
          <div class="form-fields">
            <input id="${inputId}" name="elevation" type="number" step="0.001" value="${initialValue}">
          </div>
        </div>
      </form>
    `,
    buttons: [
      {
        action: 'apply',
        label: 'Apply',
        icon: 'fas fa-arrows-up-down',
        default: true,
        callback: (_event, _button, dialog) => {
          const input = dialog?.element?.querySelector?.(`#${CSS.escape(inputId)}`);
          return String(input?.value ?? '').trim();
        }
      },
      {
        action: 'cancel',
        label: 'Cancel'
      }
    ],
    close: () => null,
    render: (_event, dialog) => {
      const input = dialog?.element?.querySelector?.(`#${CSS.escape(inputId)}`);
      requestAnimationFrame(() => {
        try { positionApplicationNearCursor?.(dialog, anchor); } catch (_) {}
        try {
          input?.focus?.();
          input?.select?.();
        } catch (_) {}
      });
    }
  });
  if (result === null || result === undefined) return;
  const targetElevation = parseElevationInput(result);
  if (!Number.isFinite(targetElevation)) {
    throw new Error('Elevation value must be a valid number.');
  }
  await applyDocsElevationChange?.(orderedDocs, targetElevation);
}

export function resolveTileElevationMove({
  doc = null,
  requestedElevation,
  quantizeElevation = null
} = {}) {
  const id = String(doc?.id || '').trim();
  if (!id) return null;
  const currentElevation = quantizeElevation(Number(doc?.elevation ?? 0) || 0);
  const targetElevation = quantizeElevation(requestedElevation);
  return {
    id,
    doc,
    currentElevation,
    requestedElevation: targetElevation,
    elevation: targetElevation,
    changed: targetElevation !== currentElevation
  };
}

export async function restoreSelectionAfterElevationMove({
  docIds = [],
  source = 'unknown',
  scene = canvas?.scene,
  waitForUiFrame = null,
  selectTileDocs = null
} = {}) {
  const ids = Array.from(new Set((Array.isArray(docIds) ? docIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)));
  if (!ids.length) return [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const docs = ids
      .map((id) => scene?.tiles?.get?.(id) || null)
      .filter(Boolean);
    if (docs.length) {
      const selectedDocs = selectTileDocs?.(docs) || [];
      if (selectedDocs.length) return selectedDocs;
    }
    await waitForUiFrame?.(80);
  }
  Logger.warn('LayerManager.elevation.selectionRestoreIncomplete', {
    sceneId: scene?.id || null,
    source,
    tileIds: ids
  });
  return [];
}

export async function applyDocsElevationChange({
  docs = [],
  targetElevation,
  orderDocsByIds = null,
  user = game?.user,
  scene = canvas?.scene,
  quantizeElevation = null,
  elevationGroupKey = null,
  computeNextSortAtElevation = null,
  getSceneElevationGroupMetadata = null,
  mergeElevationGroupMetadataOnBulkMove = null,
  setSceneElevationGroupMetadata = null,
  getFullElevationDocs = null,
  resolveTileElevationMove = null,
  restoreSelectionAfterElevationMove = null
} = {}) {
  const orderedDocs = orderDocs(docs, orderDocsByIds);
  if (!orderedDocs.length || !scene?.updateEmbeddedDocuments) return;
  const blockedDocs = orderedDocs.filter((doc) => !doc?.canUserModify?.(user, 'update'));
  if (blockedDocs.length) {
    throw new Error('You do not have permission to move every targeted layer.');
  }
  if (!scene) throw new Error('No active scene available for layer elevation change.');

  const nextElevation = quantizeElevation(targetElevation);
  const resolvedMoves = orderedDocs
    .map((doc) => resolveTileElevationMove({ doc, requestedElevation: nextElevation, quantizeElevation }))
    .filter((move) => !!move?.changed);
  if (!resolvedMoves.length) {
    Logger.info('LayerManager.contextMenu.elevation.noop', {
      sceneId: scene.id || null,
      targetKey: elevationGroupKey(nextElevation),
      tileCount: orderedDocs.length
    });
    return;
  }

  const { groups, movedGroupsBySource, movedDocIds } = buildResolvedMoveState(resolvedMoves, elevationGroupKey);
  const updates = buildElevationUpdates(groups, {
    computeNextSortAtElevation,
    elevationGroupKey
  });
  if (!updates.length) {
    Logger.info('LayerManager.contextMenu.elevation.noop', {
      sceneId: scene.id || null,
      targetKey: elevationGroupKey(nextElevation),
      tileCount: orderedDocs.length
    });
    return;
  }

  await scene.updateEmbeddedDocuments('Tile', updates);

  const completeMoves = collectCompleteElevationGroupMoves(movedGroupsBySource, {
    getFullElevationDocs
  });
  if (completeMoves.length) {
    const metadata = getSceneElevationGroupMetadata(scene);
    await setSceneElevationGroupMetadata(scene, mergeElevationGroupMetadataOnBulkMove({
      metadata,
      moves: completeMoves
    }));
  }
  await restoreSelectionAfterElevationMove?.(Array.from(movedDocIds), { source: 'context-menu' });

  Logger.info('LayerManager.contextMenu.elevation.commit', {
    sceneId: scene.id || null,
    targetKeys: Array.from(groups.keys()),
    tileCount: updates.length,
    metadataMoves: completeMoves.length
  });
}

export function resolveElevationStep({
  shiftKey = false,
  ctrlKey = false,
  metaKey = false,
  defaultStep = 0.01,
  fineStep = 0.001,
  coarseStep = 0.1
} = {}) {
  if (shiftKey) return coarseStep;
  if (ctrlKey || metaKey) return fineStep;
  return defaultStep;
}

export function getElevationShortcutDirection(event = null) {
  const code = String(event?.code || '');
  if (code === 'BracketRight' || code === 'ArrowUp') return 1;
  if (code === 'BracketLeft' || code === 'ArrowDown') return -1;
  return 0;
}

export function getElevationAnnouncePoint({
  pointer = null,
  controlledTiles = canvas?.tiles?.controlled,
  selectedDocs = [],
  dimensions = canvas?.dimensions,
  scene = canvas?.scene
} = {}) {
  const coerce = (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    return { x: Number(point.x), y: Number(point.y) };
  };
  const direct = coerce(pointer?.world || pointer);
  if (direct) return direct;

  const selectedTile = Array.isArray(controlledTiles)
    ? controlledTiles.find((tile) => !!tile && !tile.destroyed) || null
    : null;
  const selectedCenter = coerce(selectedTile?.center);
  if (selectedCenter) return selectedCenter;

  const doc = selectedTile?.document || (Array.isArray(selectedDocs) ? selectedDocs[0] : null) || null;
  const docX = Number(doc?.x);
  const docY = Number(doc?.y);
  const docW = Number(doc?.width);
  const docH = Number(doc?.height);
  if (Number.isFinite(docX) && Number.isFinite(docY) && Number.isFinite(docW) && Number.isFinite(docH)) {
    return { x: docX + (docW / 2), y: docY + (docH / 2) };
  }

  const sceneX = Number((dimensions?.sceneX ?? dimensions?.x ?? 0) || 0) || 0;
  const sceneY = Number((dimensions?.sceneY ?? dimensions?.y ?? 0) || 0) || 0;
  const sceneWidth = Number((dimensions?.sceneWidth ?? dimensions?.width ?? scene?.width) || 0) || 0;
  const sceneHeight = Number((dimensions?.sceneHeight ?? dimensions?.height ?? scene?.height) || 0) || 0;
  if (sceneWidth > 0 && sceneHeight > 0) {
    return { x: sceneX + (sceneWidth / 2), y: sceneY + (sceneHeight / 2) };
  }
  return null;
}

export function adjustElevationSelection({
  direction,
  event = null,
  pointer = null,
  source = 'unknown',
  user = game?.user,
  selectedSceneMarkers = null,
  adjustSceneMarkerElevation = null,
  controlledTiles = canvas?.tiles?.controlled,
  orderDocsByIds = null,
  resolveTileElevationMove = null,
  elevationGroupKey = null,
  computeNextSortAtElevation = null,
  getFullElevationDocs = null,
  getSceneElevationGroupMetadata = null,
  mergeElevationGroupMetadataOnBulkMove = null,
  setSceneElevationGroupMetadata = null,
  restoreSelectionAfterElevationMove = null,
  queueElevationAnnounce = null,
  getElevationAnnouncePoint = null,
  resolveElevationStep = null
} = {}) {
  if (!Number.isFinite(direction) || direction === 0) return false;
  const step = resolveElevationStep(event || {});
  if (!canvas?.ready || !canvas?.scene) return false;

  let markerAdjusted = false;
  if (selectedSceneMarkers?.size) {
    for (const markerKind of selectedSceneMarkers) {
      if (adjustSceneMarkerElevation?.(markerKind, direction, step, pointer)) {
        markerAdjusted = true;
      }
    }
  }

  if (!canvas?.tiles && !markerAdjusted) return false;
  if (!canvas?.tiles) {
    if (markerAdjusted && event) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
    }
    return markerAdjusted;
  }

  const selection = Array.isArray(controlledTiles) ? controlledTiles : [];
  if (!selection.length && !markerAdjusted) return false;
  const orderedDocs = orderDocs(
    selection.map((tile) => tile?.document || tile).filter(Boolean),
    orderDocsByIds
  );
  const scene = canvas?.scene;
  const elevationDelta = direction * step;
  let announceElevation = null;
  const resolvedMoves = [];

  for (const doc of orderedDocs) {
    if (!doc?.canUserModify?.(user, 'update')) continue;
    if (doc?.locked) continue;
    const current = Number(doc?.elevation ?? 0) || 0;
    const move = resolveTileElevationMove({
      doc,
      requestedElevation: current + elevationDelta
    });
    if (!move?.changed) continue;
    if (announceElevation === null) announceElevation = move.elevation;
    resolvedMoves.push(move);
  }

  if (!resolvedMoves.length && !markerAdjusted) return false;
  if (!resolvedMoves.length && markerAdjusted && event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    return true;
  }

  const { groups, movedGroupsBySource, movedDocIds } = buildResolvedMoveState(resolvedMoves, elevationGroupKey);
  const updates = buildElevationUpdates(groups, {
    computeNextSortAtElevation,
    elevationGroupKey
  });
  const completeElevationGroupMoves = collectCompleteElevationGroupMoves(movedGroupsBySource, {
    getFullElevationDocs
  });

  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();

  if (updates.length) {
    try {
      const updatePromise = Promise.resolve(scene?.updateEmbeddedDocuments?.('Tile', updates));
      updatePromise
        .then(() => {
          if (!completeElevationGroupMoves.length || !scene) return null;
          const metadata = getSceneElevationGroupMetadata(scene);
          const nextMetadata = mergeElevationGroupMetadataOnBulkMove({ metadata, moves: completeElevationGroupMoves });
          return setSceneElevationGroupMetadata(scene, nextMetadata)
            .then(() => {
              Logger.info('LayerManager.elevationGroup.adjust.commit', {
                sceneId: scene.id || null,
                source,
                moveCount: completeElevationGroupMoves.length,
                moves: completeElevationGroupMoves
              });
            })
            .catch((error) => {
              Logger.error('LayerManager.elevationGroup.adjust.metadataFailed', {
                sceneId: scene.id || null,
                source,
                moveCount: completeElevationGroupMoves.length,
                moves: completeElevationGroupMoves,
                error: String(error?.message || error)
              });
              ui?.notifications?.error?.(`Layers moved but failed to update elevation group names: ${error?.message || error}`);
              return null;
            });
        })
        .then(() => restoreSelectionAfterElevationMove?.(Array.from(movedDocIds), { source }))
        .catch((error) => {
          Logger.error('LayerManager.elevationAdjust.failed', {
            sceneId: scene?.id || null,
            source,
            updateCount: updates.length,
            markerAdjusted,
            error: String(error?.message || error)
          });
          ui?.notifications?.error?.(`Failed to change layer elevation: ${error?.message || error}`);
        });
    } catch (error) {
      Logger.error('LayerManager.elevationAdjust.failed', {
        sceneId: scene?.id || null,
        source,
        updateCount: updates.length,
        markerAdjusted,
        error: String(error?.message || error)
      });
      ui?.notifications?.error?.(`Failed to change layer elevation: ${error?.message || error}`);
    }
  }

  if (Number.isFinite(announceElevation)) {
    queueElevationAnnounce?.(getElevationAnnouncePoint(pointer), announceElevation);
  }
  return true;
}

export async function commitElevationGroupElevationEdit({
  sourceKey = '',
  draft = '',
  scene = canvas?.scene,
  user = game?.user,
  usesNestedGrouping = false,
  filtersApplied = false,
  sourceGroupNode = null,
  orderDocsByIds = null,
  getFullElevationDocs = null,
  parseElevationInput = null,
  quantizeElevation = null,
  elevationGroupKey = null,
  computeNextSortAtElevation = null,
  getSceneElevationGroupMetadata = null,
  mergeElevationGroupMetadataOnBulkMove = null,
  setSceneElevationGroupMetadata = null,
  resolveTileElevationMove = null,
  restoreSelectionAfterElevationMove = null
} = {}) {
  if (!scene?.updateEmbeddedDocuments) return {
    movedDocIds: [],
    updates: [],
    targetKeys: []
  };
  if (!scene?.canUserModify?.(user, 'update')) {
    ui?.notifications?.warn?.('You do not have permission to move elevation groups.');
    return {
      movedDocIds: [],
      updates: [],
      targetKeys: []
    };
  }

  const nextElevation = parseElevationInput(draft);
  if (!Number.isFinite(nextElevation)) {
    throw new Error('Elevation group value must be a valid number.');
  }
  const targetElevation = quantizeElevation(nextElevation);
  const targetKey = buildTargetElevationGroupKey({
    sourceKey,
    targetElevation,
    parseElevationInput,
    elevationGroupKey
  });
  if (targetKey === sourceKey) {
    return {
      movedDocIds: [],
      updates: [],
      targetKeys: []
    };
  }
  if (usesNestedGrouping && filtersApplied) {
    throw new Error('Clear layer filters before moving nested elevation groups.');
  }

  const movingDocs = orderDocs(
    (getFullElevationDocs?.(sourceKey) || []).filter(Boolean),
    orderDocsByIds
  );
  if (!movingDocs.length) {
    return {
      movedDocIds: [],
      updates: [],
      targetKeys: []
    };
  }
  const blockedDocs = movingDocs.filter((doc) => !doc?.canUserModify?.(user, 'update'));
  if (blockedDocs.length) {
    throw new Error('You do not have permission to move every layer in this elevation group.');
  }

  let resolvedMoves = [];
  if (usesNestedGrouping) {
    const sourceElevation = Number(sourceGroupNode?.elevation ?? parseElevationInput(sourceKey));
    if (!Number.isFinite(sourceElevation)) {
      throw new Error(`Unable to resolve source elevation group ${sourceKey}.`);
    }
    const delta = quantizeElevation(targetElevation - sourceElevation);
    resolvedMoves = movingDocs
      .map((doc) => {
        const currentElevation = quantizeElevation(Number(doc?.elevation ?? 0) || 0);
        return resolveTileElevationMove({
          doc,
          requestedElevation: currentElevation + delta
        });
      })
      .filter((move) => !!move?.changed);
  } else {
    resolvedMoves = movingDocs
      .map((doc) => resolveTileElevationMove({
        doc,
        requestedElevation: targetElevation
      }))
      .filter((move) => !!move?.changed);
  }
  if (!resolvedMoves.length) {
    return {
      movedDocIds: [],
      updates: [],
      targetKeys: []
    };
  }

  const { groups, movedGroupsBySource, movedDocIds } = buildResolvedMoveState(resolvedMoves, elevationGroupKey);
  const updates = buildElevationUpdates(groups, {
    computeNextSortAtElevation,
    elevationGroupKey
  });
  let completeMoves = collectCompleteElevationGroupMoves(movedGroupsBySource, {
    getFullElevationDocs
  });
  if (isPrefixedBandElevationGroupKey(sourceKey, parseElevationInput) && targetKey && targetKey !== sourceKey) {
    const sourceDocIds = new Set((getFullElevationDocs?.(sourceKey) || [])
      .map((doc) => doc?.id)
      .filter(Boolean));
    if (sourceDocIds.size && sourceDocIds.size === movedDocIds.size && Array.from(sourceDocIds).every((id) => movedDocIds.has(id))) {
      completeMoves = completeMoves
        .filter((move) => String(move?.sourceKey || '').trim() !== sourceKey);
      completeMoves.push({ sourceKey, targetKey });
    }
  }

  await scene.updateEmbeddedDocuments('Tile', updates);
  if (completeMoves.length) {
    const metadata = getSceneElevationGroupMetadata(scene);
    const nextMetadata = mergeElevationGroupMetadataOnBulkMove({
      metadata,
      moves: completeMoves
    });
    await setSceneElevationGroupMetadata(scene, nextMetadata);
  }
  await restoreSelectionAfterElevationMove?.(Array.from(movedDocIds), { source: 'group-edit' });

  Logger.info('LayerManager.elevationGroup.move.commit', {
    sceneId: scene.id || null,
    sourceKey,
    targetKeys: Array.from(groups.keys()),
    tileCount: updates.length,
    nestedGrouping: usesNestedGrouping
  });

  return {
    movedDocIds: Array.from(movedDocIds),
    updates,
    targetKeys: Array.from(groups.keys())
  };
}
