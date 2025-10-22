import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const SETTING_KEY = 'tokenElevationOffset';
const OFFSET = 0.999;
const EPSILON = 1e-4;

function isEnabled() {
  try { return game.settings.get(MODULE_ID, SETTING_KEY) !== false; }
  catch (_) { return true; }
}

function applyTokenElevationOffset(token, { reason = 'refresh', force = false } = {}) {
  try {
    if (!token || token.destroyed) return;
    const mesh = token.mesh;
    const doc = token.document;
    if (!mesh || mesh.destroyed || !doc) return;
    if (!isEnabled()) {
      restoreTokenElevation(token, { reason: 'disabled' });
      return;
    }
    const baseElevation = Number(doc.elevation ?? 0) || 0;
    const bumpedElevation = baseElevation + OFFSET;
    if (!force && mesh.faNexusElevationOffsetApplied && Math.abs(mesh.elevation - bumpedElevation) <= EPSILON) {
      return;
    }
    mesh.elevation = bumpedElevation;
    mesh.faNexusElevationBase = baseElevation;
    mesh.faNexusElevationOffset = OFFSET;
    mesh.faNexusElevationOffsetApplied = true;
    const hoverFadeThreshold = canvas?.primary?.hoverFadeElevation ?? 0;
    // Offsetting elevation pushes tokens past hoverFadeElevation; suppress hover fade to avoid tile-edit flicker.
    if ('hoverFade' in mesh) {
      if ((bumpedElevation > hoverFadeThreshold) && (baseElevation <= hoverFadeThreshold)) {
        if (mesh.faNexusElevationHoverFadeOriginal === undefined) {
          mesh.faNexusElevationHoverFadeOriginal = mesh.hoverFade;
        }
        if (mesh.hoverFade) mesh.hoverFade = false;
        mesh.faNexusElevationHoverFadeSuppressed = true;
      } else if (mesh.faNexusElevationHoverFadeSuppressed) {
        const originalHoverFade = mesh.faNexusElevationHoverFadeOriginal;
        if (originalHoverFade !== undefined) mesh.hoverFade = originalHoverFade;
        delete mesh.faNexusElevationHoverFadeOriginal;
        delete mesh.faNexusElevationHoverFadeSuppressed;
      }
    }
    // Keep tokens above tiles at same integer by nudging zIndex too
    const sort = Number(doc.sort ?? 0) || 0;
    mesh.sort = sort;
    mesh.zIndex = sort;
    if (mesh.parent) mesh.parent.sortDirty = true;
    Logger.debug('TokenElevationOffset.apply', { tokenId: doc.id, baseElevation, bumpedElevation, reason });
  } catch (error) {
    Logger.warn('TokenElevationOffset.apply.failed', String(error?.message || error));
  }
}

function restoreTokenElevation(token, { reason = 'restore' } = {}) {
  try {
    if (!token || token.destroyed) return;
    const mesh = token.mesh;
    const doc = token.document;
    if (!mesh || mesh.destroyed || !doc) return;
    const base = Number(doc.elevation ?? mesh.faNexusElevationBase ?? 0) || 0;
    if (Math.abs((mesh.faNexusElevationBase ?? base) - base) > EPSILON || Math.abs(mesh.elevation - base) > EPSILON) {
      mesh.elevation = base;
    }
    const sort = Number(doc.sort ?? 0) || 0;
    mesh.sort = sort;
    mesh.zIndex = sort;
    if (mesh.parent) mesh.parent.sortDirty = true;
    if ('hoverFade' in mesh) {
      const originalHoverFade = mesh.faNexusElevationHoverFadeOriginal;
      if (mesh.faNexusElevationHoverFadeSuppressed && originalHoverFade !== undefined) {
        mesh.hoverFade = originalHoverFade;
      }
      delete mesh.faNexusElevationHoverFadeOriginal;
      delete mesh.faNexusElevationHoverFadeSuppressed;
    }
    delete mesh.faNexusElevationBase;
    delete mesh.faNexusElevationOffset;
    delete mesh.faNexusElevationOffsetApplied;
    Logger.debug('TokenElevationOffset.restore', { tokenId: doc.id, base, reason });
  } catch (error) {
    Logger.warn('TokenElevationOffset.restore.failed', String(error?.message || error));
  }
}

function applyAllTokens(reason, { force = false } = {}) {
  try {
    const tokens = Array.isArray(canvas?.tokens?.placeables) ? canvas.tokens.placeables : [];
    for (const token of tokens) {
      applyTokenElevationOffset(token, { reason, force });
    }
  } catch (error) {
    Logger.warn('TokenElevationOffset.applyAll.failed', String(error?.message || error));
  }
}

try {
  Hooks.on('refreshToken', (token) => applyTokenElevationOffset(token, { reason: 'refresh' }));
  Hooks.on('canvasReady', () => applyAllTokens('canvasReady', { force: true }));
  Hooks.on('updateToken', (scene, doc) => {
    try {
      const token = canvas?.tokens?.get?.(doc.id);
      if (token) applyTokenElevationOffset(token, { reason: 'update', force: true });
    } catch (_) {}
  });
  Hooks.on('fa-nexus-token-elevation-offset-changed', ({ enabled }) => {
    try {
      if (enabled) applyAllTokens('setting-enabled', { force: true });
      else restoreAllTokens('setting-disabled');
    } catch (error) {
      Logger.warn('TokenElevationOffset.settingChange.failed', String(error?.message || error));
    }
  });
} catch (error) {
  console.warn('[fa-nexus] token-elevation-offset init failed', error);
}

function restoreAllTokens(reason) {
  try {
    const tokens = Array.isArray(canvas?.tokens?.placeables) ? canvas.tokens.placeables : [];
    for (const token of tokens) {
      restoreTokenElevation(token, { reason });
    }
  } catch (error) {
    Logger.warn('TokenElevationOffset.restoreAll.failed', String(error?.message || error));
  }
}

export { applyTokenElevationOffset, restoreTokenElevation };
