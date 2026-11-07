import { NexusLogger as Logger } from '../core/nexus-logger.js';

const DELETE_SETTLE_MS = 1000;
const LOCAL_DELETE_TTL_MS = 60000;
// Flattened images can be large; beyond this the file is simply left on disk.
const RETAINED_ORIGINAL_BUDGET_BYTES = 256 * 1024 * 1024;

let servicePromise = null;
let pendingDocs = [];
let timer = null;
let work = Promise.resolve();

// A deleted Tile can return through Undo for as long as the canvas that deleted it
// lives. Only the deleting session can undo, so only it replaces the Tile's generated
// files, and only after it holds their original bytes to write back.
const localDeletes = new Map();
const localLevelDeletes = new Map();
const captures = new Map();
const retainedOriginals = new Map();
let retainedBytes = 0;

async function getService() {
  if (!servicePromise) {
    servicePromise = import('./generated-cleanup-service.js')
      .then(({ GeneratedCleanupService }) => new GeneratedCleanupService())
      .catch((error) => {
        servicePromise = null;
        throw error;
      });
  }
  return servicePromise;
}

function enqueue(task) {
  work = work.then(task, task);
  return work;
}

function rememberLocal(map, document) {
  const now = Date.now();
  for (const [uuid, at] of map) if (now - at > LOCAL_DELETE_TTL_MS) map.delete(uuid);
  const uuid = String(document?.uuid || '').trim();
  if (uuid) map.set(uuid, now);
}

function releaseRetained(key) {
  const retained = retainedOriginals.get(key);
  if (!retained) return;
  retainedOriginals.delete(key);
  retainedBytes -= retained.blob.size;
}

// Runs before the deletion is sent, while the Tile still names its files and before
// any session can have replaced them.
async function captureOriginals(doc) {
  const cleanupService = await getService();
  const files = await cleanupService.collectTileGeneratedFiles([doc]);
  const keys = [];
  for (const [key, entry] of files) {
    keys.push(key);
    try {
      const blob = await cleanupService.fetchGeneratedFile(entry);
      // Always the bytes as they are now; an earlier copy may predate a repaint.
      releaseRetained(key);
      if (retainedBytes + blob.size > RETAINED_ORIGINAL_BUDGET_BYTES) {
        Logger.warn('GeneratedCleanup.deletedTile.originalNotRetained', { target: entry.target, bytes: blob.size, retainedBytes });
        continue;
      }
      retainedOriginals.set(key, { entry, blob });
      retainedBytes += blob.size;
    } catch (error) {
      Logger.warn('GeneratedCleanup.deletedTile.originalUnavailable', { target: entry.target, error: String(error?.message || error) });
    }
  }
  return keys;
}

async function flushDeletedTileGeneratedCleanup() {
  const docs = pendingDocs;
  pendingDocs = [];
  timer = null;
  if (!docs.length) return;
  try {
    const cleanupService = await getService();
    const captured = new Set();
    const notUndoable = new Set();
    for (const doc of docs) {
      const capture = captures.get(doc.uuid);
      captures.delete(doc.uuid);
      if (capture) for (const key of await capture.keys) captured.add(key);
      // A Tile removed with its Level never passed preDeleteTile and has no Undo.
      else for (const key of (await cleanupService.collectTileGeneratedFiles([doc])).keys()) notUndoable.add(key);
    }
    const marking = new Set();
    const result = await cleanupService.markDeletedTileGeneratedFiles(docs, {
      backupFirst: false,
      canMark: (entry) => {
        const allowed = captured.has(entry.key) ? retainedOriginals.has(entry.key) : notUndoable.has(entry.key);
        if (allowed) marking.add(entry.key);
        return allowed;
      }
    });
    // Files that stay in use were never replaced; their copies are not needed.
    for (const key of captured) if (!marking.has(key)) releaseRetained(key);
    if (result.marked) Logger.info('GeneratedCleanup.deletedTile.marked', result);
  } catch (error) {
    Logger.error('GeneratedCleanup.deletedTile.failed', { error: String(error?.message || error) });
  }
}

async function restoreRecreatedTileGeneratedFiles(doc) {
  if (!retainedOriginals.size) return;
  let cleanupService;
  let files;
  try {
    cleanupService = await getService();
    files = await cleanupService.collectTileGeneratedFiles([doc]);
  } catch (error) {
    Logger.error('GeneratedCleanup.restoredTile.failed', { tileId: doc?.id || null, error: String(error?.message || error) });
    return;
  }
  for (const key of files.keys()) {
    const retained = retainedOriginals.get(key);
    if (!retained) continue;
    try {
      await cleanupService.restoreGeneratedFile(retained.entry, retained.blob);
      releaseRetained(key);
      Logger.info('GeneratedCleanup.restoredTile.restored', { tileId: doc?.id || null, target: retained.entry.target });
    } catch (error) {
      Logger.error('GeneratedCleanup.restoredTile.failed', {
        tileId: doc?.id || null,
        target: retained.entry.target,
        error: String(error?.message || error)
      });
      globalThis.ui?.notifications?.error?.(
        `The generated file for a restored Tile could not be written back: ${retained.entry.filename}. See the console for details.`
      );
    }
  }
}

function isLocallyInitiated(doc) {
  if (localDeletes.delete(String(doc?.uuid || '').trim())) return true;
  // Foundry removes a deleted Level's Tiles on the server without preDeleteTile.
  const scene = doc?.parent;
  const levels = Array.from(doc?.levels || []);
  return !!scene && levels.length > 0 && levels.every((id) => localLevelDeletes.has(`${scene.uuid}.Level.${id}`));
}

Hooks.on('preDeleteLevel', (level) => {
  if (game?.user?.isGM) rememberLocal(localLevelDeletes, level);
});

Hooks.on('preDeleteTile', (doc, options = {}) => {
  if (!game?.user?.isGM || options?.faNexusSkipGeneratedCleanup) return;
  rememberLocal(localDeletes, doc);
  // Another hook may still refuse this deletion; let such captures lapse.
  const now = Date.now();
  for (const [uuid, capture] of captures) {
    if (now - capture.at <= LOCAL_DELETE_TTL_MS) continue;
    captures.delete(uuid);
    void capture.keys.then((keys) => keys.forEach(releaseRetained));
  }
  const keys = captureOriginals(doc).catch((error) => {
    Logger.error('GeneratedCleanup.deletedTile.captureFailed', { tileId: doc?.id || null, error: String(error?.message || error) });
    return [];
  });
  captures.set(doc.uuid, { at: now, keys });
});

Hooks.on('deleteTile', (doc, options = {}) => {
  if (options?.faNexusSkipGeneratedCleanup) {
    captures.delete(doc?.uuid);
    localDeletes.delete(String(doc?.uuid || '').trim());
    return;
  }
  if (!doc || !game?.user?.isGM || !isLocallyInitiated(doc)) return;
  pendingDocs.push(doc);
  if (timer) return;
  timer = setTimeout(() => enqueue(flushDeletedTileGeneratedCleanup), DELETE_SETTLE_MS);
});

Hooks.on('createTile', (doc) => {
  if (!game?.user?.isGM || !retainedOriginals.size) return;
  // After any replacement still in flight, so the original is what lands last.
  void enqueue(() => restoreRecreatedTileGeneratedFiles(doc));
});

// The layer history that could undo these deletions ends with the canvas.
Hooks.on('canvasTearDown', () => {
  retainedOriginals.clear();
  retainedBytes = 0;
});
