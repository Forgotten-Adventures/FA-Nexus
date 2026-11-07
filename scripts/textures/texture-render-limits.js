export function getMaxTextureSize() {
  try {
    const gl = canvas?.app?.renderer?.gl || canvas?.app?.renderer?.context?.gl;
    if (!gl) return 4096;
    const value = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const maximum = Number(value || 4096) || 4096;
    return Math.max(1024, Math.min(maximum, 8192));
  } catch (_) {
    return 4096;
  }
}
