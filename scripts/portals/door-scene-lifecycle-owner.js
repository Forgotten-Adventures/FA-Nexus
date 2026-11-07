export function getActiveDoorSceneId() {
  const canvasRef = globalThis.canvas;
  const gameRef = globalThis.game;
  const id = canvasRef?.scene?.id ?? gameRef?.scenes?.current?.id ?? null;
  return id ? String(id) : null;
}

export function getDoorDocumentSceneId(doc) {
  const id = doc?.parent?.id ?? doc?.scene?.id ?? null;
  return id ? String(id) : null;
}

export class DoorSceneLifecycleOwner {
  constructor({ logger, foreignLogKey, missingLogKey = foreignLogKey } = {}) {
    this.logger = logger || null;
    this.foreignLogKey = foreignLogKey;
    this.missingLogKey = missingLogKey;
    this.pendingBuilds = new Map();
    this.sceneGeneration = 0;
    this.sceneId = null;
  }

  beginCanvasReady() {
    this.sceneGeneration += 1;
    this.sceneId = getActiveDoorSceneId();
    return this.sceneId;
  }

  beginCanvasTearDown() {
    this.sceneGeneration += 1;
    const previousSceneId = this.sceneId || getActiveDoorSceneId();
    this.sceneId = null;
    return previousSceneId;
  }

  captureSceneScope() {
    return {
      generation: this.sceneGeneration,
      sceneId: this.sceneId || getActiveDoorSceneId()
    };
  }

  isCurrentSceneScope(generation = this.sceneGeneration, sceneId = this.sceneId || getActiveDoorSceneId()) {
    const activeSceneId = this.sceneId || getActiveDoorSceneId();
    return generation === this.sceneGeneration
      && !!sceneId
      && !!activeSceneId
      && String(sceneId) === String(activeSceneId)
      && !!globalThis.canvas?.ready;
  }

  isActiveSceneDocument(doc, { phase = 'unknown', log = true } = {}) {
    if (!doc) return false;
    const activeSceneId = this.sceneId || getActiveDoorSceneId();
    const docSceneId = getDoorDocumentSceneId(doc);
    if (activeSceneId && docSceneId && activeSceneId === docSceneId) return true;
    if (log) {
      this.logger?.debug?.(activeSceneId && docSceneId ? this.foreignLogKey : this.missingLogKey, {
        phase,
        wallId: doc?.id || null,
        activeSceneId,
        docSceneId
      });
    }
    return false;
  }

  hasPendingBuild(key) {
    return this.pendingBuilds.has(key);
  }

  getPendingBuild(key) {
    return this.pendingBuilds.get(key);
  }

  createPendingBuild(key, extra = {}) {
    const scope = this.captureSceneScope();
    const pending = { ...extra, ...scope, cancelled: false, promise: null };
    this.pendingBuilds.set(key, pending);
    return pending;
  }

  settlePendingBuild(key, pending) {
    if (this.pendingBuilds.get(key) === pending) this.pendingBuilds.delete(key);
  }

  cancelPendingBuild(key) {
    const pending = this.pendingBuilds.get(key);
    if (!pending) return;
    pending.cancelled = true;
    this.pendingBuilds.delete(key);
  }

  cancelPendingBuildsWhere(predicate) {
    for (const key of Array.from(this.pendingBuilds.keys())) {
      if (predicate?.(key, this.pendingBuilds.get(key)) !== true) continue;
      this.cancelPendingBuild(key);
    }
  }

  cancelAllPendingBuilds() {
    for (const pending of this.pendingBuilds.values()) {
      pending.cancelled = true;
    }
    this.pendingBuilds.clear();
  }
}
