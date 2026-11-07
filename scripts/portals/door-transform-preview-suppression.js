const DEFAULT_SOURCE = 'unknown';
const MODULE_ID = 'fa-nexus';
const BUILDING_TYPED_TILE_FLAGS = Object.freeze([
  'buildingDoorFrame',
  'buildingWindowFrame',
  'buildingWindowWindow',
  'buildingWindowSill'
]);

function sorted(values) {
  return Array.from(values || []).map(String).filter(Boolean).sort();
}

function targetIdentity(target = {}) {
  const wallId = String(target.wallId || 'unknown-wall');
  const kind = String(target.kind || 'portal-visual');
  const name = String(target.object?.name || target.object?.label || 'unnamed');
  return `${wallId}/${kind}/${name}`;
}

function documentType(document) {
  return String(document?.documentName || document?.constructor?.metadata?.name || '').trim();
}

function readFlag(document, key) {
  if (typeof document?.getFlag === 'function') return document.getFlag(MODULE_ID, key);
  return document?.flags?.[MODULE_ID]?.[key]
    ?? document?._source?.flags?.[MODULE_ID]?.[key]
    ?? null;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}

function collectionGet(collection, id) {
  const normalized = String(id || '').trim();
  if (!normalized || !collection) return null;
  if (typeof collection.get === 'function') return collection.get(normalized) || null;
  return collectionValues(collection).find((entry) => String(entry?.id || '') === normalized) || null;
}

function addId(target, value) {
  const id = String(value || '').trim();
  if (id) target.add(id);
}

function addIds(target, values) {
  for (const value of Array.isArray(values) ? values : []) addId(target, value);
}

function isAnimatedBuildingPortal(document) {
  if (!readFlag(document, 'buildingDoor') && !readFlag(document, 'buildingWindow')) return false;
  // Foundry draws Door meshes only for Door Walls. A portal neutralized by Scene Group
  // Hide has none to hold or wait for until Show restores its Door type.
  if (!(Number(document?._source?.door ?? document?.door) > 0)) return false;
  const animation = document?.animation || document?._source?.animation || null;
  return !!(
    String(animation?.type || '').trim()
    && String(animation?.texture || '').trim()
  );
}

function angleDistance(left, right) {
  const fullTurn = Math.PI * 2;
  const delta = ((Number(left) - Number(right)) % fullTurn + fullTurn) % fullTurn;
  return Math.min(delta, fullTurn - delta);
}

export function isDoorMeshSynchronized(mesh, wall) {
  if (!mesh || mesh.destroyed || !wall) return false;
  const coords = Array.from(wall?.c || wall?._source?.c || []).slice(0, 4).map(Number);
  if (coords.length !== 4 || !coords.every(Number.isFinite)) return false;
  const closed = mesh._closedPosition;
  const textureWidth = Number(mesh.texture?.width) - (2 * Number(mesh.texturePadding || 0));
  if (!closed || !(textureWidth > 0)) return false;

  const [ax, ay, bx, by] = coords;
  const dx = bx - ax;
  const dy = by - ay;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 0)) return false;
  const rawStyle = String(mesh.name || '').split(/[:.]/).at(-1);
  const style = rawStyle === 'doubleL' || rawStyle === 'doubleR' ? rawStyle : 'single';
  const midpointAnimation = Math.abs(Number(mesh.anchor?.x) - 0.5) < 0.001;
  let ratio = 0;
  if (style === 'doubleR') ratio = midpointAnimation ? 0.75 : 1;
  else if (style === 'doubleL') ratio = midpointAnimation ? 0.25 : 0;
  else if (midpointAnimation) ratio = 0.5;
  const expectedX = ax + (dx * ratio);
  const expectedY = ay + (dy * ratio);
  const expectedRotation = Math.atan2(dy, dx) - (style === 'doubleR' ? Math.PI : 0);
  const expectedWidth = style === 'single' ? distance : distance / 2;
  return Math.abs(Number(closed.x) - expectedX) < 0.01
    && Math.abs(Number(closed.y) - expectedY) < 0.01
    && angleDistance(closed.rotation, expectedRotation) < 0.0001
    && Math.abs(Number(closed.scaleX) - (expectedWidth / textureWidth)) < 0.0001;
}

function collectTileBuildingReferences(tile, scene, state, visitedTileIds) {
  const tileId = String(tile?.id || '').trim();
  if (tileId && visitedTileIds.has(tileId)) return;
  if (tileId) {
    visitedTileIds.add(tileId);
    state.tileIds.add(tileId);
  }

  const building = readFlag(tile, 'building');
  const meta = building?.meta || {};
  addIds(state.wallIds, meta.wallIds);
  addId(state.groupIds, meta.wallGroupId);
  addIds(state.groupIds, meta.wallGroupIds);
  addIds(state.groupIds, meta.outerWallGroupIds);
  addIds(state.groupIds, meta.innerWallGroupIds);

  const composite = readFlag(tile, 'buildingComposite');
  addId(state.groupIds, composite?.wallGroupId);
  addIds(state.groupIds, composite?.wallGroupIds);
  addIds(state.groupIds, composite?.outerWallGroupIds);
  addIds(state.groupIds, composite?.innerWallGroupIds);

  for (const key of BUILDING_TYPED_TILE_FLAGS) {
    const typed = readFlag(tile, key);
    addId(state.groupIds, typed?.wallGroupId);
    addIds(state.groupIds, typed?.wallGroupIds);
  }

  const foregroundId = composite?.wallTileId
    || meta?.wallTileId
    || meta?.composite?.wallTileId
    || null;
  const foreground = collectionGet(scene?.tiles, foregroundId);
  if (foreground) collectTileBuildingReferences(foreground, scene, state, visitedTileIds);
}

export function resolveAffectedAnimatedPortalWalls(documents = []) {
  const input = Array.from(documents || []).filter(Boolean);
  const scene = input.find((document) => document?.parent)?.parent
    || globalThis.canvas?.scene
    || null;
  if (!scene) return [];

  const state = {
    wallIds: new Set(),
    groupIds: new Set(),
    tileIds: new Set()
  };
  const visitedTileIds = new Set();
  for (const document of input) {
    if (documentType(document) === 'Tile') {
      collectTileBuildingReferences(document, scene, state, visitedTileIds);
      continue;
    }
    if (documentType(document) !== 'Wall') continue;
    addId(state.wallIds, document.id);
    const buildingWall = readFlag(document, 'buildingWall');
    addId(state.groupIds, buildingWall?.groupId);
    addId(state.tileIds, buildingWall?.tileId);
    const ownerTile = collectionGet(scene?.tiles, buildingWall?.tileId);
    if (ownerTile) collectTileBuildingReferences(ownerTile, scene, state, visitedTileIds);
  }

  const affected = [];
  for (const wall of collectionValues(scene.walls)) {
    if (!isAnimatedBuildingPortal(wall)) continue;
    const buildingWall = readFlag(wall, 'buildingWall');
    const matches = state.wallIds.has(String(wall?.id || ''))
      || state.groupIds.has(String(buildingWall?.groupId || ''))
      || state.tileIds.has(String(buildingWall?.tileId || ''));
    if (matches) affected.push(wall);
  }
  return affected.sort((left, right) => String(left?.id || '').localeCompare(String(right?.id || '')));
}

export function resolvePortalVisualTargets(walls = [], {
  canvasRef = globalThis.canvas,
  proxyManager = null,
  shadowManager = null
} = {}) {
  const targets = [];
  const seen = new Set();
  const push = (wallId, kind, object) => {
    if (!object || object.destroyed || seen.has(object)) return;
    seen.add(object);
    targets.push({ wallId, kind, object });
  };
  for (const wall of Array.from(walls || []).filter(Boolean)) {
    const wallId = String(wall?.id || '').trim();
    if (!wallId) continue;
    const placeable = canvasRef?.walls?.get?.(wallId)
      || Array.from(canvasRef?.walls?.placeables || []).find((entry) => String(entry?.id || entry?.document?.id || '') === wallId)
      || null;
    for (const mesh of Array.from(placeable?.doorMeshes || [])) {
      push(wallId, 'current-level-mesh', mesh);
    }
    for (const mesh of Array.from(proxyManager?.getDoorMeshes?.(wallId) || [])) {
      push(wallId, 'proxy-mesh', mesh);
    }
    for (const container of Array.from(shadowManager?.getPortalShadowContainers?.(wallId) || [])) {
      push(wallId, 'shadow-container', container);
    }
  }
  return targets;
}

export function arePortalVisualsAuthoritative(walls = [], {
  canvasRef = globalThis.canvas,
  proxyManager = null,
  shadowManager = null
} = {}) {
  for (const wall of Array.from(walls || []).filter(Boolean)) {
    const wallId = String(wall?.id || '').trim();
    if (!wallId) return false;
    if (wall?.viewed !== false) {
      const placeable = canvasRef?.walls?.get?.(wallId)
        || Array.from(canvasRef?.walls?.placeables || []).find((entry) => (
          String(entry?.id || entry?.document?.id || '') === wallId
        ))
        || null;
      const currentMeshes = Array.from(placeable?.doorMeshes || [])
        .filter((mesh) => mesh && !mesh.destroyed);
      if (!currentMeshes.length) return false;
      if (!currentMeshes.every((mesh) => isDoorMeshSynchronized(mesh, wall))) return false;
    }
    const proxyMeshes = Array.from(proxyManager?.getDoorMeshes?.(wallId) || [])
      .filter((mesh) => mesh && !mesh.destroyed);
    if (!proxyMeshes.every((mesh) => isDoorMeshSynchronized(mesh, wall))) return false;
    if (proxyManager?.isDoorVisualReady?.(wallId) === false) return false;
    if (shadowManager?.isPortalShadowReady?.(wallId) === false) return false;
  }
  return true;
}

export class DoorTransformPreviewSuppressionController {
  constructor({
    resolveAffectedWalls = () => [],
    resolveTargets = () => [],
    isAuthoritativeReady = () => true,
    holdWall = () => {},
    releaseWall = () => {},
    holdWallTargetKind = null,
    releaseWallTargetKind = null,
    waitForNextHandoffCheck = () => new Promise((resolve) => setTimeout(resolve, 16)),
    reportBackgroundCheckError = (error, details) => {
      console.error('Animated portal background handoff check failed.', { error, details });
    },
    handoffTimeoutMs = 10_000
  } = {}) {
    this._resolveAffectedWalls = resolveAffectedWalls;
    this._resolveTargets = resolveTargets;
    this._isAuthoritativeReady = isAuthoritativeReady;
    this._holdWall = holdWall;
    this._releaseWall = releaseWall;
    this._holdWallTargetKind = typeof holdWallTargetKind === 'function' ? holdWallTargetKind : null;
    this._releaseWallTargetKind = typeof releaseWallTargetKind === 'function' ? releaseWallTargetKind : null;
    this._waitForNextHandoffCheck = waitForNextHandoffCheck;
    this._reportBackgroundCheckError = reportBackgroundCheckError;
    this._handoffTimeoutMs = handoffTimeoutMs;
    this._sessions = new Map();
    this._targetHolds = new Map();
    this._nextSessionId = 0;
  }

  begin({ documents = [], source = DEFAULT_SOURCE } = {}) {
    const walls = Array.from(this._resolveAffectedWalls(documents) || []).filter(Boolean);
    const wallIds = new Set(walls.map((wall) => String(wall?.id || '')).filter(Boolean));
    const session = {
      id: `door-transform-preview-${++this._nextSessionId}`,
      source: String(source || DEFAULT_SOURCE),
      walls,
      wallIds,
      documents: Array.from(documents || []).filter(Boolean),
      targets: new Set(),
      targetRecords: new Map(),
      targetIdentities: new Set(),
      heldWalls: new Set(),
      heldWallTargetKinds: new Map(),
      state: 'preview'
    };
    this._sessions.set(session.id, session);
    try {
      this._resolveAndHold(session);
      this._holdManagerTargets(session);
    } catch (error) {
      this._release(session);
      throw error;
    }
    return {
      id: session.id,
      wallIds: sorted(session.wallIds),
      describe: (phase = session.state) => this._describe(session, phase),
      prepareCommit: () => this._prepareCommit(session),
      cancel: (reason = 'cancel') => this._cancel(session, reason),
      commit: () => this._commit(session),
      continueCommit: () => this._continueCommit(session),
      fail: () => this._fail(session),
      abandon: () => this._abandon(session)
    };
  }

  diagnostics() {
    const wallIds = new Set();
    const targets = new Set();
    for (const session of this._sessions.values()) {
      for (const wallId of session.wallIds) wallIds.add(wallId);
      for (const identity of session.targetIdentities) targets.add(identity);
    }
    return {
      sessionCount: this._sessions.size,
      suppressedWallIds: sorted(wallIds),
      suppressedTargets: sorted(targets)
    };
  }

  revealSynchronizedPreviewTargets(wall, { proxyReady = false, shadowReady = false } = {}) {
    const wallId = String(wall?.id || '').trim();
    if (!wallId) return 0;
    const targets = Array.from(this._resolveTargets([wall]) || []).filter(Boolean);
    const proxyTargets = targets.filter((target) => target?.kind === 'proxy-mesh');
    const synchronizedProxyTargets = proxyReady && proxyTargets.length
      && proxyTargets.every((target) => isDoorMeshSynchronized(target.object, wall));
    const releasableTargets = targets.filter((target) => (
      (target?.kind === 'current-level-mesh' && isDoorMeshSynchronized(target.object, wall))
      || (target?.kind === 'proxy-mesh' && synchronizedProxyTargets)
      || (target?.kind === 'shadow-container' && shadowReady)
    ));
    if (!releasableTargets.length && !synchronizedProxyTargets && !shadowReady) return 0;

    let released = 0;
    for (const session of this._sessions.values()) {
      if (session.state !== 'preview' || !session.wallIds.has(wallId)) continue;
      for (const target of releasableTargets) {
        if (this._releaseTarget(session, target.object)) released += 1;
        session.targetRecords.set(target.object, targetIdentity(target));
      }
      if (synchronizedProxyTargets) this._releaseManagerTargetKind(session, wallId, 'proxy-mesh');
      if (shadowReady) this._releaseManagerTargetKind(session, wallId, 'shadow-container');
    }
    return released;
  }

  revealSynchronizedCurrentLevelMeshes(wall) {
    return this.revealSynchronizedPreviewTargets(wall);
  }

  _describe(session, phase = session?.state || 'unknown') {
    return {
      source: session?.source || DEFAULT_SOURCE,
      documents: Array.from(session?.documents || []).map((document) => ({
        type: documentType(document) || 'Document',
        id: String(document?.id || '')
      })),
      wallIds: sorted(session?.wallIds),
      targets: sorted(session?.targetIdentities),
      phase
    };
  }

  _resolveAndHold(session) {
    const targets = Array.from(this._resolveTargets(session.walls) || []).filter(Boolean);
    for (const target of targets) this._holdTarget(session, target);
  }

  _holdTarget(session, target) {
    const object = target?.object;
    // A target released after preview synchronization already owns the held
    // pose. Keep that same display visible through source reset and commit;
    // replacement objects still acquire their own hold until they are ready.
    if (!object || object.destroyed || session.targetRecords.has(object)) return;
    let hold = this._targetHolds.get(object);
    if (!hold) {
      hold = {
        sessions: new Set(),
        visible: object.visible,
        renderable: object.renderable
      };
      this._targetHolds.set(object, hold);
    }
    hold.sessions.add(session.id);
    session.targets.add(object);
    const identity = targetIdentity(target);
    session.targetRecords.set(object, identity);
    session.targetIdentities.add(identity);
    object.visible = false;
    object.renderable = false;
  }

  _holdManagerTargets(session) {
    if (!this._holdWallTargetKind || !this._releaseWallTargetKind) {
      for (const wall of session.walls) {
        if (session.heldWalls.has(wall)) continue;
        this._holdWall(wall);
        session.heldWalls.add(wall);
      }
      return;
    }
    for (const wall of session.walls) {
      const wallId = String(wall?.id || '').trim();
      if (!wallId) continue;
      for (const kind of ['proxy-mesh', 'shadow-container']) {
        const key = `${wallId}/${kind}`;
        if (session.heldWallTargetKinds.has(key)) continue;
        this._holdWallTargetKind(wall, kind);
        session.heldWallTargetKinds.set(key, { wall, kind });
      }
    }
  }

  _releaseManagerTargetKind(session, wallId, kind) {
    const key = `${wallId}/${kind}`;
    const held = session?.heldWallTargetKinds?.get(key);
    if (!held) return false;
    session.heldWallTargetKinds.delete(key);
    this._releaseWallTargetKind?.(held.wall, held.kind);
    return true;
  }

  _releaseTarget(session, object) {
    if (!session?.targets?.has(object)) return false;
    const hold = this._targetHolds.get(object);
    const identity = session.targetRecords.get(object);
    session.targets.delete(object);
    if (identity && !Array.from(session.targets).some(target => session.targetRecords.get(target) === identity)) {
      session.targetIdentities.delete(identity);
    }
    if (!hold) return true;
    hold.sessions.delete(session.id);
    if (hold.sessions.size) return true;
    this._targetHolds.delete(object);
    if (!object.destroyed) {
      object.visible = hold.visible;
      object.renderable = hold.renderable;
    }
    return true;
  }

  _cancel(session) {
    if (!session || session.state === 'done') return false;
    session.state = 'done';
    this._release(session);
    return true;
  }

  _prepareCommit(session) {
    if (!session || session.state !== 'preview') return false;
    this._resolveAndHold(session);
    session.state = 'prepared';
    return true;
  }

  async _commit(session) {
    if (!session || session.state === 'done') return false;
    if (session.pending) return session.pending;
    session.state = 'commit';
    const pending = this._waitForHandoff(session, { phase: 'commit-handoff', releaseOnFailure: false });
    session.pending = pending;
    try {
      return await pending;
    } catch (error) {
      session.state = 'failed';
      throw error;
    } finally {
      if (session.pending === pending) session.pending = null;
    }
  }

  async _continueCommit(session) {
    if (!session || session.state === 'done') return false;
    if (session.pending) return session.pending;
    session.state = 'commit-background';
    const pending = this._waitForHandoff(session, {
      phase: 'commit-background-handoff',
      releaseOnFailure: false,
      timeoutMs: null,
      continueOnCheckError: true
    });
    session.pending = pending;
    try {
      return await pending;
    } catch (error) {
      session.state = 'failed';
      throw error;
    } finally {
      if (session.pending === pending) session.pending = null;
    }
  }

  async _fail(session) {
    if (!session || session.state === 'done') return false;
    if (session.pending) return session.pending;
    session.state = 'rollback';
    const pending = this._waitForHandoff(session, { phase: 'rollback-handoff', releaseOnFailure: true });
    session.pending = pending;
    try {
      return await pending;
    } finally {
      if (session.pending === pending) session.pending = null;
    }
  }

  async _waitForHandoff(session, {
    phase,
    releaseOnFailure,
    timeoutMs = this._handoffTimeoutMs,
    continueOnCheckError = false
  }) {
    const startedAt = Date.now();
    while (true) {
      if (!this._sessions.has(session.id) || session.state === 'done') return false;
      try {
        this._resolveAndHold(session);
        if (this._isAuthoritativeReady(session.walls)) {
          this._release(session);
          session.state = 'done';
          return true;
        }
      } catch (error) {
        if (!continueOnCheckError) throw error;
        this._reportBackgroundCheckError(error, this._describe(session, phase));
      }
      if (timeoutMs != null && Date.now() - startedAt >= timeoutMs) {
        const error = new Error(
          `Timed out waiting for authoritative portal visuals: ${sorted(session.wallIds).join(', ') || 'unknown Wall'}.`
        );
        error.name = 'DoorTransformPreviewSuppressionError';
        error.details = this._describe(session, phase);
        if (releaseOnFailure) {
          this._release(session);
          session.state = 'done';
        }
        throw error;
      }
      await this._waitForNextHandoffCheck();
    }
  }

  _abandon(session) {
    if (!session || session.state === 'done') return false;
    session.state = 'done';
    this._release(session);
    return true;
  }

  cancelAll(reason = 'manual') {
    for (const session of Array.from(this._sessions.values())) {
      this._cancel(session, reason);
    }
  }

  _release(session) {
    for (const object of Array.from(session?.targets || [])) this._releaseTarget(session, object);
    session?.targets?.clear?.();
    session?.targetRecords?.clear?.();
    for (const wall of session?.heldWalls || []) {
      this._releaseWall(wall);
    }
    session?.heldWalls?.clear?.();
    for (const { wall, kind } of session?.heldWallTargetKinds?.values?.() || []) {
      this._releaseWallTargetKind?.(wall, kind);
    }
    session?.heldWallTargetKinds?.clear?.();
    this._sessions.delete(session?.id);
  }
}
