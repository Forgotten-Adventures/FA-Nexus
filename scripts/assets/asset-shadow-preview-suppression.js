import { NexusLogger as Logger } from '../core/nexus-logger.js';

const controllers = new WeakMap();

function documentType(document) {
  return String(document?.documentName || document?.constructor?.metadata?.name || '').trim();
}

function tileId(document) {
  return String(document?.id || document?._id || '').trim();
}

function sorted(values) {
  return Array.from(values || []).map(String).filter(Boolean).sort();
}

function chunkIdentity(layerKey, chunkKey) {
  return `${layerKey}/${chunkKey}`;
}

function createFailure(message, { source, tileIds, chunks, layerKeys, cause } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'AssetShadowPreviewSuppressionError';
  error.details = {
    source: source || 'unknown',
    tileIds: sorted(tileIds),
    chunks: sorted(chunks),
    layerKeys: sorted(layerKeys)
  };
  return error;
}

export class AssetShadowPreviewSuppressionController {
  constructor(manager) {
    this.manager = manager;
    this._sessions = new Map();
    this._chunkHolds = new Map();
    this._nextSessionId = 0;
  }

  begin({ documents = [], source = 'unknown', operation = 'suppress', pivot = null } = {}) {
    const tileIds = new Set(
      Array.from(documents || [])
        .filter((document) => documentType(document) === 'Tile')
        .map(tileId)
        .filter(Boolean)
    );
    const session = {
      id: `asset-shadow-preview-${++this._nextSessionId}`,
      source: String(source || 'unknown'),
      tileIds,
      layerKeys: new Set(),
      chunkIdentities: new Set(),
      chunks: new Set(),
      operation: String(operation || 'suppress').trim().toLowerCase(),
      previewSplits: [],
      translation: { x: 0, y: 0 },
      rotation: {
        angle: 0,
        pivot: {
          x: Number(pivot?.x),
          y: Number(pivot?.y)
        }
      },
      scale: {
        factor: 1,
        pivot: {
          x: Number(pivot?.x),
          y: Number(pivot?.y)
        }
      },
      rebuildsSuspended: false,
      state: 'preview'
    };
    this._sessions.set(session.id, session);

    try {
      session.ready = ['translate', 'rotate', 'scale'].includes(session.operation)
        ? this._prepareSplitPreview(session)
        : Promise.resolve((this._resolveAndHold(session), true));
    } catch (cause) {
      this._release(session);
      throw createFailure('Failed to suppress affected asset shadow chunks.', {
        source: session.source,
        tileIds: session.tileIds,
        chunks: session.chunkIdentities,
        layerKeys: session.layerKeys,
        cause
      });
    }

    return {
      id: session.id,
      tileIds: sorted(session.tileIds),
      ready: session.ready,
      updateTranslation: (delta) => this._updateTranslation(session, delta),
      updateRotation: (transform) => this._updateRotation(session, transform),
      updateScale: (transform) => this._updateScale(session, transform),
      prepareCommit: () => this._prepareCommit(session),
      cancel: () => this._cancel(session),
      commit: () => this._commit(session, { failure: false }),
      fail: () => this._commit(session, { failure: true }),
      abandon: (reason = 'handoff-failed') => this._abandon(session, reason)
    };
  }

  syncChunk(layerKey, chunk, tileIds = []) {
    if (!chunk) return;
    chunk.tileIds = new Set(Array.from(tileIds || []).map(String).filter(Boolean));
    for (const session of this._sessions.values()) {
      if (session.state === 'done' || !this._chunkAffectsSession(chunk, session)) continue;
      session.layerKeys.add(String(layerKey));
      this._holdChunk(session, String(layerKey), chunk);
    }
  }

  applyChunkVisibility(layerKey, chunk) {
    if (!chunk?.sprite || chunk.sprite.destroyed) return;
    const hold = this._chunkHolds.get(chunk);
    if (!hold?.sessions?.size) return;
    // A completed render has made this chunk authoritative. Keep it hidden for
    // the handoff, but reveal this final texture when the last session releases.
    hold.visible = true;
    hold.renderable = true;
    chunk.sprite.visible = false;
    chunk.sprite.renderable = false;
  }

  cancelAll(reason = 'manual') {
    for (const session of Array.from(this._sessions.values())) {
      this._cancel(session, reason);
    }
  }

  diagnostics() {
    const suppressedTileIds = new Set();
    const suppressedChunks = new Set();
    for (const session of this._sessions.values()) {
      for (const id of session.tileIds) suppressedTileIds.add(id);
      for (const identity of session.chunkIdentities) suppressedChunks.add(identity);
    }
    return {
      sessionCount: this._sessions.size,
      suppressedTileIds: sorted(suppressedTileIds),
      suppressedChunks: sorted(suppressedChunks)
    };
  }

  _resolveAndHold(session) {
    for (const { layerKey, chunk } of this._resolveAffectedChunks(session)) {
      session.layerKeys.add(layerKey);
      this._holdChunk(session, layerKey, chunk);
    }
  }

  _resolveAffectedChunks(session) {
    const affected = [];
    const seen = new Set();
    for (const id of session.tileIds) {
      const layerKey = this.manager?._tileIndex?.get?.(id);
      if (layerKey == null) continue;
      const normalizedLayerKey = String(layerKey);
      session.layerKeys.add(normalizedLayerKey);
      const layer = this.manager?._layers?.get?.(layerKey)
        || this.manager?._layers?.get?.(normalizedLayerKey);
      for (const chunk of layer?.renderChunks?.values?.() || []) {
        if (!chunk?.tileIds?.has?.(id)) continue;
        if (seen.has(chunk)) continue;
        seen.add(chunk);
        affected.push({ layerKey: normalizedLayerKey, layer, chunk });
      }
    }
    return affected;
  }

  async _prepareSplitPreview(session) {
    const affected = this._resolveAffectedChunks(session);
    if (!affected.length) return true;
    const prepare = this.manager?.prepareTransformPreviewShadowSplit;
    if (typeof prepare !== 'function') {
      this._resolveAndHold(session);
      Logger.warn('AssetShadow.previewSuppression.transformSplitUnavailable', {
        source: session.source,
        operation: session.operation,
        tileIds: sorted(session.tileIds)
      });
      globalThis.ui?.notifications?.warn?.(
        `Live shadow ${session.operation} preview is unavailable; affected shadows will remain hidden until the gesture finishes.`
      );
      return false;
    }

    const prepared = [];
    try {
      const splits = await Promise.all(affected.map(({ layerKey, layer, chunk }) => prepare.call(this.manager, {
        sessionId: session.id,
        layerKey,
        layer,
        chunk,
        movingTileIds: session.tileIds
      })));
      for (const split of splits) {
        if (!split) throw new Error(`Asset shadow ${session.operation} split produced no preview resources.`);
        prepared.push(split);
      }
      if (session.state !== 'preview') {
        for (const split of prepared) split?.destroy?.();
        return false;
      }
      session.previewSplits.push(...prepared);
      for (const { layerKey, chunk } of affected) this._holdChunk(session, layerKey, chunk);
      for (const split of session.previewSplits) {
        split?.activate?.();
        if (session.operation === 'translate') split?.updateTranslation?.(session.translation);
        else if (session.operation === 'rotate') split?.updateRotation?.(session.rotation);
        else split?.updateScale?.(session.scale);
      }
      return true;
    } catch (cause) {
      for (const split of prepared) split?.destroy?.();
      if (session.state === 'preview') this._resolveAndHold(session);
      Logger.error('AssetShadow.previewSuppression.transformSplitFailed', {
        source: session.source,
        operation: session.operation,
        tileIds: sorted(session.tileIds),
        chunks: affected.map(({ layerKey, chunk }) => chunkIdentity(layerKey, String(chunk?.key || 'unknown'))),
        error: String(cause?.message || cause)
      });
      globalThis.ui?.notifications?.warn?.(
        `Live shadow ${session.operation} preview could not be prepared; affected shadows will remain hidden until the gesture finishes.`
      );
      return false;
    }
  }

  _updateTranslation(session, delta = {}) {
    if (!session || session.state !== 'preview' || session.operation !== 'translate') return false;
    const x = Number(delta?.x);
    const y = Number(delta?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    session.translation = { x, y };
    for (const split of session.previewSplits) split?.updateTranslation?.(session.translation);
    return true;
  }

  _updateRotation(session, transform = {}) {
    if (!session || session.state !== 'preview' || session.operation !== 'rotate') return false;
    const angle = Number(transform?.angle);
    const x = Number(transform?.pivot?.x ?? session.rotation?.pivot?.x);
    const y = Number(transform?.pivot?.y ?? session.rotation?.pivot?.y);
    if (![angle, x, y].every(Number.isFinite)) return false;
    session.rotation = { angle, pivot: { x, y } };
    for (const split of session.previewSplits) split?.updateRotation?.(session.rotation);
    return true;
  }

  _updateScale(session, transform = {}) {
    if (!session || session.state !== 'preview' || session.operation !== 'scale') return false;
    const factor = Number(transform?.factor);
    const x = Number(transform?.pivot?.x ?? session.scale?.pivot?.x);
    const y = Number(transform?.pivot?.y ?? session.scale?.pivot?.y);
    if (!Number.isFinite(factor) || factor <= 0 || ![x, y].every(Number.isFinite)) return false;
    session.scale = { factor, pivot: { x, y } };
    for (const split of session.previewSplits) split?.updateScale?.(session.scale);
    return true;
  }

  _chunkAffectsSession(chunk, session) {
    for (const id of session.tileIds) {
      if (chunk?.tileIds?.has?.(id)) return true;
    }
    return false;
  }

  _holdChunk(session, layerKey, chunk) {
    if (session.chunks.has(chunk)) return;
    const chunkKey = String(chunk?.key || 'unknown');
    let hold = this._chunkHolds.get(chunk);
    if (!hold) {
      hold = {
        sessions: new Set(),
        visible: chunk?.sprite?.visible !== false,
        renderable: chunk?.sprite?.renderable !== false
      };
      this._chunkHolds.set(chunk, hold);
    }
    hold.sessions.add(session.id);
    session.chunks.add(chunk);
    session.chunkIdentities.add(chunkIdentity(layerKey, chunkKey));
    if (chunk?.sprite && !chunk.sprite.destroyed) {
      chunk.sprite.visible = false;
      chunk.sprite.renderable = false;
    }
  }

  _cancel(session, reason = 'cancel') {
    if (!session || session.state === 'done') return false;
    session.state = 'done';
    this._resumeRebuilds(session, { immediate: false });
    this._release(session);
    Logger.debug?.('AssetShadow.previewSuppression.cancelled', {
      reason,
      source: session.source,
      tileIds: sorted(session.tileIds),
      chunks: sorted(session.chunkIdentities)
    });
    return true;
  }

  _prepareCommit(session) {
    if (!session || session.state !== 'preview' || session.rebuildsSuspended) return false;
    if (!session.layerKeys.size || typeof this.manager?.suspendRebuilds !== 'function') return false;
    this.manager.suspendRebuilds();
    session.rebuildsSuspended = true;
    return true;
  }

  async _commit(session, { failure }) {
    if (!session || session.state === 'done') return false;
    if (session.state === 'commit') return session.pending;
    session.state = 'commit';
    this._resolveAndHold(session);
    const layerKeys = sorted(session.layerKeys);
    const pending = (async () => {
      try {
        const queuedBeforeResume = new Set(
          layerKeys.filter((layerKey) => this._hasScheduledAuthoritativeRebuild(layerKey))
        );
        this._resumeRebuilds(session, { immediate: true });
        this._ensureAuthoritativeRebuilds(layerKeys, queuedBeforeResume);
        await this.manager?._rebuildWorkflow?.waitFor?.(layerKeys);
        this._release(session);
        session.state = 'done';
        return true;
      } catch (cause) {
        if (failure) {
          this._release(session);
          session.state = 'done';
        } else {
          session.state = 'failed';
          for (const chunk of session.chunks) this.applyChunkVisibility(null, chunk);
        }
        const error = createFailure(
          failure
            ? 'Failed to restore authoritative asset shadows after a transform rollback.'
            : 'Failed to rebuild authoritative asset shadows after a transform commit.',
          {
            source: session.source,
            tileIds: session.tileIds,
            chunks: session.chunkIdentities,
            layerKeys,
            cause
          }
        );
        Logger.error('AssetShadow.previewSuppression.handoffFailed', error.details, {
          error: String(cause?.message || cause)
        });
        throw error;
      } finally {
        if (session.state === 'done') this._sessions.delete(session.id);
      }
    })();
    session.pending = pending;
    return pending;
  }

  _hasScheduledAuthoritativeRebuild(layerKey) {
    const workflow = this.manager?._rebuildWorkflow;
    const layer = this.manager?._layers?.get?.(layerKey);
    return !!(
      layer?.rebuilding
      || workflow?._running?.has?.(layerKey)
      || workflow?._timers?.has?.(layerKey)
      || workflow?._pending?.has?.(layerKey)
    );
  }

  _ensureAuthoritativeRebuilds(layerKeys, queuedBeforeResume = new Set()) {
    for (const layerKey of layerKeys) {
      const alreadyScheduled = queuedBeforeResume.has(layerKey)
        || this._hasScheduledAuthoritativeRebuild(layerKey);
      if (!alreadyScheduled) this.manager?._scheduleRebuild?.(layerKey, true);
    }
  }

  _release(session) {
    this._releasePreviewSplits(session);
    for (const chunk of session?.chunks || []) {
      const hold = this._chunkHolds.get(chunk);
      if (!hold) continue;
      hold.sessions.delete(session.id);
      if (hold.sessions.size) continue;
      this._chunkHolds.delete(chunk);
      if (!chunk?.sprite || chunk.sprite.destroyed) continue;
      chunk.sprite.visible = hold.visible;
      chunk.sprite.renderable = hold.renderable;
    }
    session?.chunks?.clear?.();
    this._sessions.delete(session?.id);
  }

  _releasePreviewSplits(session) {
    for (const split of session?.previewSplits || []) {
      try { split?.destroy?.(); } catch (_) {}
    }
    if (session?.previewSplits) session.previewSplits.length = 0;
  }

  _abandon(session, reason) {
    if (!session || session.state === 'done') return false;
    session.state = 'done';
    this._resumeRebuilds(session, { immediate: false });
    const discardedChunks = [];
    for (const [layerKey, layer] of this.manager?._layers || []) {
      for (const [chunkKey, chunk] of layer?.renderChunks || []) {
        if (!session.chunks.has(chunk)) continue;
        const hold = this._chunkHolds.get(chunk);
        if ((hold?.sessions?.size || 0) > 1) continue;
        layer.renderChunks.delete(chunkKey);
        this.manager?._destroyLayerRenderChunk?.(layer, chunk);
        discardedChunks.push(chunkIdentity(layerKey, chunkKey));
      }
    }
    this._release(session);
    for (const layerKey of session.layerKeys) this.manager?._scheduleRebuild?.(layerKey, true);
    Logger.error('AssetShadow.previewSuppression.abandoned', {
      reason,
      source: session.source,
      tileIds: sorted(session.tileIds),
      discardedChunks: sorted(discardedChunks),
      layerKeys: sorted(session.layerKeys)
    });
    return true;
  }

  _resumeRebuilds(session, { immediate }) {
    if (!session?.rebuildsSuspended) return false;
    session.rebuildsSuspended = false;
    this.manager?.resumeRebuilds?.({ immediate: !!immediate });
    return true;
  }
}

export function getAssetShadowPreviewSuppressionController(manager) {
  if (!manager || (typeof manager !== 'object' && typeof manager !== 'function')) {
    throw new TypeError('Asset shadow preview suppression requires a manager.');
  }
  let controller = controllers.get(manager);
  if (!controller) {
    controller = new AssetShadowPreviewSuppressionController(manager);
    controllers.set(manager, controller);
  }
  return controller;
}
