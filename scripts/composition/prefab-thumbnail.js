// Crop browsing artwork only. Stored geometry, custom bounds and capture origin
// are independent of the thumbnail's transparent padding.
export async function createPrefabThumbnail(source) {
  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let left = bitmap.width, top = bitmap.height, right = -1, bottom = -1;
    for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
      if (!data[(y * bitmap.width + x) * 4 + 3]) continue;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
    const width = Math.max(1, right - left + 1), height = Math.max(1, bottom - top + 1);
    const scale = Math.min(1, 128 / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    if (right >= 0) ctx.drawImage(bitmap, left, top, width, height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .85));
    if (!blob) throw new Error('Could not encode the Prefab thumbnail.');
    return blob;
  } finally { bitmap.close(); }
}
