// Stateless authored Door leaf appearance admission; no scene or renderer state.
export function normalizeBuildingV2DoorAppearance(appearance = {}) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (!object(appearance) || Object.keys(appearance).some(key => !['widthScale', 'lockAspectRatio', 'hsbc', 'gridSize'].includes(key))) {
    throw new Error('Building V2 Door appearance requires only widthScale, lockAspectRatio, HSBC, and an optional local grid basis.');
  }
  if (appearance.gridSize !== undefined && (!Number.isFinite(appearance.gridSize) || !(appearance.gridSize > 0))) {
    throw new Error('Building V2 Door artwork grid basis must be finite and positive.');
  }
  if (appearance.lockAspectRatio !== undefined && typeof appearance.lockAspectRatio !== 'boolean') {
    throw new Error('Building V2 Door lockAspectRatio must be boolean.');
  }
  const hsbc = appearance.hsbc === undefined ? {} : appearance.hsbc;
  if (!object(hsbc) || Object.keys(hsbc).some(key => !['hue', 'saturation', 'brightness', 'contrast'].includes(key))) {
    throw new Error('Building V2 Door HSBC requires supported color channels.');
  }
  const number = (value, fallback, min, max, label) => {
    const result = value === undefined ? fallback : value;
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(`Building V2 Door ${label} is outside its supported range.`);
    return result;
  };
  const widthScale = appearance.widthScale === undefined ? 1 : appearance.widthScale;
  if (!Number.isFinite(widthScale) || widthScale <= 0) {
    throw new Error('Building V2 Door widthScale must be positive.');
  }
  return {
    widthScale,
    ...(appearance.gridSize !== undefined ? { gridSize: appearance.gridSize } : {}),
    lockAspectRatio: appearance.lockAspectRatio === true,
    hsbc: {
      hue: number(hsbc.hue, 0, -180, 180, 'hue'),
      saturation: number(hsbc.saturation, 1, 0, 2, 'saturation'),
      brightness: number(hsbc.brightness, 1, 0, 2, 'brightness'),
      contrast: number(hsbc.contrast, 1, 0, 2, 'contrast')
    }
  };
}

export function materializeBuildingV2DoorTextureGridSize(appearance, scale = 1, sceneGridSize) {
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('Building V2 Door scene scale must be positive.');
  const normalized = normalizeBuildingV2DoorAppearance(appearance);
  if (normalized.gridSize !== undefined && (!Number.isFinite(sceneGridSize) || !(sceneGridSize > 0))) {
    throw new Error('Building V2 Door artwork materialization requires the current Scene grid size.');
  }
  // Records without a captured basis retain the released Scene-relative sizing.
  const gridRatio = normalized.gridSize === undefined ? 1 : sceneGridSize / normalized.gridSize;
  return 200 * gridRatio / (normalized.widthScale * scale);
}
