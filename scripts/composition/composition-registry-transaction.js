// Shared serialization for Scene composition registry changes.
const MODULE_ID = 'fa-nexus';
const COMMIT_TIMEOUT_MS = 30_000;
const COMMIT_MUTEX_FLAG = 'buildingCommitMutex';
const activeRequests = new Set();
// Mutex Walls this client is acquiring or holding. Its own requests wait for each other here, before the server: a lock
// Wall this client just created is not in the Scene's collection until the server answers, and on a slow host (The
// Forge) a second request sent in that window was refused as a duplicate ID and failed.
const LOCAL_HOLDS = new Set();
function isDuplicateMutexCreate(error, id) {
  const message = String(error?.message || error || '');
  return message.includes(id) && /already exists/i.test(message);
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function normalizeIdentity(value) { return String(value || '').trim(); }
function commitMutexId(key) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < key.length; index += 1) {
    const code = key.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function mutexFailure(code, message, details = {}, options = {}) {
  const error = new Error(message, options);
  error.code = code;
  error.phase = details.phase || 'commit';
  if (details.rollback !== undefined) error.rollback = details.rollback;
  if (details.residue !== undefined) error.residue = clone(details.residue);
  if (details.recovery !== undefined) error.recovery = String(details.recovery);
  if (details.commitApplied === true) error.commitApplied = true;
  return error;
}

export class FoundryCompositionRegistryMutex {
  constructor({
    getGame = () => globalThis.game,
    resolveScene = (sceneId) => {
      const active = globalThis.canvas?.scene;
      if (normalizeIdentity(active?.id) === normalizeIdentity(sceneId)) return active;
      return getGame()?.scenes?.get?.(sceneId) || null;
    },
    now = () => Date.now(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  } = {}) {
    this._getGame = getGame;
    this._resolveScene = resolveScene;
    this._now = now;
    this._sleep = sleep;
  }

  _scene(sceneId) {
    const scene = this._resolveScene?.(normalizeIdentity(sceneId)) || null;
    if (!scene?.walls?.get || !scene?.createEmbeddedDocuments || !scene?.deleteEmbeddedDocuments) {
      throw new Error(`Foundry Scene ${normalizeIdentity(sceneId)} cannot host Composition registry serialization.`);
    }
    return scene;
  }

  _read(scene, id) {
    return scene?.walls?.get?.(id) || null;
  }

  _value(document) {
    return clone(document?.flags?.[MODULE_ID]?.[COMMIT_MUTEX_FLAG]
      ?? document?._source?.flags?.[MODULE_ID]?.[COMMIT_MUTEX_FLAG]
      ?? null);
  }

  async _releaseOwned(scene, id, requestId, reason) {
    const live = this._read(scene, id);
    if (!live) return { released: false, alreadyReleased: true };
    const value = this._value(live);
    if (normalizeIdentity(value?.requestId) !== normalizeIdentity(requestId)) {
      throw new Error(`Composition registry mutex ${id} is owned by another request.`);
    }
    await scene.deleteEmbeddedDocuments('Wall', [id], {
      // Foundry records the current user's embedded writes for Ctrl+Z unless they
      // are marked as undo work. The lock must never be recreated by Undo.
      isUndo: true,
      faNexusBuildingCommitMutex: true,
      faNexusBuildingCommitMutexReason: reason
    });
    const remaining = this._read(scene, id);
    if (remaining) {
      throw new Error(`Composition registry mutex ${id} remained after release.`);
    }
    return { released: true, alreadyReleased: false };
  }

  async run({
    sceneId,
    rootTileId,
    requestId,
    expectedRevisions,
    timeoutMs = COMMIT_TIMEOUT_MS,
    operationApplied = (result) => result?.kind === 'committed'
  } = {}, operation) {
    if (typeof operation !== 'function') throw new TypeError('Composition registry mutex requires an operation.');
    const normalizedSceneId = normalizeIdentity(sceneId);
    const normalizedRootTileId = normalizeIdentity(rootTileId);
    const normalizedRequestId = normalizeIdentity(requestId);
    if (!normalizedSceneId || !normalizedRootTileId || !normalizedRequestId) {
      throw new Error('Composition registry mutex requires exact Scene, root Tile, and request identities.');
    }
    const scene = this._scene(normalizedSceneId);
    const id = commitMutexId(`${normalizedSceneId}:${normalizedRootTileId}`);
    const deadline = this._now() + timeoutMs;
    const value = {
      version: 1,
      requestId: normalizedRequestId,
      sceneId: normalizedSceneId,
      rootTileId: normalizedRootTileId,
      expectedRevisions: clone(expectedRevisions || {}),
      acquiredAt: this._now()
    };

    while (LOCAL_HOLDS.has(id)) {
      if (this._now() >= deadline) {
        throw mutexFailure('BUILDING_COMMIT_MUTEX_TIMEOUT',
          'Another Scene operation has not finished. If it was interrupted, use Recover in Scene Groups.', {
            residue: [{ documentName: 'Wall', id, difference: 'commit-mutex-still-held' }],
            recovery: 'Open Scene Groups and recover the interrupted operation only after other editing has stopped.'
          });
      }
      await this._sleep(Math.min(50, Math.max(1, deadline - this._now())));
    }
    LOCAL_HOLDS.add(id);
    try {
      for (;;) {
        const existing = this._read(scene, id);
        if (existing) {
          if (this._now() >= deadline) {
            throw mutexFailure('BUILDING_COMMIT_MUTEX_TIMEOUT',
              'Another Scene operation has not finished. If it was interrupted, use Recover in Scene Groups.', {
                residue: [{ documentName: 'Wall', id, difference: 'commit-mutex-still-held' }],
                recovery: 'Open Scene Groups and recover the interrupted operation only after other editing has stopped.'
              });
          }
          await this._sleep(Math.min(50, Math.max(1, deadline - this._now())));
          continue;
        }
        try {
          value.acquiredAt = this._now();
          const created = await scene.createEmbeddedDocuments('Wall', [{
            _id: id,
            c: [0, 0, 0, 0],
            move: 0,
            light: 0,
            sight: 0,
            sound: 0,
            dir: 0,
            door: 0,
            ds: 0,
            flags: { [MODULE_ID]: { [COMMIT_MUTEX_FLAG]: clone(value) } }
          }], {
            keepId: true,
            isUndo: true,
            faNexusBuildingCommitMutex: true,
            faNexusBuildingCommitMutexReason: 'acquire'
          });
          if (!Array.isArray(created) || !created.length) {
            throw new Error(`Composition registry mutex ${id} creation returned no Wall.`);
          }
          const acquired = created[0];
          if (normalizeIdentity(acquired?.id) !== id
            || normalizeIdentity(this._value(acquired)?.requestId) !== normalizedRequestId) {
            throw new Error(`Composition registry mutex ${id} creation returned the wrong Wall identity or owner.`);
          }
          break;
        } catch (createError) {
          let live = this._read(scene, id);
          // Another client's lock this client has not received yet is refused as a duplicate ID: keep waiting for it.
          if (!live && !isDuplicateMutexCreate(createError, id)) {
            await this._sleep(25);
            live = this._read(scene, id);
            if (!live) throw createError;
          }
          if (this._now() >= deadline) {
            throw mutexFailure(
              'BUILDING_COMMIT_MUTEX_TIMEOUT',
              `Composition registry waited ${timeoutMs}ms for another material Commit to finish.`,
              {
                residue: [{ documentName: 'Wall', id, difference: 'commit-mutex-still-held' }],
                recovery: `Wait for the other Commit to finish. If no Commit is active, inspect and remove Wall ${id}, then Reload Current Building.`
              }
            );
          }
          await this._sleep(Math.min(50, Math.max(1, deadline - this._now())));
        }
      }

      activeRequests.add(normalizedRequestId);
      let result;
      let operationError = null;
      try {
        result = await operation();
      } catch (error) {
        operationError = error;
      }

      let releaseError = null;
      try {
        await this._releaseOwned(scene, id, normalizedRequestId, 'release');
      } catch (error) {
        releaseError = error;
      }
      activeRequests.delete(normalizedRequestId);

      if (releaseError) {
        const commitApplied = !operationError && operationApplied(result) === true;
        const residue = [{
          documentName: 'Wall',
          id,
          difference: `commit-mutex-release-failed:${String(releaseError?.message || releaseError)}`
        }];
        if (operationError?.code === 'BUILDING_ROLLBACK_INCOMPLETE') {
          operationError.residue = [...(operationError.residue || []), ...residue];
          operationError.recovery = `${operationError.recovery || ''} Remove the stale FA Nexus Composition registry mutex after verifying no Commit is active.`.trim();
          throw operationError;
        }
        throw mutexFailure(
          operationError ? 'BUILDING_ROLLBACK_INCOMPLETE' : 'BUILDING_COMMIT_MUTEX_RELEASE_FAILED',
          operationError
            ? `Composition registry failed and its transaction mutex could not be released: ${String(operationError?.message || operationError)}`
            : 'The Composition registry finished, but its transaction mutex could not be released.',
          {
            phase: operationError ? 'rollback' : 'teardown',
            rollback: operationError ? 'incomplete' : undefined,
            residue,
            recovery: `Verify the current Building, then remove stale Wall ${id} before editing again.`,
            commitApplied
          },
          { cause: operationError || releaseError }
        );
      }
      if (operationError) throw operationError;
      return result;
    } finally {
      LOCAL_HOLDS.delete(id);
    }
  }
}

const defaultCompositionRegistryMutex = new FoundryCompositionRegistryMutex();

/** Read-only evidence for explicit recovery; age alone never releases a lock. */
export function inspectCompositionRegistryLocks(scene, now = Date.now()) {
  return Array.from(scene?.walls || []).flatMap(wall => {
    const value = wall.flags?.[MODULE_ID]?.[COMMIT_MUTEX_FLAG];
    if (!value || value.version !== 1 || value.sceneId !== scene.id) return [];
    return [{ id: wall.id, requestId: value.requestId, acquiredAt: value.acquiredAt,
      recoverable: Number.isFinite(value.acquiredAt) && now - value.acquiredAt > COMMIT_TIMEOUT_MS
        && !activeRequests.has(value.requestId) }];
  });
}

export async function releaseInterruptedCompositionRegistryLock(scene, inspected) {
  if (!globalThis.game?.user?.isGM || !scene.canUserModify(game.user, 'update')) throw new Error('Only a GM may recover a Scene operation.');
  const current = inspectCompositionRegistryLocks(scene).find(lock => lock.id === inspected.id);
  if (!current || current.requestId !== inspected.requestId || current.acquiredAt !== inspected.acquiredAt || !current.recoverable) {
    throw new Error('The Scene operation changed or is still active. Refresh Scene Groups before recovering it.');
  }
  return defaultCompositionRegistryMutex._releaseOwned(scene, current.id, current.requestId, 'explicit-recovery');
}

export async function runFoundryCompositionRegistryTransaction({ scene, timeoutMs = COMMIT_TIMEOUT_MS } = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('Composition registry transaction requires an operation.');
  const sceneId = normalizeIdentity(scene?.id);
  if (!sceneId) throw new Error('Composition registry transaction requires an exact Scene identity.');
  if (!globalThis.game?.user?.isGM) throw new Error('Only an authenticated GM may change the Scene composition registry.');
  const requestId = normalizeIdentity(globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`);
  return defaultCompositionRegistryMutex.run({
    sceneId,
    rootTileId: '__building_creation_registry__',
    requestId,
    expectedRevisions: {},
    timeoutMs,
    operationApplied: () => true
  }, operation);
}
