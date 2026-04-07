const MODULE_ID = 'fa-nexus';
const GENERATED_ROOT_SEGMENT = '__generated';
const MASKS_SEGMENT = 'masks';
const FLATTENED_SEGMENT = 'flattened';

export function appendStoragePath(basePath, segment) {
  const base = String(basePath || '').trim().replace(/\/+$/, '');
  const cleanSegment = String(segment || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!base) return cleanSegment;
  if (!cleanSegment) return base;
  const match = base.match(/^([a-z0-9+.-]+:)(.*)$/i);
  if (match && !/^https?:$/i.test(match[1])) {
    const tail = String(match[2] || '').replace(/^\/+/, '').replace(/\/+$/, '');
    return `${match[1]}${[tail, cleanSegment].filter(Boolean).join('/')}`;
  }
  return `${base}/${cleanSegment}`;
}

export function sanitizeGeneratedPathSegment(value, fallback = '') {
  const normalized = String(value ?? '').trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/[. -]+$/, '');
  return normalized || String(fallback || '').trim();
}

export function sanitizeStoragePathSegments(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  const match = raw.match(/^([a-z0-9+.-]+:)(.*)$/i);
  const hasPrefix = !!(match && !/^https?:$/i.test(match[1]));
  const prefix = hasPrefix ? match[1] : '';
  const remainder = hasPrefix ? String(match[2] || '') : raw;
  const sanitized = remainder
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => sanitizeGeneratedPathSegment(segment, segment))
    .filter(Boolean)
    .join('/');
  return prefix ? (sanitized ? `${prefix}${sanitized}` : prefix) : sanitized;
}

export function getConfiguredAssetsDir({ moduleId = MODULE_ID } = {}) {
  try {
    return String(game?.settings?.get?.(moduleId, 'cloudDownloadDirAssets') || 'fa-nexus-assets').trim() || 'fa-nexus-assets';
  } catch (_) {
    return 'fa-nexus-assets';
  }
}

export function getCurrentWorldId() {
  return sanitizeGeneratedPathSegment(game?.world?.id || '', '');
}

export function getSceneId(scene = null) {
  const candidate = scene?.id || canvas?.scene?.id || game?.scenes?.current?.id || '';
  return sanitizeGeneratedPathSegment(candidate, '');
}

export function normalizeGeneratedKind(kind = 'flattened') {
  const value = String(kind || '').trim().toLowerCase();
  if (value === 'mask' || value === MASKS_SEGMENT) return MASKS_SEGMENT;
  if (value === 'flatten' || value === FLATTENED_SEGMENT) return FLATTENED_SEGMENT;
  throw new Error(`Unsupported generated asset kind: ${kind}`);
}

export function buildGeneratedRoot(kind, { assetsDir } = {}) {
  return appendStoragePath(
    appendStoragePath(String(assetsDir || getConfiguredAssetsDir()).trim(), GENERATED_ROOT_SEGMENT),
    normalizeGeneratedKind(kind)
  );
}

export function buildWorldGeneratedFolder(root, { worldId } = {}) {
  const cleanRoot = String(root || '').trim();
  const resolvedWorldId = sanitizeGeneratedPathSegment(worldId || getCurrentWorldId(), '');
  if (!cleanRoot) throw new Error('Generated asset root is required');
  if (!resolvedWorldId) throw new Error('Current world id is unavailable');
  return appendStoragePath(cleanRoot, resolvedWorldId);
}

export function buildSceneGeneratedFolder(root, { worldId, sceneId } = {}) {
  const worldFolder = buildWorldGeneratedFolder(root, { worldId });
  const resolvedSceneId = sanitizeGeneratedPathSegment(sceneId || getSceneId(), '');
  if (!resolvedSceneId) throw new Error('Current scene id is unavailable');
  return appendStoragePath(worldFolder, resolvedSceneId);
}

export function resolveGeneratedSceneFolder(kind, { root, assetsDir, worldId, sceneId } = {}) {
  const generatedRoot = String(root || '').trim() || buildGeneratedRoot(kind, { assetsDir });
  return {
    kind: normalizeGeneratedKind(kind),
    root: generatedRoot,
    worldId: sanitizeGeneratedPathSegment(worldId || getCurrentWorldId(), ''),
    sceneId: sanitizeGeneratedPathSegment(sceneId || getSceneId(), ''),
    folder: buildSceneGeneratedFolder(generatedRoot, { worldId, sceneId })
  };
}
