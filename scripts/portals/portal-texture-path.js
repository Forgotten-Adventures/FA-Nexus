export function hasSmallPortalTextureToken(path) {
  const value = String(path || '').toLowerCase();
  return /(?:^|[\\/_\-\s.])small(?:$|[\\/_\-\s.])/.test(value);
}

export function parseExplicitPortalTextureGridWidth(path) {
  const value = String(path || '').toLowerCase();
  if (!value) return null;
  const match = value.match(/(?:^|[^0-9])(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)(?=[^0-9]|$)/);
  if (!match) return null;
  const width = Number.parseFloat(String(match[1] || ''));
  return Number.isFinite(width) && width > 0 ? width : null;
}

export function isSmallPortalTexturePath(path) {
  const explicitWidth = parseExplicitPortalTextureGridWidth(path);
  if (Number.isFinite(explicitWidth) && explicitWidth > 1) return false;
  return hasSmallPortalTextureToken(path);
}

export function parsePortalTextureGridWidth(path) {
  const explicitWidth = parseExplicitPortalTextureGridWidth(path);
  if (Number.isFinite(explicitWidth) && explicitWidth > 0) {
    return explicitWidth <= 1 && hasSmallPortalTextureToken(path) ? 0.5 : explicitWidth;
  }
  return hasSmallPortalTextureToken(path) ? 0.5 : null;
}
