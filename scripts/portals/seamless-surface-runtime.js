// Shared committed-runtime helpers. Authoring state belongs to the premium editor.

function clone(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function createSeamlessSecretDoorLeafTexturePlan(spanLength) {
  const fullWidth = Math.max(2, Math.ceil(Math.max(1, Number(spanLength) || 0) / 2) * 2);
  const leafWidth = fullWidth / 2;
  return {
    fullWidth,
    leafWidth,
    left: { sourceStart: 0, sourceEnd: leafWidth, reverse: false },
    right: { sourceStart: leafWidth, sourceEnd: fullWidth, reverse: true }
  };
}

export async function reconstructTransientPortalSurface(plan, {
  loadSourceTexture,
  renderSurface,
  validateSurface = null
} = {}) {
  requireObject(plan, 'Transient Portal surface plan');
  if (typeof loadSourceTexture !== 'function') throw new Error('Transient Portal source loader is required.');
  if (typeof renderSurface !== 'function') throw new Error('Transient Portal renderer is required.');
  const sourceTexture = await loadSourceTexture(plan.sourceTexture);
  if (!sourceTexture) throw new Error(`Transient Portal source texture ${plan.sourceTexture} could not be loaded.`);
  let rendered = null;
  try {
    rendered = await renderSurface(clone(plan), sourceTexture);
    if (!rendered?.texture) throw new Error('Transient Portal renderer returned no texture.');
    if (typeof validateSurface === 'function') await validateSurface(rendered.texture, clone(plan));
    return rendered;
  } catch (error) {
    try { rendered?.destroy?.(); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Transient Portal reconstruction and cleanup failed.');
    }
    throw error;
  }
}
