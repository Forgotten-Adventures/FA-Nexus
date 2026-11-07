export function getMatchingElevationGroupKeys(viewState = null) {
  const state = viewState || null;
  if (!state) return [];
  const keys = new Set();
  const visibleKeys = state?.matchingGroupHierarchy?.visibleKeys;
  if (visibleKeys instanceof Set) {
    for (const key of visibleKeys) {
      if (String(key || '').trim()) keys.add(key);
    }
  }
  const map = state?.matchingTileIdsByElevation;
  if (map instanceof Map) {
    for (const key of map.keys()) {
      if (String(key || '').trim()) keys.add(key);
    }
  }
  const sections = state?.matchingTileIdsBySection;
  if (sections instanceof Map) {
    for (const sectionId of sections.keys()) {
      const id = String(sectionId || '').trim();
      if (id) keys.add(`section:${id}`);
    }
  }
  return Array.from(keys);
}

export function getMatchingElevationDocs(viewState, elevationKey, { resolveDocumentById = null } = {}) {
  const key = String(elevationKey || '').trim();
  if (!key) return [];
  const ids = viewState?.matchingTileIdsByElevation?.get?.(key) || [];
  const docs = [];
  for (const id of ids) {
    const doc = viewState?.fullTileDocsById?.get?.(id) || resolveDocumentById?.(id) || null;
    if (doc) docs.push(doc);
  }
  return docs;
}

export function getFullElevationDocs(viewState, elevationKey) {
  const key = String(elevationKey || '').trim();
  if (!key) return [];
  const docs = viewState?.fullGroupDocsByKey?.get?.(key) || [];
  return Array.isArray(docs) ? docs.filter(Boolean) : [];
}

export function getFullGroupNode(viewState, elevationKey) {
  const key = String(elevationKey || '').trim();
  if (!key) return null;
  return viewState?.fullGroupHierarchy?.nodesByKey?.get?.(key) || null;
}

export function getMatchingGroupNode(viewState, elevationKey) {
  const key = String(elevationKey || '').trim();
  if (!key) return null;
  return viewState?.matchingGroupHierarchy?.nodesByKey?.get?.(key) || null;
}

export function usesNestedGrouping(viewState) {
  return !!viewState?.nestedGrouping;
}

export function setMatchingElevationGroupsCollapsed({
  viewState = null,
  sessionState = null,
  collapsed = false,
  persistCollapsedState = null
} = {}) {
  const matchingGroupKeys = getMatchingElevationGroupKeys(viewState);
  if (!matchingGroupKeys.length || !sessionState) {
    return { changed: false, matchingGroupKeys: [] };
  }
  if (!(sessionState.collapsedElevations instanceof Set)) {
    sessionState.collapsedElevations = new Set();
  }
  let changed = false;
  for (const key of matchingGroupKeys) {
    if (collapsed) {
      if (!sessionState.collapsedElevations.has(key)) {
        sessionState.collapsedElevations.add(key);
        changed = true;
      }
      continue;
    }
    if (sessionState.collapsedElevations.delete(key)) changed = true;
  }
  if (changed) {
    try { persistCollapsedState?.(); } catch (_) {}
  }
  return { changed, matchingGroupKeys };
}

export function toggleElevationGroupCollapsed({
  sessionState = null,
  elevationKey = null,
  persistCollapsedState = null
} = {}) {
  const key = String(elevationKey || '').trim();
  if (!key || !sessionState) return false;
  if (!(sessionState.collapsedElevations instanceof Set)) {
    sessionState.collapsedElevations = new Set();
  }
  if (sessionState.collapsedElevations.has(key)) sessionState.collapsedElevations.delete(key);
  else sessionState.collapsedElevations.add(key);
  try { persistCollapsedState?.(); } catch (_) {}
  return true;
}

export function expandElevationGroupsForDocs({
  docs = [],
  viewState = null,
  sessionState = null,
  elevationGroupKey = null,
  resolveDocumentGroupKey = null,
  persistCollapsedState = null
} = {}) {
  if (!Array.isArray(docs) || !docs.length || !(sessionState?.collapsedElevations instanceof Set) || !sessionState.collapsedElevations.size) {
    return { changed: false, keysToExpand: [] };
  }
  if (typeof elevationGroupKey !== 'function') {
    throw new Error('expandElevationGroupsForDocs requires elevationGroupKey');
  }

  const keysToExpand = new Set();
  for (const doc of docs) {
    if (!doc) continue;
    const exactKey = String(resolveDocumentGroupKey?.(doc) || elevationGroupKey(doc?.elevation ?? 0)).trim();
    if (!exactKey) continue;
    let node = getFullGroupNode(viewState, exactKey);
    if (!node) {
      keysToExpand.add(exactKey);
      continue;
    }
    while (node) {
      keysToExpand.add(node.key);
      node = node.parentKey ? getFullGroupNode(viewState, node.parentKey) : null;
    }
  }

  let changed = false;
  for (const key of keysToExpand) {
    if (sessionState.collapsedElevations.delete(key)) changed = true;
  }
  if (changed) {
    try { persistCollapsedState?.(); } catch (_) {}
  }
  return {
    changed,
    keysToExpand: Array.from(keysToExpand)
  };
}
