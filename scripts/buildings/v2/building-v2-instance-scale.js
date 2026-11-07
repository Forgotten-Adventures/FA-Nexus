const EPSILON = 1e-6;

function positiveFinite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || !(number > 0)) {
    throw new Error(`Building V2 ${label} must be finite and greater than zero.`);
  }
  return number;
}

/**
 * Derive the one supported positive uniform Building Instance Scale from the
 * integer Root rectangle and the exact Building-local Render Envelope.
 *
 * Foundry rounds Root dimensions upward to integer pixels. The canonical
 * state-only scale is the largest positive uniform scale whose exact artwork
 * envelope still fits both stored Root axes and reproduces both dimensions
 * through the same upward materialization rule.
 */
export function deriveBuildingV2InstanceScale({ width, height, envelopeWidth, envelopeHeight } = {}) {
  const rootWidth = positiveFinite(width, 'Root width');
  const rootHeight = positiveFinite(height, 'Root height');
  const localWidth = positiveFinite(envelopeWidth, 'Render Envelope width');
  const localHeight = positiveFinite(envelopeHeight, 'Render Envelope height');
  const scaleX = rootWidth / localWidth;
  const scaleY = rootHeight / localHeight;
  const ceilPixel = (value) => Math.max(1, Math.ceil(value - EPSILON));
  if (ceilPixel(localWidth) === rootWidth && ceilPixel(localHeight) === rootHeight) {
    return Object.freeze({ scale: 1, scaleX, scaleY });
  }
  const scale = Math.min(scaleX, scaleY);
  if (ceilPixel(localWidth * scale) !== rootWidth || ceilPixel(localHeight * scale) !== rootHeight) {
    throw new Error(
      'Building V2 Edit does not support non-uniform Root scale: '
      + `horizontal ${scaleX.toFixed(6)}, vertical ${scaleY.toFixed(6)}.`
    );
  }
  return Object.freeze({ scale, scaleX, scaleY });
}
