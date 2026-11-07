// The persisted chunk rectangles and their shared renderer-local placement.
// Consumers must use this layout rather than stretching the wrapper's first image.
export function resolveFlattenedChunkEntries(meta) {
  const chunks = Array.isArray(meta?.chunks) ? meta.chunks : [];
  return chunks.flatMap((chunk) => {
    const src = String(chunk?.src || '').trim();
    const width = Number(chunk?.width) || 0;
    const height = Number(chunk?.height) || 0;
    if (!src || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
    return [{ src, x: Number(chunk?.x) || 0, y: Number(chunk?.y) || 0, width, height }];
  });
}

export function resolveFlattenedChunkContainerTransform(mesh, doc, previewScale = null) {
  const docWidth = Math.max(1, Number(doc?.width) || 0) || Math.max(1, Number(mesh?.width) || 1);
  const docHeight = Math.max(1, Number(doc?.height) || 0) || Math.max(1, Number(mesh?.height) || 1);
  const rawSx = Number(mesh?.scale?.x ?? 1) || 1;
  const rawSy = Number(mesh?.scale?.y ?? 1) || 1;
  const sx = Math.abs(rawSx) > 1.001 ? rawSx : (Math.sign(rawSx || 1) || 1) * docWidth;
  const sy = Math.abs(rawSy) > 1.001 ? rawSy : (Math.sign(rawSy || 1) || 1) * docHeight;
  const anchorX = Number(doc?.texture?.anchorX);
  const anchorY = Number(doc?.texture?.anchorY);
  const ax = Number.isFinite(anchorX) ? anchorX : 0.5;
  const ay = Number.isFinite(anchorY) ? anchorY : 0.5;
  const previewScaleX = Number(previewScale?.x);
  const previewScaleY = Number(previewScale?.y);
  return {
    scaleX: (Number.isFinite(previewScaleX) && previewScaleX > 0 ? previewScaleX : 1) / Math.abs(sx),
    scaleY: (Number.isFinite(previewScaleY) && previewScaleY > 0 ? previewScaleY : 1) / Math.abs(sy),
    x: -(docWidth * (rawSx < 0 ? 1 - ax : ax)) / Math.abs(sx),
    y: -(docHeight * (rawSy < 0 ? 1 - ay : ay)) / Math.abs(sy)
  };
}
