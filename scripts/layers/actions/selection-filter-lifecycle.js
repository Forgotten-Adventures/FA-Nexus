import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function createSelectionFilterState() {
  return {
    active: false,
    min: null,
    max: null,
    skipLocked: false,
    skipHidden: false,
    skipFiltered: false,
    listFilterSignature: '',
    listFilterActive: false,
    matchingListTileIds: new Set()
  };
}

function requireAdapter(adapters, name) {
  const adapter = adapters?.[name];
  if (typeof adapter !== 'function') throw new Error(`Layer selection filter lifecycle missing ${name} adapter.`);
  return adapter;
}

export function createSelectionFilterLifecycle(adapters = {}) {
  const state = createSelectionFilterState();
  const logger = adapters.logger || Logger;

  function buildListFilterSignature(sessionState) {
    return JSON.stringify({
      sceneKey: requireAdapter(adapters, 'getSceneKey')(),
      searchQuery: String(sessionState?.searchQuery ?? ''),
      typeFilters: sessionState?.typeFilters instanceof Set ? Array.from(sessionState.typeFilters).sort() : [],
      flagFilters: requireAdapter(adapters, 'getListFilterFlagKeys')().filter((key) => !!sessionState?.flagFilters?.[key])
    });
  }

  function invalidateListFilterCache(reason = 'unknown') {
    state.listFilterSignature = '';
    state.listFilterActive = false;
    state.matchingListTileIds = new Set();
    logger.trace?.('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.invalidated', { reason });
  }

  function syncListFilterCache({ reason = 'unknown', force = false } = {}) {
    const sessionState = requireAdapter(adapters, 'getSessionState')();
    const signature = buildListFilterSignature(sessionState);
    const active = requireAdapter(adapters, 'listFiltersActive')(sessionState);
    if (!force && signature === state.listFilterSignature && active === state.listFilterActive) {
      return {
        active,
        matchingIds: state.matchingListTileIds
      };
    }

    state.listFilterSignature = signature;
    state.listFilterActive = active;
    state.matchingListTileIds = new Set();

    if (!active) {
      logger.trace?.('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.synced', {
        reason,
        active: false,
        matchingCount: 0
      });
      return {
        active: false,
        matchingIds: state.matchingListTileIds
      };
    }

    const parsedQuery = requireAdapter(adapters, 'parseListSearchQuery')(sessionState.searchQuery || '');
    const sortedDocs = requireAdapter(adapters, 'getSortedTileDocs')();
    const elevationGroupMetadata = requireAdapter(adapters, 'getElevationGroupMetadata')();
    const sectionMetadata = typeof adapters.getSectionMetadata === 'function' ? adapters.getSectionMetadata() : {};
    const nestedGrouping = requireAdapter(adapters, 'isNestedGroupingEnabled')();
    for (let index = 0; index < sortedDocs.length; index += 1) {
      const doc = sortedDocs[index];
      const entry = requireAdapter(adapters, 'buildTileEntry')(doc, index);
      requireAdapter(adapters, 'applyGroupSearchTextToEntries')([entry], {
        elevationGroupMetadata,
        nestedGrouping
      });
      if (typeof adapters.applySectionSearchTextToEntries === 'function') {
        adapters.applySectionSearchTextToEntries([entry], sectionMetadata);
      }
      if (!requireAdapter(adapters, 'entryMatchesListFilters')(entry, sessionState, parsedQuery)) continue;
      if (entry.id) state.matchingListTileIds.add(entry.id);
    }

    logger.trace?.('layerSelectionFilter', 'LayerManager.selectionFilter.listCache.synced', {
      reason,
      active: true,
      matchingCount: state.matchingListTileIds.size,
      totalTileCount: sortedDocs.length
    });
    return {
      active: true,
      matchingIds: state.matchingListTileIds
    };
  }

  function usesListFilters() {
    if (!state.active || !state.skipFiltered) return false;
    return !!syncListFilterCache({ reason: 'selection-active-check' }).active;
  }

  function placeableMatchesListFilters(placeable) {
    if (!usesListFilters()) return true;
    const matcher = syncListFilterCache({ reason: 'placeable-match-check' });
    if (!matcher.active) return true;
    const id = placeable?.document?.id || placeable?.id;
    if (!id) return false;
    return matcher.matchingIds.has(id);
  }

  function syncFromSettings() {
    const { min, max, skipLocked, skipHidden, skipFiltered } = requireAdapter(adapters, 'getElevationRangeFromSettings')();
    const wasSkipLocked = state.skipLocked;
    const wasSkipHidden = state.skipHidden;
    const wasSkipFiltered = state.skipFiltered;
    state.min = min;
    state.max = max;
    state.skipLocked = !!skipLocked;
    state.skipHidden = !!skipHidden;
    state.skipFiltered = !!skipFiltered;
    if (wasSkipFiltered !== state.skipFiltered) invalidateListFilterCache('settings-sync');
    if (
      wasSkipLocked !== state.skipLocked
      || wasSkipHidden !== state.skipHidden
      || wasSkipFiltered !== state.skipFiltered
    ) {
      requireAdapter(adapters, 'refreshTileInteractionState')();
    }
  }

  function active() {
    return !!state.active && (
      Number.isFinite(state.min)
      || Number.isFinite(state.max)
      || !!state.skipLocked
      || !!state.skipHidden
      || usesListFilters()
    );
  }

  function elevationInRange(value) {
    if (!active()) return true;
    if (!Number.isFinite(value)) return false;
    // The range lies between the two numbers whichever was typed into which box: "40 - 20" is 20 to 40, not a
    // range that no Elevation can be in.
    const reversed = Number.isFinite(state.min) && Number.isFinite(state.max) && state.min > state.max;
    const low = reversed ? state.max : state.min;
    const high = reversed ? state.min : state.max;
    if (Number.isFinite(low) && value < low) return false;
    if (Number.isFinite(high) && value > high) return false;
    return true;
  }

  return {
    state,
    active,
    elevationInRange,
    invalidateListFilterCache,
    placeableMatchesListFilters,
    syncFromSettings,
    syncListFilterCache,
    usesListFilters
  };
}
