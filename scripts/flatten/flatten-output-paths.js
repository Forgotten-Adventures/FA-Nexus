import {
  appendStoragePath,
  buildGeneratedRoot,
  resolveGeneratedSceneFolder,
  sanitizeStoragePathSegments
} from '../storage/generated-paths.js';
import { normalizeGeneratedFlattenRoot } from '../storage/generated-output-policy.js';
import { getContentKindDescriptor } from '../content/content-kind-descriptors.js';

const ACTION_EXPORT = 'export';
const ACTION_FLATTEN = 'flatten';
const SCOPE_SCENE = 'scene';

export function normalizeFlattenOutputAction(action = ACTION_FLATTEN) {
  return action === ACTION_EXPORT ? ACTION_EXPORT : ACTION_FLATTEN;
}

export function sanitizeFlattenOutputPart(value, fallback = 'item') {
  const fallbackText = String(fallback || 'item').trim() || 'item';
  let text = String(value ?? '').trim() || fallbackText;
  text = text.replace(/\.[^./\\]+$/, '');
  text = text.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-');
  text = text.replace(/\s+/g, '-').replace(/-+/g, '-').trim();
  text = text.replace(/^\.+/, '').replace(/[. ]+$/, '');
  return text || fallbackText;
}

export function normalizeFlattenOutputName(value, fallback = '') {
  const trimmed = String(value ?? '').trim();
  if (trimmed) return trimmed;
  return String(fallback || '').trim();
}

/** Keep ordinary names, but disambiguate the entire set if sanitized names
 * collide (including on case-insensitive storage). An ordinal on every Level
 * also avoids collisions with a Level already named like a generated suffix. */
export function buildFlattenLevelOutputSlugs(levelNames) {
  const slugs = levelNames.map(name => sanitizeFlattenOutputPart(name, 'level'));
  if (new Set(slugs.map(slug => slug.toLowerCase())).size === slugs.length) return slugs;
  return slugs.map((slug, index) => `${slug}-level-${index + 1}`);
}

export function sanitizeFlattenOutputBaseName(value, fallbackBase = '') {
  const fallback = String(fallbackBase || '').trim() || 'flattened';
  let name = String(value ?? '').trim();
  if (!name) name = fallback;
  return sanitizeFlattenOutputPart(name, fallback);
}

export function buildFlattenOutputFilename(baseName, suffix = '', fallbackBase = 'flattened') {
  const safeBase = sanitizeFlattenOutputBaseName(baseName, fallbackBase);
  const cleanSuffix = String(suffix || '').trim();
  return `${safeBase}${cleanSuffix}.webp`;
}

export function buildFlattenOutputBaseName({
  action = ACTION_FLATTEN,
  scope = 'level',
  sceneName = 'scene',
  levelName = 'level',
  now = new Date(),
  random = Math.random
} = {}) {
  const normalizedAction = normalizeFlattenOutputAction(action);
  const scenePart = sanitizeFlattenOutputPart(sceneName, 'scene');
  const scopePart = scope === SCOPE_SCENE
    ? 'all-levels'
    : sanitizeFlattenOutputPart(levelName, 'level');
  const actionPart = normalizedAction === ACTION_EXPORT ? ACTION_EXPORT : 'flattened';
  const timestamp = resolveOutputTimestamp(now);
  const rand = resolveOutputRandom(random);
  return sanitizeFlattenOutputBaseName(
    `${scenePart}-${scopePart}-${actionPart}-${timestamp}-${rand}`,
    `${actionPart}-${timestamp}-${rand}`
  );
}

export function getFlattenOutputDefaultFolder(action = ACTION_FLATTEN, { assetsDir = '' } = {}) {
  const cleanAssetsDir = String(assetsDir || '').trim() || getContentKindDescriptor('assets').downloadDirDefault;
  if (normalizeFlattenOutputAction(action) === ACTION_EXPORT) {
    return appendStoragePath(cleanAssetsDir, 'exports');
  }
  return buildGeneratedRoot('flattened', { assetsDir: cleanAssetsDir });
}

export function getStoredFlattenOutputFolder(action = ACTION_FLATTEN, stored = {}, { assetsDir = '' } = {}) {
  const normalizedAction = normalizeFlattenOutputAction(action);
  const key = normalizedAction === ACTION_EXPORT ? 'exportOutputFolder' : 'flattenOutputFolder';
  const configured = String(stored?.[key] || '').trim();
  if (configured) {
    if (normalizedAction === ACTION_FLATTEN) {
      const normalizedConfigured = normalizeGeneratedFlattenRoot(configured, { assetsDir });
      if (normalizedConfigured) return normalizedConfigured;
    }
    return sanitizeStoragePathSegments(configured);
  }
  return getFlattenOutputDefaultFolder(normalizedAction, { assetsDir });
}

export function normalizeFlattenOutputFolder(value, fallback = '') {
  const trimmed = String(value ?? '').trim();
  if (trimmed) return sanitizeStoragePathSegments(trimmed);
  return sanitizeStoragePathSegments(String(fallback || '').trim());
}

export function resolveFlattenOutputFolder(action = ACTION_FLATTEN, folder = '', {
  assetsDir = '',
  worldId = null,
  sceneId = null
} = {}) {
  const normalizedAction = normalizeFlattenOutputAction(action);
  const outputRoot = normalizeFlattenOutputFolder(
    folder,
    getFlattenOutputDefaultFolder(normalizedAction, { assetsDir })
  );
  if (normalizedAction === ACTION_EXPORT) {
    return {
      root: outputRoot,
      folder: outputRoot,
      outputRoot,
      effectiveFolder: outputRoot,
      sceneOwned: false,
      worldId: '',
      sceneId: ''
    };
  }

  const generatedPath = resolveGeneratedSceneFolder('flattened', {
    root: outputRoot,
    assetsDir,
    ...(worldId ? { worldId } : {}),
    ...(sceneId ? { sceneId } : {})
  });
  return {
    ...generatedPath,
    outputRoot: generatedPath.root,
    effectiveFolder: generatedPath.folder,
    sceneOwned: true
  };
}

function resolveOutputTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value instanceof Date ? value : new Date(value);
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
}

function resolveOutputRandom(random) {
  const value = typeof random === 'function' ? random() : random;
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
  return Math.floor(safe * 1e6).toString().padStart(6, '0');
}
