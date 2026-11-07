const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const ROUND_PLACES = 9;
const MATRIX_TOLERANCE = 1e-8;

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function roundScatterTransformNumber(value, places = ROUND_PLACES) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  if (Math.abs(rounded - Math.round(rounded)) <= 1e-8) return Math.round(rounded);
  return Object.is(rounded, -0) ? 0 : rounded;
}

function normalizeAngle(value) {
  const numeric = finite(value) ?? 0;
  const normalized = ((numeric + 180) % 360 + 360) % 360 - 180;
  return roundScatterTransformNumber(normalized);
}

function validAffine(value) {
  if (!value || typeof value !== 'object') return null;
  const affine = {
    a: finite(value.a),
    b: finite(value.b),
    c: finite(value.c),
    d: finite(value.d)
  };
  return Object.values(affine).every((entry) => entry != null) ? affine : null;
}

export function resolveScatterInstanceAffine(instance) {
  const stored = validAffine(instance?.affine);
  if (stored) {
    return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, roundScatterTransformNumber(value)]));
  }
  const width = Math.max(1, finite(instance?.w) ?? 0);
  const height = Math.max(1, finite(instance?.h) ?? 0);
  const radians = (finite(instance?.r) ?? 0) * DEG_TO_RAD;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const flipX = instance?.flipH ? -1 : 1;
  const flipY = instance?.flipV ? -1 : 1;
  return {
    a: roundScatterTransformNumber(cosine * width * flipX),
    b: roundScatterTransformNumber(sine * width * flipX),
    c: roundScatterTransformNumber(-sine * height * flipY),
    d: roundScatterTransformNumber(cosine * height * flipY)
  };
}

function affineMatches(left, right, tolerance = MATRIX_TOLERANCE) {
  return ['a', 'b', 'c', 'd'].every((field) => (
    Math.abs(Number(left?.[field]) - Number(right?.[field])) <= tolerance
  ));
}

export function applyScatterInstanceAffine(instance, affine, { x = instance?.x, y = instance?.y } = {}) {
  const normalized = validAffine(affine);
  if (!instance || typeof instance !== 'object' || !normalized) {
    throw new Error('Scatter instance transform requires finite affine geometry.');
  }
  const flipX = instance.flipH ? -1 : 1;
  const flipY = instance.flipV ? -1 : 1;
  const orientedX = { x: normalized.a * flipX, y: normalized.b * flipX };
  const orientedY = { x: normalized.c * flipY, y: normalized.d * flipY };
  const next = {
    ...instance,
    x: roundScatterTransformNumber(Number(x)),
    y: roundScatterTransformNumber(Number(y)),
    w: roundScatterTransformNumber(Math.hypot(orientedX.x, orientedX.y)),
    h: roundScatterTransformNumber(Math.hypot(orientedY.x, orientedY.y)),
    r: normalizeAngle(Math.atan2(orientedX.y, orientedX.x) * RAD_TO_DEG)
  };
  if (![next.x, next.y, next.w, next.h, next.r].every(Number.isFinite) || next.w <= 0 || next.h <= 0) {
    throw new Error('Scatter instance transform produced invalid geometry.');
  }
  const roundedAffine = Object.fromEntries(
    Object.entries(normalized).map(([key, value]) => [key, roundScatterTransformNumber(value)])
  );
  delete next.affine;
  if (!affineMatches(resolveScatterInstanceAffine(next), roundedAffine)) next.affine = roundedAffine;
  return next;
}

export function transformScatterInstanceGeometry(instance, transform = {}) {
  const matrix = {
    a: finite(transform.a),
    b: finite(transform.b),
    c: finite(transform.c),
    d: finite(transform.d),
    tx: finite(transform.tx) ?? 0,
    ty: finite(transform.ty) ?? 0
  };
  if (![matrix.a, matrix.b, matrix.c, matrix.d].every((entry) => entry != null)) {
    throw new Error('Scatter instance transform requires a finite matrix.');
  }
  const source = resolveScatterInstanceAffine(instance);
  const affine = {
    a: (matrix.a * source.a) + (matrix.c * source.b),
    b: (matrix.b * source.a) + (matrix.d * source.b),
    c: (matrix.a * source.c) + (matrix.c * source.d),
    d: (matrix.b * source.c) + (matrix.d * source.d)
  };
  const sourceX = finite(instance?.x);
  const sourceY = finite(instance?.y);
  if (sourceX == null || sourceY == null) throw new Error('Scatter instance transform requires a finite center.');
  return applyScatterInstanceAffine(instance, affine, {
    x: (matrix.a * sourceX) + (matrix.c * sourceY) + matrix.tx,
    y: (matrix.b * sourceX) + (matrix.d * sourceY) + matrix.ty
  });
}

export function computeAffineScatterInstanceBounds(instance) {
  const centerX = finite(instance?.x) ?? 0;
  const centerY = finite(instance?.y) ?? 0;
  const { a, b, c, d } = resolveScatterInstanceAffine(instance);
  const halfWidthX = (Math.abs(a) + Math.abs(c)) / 2;
  const halfWidthY = (Math.abs(b) + Math.abs(d)) / 2;
  return {
    minX: roundScatterTransformNumber(centerX - halfWidthX),
    minY: roundScatterTransformNumber(centerY - halfWidthY),
    maxX: roundScatterTransformNumber(centerX + halfWidthX),
    maxY: roundScatterTransformNumber(centerY + halfWidthY)
  };
}

export function applyScatterInstanceTransformToSprite(sprite, instance) {
  if (!sprite || !instance) return false;
  const stored = validAffine(instance.affine);
  if (!stored) return false;
  const textureWidth = Math.max(1, Number(sprite.texture?.width || sprite.texture?.orig?.width) || 1);
  const textureHeight = Math.max(1, Number(sprite.texture?.height || sprite.texture?.orig?.height) || 1);
  const Matrix = globalThis.PIXI?.Matrix;
  if (typeof Matrix !== 'function' || typeof sprite.transform?.setFromMatrix !== 'function') {
    throw new Error('Scatter affine rendering requires PIXI.Matrix and Transform.setFromMatrix.');
  }
  const matrix = new Matrix(
    stored.a / textureWidth,
    stored.b / textureWidth,
    stored.c / textureHeight,
    stored.d / textureHeight,
    Number(instance.x) || 0,
    Number(instance.y) || 0
  );
  sprite.transform.setFromMatrix(matrix);
  return true;
}
