import {
  hasSmallPortalTextureToken,
  parseExplicitPortalTextureGridWidth
} from './portal-texture-path.js';

const MODULE_ID = 'fa-nexus';

export function isSmallAnimatedWindowDocument(doc) {
  const faFlags = doc?.flags?.[MODULE_ID] || {};
  const buildingWindow = doc?.getFlag?.(MODULE_ID, 'buildingWindow') || faFlags.buildingWindow || null;
  if (!buildingWindow) return false;
  const animation = doc?.animation || doc?._source?.animation || doc?.data?.animation || null;
  const texture = String(animation?.texture || buildingWindow.textureLocal || buildingWindow.textureKey || '');
  const explicitWidth = parseExplicitPortalTextureGridWidth(texture);
  if (Number.isFinite(explicitWidth) && explicitWidth > 1) return false;
  const flagWidth = Number(buildingWindow.textureGridWidth);
  if (Number.isFinite(flagWidth) && flagWidth > 1) return false;
  if (buildingWindow.smallTexture === true) return true;
  if (Number.isFinite(flagWidth) && flagWidth <= 0.5) return true;
  return hasSmallPortalTextureToken(texture);
}

function getTextureWidth(texture) {
  return Number(texture?.width || texture?.baseTexture?.width || 0) || 0;
}

export function getSmallAnimatedWindowTexturePadding(texture, smallWindow) {
  return smallWindow ? getTextureWidth(texture) * 0.25 : 0;
}
