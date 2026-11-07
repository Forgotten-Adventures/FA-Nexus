export function encodeTexturePath(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try { return encodeURI(decodeURI(String(path))); }
  catch (_) {
    try { return encodeURI(String(path)); }
    catch { return path; }
  }
}
