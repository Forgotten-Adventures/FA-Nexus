export const PREFAB_ROOT = 'fa-nexus/prefabs';
export const PREFAB_ARTIFACT_ROOT = `${PREFAB_ROOT}/artifacts/sha256`;
export function isPrefabArtifactPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/$/, '').split('?')[0];
  return normalized === PREFAB_ARTIFACT_ROOT || normalized.startsWith(`${PREFAB_ARTIFACT_ROOT}/`);
}
