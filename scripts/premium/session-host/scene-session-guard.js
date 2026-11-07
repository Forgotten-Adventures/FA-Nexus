import { NexusLogger as Logger } from '../../core/nexus-logger.js';
import { resolveTileDocument } from './editing-targets.js';
import {
  buildHostedSessionContextDetails,
  getCurrentSceneId,
  isApplicationHostReady,
  isHostedSessionSceneCurrent
} from './host-context.js';
import { stopOrphanedSession as stopHostedOrphanedSession } from './session-lifecycle.js';

export function snapshotHostedSessionScene(owner, {
  target = null,
  phase = 'start',
  loggerPrefix = 'PremiumSessionHost',
  resolveDocument = resolveTileDocument
} = {}) {
  const doc = resolveDocument(target);
  const sceneId = String(doc?.parent?.id || getCurrentSceneId() || '').trim();
  owner._sessionSceneId = sceneId || null;
  if (!sceneId) {
    Logger.warn?.(`${loggerPrefix}.session.sceneIdMissing`, { phase });
  }
  return owner._sessionSceneId;
}

export function isHostedSceneSessionHostReady(owner, {
  app = null,
  isEditorHostReady = null
} = {}) {
  const hostReady = typeof isEditorHostReady === 'function'
    ? !!isEditorHostReady()
    : isApplicationHostReady(app);
  if (!hostReady) {
    owner._hostUnavailableReason = 'host-context-unavailable';
    return false;
  }
  if (!isHostedSessionSceneCurrent(owner._sessionSceneId)) {
    owner._hostUnavailableReason = 'scene-changed-during-editor-session';
    return false;
  }
  owner._hostUnavailableReason = 'host-context-unavailable';
  return true;
}

export function handleInactiveHostedSceneSessionStop(owner, {
  loggerPrefix = 'PremiumSessionHost',
  details = null
} = {}) {
  if (owner._sessionSceneId && !isHostedSessionSceneCurrent(owner._sessionSceneId)) {
    Logger.warn?.(`${loggerPrefix}.session.sceneChangedInactive`, {
      reason: 'scene-changed-during-editor-session',
      sessionSceneId: owner._sessionSceneId || null,
      currentSceneId: getCurrentSceneId() || null,
      ...(details && typeof details === 'object' ? details : {})
    });
  }
  owner._sessionSceneId = null;
}

export function stopOrphanedHostedSceneSession(owner, {
  reason = 'host-context-unavailable',
  loggerPrefix = 'PremiumSessionHost',
  app = null,
  delegate = null,
  contextDetails = null,
  cancelToolWindowMonitor = null,
  stopSession = null,
  onFallbackCleanup = null
} = {}) {
  const { extra = null, ...baseContextDetails } = contextDetails && typeof contextDetails === 'object'
    ? contextDetails
    : {};
  return stopHostedOrphanedSession({
    reason,
    loggerPrefix,
    details: buildHostedSessionContextDetails({
      app,
      delegate,
      includeAppState: true,
      ...baseContextDetails,
      extra: {
        ...(extra && typeof extra === 'object' ? extra : {}),
        sessionSceneId: owner._sessionSceneId || null,
        currentSceneId: getCurrentSceneId() || null
      }
    }),
    cancelToolWindowMonitor,
    stopSession,
    onFallbackCleanup
  });
}
