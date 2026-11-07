export const PRESERVE_LINKED_TILE_CLEANUP_OPTION = 'faNexusPreserveLinkedTileCleanup';

const SUPPRESS_LINKED_TILE_DELETE_GLOBAL = 'FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE';
const SUPPRESS_LINKED_TILE_DELETE_IDS_GLOBAL = 'FA_NEXUS_SUPPRESS_LINKED_TILE_DELETE_IDS';
const SUPPRESS_BUILDING_TILE_DELETE_GLOBAL = 'FA_NEXUS_SUPPRESS_BUILDING_TILE_DELETE';

function restoreGlobalValue(root, key, previous) {
  if (previous === undefined) delete root[key];
  else root[key] = previous;
}

export function shouldSkipLinkedTileCleanup(doc = null, options = {}, {
  includeBuildingSuppression = false
} = {}) {
  try {
    if (options?.[PRESERVE_LINKED_TILE_CLEANUP_OPTION]) return true;
    if (globalThis?.[SUPPRESS_LINKED_TILE_DELETE_GLOBAL]) return true;
    if (includeBuildingSuppression && globalThis?.[SUPPRESS_BUILDING_TILE_DELETE_GLOBAL]) return true;
    const suppressedIds = globalThis?.[SUPPRESS_LINKED_TILE_DELETE_IDS_GLOBAL];
    const docId = doc?.id || doc?._id || null;
    return !!(docId && suppressedIds instanceof Set && suppressedIds.has(docId));
  } catch (_) {
    return false;
  }
}

export async function withLinkedTileCleanupSuppressed(ids, callback, {
  suppressBuildingCleanup = false
} = {}) {
  const root = globalThis;
  const tileIds = Array.from(new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean)));
  const previousLinked = root?.[SUPPRESS_LINKED_TILE_DELETE_GLOBAL];
  const previousBuilding = root?.[SUPPRESS_BUILDING_TILE_DELETE_GLOBAL];
  const previousIds = root?.[SUPPRESS_LINKED_TILE_DELETE_IDS_GLOBAL];
  const nextIds = previousIds instanceof Set ? new Set(previousIds) : new Set();
  for (const id of tileIds) nextIds.add(id);

  try {
    root[SUPPRESS_LINKED_TILE_DELETE_GLOBAL] = true;
    root[SUPPRESS_LINKED_TILE_DELETE_IDS_GLOBAL] = nextIds;
    if (suppressBuildingCleanup) {
      root[SUPPRESS_BUILDING_TILE_DELETE_GLOBAL] = true;
    }
    return await callback?.();
  } finally {
    restoreGlobalValue(root, SUPPRESS_LINKED_TILE_DELETE_GLOBAL, previousLinked);
    restoreGlobalValue(root, SUPPRESS_LINKED_TILE_DELETE_IDS_GLOBAL, previousIds);
    if (suppressBuildingCleanup) {
      restoreGlobalValue(root, SUPPRESS_BUILDING_TILE_DELETE_GLOBAL, previousBuilding);
    }
  }
}
