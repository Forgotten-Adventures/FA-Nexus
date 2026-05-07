export function getApplicationHostContext(app, { includeAppState = false } = {}) {
  const details = {
    canvasReady: !!canvas?.ready,
    hasCanvasStage: !!canvas?.stage
  };
  if (includeAppState) {
    details.appRendered = !!app?.rendered;
    details.hasAppElement = !!app?.element;
  }
  return details;
}

export function getCurrentSceneId() {
  try {
    return String(canvas?.scene?.id || '').trim();
  } catch (_) {
    return '';
  }
}

export function isHostedSessionSceneCurrent(expectedSceneId) {
  const expected = String(expectedSceneId || '').trim();
  if (!expected) return true;
  const current = getCurrentSceneId();
  return !!current && current === expected;
}

export function buildHostedSessionContextDetails({
  app = null,
  delegate = null,
  includeAppState = false,
  tileId,
  editingTileId,
  editingMode,
  extra = null
} = {}) {
  const details = {
    delegateActive: !!delegate?.isActive,
    ...getApplicationHostContext(app, { includeAppState })
  };
  if (tileId !== undefined) details.tileId = tileId || null;
  if (editingTileId !== undefined) details.editingTileId = editingTileId || null;
  if (editingMode !== undefined) details.editingMode = editingMode || null;
  if (extra && typeof extra === 'object') Object.assign(details, extra);
  return details;
}

export function canRecoverHostedSessionFromCanvasTeardown(app) {
  try {
    if (canvas?.ready) return false;
    if (!canvas?.stage) return false;
    if (!app) return false;
    if (app.rendered === false) return false;
    if (!app.element) return false;
    return true;
  } catch (_) {
    return false;
  }
}

export function isApplicationHostReady(app) {
  try {
    const details = getApplicationHostContext(app, { includeAppState: true });
    if (!details.canvasReady || !details.hasCanvasStage) return false;
    if (!app) return false;
    if (app.rendered === false) return false;
    if (!app.element) return false;
    return true;
  } catch (_) {
    return false;
  }
}
