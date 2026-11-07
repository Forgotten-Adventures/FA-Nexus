export const DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT = 4096;
export const MIN_PREVIEW_RENDER_TEXTURE_LIMIT = 1024;

export function buildPreviewDilationOffsets(radius) {
  const offsets = [{ x: 0, y: 0 }];
  const r = Math.max(0, Number(radius || 0));
  if (r < 0.05) return offsets;
  const steps = 16;
  const full = Math.PI * 2;
  for (let i = 0; i < steps; i++) {
    const angle = (full * i) / steps;
    offsets.push({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  }
  const inner = r * 0.55;
  if (inner >= 0.05) {
    for (let i = 0; i < steps; i++) {
      const angle = (full * i) / steps + (full / (steps * 2));
      offsets.push({ x: Math.cos(angle) * inner, y: Math.sin(angle) * inner });
    }
  }
  return offsets;
}

export function computeRotatedSpriteBounds(width, height, rotationRadians) {
  const w = Math.max(0, Math.abs(Number(width) || 0));
  const h = Math.max(0, Math.abs(Number(height) || 0));
  if (!w && !h) return { width: 0, height: 0 };
  const theta = Number(rotationRadians) || 0;
  const sin = Math.abs(Math.sin(theta));
  const cos = Math.abs(Math.cos(theta));
  const rotatedWidth = (w * cos) + (h * sin);
  const rotatedHeight = (w * sin) + (h * cos);
  return {
    width: Math.max(0, rotatedWidth),
    height: Math.max(0, rotatedHeight)
  };
}

export function resolveSafePreviewRenderTextureLimit({
  hardwareMaxTextureSize = DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT,
  previewMaxTextureSize = DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT
} = {}) {
  const hardwareLimit = Number(hardwareMaxTextureSize || DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT) || DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT;
  const configuredLimit = Number(previewMaxTextureSize || DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT) || DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT;
  return Math.max(MIN_PREVIEW_RENDER_TEXTURE_LIMIT, Math.min(hardwareLimit, configuredLimit));
}

export function resolveSafePreviewRenderTarget(width, height, {
  maxTextureSize = DEFAULT_PREVIEW_RENDER_TEXTURE_LIMIT,
  resolution = 1,
  minSize = 1
} = {}) {
  const requestedWidth = Math.max(minSize, Math.ceil(Number(width) || 0));
  const requestedHeight = Math.max(minSize, Math.ceil(Number(height) || 0));
  const safeResolution = Math.max(0.01, Number(resolution) || 1);
  const maxLogicalSize = Math.max(minSize, Math.floor(maxTextureSize / safeResolution));
  const scale = Math.min(
    1,
    maxLogicalSize / Math.max(1, requestedWidth),
    maxLogicalSize / Math.max(1, requestedHeight)
  );
  const textureWidth = Math.max(minSize, Math.min(requestedWidth, Math.floor(requestedWidth * scale) || minSize));
  const textureHeight = Math.max(minSize, Math.min(requestedHeight, Math.floor(requestedHeight * scale) || minSize));
  return {
    requestedWidth,
    requestedHeight,
    textureWidth,
    textureHeight,
    drawScaleX: textureWidth / Math.max(1, requestedWidth),
    drawScaleY: textureHeight / Math.max(1, requestedHeight),
    resolution: safeResolution
  };
}
