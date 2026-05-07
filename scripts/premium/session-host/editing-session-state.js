import {
  getSharedEditingTileSet,
  resolveTileId,
  resolveTilePlaceable
} from './editing-targets.js';
import { NexusLogger as Logger } from '../../core/nexus-logger.js';

function stringifyError(error) {
  return String(error?.message || error);
}

function readTrackedTileId(host, stateKey) {
  if (!host || !stateKey) return null;
  try {
    const value = host[stateKey];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch (_) {
    return null;
  }
}

function writeTrackedTileId(host, stateKey, tileId) {
  if (!host || !stateKey) return;
  try {
    host[stateKey] = tileId || null;
  } catch (_) {}
}

export function beginEditingTileTracking(host, {
  target = null,
  sharedSetKey,
  stateKey = '_editingTileId',
  onReplace = null
} = {}) {
  const tileId = resolveTileId(target);
  if (!tileId) return { tileId: null, tile: null, replacedTileId: null };

  const activeTileId = readTrackedTileId(host, stateKey);
  const replacedTileId = activeTileId && activeTileId !== tileId ? activeTileId : null;
  if (replacedTileId) {
    try { onReplace?.(replacedTileId); } catch (_) {}
  }

  writeTrackedTileId(host, stateKey, tileId);
  try { getSharedEditingTileSet(sharedSetKey)?.add(tileId); } catch (_) {}

  return {
    tileId,
    tile: resolveTilePlaceable(target, tileId),
    replacedTileId
  };
}

export function endEditingTileTracking(host, {
  target = null,
  fallbackId = null,
  sharedSetKey,
  stateKey = '_editingTileId'
} = {}) {
  const tileId = resolveTileId(target) || fallbackId || readTrackedTileId(host, stateKey);
  if (!tileId) return { tileId: null, tile: null };

  try { getSharedEditingTileSet(sharedSetKey)?.delete(tileId); } catch (_) {}
  if (readTrackedTileId(host, stateKey) === tileId) writeTrackedTileId(host, stateKey, null);

  return {
    tileId,
    tile: resolveTilePlaceable(target, tileId)
  };
}

function normalizeRefreshJobs(jobs) {
  if (jobs == null) return [];
  const list = Array.isArray(jobs) ? jobs : [jobs];
  return list.filter(Boolean).map((job) => Promise.resolve(job));
}

export function endEditingTileWithRefresh(host, {
  target = null,
  fallbackId = null,
  sharedSetKey,
  stateKey = '_editingTileId',
  beforeCollect = null,
  collectRefreshJobs = null,
  refreshAfterJobs = null,
  refreshOnCollectError = false,
  logRejectedRefreshJobs = true,
  loggerPrefix = 'PremiumSessionHost'
} = {}) {
  let tileId = null;
  let tile = null;
  let refreshJobs = [];
  let refreshPromise = null;

  const runRefresh = () => {
    if (!tileId || typeof refreshAfterJobs !== 'function') return;
    try {
      refreshAfterJobs({ tileId, tile, refreshJobs, refreshPromise });
    } catch (error) {
      Logger.warn?.(`${loggerPrefix}.editingExit.refreshFailed`, {
        tileId,
        error: stringifyError(error)
      });
    }
  };

  try {
    ({ tileId, tile } = endEditingTileTracking(host, {
      target,
      fallbackId,
      sharedSetKey,
      stateKey
    }));
    if (!tileId) return { tileId: null, tile: null, refreshJobs, refreshPromise };

    beforeCollect?.({ tileId, tile });
    if (tile && typeof collectRefreshJobs === 'function') {
      refreshJobs = normalizeRefreshJobs(collectRefreshJobs({ tileId, tile }));
      refreshPromise = refreshJobs.length
        ? Promise.allSettled(refreshJobs).then((results) => {
          if (logRejectedRefreshJobs) {
            results.forEach((result, index) => {
              if (result?.status !== 'rejected') return;
              Logger.warn?.(`${loggerPrefix}.editingExit.refreshJobFailed`, {
                tileId,
                index,
                error: stringifyError(result.reason)
              });
            });
          }
          return results;
        })
        : null;
    }
  } catch (error) {
    Logger.warn?.(`${loggerPrefix}.editingExit.collectFailed`, {
      tileId,
      error: stringifyError(error)
    });
    if (refreshOnCollectError && tileId) runRefresh();
    return { tileId, tile, refreshJobs: [], refreshPromise: null, error };
  }

  if (refreshPromise) Promise.resolve(refreshPromise).finally(runRefresh);
  else runRefresh();

  return { tileId, tile, refreshJobs, refreshPromise };
}
