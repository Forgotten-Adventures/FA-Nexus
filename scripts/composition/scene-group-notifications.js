const BLOCKED_MESSAGES = Object.freeze({
  'document-move-locked': 'This group contains locked items. Unlock them before moving it.',
  'document-transform-locked': 'This group contains locked items. Unlock them before transforming it.',
  'document-update-forbidden': 'You do not have permission to change every item in this group.'
});

export function isSceneGroupOperationBlocked(error) {
  return Object.hasOwn(BLOCKED_MESSAGES, error?.code);
}

/** Toasts are summaries; callers retain complete errors and identities in diagnostics. */
export function sceneGroupFailureMessage(error, context = 'Scene Group operation failed') {
  if (error?.code === 'missing-document') return 'This Scene has references to deleted items. Open Scene Groups and choose Recover.';
  if (error?.code === 'BUILDING_COMMIT_MUTEX_TIMEOUT') return 'Another Scene operation has not finished. If it was interrupted, open Scene Groups and choose Recover.';
  if (error?.code === 'mixed-selection-depth') return 'The selection mixes items of different Scene Groups. A new group can be made from items of one group, or from items that are in no group.';
  if (isSceneGroupOperationBlocked(error)) return BLOCKED_MESSAGES[error.code];
  const detail = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  if (!detail || detail.length > 160 || (error?.identities?.length || 0) > 3) return `${context}. See the console for details.`;
  return `${context}: ${detail}`;
}

export function notifySceneGroupFailure(error, context) {
  const severity = isSceneGroupOperationBlocked(error) ? 'info' : 'error';
  globalThis.ui?.notifications?.[severity]?.(sceneGroupFailureMessage(error, context));
}
