import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { resolveCanvasTilePlaceable, resolveTilePlaceable } from './tile-targets.js';

const DEFAULT_APPLY_RETRY_DELAYS = Object.freeze([0, 16, 60, 140, 300]);
const LIFECYCLE_HOOKS = Object.freeze(['drawTile', 'refreshTile', 'controlTile', 'hoverTile']);

export const CUSTOM_TILE_RENDER_PHASES = Object.freeze({
  SOURCE: 0,
  MASK: 100,
  OVERHEAD: 200
});

const lifecycleRenderers = new Map();
const installedLifecycleHooks = new Set();
const lifecycleTasks = new WeakMap();

function stringifyError(error) {
  return String(error?.message || error);
}

function writeLog(logger, level, code, payload) {
  const target = logger || Logger;
  const method = typeof target?.[level] === 'function'
    ? target[level]
    : typeof target?.warn === 'function'
      ? target.warn
      : null;
  try { method?.call(target, code, payload); } catch (_) {}
}

function normalizeRetryDelays(delays) {
  const source = Array.isArray(delays) && delays.length ? delays : DEFAULT_APPLY_RETRY_DELAYS;
  const normalized = [];
  for (const delay of source) {
    const numeric = Number(delay);
    if (!Number.isFinite(numeric) || numeric < 0) continue;
    normalized.push(numeric);
  }
  return normalized.length ? normalized : DEFAULT_APPLY_RETRY_DELAYS.slice();
}

function resolveRetryTilePlaceable(doc, tileId = null) {
  return resolveCanvasTilePlaceable(doc, tileId) || resolveTilePlaceable(doc, tileId);
}

function normalizeLifecycleHooks(hooks) {
  const source = Array.isArray(hooks) ? hooks : [hooks || 'drawTile'];
  return [...new Set(source)].filter((hook) => LIFECYCLE_HOOKS.includes(hook));
}

function getLifecycleEntries(hookName) {
  const map = lifecycleRenderers.get(hookName);
  if (!map?.size) return [];
  return Array.from(map.values()).sort((a, b) => a.phase - b.phase);
}

function getLifecycleReason(hookName, args) {
  if (hookName === 'controlTile') return `controlTile:${args?.[1] ? 'on' : 'off'}`;
  if (hookName === 'hoverTile') return `hoverTile:${args?.[1] ? 'on' : 'off'}`;
  return hookName;
}

function logLifecycleRendererFailure(entry, context, error) {
  writeLog(entry.logger, entry.logLevel, entry.logCode, {
    rendererId: entry.id,
    hook: context.hook,
    reason: context.reason,
    tileId: context.tileId,
    error: stringifyError(error)
  });
}

function runLifecycleRenderer(entry, context) {
  try {
    const result = entry.callback(context.tile, context);
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).catch((error) => {
        logLifecycleRendererFailure(entry, context, error);
      });
    }
  } catch (error) {
    logLifecycleRendererFailure(entry, context, error);
  }
  return null;
}

function dispatchLifecycleHook(hookName, args) {
  const entries = getLifecycleEntries(hookName);
  if (!entries.length) return;
  const tile = args?.[0] || null;
  const context = {
    hook: hookName,
    reason: getLifecycleReason(hookName, args),
    tile,
    tileId: tile?.document?.id || tile?.id || null
  };
  let chain = null;
  for (const entry of entries) {
    if (chain) {
      chain = chain.then(() => runLifecycleRenderer(entry, context));
      continue;
    }
    const result = runLifecycleRenderer(entry, context);
    if (result) chain = result;
  }
  if (chain && tile) {
    let tasks = lifecycleTasks.get(tile);
    if (!tasks) lifecycleTasks.set(tile, tasks = new Set());
    tasks.add(chain);
    chain.finally(() => {
      tasks.delete(chain);
      if (!tasks.size) lifecycleTasks.delete(tile);
    });
  }
}

/** Foundry draw hooks are synchronous even when custom renderers are async.
 * Callers which need the finished native artwork must await that same work,
 * not invoke each renderer again while its draw hook is still building it.
 */
export async function waitForCustomTileRender(tile) {
  while (lifecycleTasks.get(tile)?.size) await Promise.all(lifecycleTasks.get(tile));
}

function installLifecycleHook(hookName) {
  if (installedLifecycleHooks.has(hookName)) return;
  const hooks = globalThis?.Hooks;
  if (typeof hooks?.on !== 'function') {
    writeLog(Logger, 'warn', 'CustomTileRender.lifecycle.hookUnavailable', { hook: hookName });
    return;
  }
  hooks.on(hookName, (...args) => dispatchLifecycleHook(hookName, args));
  installedLifecycleHooks.add(hookName);
}

export function registerCustomTileRenderLifecycle({
  id,
  hooks = 'drawTile',
  phase = CUSTOM_TILE_RENDER_PHASES.SOURCE,
  callback,
  logger = Logger,
  logCode = 'CustomTileRender.lifecycle.rendererFailed',
  logLevel = 'warn'
} = {}) {
  if (!id) throw new Error('registerCustomTileRenderLifecycle requires id');
  if (typeof callback !== 'function') throw new Error('registerCustomTileRenderLifecycle requires callback');
  const hookNames = normalizeLifecycleHooks(hooks);
  if (!hookNames.length) throw new Error('registerCustomTileRenderLifecycle requires a supported hook');
  const numericPhase = Number.isFinite(Number(phase)) ? Number(phase) : CUSTOM_TILE_RENDER_PHASES.SOURCE;
  for (const hookName of hookNames) {
    installLifecycleHook(hookName);
    let map = lifecycleRenderers.get(hookName);
    if (!map) {
      map = new Map();
      lifecycleRenderers.set(hookName, map);
    }
    const entry = {
      id,
      phase: numericPhase,
      callback,
      logger,
      logCode,
      logLevel
    };
    map.set(id, entry);
  }
}

export function requestCustomTileRenderRefresh(tile, {
  reason = 'custom-tile-refresh',
  logger = Logger,
  logCode = 'CustomTileRender.refresh.failed',
  logLevel = 'debug'
} = {}) {
  const refresh = () => {
    try {
      if (!canvas?.ready || !tile || tile.destroyed) return;
      try { tile.renderFlags?.set?.({ refreshState: true }); } catch (_) {}
    } catch (error) {
      writeLog(logger, logLevel, logCode, {
        tileId: tile?.document?.id || tile?.id || null,
        reason,
        error: stringifyError(error)
      });
    }
  };
  refresh();
  try { requestAnimationFrame(() => refresh()); } catch (_) {}
  try { setTimeout(refresh, 80); } catch (_) {}
}

export function scheduleCustomTileRenderApply(doc, {
  reason = 'tile-change',
  shouldApplyDocument = null,
  hasOverlay = null,
  applyTile,
  afterApply = null,
  resolvePlaceable = resolveRetryTilePlaceable,
  retryDelays = DEFAULT_APPLY_RETRY_DELAYS,
  logger = Logger,
  logCode = 'CustomTileRender.apply',
  logLevel = 'debug',
  refreshLogLevel = logLevel
} = {}) {
  if (typeof applyTile !== 'function') throw new Error('scheduleCustomTileRenderApply requires applyTile');
  const id = doc?.id || doc?._id || '';
  if (!id) return false;
  const resolveTile = () => {
    try { return resolvePlaceable(doc, id) || null; }
    catch (error) {
      writeLog(logger, logLevel, `${logCode}.resolveFailed`, {
        tileId: id,
        reason,
        error: stringifyError(error)
      });
      return null;
    }
  };
  const initialTile = resolveTile();
  const shouldApply = typeof shouldApplyDocument === 'function' ? !!shouldApplyDocument(doc) : true;
  const hasExistingOverlay = typeof hasOverlay === 'function' ? !!hasOverlay(initialTile) : false;
  if (!shouldApply && !hasExistingOverlay) return false;

  const delays = normalizeRetryDelays(retryDelays);
  const run = (attempt = 0) => {
    try {
      const tile = resolveTile();
      if (tile && !tile.destroyed) {
        Promise.resolve(applyTile(tile, { doc, reason, attempt }))
          .then(() => {
            requestCustomTileRenderRefresh(tile, {
              reason,
              logger,
              logCode: `${logCode}.refreshFailed`,
              logLevel: refreshLogLevel
            });
            try { afterApply?.(tile, { doc, reason, attempt }); }
            catch (error) {
              writeLog(logger, logLevel, `${logCode}.afterApplyFailed`, {
                tileId: id,
                reason,
                attempt,
                error: stringifyError(error)
              });
            }
          })
          .catch((error) => writeLog(logger, logLevel, `${logCode}.failed`, {
            tileId: id,
            reason,
            attempt,
            error: stringifyError(error)
          }));
        return;
      }
      const nextDelay = delays[attempt + 1];
      if (Number.isFinite(nextDelay)) setTimeout(() => run(attempt + 1), nextDelay);
    } catch (error) {
      writeLog(logger, logLevel, `${logCode}.scheduleFailed`, {
        tileId: id,
        reason,
        attempt,
        error: stringifyError(error)
      });
    }
  };
  run(0);
  return true;
}
