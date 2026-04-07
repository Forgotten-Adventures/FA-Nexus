export const GRID_SNAP_DIVISORS = Object.freeze([1, 2, 3, 4, 5]);
export const GRID_SNAP_SUBDIV_LABELS = Object.freeze(['Full', '1/2', '1/3', '1/4', '1/5']);
export const GRID_SNAP_SUBDIV_SETTING_KEY = 'gridSnapSubdivisions';
export const GRID_SNAP_SUBDIV_MIN = 0;
export const GRID_SNAP_SUBDIV_MAX = GRID_SNAP_DIVISORS.length - 1;
export const GRID_SNAP_SUBDIV_DEFAULT = 1;

export function normalizeGridSnapSubdivision(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return GRID_SNAP_SUBDIV_DEFAULT;
  return Math.max(
    GRID_SNAP_SUBDIV_MIN,
    Math.min(GRID_SNAP_SUBDIV_MAX, Math.round(numeric))
  );
}

export function readGridSnapSubdivisionSetting() {
  try {
    const raw = globalThis?.game?.settings?.get?.('fa-nexus', GRID_SNAP_SUBDIV_SETTING_KEY);
    return normalizeGridSnapSubdivision(raw);
  } catch (_) {
    return GRID_SNAP_SUBDIV_DEFAULT;
  }
}

export function getGridSnapDivisor(subdivisions = undefined) {
  const index = normalizeGridSnapSubdivision(
    subdivisions !== undefined ? subdivisions : readGridSnapSubdivisionSetting()
  );
  return GRID_SNAP_DIVISORS[index] ?? 1;
}

export function getGridSnapStep(gridSize, subdivisions = undefined) {
  const size = Number(gridSize);
  if (!Number.isFinite(size) || size <= 0) return 0;
  const divisor = getGridSnapDivisor(subdivisions);
  const safeDivisor = Math.max(1, Number(divisor) || 1);
  return size / safeDivisor;
}

export function formatGridSnapSubdivisionLabel(value) {
  const index = normalizeGridSnapSubdivision(value);
  return GRID_SNAP_SUBDIV_LABELS[index] ?? GRID_SNAP_SUBDIV_LABELS[0];
}

export function snapPointToSubgrid(point, gridSize, subdivisions = undefined) {
  if (!point) return { x: 0, y: 0 };
  const step = getGridSnapStep(gridSize, subdivisions);
  if (!step || !Number.isFinite(step) || step <= 0) {
    return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
  }
  const x = Number(point.x) || 0;
  const y = Number(point.y) || 0;
  return {
    x: Math.round(x / step) * step,
    y: Math.round(y / step) * step
  };
}
