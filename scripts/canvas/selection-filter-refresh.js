import { NexusLogger as Logger } from '../core/nexus-logger.js';

export function requestSelectionFilterRefresh({
  reason = 'unknown',
  source = 'unknown',
  tileIds = null
} = {}) {
  const normalizedTileIds = Array.isArray(tileIds)
    ? [...new Set(tileIds.filter((id) => typeof id === 'string' && id.trim()))]
    : [];
  try {
    Hooks?.callAll?.('fa-nexus-selection-filter-refresh', {
      reason,
      source,
      tileIds: normalizedTileIds
    });
  } catch (error) {
    Logger.error('SelectionFilterRefresh.request.failed', {
      reason,
      source,
      tileIds: normalizedTileIds,
      error: String(error?.message || error)
    });
  }
}
