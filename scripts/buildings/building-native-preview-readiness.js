export async function waitForStableNativePreview({
  getState,
  waitForFrame = null,
  maxAttempts = 12
} = {}) {
  if (typeof getState !== 'function') {
    throw new TypeError('Native preview readiness requires a state reader.');
  }

  let observedFrame = false;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const state = getState() || {};
    if (state.failure) throw state.failure;
    const running = state.running || null;
    if (running) {
      await running;
      continue;
    }
    if (Number(state.applied || 0) < Number(state.requested || 0)) break;
    if (!observedFrame && typeof waitForFrame === 'function') {
      observedFrame = true;
      await waitForFrame();
      continue;
    }
    return true;
  }

  const state = getState() || {};
  throw new Error(
    `Native preview did not drain after ${maxAttempts} observed tasks `
    + `(requested ${Number(state.requested || 0)}, applied ${Number(state.applied || 0)}).`
  );
}
