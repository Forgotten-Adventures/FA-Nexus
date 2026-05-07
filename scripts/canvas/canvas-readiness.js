export function getCanvasReadiness({
  canvasRef = globalThis?.canvas,
  requireScene = false,
  requireStage = false,
  requireTiles = false,
  requireRenderer = false,
  requireInterface = false,
  requirePrimary = false
} = {}) {
  const activeCanvas = canvasRef || null;
  const details = {
    canvas: activeCanvas,
    hasCanvas: !!activeCanvas,
    canvasReady: !!activeCanvas?.ready,
    hasScene: !!activeCanvas?.scene,
    hasStage: !!activeCanvas?.stage,
    hasTiles: !!activeCanvas?.tiles,
    hasRenderer: !!activeCanvas?.app?.renderer,
    hasInterface: !!activeCanvas?.interface,
    hasPrimary: !!activeCanvas?.primary
  };
  details.isReady = !!(
    details.hasCanvas
    && details.canvasReady
    && (!requireScene || details.hasScene)
    && (!requireStage || details.hasStage)
    && (!requireTiles || details.hasTiles)
    && (!requireRenderer || details.hasRenderer)
    && (!requireInterface || details.hasInterface)
    && (!requirePrimary || details.hasPrimary)
  );
  return details;
}

export function isCanvasReadyFor(requirements = {}) {
  return getCanvasReadiness(requirements).isReady;
}

export function onCanvasReady(callback, {
  hooks = globalThis?.Hooks,
  once = false,
  catchUp = 'microtask'
} = {}) {
  if (typeof callback !== 'function') return;
  const method = once ? 'once' : 'on';
  if (hooks && typeof hooks[method] === 'function') {
    hooks[method]('canvasReady', callback);
  }
  if (!isCanvasReadyFor()) return;
  if (catchUp === 'sync') {
    callback();
    return;
  }
  if (catchUp === 'timeout') {
    setTimeout(callback, 0);
    return;
  }
  queueMicrotask(callback);
}
