import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolveTileId } from './tile-targets.js';

const TILE_MESH_WAITERS = new Map();

function resolveTileMesh(tile) {
  try {
    const mesh = tile?.mesh || null;
    return mesh && !mesh.destroyed ? mesh : null;
  } catch (_) {
    return null;
  }
}

function isTileMeshWaitActive(tile) {
  try {
    return !!tile && !tile.destroyed && !!tile.document?.scene;
  } catch (_) {
    return false;
  }
}

function registerLifecycleHooks(tile, { scope, tileId, wake }) {
  const hooks = globalThis.Hooks;
  if (!hooks?.on || !hooks?.off) return () => {};

  const onLifecycle = (eventTile) => {
    if (eventTile !== tile) return;
    Logger.debug?.(`${scope}.lifecyclePulse`, {
      tileId,
      hasMesh: !!resolveTileMesh(tile)
    });
    wake('lifecycle');
  };

  const onDestroy = (eventTile) => {
    if (eventTile !== tile) return;
    Logger.debug?.(`${scope}.destroyed`, { tileId });
    wake('destroyed');
  };

  hooks.on('drawTile', onLifecycle);
  hooks.on('refreshTile', onLifecycle);
  hooks.on('destroyTile', onDestroy);

  return () => {
    try { hooks.off('drawTile', onLifecycle); } catch (_) {}
    try { hooks.off('refreshTile', onLifecycle); } catch (_) {}
    try { hooks.off('destroyTile', onDestroy); } catch (_) {}
  };
}

export async function waitForTileMesh(tile, options = {}) {
  try {
    if (!tile || tile.destroyed) return null;

    const immediateMesh = resolveTileMesh(tile);
    if (immediateMesh) return immediateMesh;

    const existing = TILE_MESH_WAITERS.get(tile);
    if (existing?.promise) return existing.promise;

    const attempts = Math.max(1, Number(options?.attempts) || 8);
    const delay = Math.max(10, Number(options?.delay) || 60);
    const scope = typeof options?.scope === 'string' && options.scope.trim()
      ? options.scope.trim()
      : 'TileMeshWaiter';
    const tileId = resolveTileId(tile);

    let wake = null;
    let cancelled = false;
    let cancelReason = null;
    const wakeWaiter = (reason) => {
      if (!wake) return;
      const currentWake = wake;
      wake = null;
      currentWake(reason);
    };

    let unregisterHooks = () => {};
    const entry = {
      promise: null,
      cancel: (reason = 'clear') => {
        cancelled = true;
        cancelReason = reason;
        Logger.debug?.(`${scope}.cancelled`, {
          tileId,
          reason
        });
        wakeWaiter('cancelled');
      }
    };

    entry.promise = (async () => {
      Logger.debug?.(`${scope}.waitStart`, {
        tileId,
        attempts,
        delay,
        isPreview: !!tile?.isPreview
      });
      unregisterHooks = registerLifecycleHooks(tile, {
        scope,
        tileId,
        wake: wakeWaiter
      });

      try {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          const liveMesh = resolveTileMesh(tile);
          if (liveMesh) {
            Logger.debug?.(`${scope}.meshReady`, {
              tileId,
              attempt: attempt + 1
            });
            return liveMesh;
          }

          if (cancelled || !isTileMeshWaitActive(tile)) {
            Logger.debug?.(`${scope}.waitAborted`, {
              tileId,
              attempt: attempt + 1,
              cancelled,
              cancelReason,
              destroyed: !!tile?.destroyed,
              hasScene: !!tile?.document?.scene
            });
            break;
          }

          const wakeReason = await new Promise((resolve) => {
            let settled = false;
            const finish = (reason) => {
              if (settled) return;
              settled = true;
              if (wake === finish) wake = null;
              resolve(reason);
            };
            wake = finish;
            setTimeout(() => finish('delay'), delay);
          });

          if (wakeReason !== 'delay') {
            Logger.debug?.(`${scope}.waitWake`, {
              tileId,
              attempt: attempt + 1,
              reason: wakeReason,
              hasMesh: !!resolveTileMesh(tile)
            });
          } else if (!isTileMeshWaitActive(tile)) {
            break;
          }
        }

        const mesh = resolveTileMesh(tile);
        if (!mesh && !cancelled && isTileMeshWaitActive(tile)) {
          Logger.warn?.(`${scope}.meshWaitTimedOut`, {
            tileId,
            attempts,
            delay,
            isPreview: !!tile?.isPreview
          });
        }
        return mesh;
      } finally {
        unregisterHooks();
        wake = null;
        if (TILE_MESH_WAITERS.get(tile) === entry) TILE_MESH_WAITERS.delete(tile);
      }
    })();

    TILE_MESH_WAITERS.set(tile, entry);
    return entry.promise;
  } catch (error) {
    Logger.warn?.('TileMeshWaiter.waitForTileMesh.failed', {
      tileId: resolveTileId(tile),
      error: String(error?.message || error)
    });
    return null;
  }
}

export function clearTileMeshWaiters(reason = 'clear') {
  for (const entry of TILE_MESH_WAITERS.values()) {
    try { entry?.cancel?.(reason); } catch (_) {}
  }
  TILE_MESH_WAITERS.clear();
}
