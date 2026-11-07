const DEFAULT_SETTINGS = Object.freeze({
  offsetDistance: 0,
  offsetAngle: 135
});

function defaultNormalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function defaultClampNumber(value, min, max, fallback) {
  const numeric = defaultNormalizeNumber(value, fallback);
  return Math.min(max, Math.max(min, numeric));
}

function defaultNormalizeAngle(value, fallback = DEFAULT_SETTINGS.offsetAngle) {
  const numeric = defaultNormalizeNumber(value, fallback);
  let normalized = numeric % 360;
  if (normalized < 0) normalized += 360;
  return normalized;
}

function defaultComputeShadowOffsetVector(distance = DEFAULT_SETTINGS.offsetDistance, angle = DEFAULT_SETTINGS.offsetAngle) {
  const normalizedDistance = Math.max(0, defaultNormalizeNumber(distance, DEFAULT_SETTINGS.offsetDistance));
  const normalizedAngle = defaultNormalizeAngle(angle, DEFAULT_SETTINGS.offsetAngle);
  const theta = normalizedAngle * (Math.PI / 180);
  return {
    x: Math.cos(theta) * normalizedDistance,
    y: Math.sin(theta) * normalizedDistance
  };
}

function defaultFormatShadowDisplay(field, value) {
  const numeric = defaultNormalizeNumber(value, 0);
  if (field === 'offsetAngle') return `${Math.round(numeric)}deg`;
  if (field === 'offsetDistance') return `${Math.round(numeric)} px`;
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1);
}

function defaultGetAppState(app) {
  if (!app) {
    return {
      shadow: {
        pointerCleanup: null,
        layoutObserver: null,
        layoutSyncFrame: 0
      }
    };
  }
  if (!app.__faNexusTileConfigShadowOffsetState) {
    app.__faNexusTileConfigShadowOffsetState = {
      shadow: {
        pointerCleanup: null,
        layoutObserver: null,
        layoutSyncFrame: 0
      }
    };
  }
  return app.__faNexusTileConfigShadowOffsetState;
}

function resolveShadowState(app, deps) {
  const state = deps.getAppState(app);
  if (!state.shadow) {
    state.shadow = {
      pointerCleanup: null,
      layoutObserver: null,
      layoutSyncFrame: 0
    };
  }
  return state.shadow;
}

function resolveDeps(deps = {}) {
  const defaultSettings = deps.defaultSettings || DEFAULT_SETTINGS;
  return {
    defaultSettings,
    offsetMaxCeiling: Number.isFinite(Number(deps.offsetMaxCeiling)) ? Number(deps.offsetMaxCeiling) : 512,
    normalizeNumber: deps.normalizeNumber || defaultNormalizeNumber,
    clampNumber: deps.clampNumber || defaultClampNumber,
    normalizeAngle: deps.normalizeAngle || defaultNormalizeAngle,
    computeShadowOffsetVector: deps.computeShadowOffsetVector || defaultComputeShadowOffsetVector,
    formatShadowDisplay: deps.formatShadowDisplay || defaultFormatShadowDisplay,
    readShadowOffsetUiMax: deps.readShadowOffsetUiMax || (() => 40),
    getAppState: deps.getAppState || defaultGetAppState,
    schedulePreviewSync: deps.schedulePreviewSync || (() => {}),
    requestAnimationFrame: deps.requestAnimationFrame || globalThis.requestAnimationFrame || ((callback) => setTimeout(callback, 0)),
    cancelAnimationFrame: deps.cancelAnimationFrame || globalThis.cancelAnimationFrame || ((handle) => clearTimeout(handle)),
    ResizeObserver: deps.ResizeObserver ?? globalThis.ResizeObserver,
    window: deps.window || globalThis.window || globalThis,
    createEvent: deps.createEvent || ((type) => new Event(type, { bubbles: true }))
  };
}

export function updateTileConfigShadowOffsetHeaderDisplay(root, { distance, angle } = {}, deps = {}) {
  const { formatShadowDisplay } = resolveDeps(deps);
  const distanceDisplay = root.querySelector('[data-fa-nexus-shadow-offset-distance-display]');
  const angleDisplay = root.querySelector('[data-fa-nexus-shadow-offset-angle-display]');
  if (distanceDisplay) distanceDisplay.textContent = formatShadowDisplay('offsetDistance', distance);
  if (angleDisplay) angleDisplay.textContent = formatShadowDisplay('offsetAngle', angle);
}

export function syncTileConfigShadowOffsetHandle(root, deps = {}) {
  const resolved = resolveDeps(deps);
  const control = root.querySelector('[data-fa-nexus-shadow-offset-control]');
  const circle = root.querySelector('[data-fa-nexus-shadow-offset-circle]');
  const handle = root.querySelector('[data-fa-nexus-shadow-offset-handle]');
  const maxInput = root.querySelector('[data-fa-nexus-shadow-offset-max]');
  const distanceInput = root.querySelector('[data-fa-nexus-shadow-field="offsetDistance"]');
  const angleInput = root.querySelector('[data-fa-nexus-shadow-field="offsetAngle"]');
  if (!control || !circle || !handle || !maxInput || !distanceInput || !angleInput) return;

  const maxDistance = resolved.clampNumber(
    maxInput.value,
    1,
    resolved.offsetMaxCeiling,
    resolved.readShadowOffsetUiMax()
  );
  control.dataset.maxDistance = String(maxDistance);
  const distance = resolved.clampNumber(
    distanceInput.value,
    0,
    Number.MAX_SAFE_INTEGER,
    resolved.defaultSettings.offsetDistance
  );
  const angle = resolved.normalizeAngle(angleInput.value, resolved.defaultSettings.offsetAngle);
  updateTileConfigShadowOffsetHeaderDisplay(root, { distance, angle }, resolved);
  const diameter = Math.min(circle.clientWidth, circle.clientHeight);
  if (!Number.isFinite(diameter) || diameter < 2) return;
  const radius = diameter / 2;
  const ratio = maxDistance > 0 ? Math.min(1, distance / maxDistance) : 0;
  const theta = angle * (Math.PI / 180);
  const offsetX = Math.cos(theta) * radius * ratio;
  const offsetY = Math.sin(theta) * radius * ratio;
  handle.style.setProperty('--fa-nexus-drop-shadow-offset-x', `${offsetX}px`);
  handle.style.setProperty('--fa-nexus-drop-shadow-offset-y', `${offsetY}px`);
}

export function queueTileConfigShadowOffsetLayoutSync(app, root, deps = {}) {
  const resolved = resolveDeps(deps);
  const shadowState = resolveShadowState(app, resolved);
  if (shadowState.layoutSyncFrame) {
    try {
      resolved.cancelAnimationFrame.call(resolved.window, shadowState.layoutSyncFrame);
    } catch (_) {}
  }
  shadowState.layoutSyncFrame = resolved.requestAnimationFrame.call(resolved.window, () => {
    shadowState.layoutSyncFrame = 0;
    syncTileConfigShadowOffsetHandle(root, resolved);
  });
}

export function updateTileConfigShadowOffsetInputs(root, {
  distance = DEFAULT_SETTINGS.offsetDistance,
  angle = DEFAULT_SETTINGS.offsetAngle
} = {}, deps = {}) {
  const resolved = resolveDeps(deps);
  const distanceInput = root.querySelector('[data-fa-nexus-shadow-field="offsetDistance"]');
  const angleInput = root.querySelector('[data-fa-nexus-shadow-field="offsetAngle"]');
  const offsetXInput = root.querySelector('[data-fa-nexus-shadow-field="offsetX"]');
  const offsetYInput = root.querySelector('[data-fa-nexus-shadow-field="offsetY"]');
  if (!distanceInput || !angleInput || !offsetXInput || !offsetYInput) return false;
  const nextDistance = Math.max(
    0,
    resolved.normalizeNumber(distance, resolved.defaultSettings.offsetDistance)
  );
  const nextAngle = resolved.normalizeAngle(angle, resolved.defaultSettings.offsetAngle);
  const nextOffset = resolved.computeShadowOffsetVector(nextDistance, nextAngle);
  distanceInput.value = String(nextDistance);
  angleInput.value = String(Math.round(nextAngle));
  offsetXInput.value = String(nextOffset.x);
  offsetYInput.value = String(nextOffset.y);
  distanceInput.dispatchEvent(resolved.createEvent('input'));
  distanceInput.dispatchEvent(resolved.createEvent('change'));
  angleInput.dispatchEvent(resolved.createEvent('input'));
  angleInput.dispatchEvent(resolved.createEvent('change'));
  syncTileConfigShadowOffsetHandle(root, resolved);
  return true;
}

export function bindTileConfigShadowOffsetControl(app, root, deps = {}) {
  const resolved = resolveDeps(deps);
  const control = root.querySelector('[data-fa-nexus-shadow-offset-control]');
  const circle = root.querySelector('[data-fa-nexus-shadow-offset-circle]');
  const maxInput = root.querySelector('[data-fa-nexus-shadow-offset-max]');
  const distanceInput = root.querySelector('[data-fa-nexus-shadow-field="offsetDistance"]');
  const angleInput = root.querySelector('[data-fa-nexus-shadow-field="offsetAngle"]');
  const shadowToggle = root.querySelector('[data-fa-nexus-shadow-enabled]');
  if (!control || !circle || !maxInput || !distanceInput || !angleInput || !shadowToggle) return;

  const shadowState = resolveShadowState(app, resolved);
  const dragState = {
    active: false
  };

  const applyMouse = (event) => {
    const rect = circle.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const radius = Math.max(1, Math.min(rect.width, rect.height) / 2);
    const radial = Math.min(1, Math.sqrt(dx * dx + dy * dy) / radius);
    const maxDistance = resolved.clampNumber(
      maxInput.value,
      1,
      resolved.offsetMaxCeiling,
      resolved.readShadowOffsetUiMax()
    );
    const distance = Math.round(radial * maxDistance);
    let angle = Math.atan2(dy, dx) * (180 / Math.PI);
    if (!Number.isFinite(angle)) angle = resolved.defaultSettings.offsetAngle;
    angle = resolved.normalizeAngle(angle, resolved.defaultSettings.offsetAngle);
    updateTileConfigShadowOffsetInputs(root, { distance, angle }, resolved);
    resolved.schedulePreviewSync(app, root, { hsbc: false, shadow: true });
  };

  const releaseDrag = () => {
    if (!dragState.active) return;
    dragState.active = false;
    resolved.window.removeEventListener('mousemove', onMouseMove, false);
    resolved.window.removeEventListener('mouseup', onMouseUp, false);
  };

  const onMouseMove = (event) => {
    if (!dragState.active) return;
    event.preventDefault();
    applyMouse(event);
  };

  const onMouseUp = (event) => {
    if (!dragState.active) return;
    event.preventDefault();
    applyMouse(event);
    releaseDrag();
  };

  control.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (!shadowToggle.checked) return;
    dragState.active = true;
    resolved.window.addEventListener('mousemove', onMouseMove, { passive: false });
    resolved.window.addEventListener('mouseup', onMouseUp, { passive: false });
    event.preventDefault();
    applyMouse(event);
  });

  control.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    updateTileConfigShadowOffsetInputs(root, {
      distance: resolved.defaultSettings.offsetDistance,
      angle: resolved.defaultSettings.offsetAngle
    }, resolved);
    resolved.schedulePreviewSync(app, root, { hsbc: false, shadow: true });
  });

  maxInput.addEventListener('input', () => {
    syncTileConfigShadowOffsetHandle(root, resolved);
  });

  maxInput.addEventListener('change', () => {
    syncTileConfigShadowOffsetHandle(root, resolved);
  });

  shadowToggle.addEventListener('change', () => {
    control.dataset.disabled = shadowToggle.checked ? 'false' : 'true';
    control.classList.toggle('is-disabled', !shadowToggle.checked);
    syncTileConfigShadowOffsetHandle(root, resolved);
  });

  if (shadowState.pointerCleanup) {
    try { shadowState.pointerCleanup(); } catch (_) {}
  }
  try { shadowState.layoutObserver?.disconnect?.(); } catch (_) {}
  shadowState.pointerCleanup = releaseDrag;
  control.dataset.disabled = shadowToggle.checked ? 'false' : 'true';
  control.classList.toggle('is-disabled', !shadowToggle.checked);
  if (typeof resolved.ResizeObserver === 'function') {
    const observer = new resolved.ResizeObserver(() => {
      queueTileConfigShadowOffsetLayoutSync(app, root, resolved);
    });
    observer.observe(circle);
    shadowState.layoutObserver = observer;
  } else {
    shadowState.layoutObserver = null;
  }
  syncTileConfigShadowOffsetHandle(root, resolved);
  queueTileConfigShadowOffsetLayoutSync(app, root, resolved);
}
