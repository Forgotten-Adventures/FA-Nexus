const DEFAULT_LOG_PREFIX = '[fa-nexus][premium-wall-lifecycle]';

function resolveScene() {
  return globalThis?.canvas?.scene || null;
}

// A Wall exists while its Scene collection holds it. Foundry's `document._destroyed` is not an
// existence test: it is set when a placeable is destroyed and stays set after the canvas draws
// that document again, so every Wall carries it after a Level switch or a return to the Scene.
function getWallDocument(wallId) {
  const id = String(wallId || '').trim();
  const scene = resolveScene();
  if (!id || !scene) return null;
  return scene.walls?.get?.(id) || scene.getEmbeddedDocument?.('Wall', id) || null;
}

function getSceneWallSources() {
  const source = resolveScene()?._source?.walls;
  return Array.isArray(source) ? source : [];
}

function getWallSourceId(source) {
  return String(source?._id || source?.id || '').trim() || null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectMissingSourceDeletionPaths(current, source, prefix = '') {
  if (!isPlainObject(current) || !isPlainObject(source)) return [];
  const paths = [];
  for (const [key, value] of Object.entries(current)) {
    if (key === '_id' || key === 'id') continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      paths.push(prefix ? `${prefix}.${key}` : key);
      continue;
    }
    if (isPlainObject(value) && isPlainObject(source[key])) {
      paths.push(
        ...collectMissingSourceDeletionPaths(value, source[key], prefix ? `${prefix}.${key}` : key)
      );
    }
  }
  return paths;
}

function applyForcedDeletion(target, path) {
  const ForcedDeletion = globalThis?.foundry?.data?.operators?.ForcedDeletion;
  if (typeof ForcedDeletion !== 'function') {
    throw new Error('Foundry ForcedDeletion is unavailable for exact Wall rollback.');
  }
  const parts = String(path || '').split('.').filter(Boolean);
  if (!parts.length) throw new Error('Exact Wall rollback requires a deletion path.');
  let entry = target;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(entry[part])) entry[part] = {};
    entry = entry[part];
  }
  entry[parts.at(-1)] = new ForcedDeletion();
}

function hasWallSource(wallId) {
  const id = String(wallId || '').trim();
  if (!id) return false;
  return getSceneWallSources().some((source) => getWallSourceId(source) === id);
}

function normalizeWallIds(ids = []) {
  if (!Array.isArray(ids)) return [];
  return ids.map((id) => String(id || '').trim()).filter(Boolean);
}

function logWith(logger, level, prefix, code, payload = {}) {
  const fn = logger?.[level] || logger?.warn || null;
  if (typeof fn === 'function') fn.call(logger, prefix || DEFAULT_LOG_PREFIX, code, payload);
}

export function cloneWallDocumentSource(entry, {
  logger = null,
  logPrefix = DEFAULT_LOG_PREFIX
} = {}) {
  try {
    if (entry?.document?.toObject) return entry.document.toObject(false);
    if (entry?.toObject) return entry.toObject(false);
    const source = entry?.source || entry?._source || entry || null;
    if (!source) return null;
    if (globalThis?.foundry?.utils?.deepClone) return foundry.utils.deepClone(source);
    return JSON.parse(JSON.stringify(source));
  } catch (error) {
    logWith(logger, 'warn', logPrefix, 'wallDocument.clone.failed', {
      wallId: entry?.id || entry?.document?.id || entry?._id || null,
      error: String(error?.message || error)
    });
    return null;
  }
}

export async function refreshWallDocumentRuntime({
  logger = null,
  logPrefix = DEFAULT_LOG_PREFIX,
  code = 'refresh',
  redrawWallsLayer = false
} = {}) {
  const canvas = globalThis?.canvas || null;
  if (!canvas) return;
  if (redrawWallsLayer && typeof canvas.walls?.draw === 'function') {
    try {
      await canvas.walls.draw();
    } catch (drawError) {
      logWith(logger, 'warn', logPrefix, `${code}.wallsLayer.draw.failed`, {
        error: String(drawError?.message || drawError)
      });
    }
  }
  if (canvas.perception?.update) {
    try {
      canvas.perception.update({ initializeVision: true, refreshLighting: true, refreshVision: true }, true);
    } catch (perceptionError) {
      logWith(logger, 'warn', logPrefix, `${code}.perception.failed`, {
        error: String(perceptionError?.message || perceptionError)
      });
    }
  }
}

// An editor session's preview Walls are its working state, not steps the user took. Foundry
// records every Wall the current user creates on the viewed Scene for Ctrl+Z; drop the entries
// that hold only these Walls so native Undo cannot delete them one batch at a time.
export function forgetWallCreationHistory(ids = []) {
  const wallIds = new Set(normalizeWallIds(ids));
  const history = globalThis?.canvas?.walls?.history;
  if (!wallIds.size || !Array.isArray(history)) return;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.type !== 'create' || !Array.isArray(entry.data) || !entry.data.length) continue;
    if (entry.data.every((data) => wallIds.has(data?._id))) history.splice(index, 1);
  }
}

export async function deleteWallDocuments(ids = [], {
  logger = null,
  logPrefix = DEFAULT_LOG_PREFIX,
  code = 'delete',
  redrawWallsLayer = false,
  verifySource = false,
  retryNoHook = false,
  sleepMs = 0,
  logSummary = false,
  errorLevel = 'warn',
  documentDeleteOptions = {},
  getDocument = getWallDocument,
  hasSource = hasWallSource
} = {}) {
  const wallIds = normalizeWallIds(ids);
  const scene = resolveScene();
  const result = {
    requested: wallIds.length,
    successfulDeletes: [],
    alreadyGone: [],
    sourceOnlyDeletes: [],
    errors: [],
    survivingIds: []
  };
  if (!wallIds.length || !scene) return result;

  const checkSource = (wallId) => !!(verifySource && hasSource?.(wallId));
  for (const wallId of wallIds) {
    try {
      const doc = getDocument?.(wallId);
      const sourcePresent = checkSource(wallId);
      if (!doc && !sourcePresent) {
        result.alreadyGone.push(wallId);
        continue;
      }
      if (!doc && sourcePresent) result.sourceOnlyDeletes.push(wallId);
      await scene.deleteEmbeddedDocuments('Wall', [wallId], documentDeleteOptions);
      result.successfulDeletes.push(wallId);
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('does not exist')) {
        if (checkSource(wallId)) result.errors.push({ wallId, error: message, sourcePresent: true });
        else result.alreadyGone.push(wallId);
      } else {
        result.errors.push({ wallId, error: message });
      }
    }
  }

  if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
  result.survivingIds = wallIds.filter((wallId) => {
    return !!getDocument?.(wallId) || checkSource(wallId);
  });

  if (result.survivingIds.length && retryNoHook) {
    logWith(logger, 'warn', logPrefix, `${code}.survivorsAfterInitialDelete`, {
      requested: wallIds,
      survivingIds: result.survivingIds
    });
    try {
      await scene.deleteEmbeddedDocuments('Wall', result.survivingIds, {
        ...documentDeleteOptions,
        noHook: true
      });
    } catch (error) {
      const message = String(error?.message || error);
      if (message.includes('does not exist')) {
        for (const wallId of result.survivingIds) {
          if (checkSource(wallId)) {
            result.errors.push({ wallId, error: message, sourcePresent: true, phase: 'retryNoHook' });
          }
        }
      } else {
        result.errors.push({ wallIds: result.survivingIds, error: message, phase: 'retryNoHook' });
      }
    }
    if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
    result.survivingIds = wallIds.filter((wallId) => {
      return !!getDocument?.(wallId) || checkSource(wallId);
    });
  }

  if (logSummary && (result.alreadyGone.length || result.errors.length || result.successfulDeletes.length)) {
    logWith(logger, 'info', logPrefix, `${code}.complete`, {
      requested: result.requested,
      deleted: result.successfulDeletes.length,
      alreadyGone: result.alreadyGone.length,
      sourceOnlyDeletes: result.sourceOnlyDeletes.length,
      errors: result.errors.length
    });
  }
  if (result.errors.length) {
    logWith(logger, errorLevel, logPrefix, `${code}.errors`, { errors: result.errors });
  }
  if (result.survivingIds.length) {
    logWith(logger, errorLevel, logPrefix, `${code}.persisted`, {
      requested: wallIds,
      survivingIds: result.survivingIds
    });
  }

  await refreshWallDocumentRuntime({ logger, logPrefix, code, redrawWallsLayer });
  return result;
}

export async function restoreWallDocuments(sources = [], {
  logger = null,
  logPrefix = DEFAULT_LOG_PREFIX,
  code = 'restore.failed',
  documentUpdateOptions = {}
} = {}) {
  const scene = resolveScene();
  if (!Array.isArray(sources) || !sources.length || !scene) return { restored: false };
  const payloadById = new Map();
  for (const entry of sources) {
    const source = cloneWallDocumentSource(entry, { logger, logPrefix });
    const id = getWallSourceId(source);
    if (source && id) payloadById.set(id, source);
  }
  const payload = Array.from(payloadById.values());
  if (!payload.length) return { restored: false };
  try {
    const updates = payload
      .filter((source) => !!scene.walls?.get?.(getWallSourceId(source)))
      .map((source) => {
        const current = scene.walls.get(getWallSourceId(source))?.toObject?.(false) || {};
        const update = cloneWallDocumentSource(source, { logger, logPrefix });
        for (const path of collectMissingSourceDeletionPaths(current, source)) {
          applyForcedDeletion(update, path);
        }
        return update;
      });
    const creates = payload.filter((source) => !scene.walls?.get?.(getWallSourceId(source)));
    if (updates.length) {
      await scene.updateEmbeddedDocuments('Wall', updates, {
        diff: false,
        ...documentUpdateOptions
      });
    }
    if (creates.length) {
      await scene.createEmbeddedDocuments('Wall', creates, {
        keepId: true,
        ...documentUpdateOptions
      });
    }
    return {
      restored: true,
      updated: updates.length,
      created: creates.length
    };
  } catch (error) {
    if (code) {
      logWith(logger, 'warn', logPrefix, code, {
        message: String(error?.message || error)
      });
    }
    return { restored: false, error };
  }
}
