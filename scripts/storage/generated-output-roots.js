import {
  buildGeneratedRoot,
  getConfiguredAssetsDir,
  getCurrentWorldId,
  getSceneId
} from './generated-paths.js';
import {
  detectGeneratedOutputPath,
  getGeneratedFlattenRootCandidates,
  normalizeGeneratedFlattenRoot,
  readRegisteredGeneratedFlattenRoots
} from './generated-output-policy.js';
import { sanitizeStorageTargetPath, sanitizeStoragePathSegments } from './path-utils.js';

const MODULE_ID = 'fa-nexus';

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function findSceneOwnedRootPrefix(path, {
  worldId = getCurrentWorldId(),
  sceneId = getSceneId()
} = {}) {
  const normalized = trimTrailingSlashes(sanitizeStorageTargetPath(path));
  const cleanWorldId = String(worldId || '').trim();
  const cleanSceneId = String(sceneId || '').trim();
  if (!normalized || !cleanWorldId || !cleanSceneId) return '';

  const nestedMarker = `/${cleanWorldId}/${cleanSceneId}/`;
  const terminalMarker = `/${cleanWorldId}/${cleanSceneId}`;
  let boundaryIndex = normalized.lastIndexOf(nestedMarker);
  if (boundaryIndex < 0 && normalized.endsWith(terminalMarker)) {
    boundaryIndex = normalized.length - terminalMarker.length;
  }
  if (boundaryIndex <= 0) return '';

  return trimTrailingSlashes(sanitizeStoragePathSegments(normalized.slice(0, boundaryIndex)));
}

export function getGeneratedCleanupRootSpecs({
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  flattenOptions = null
} = {}) {
  const defaultFlattenRoot = buildGeneratedRoot('flattened', { assetsDir });
  const flattenRoots = new Set(getGeneratedFlattenRootCandidates({
    moduleId,
    assetsDir,
    flattenOptions
  }));

  return [
    {
      category: 'mask',
      storedRoot: buildGeneratedRoot('masks', { assetsDir }),
      reason: 'default-generated-root'
    },
    ...[...flattenRoots].map((storedRoot) => ({
      category: 'flattened',
      storedRoot,
      reason: storedRoot === defaultFlattenRoot
        ? 'default-generated-root'
        : 'registered-generated-root'
    }))
  ];
}

export function extractGeneratedFlattenRootFromPath(path, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  worldId = getCurrentWorldId(),
  sceneId = getSceneId()
} = {}) {
  const normalizedPath = trimTrailingSlashes(sanitizeStorageTargetPath(path));
  if (!normalizedPath) return '';

  const detected = detectGeneratedOutputPath(normalizedPath, {
    assetsDir,
    kind: 'flattened'
  });
  if (detected?.canonicalRoot) {
    return normalizeGeneratedFlattenRoot(detected.canonicalRoot, { assetsDir });
  }

  return findSceneOwnedRootPrefix(normalizedPath, { worldId, sceneId });
}

export async function ensureGeneratedFlattenRootRegistered(root, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId })
} = {}) {
  const normalizedRoot = normalizeGeneratedFlattenRoot(root, { assetsDir });
  if (!normalizedRoot) {
    return {
      root: '',
      existed: false,
      changed: false,
      roots: readRegisteredGeneratedFlattenRoots({ moduleId, assetsDir })
    };
  }

  const result = await ensureGeneratedFlattenRootsRegistered([normalizedRoot], { moduleId, assetsDir });
  return {
    root: normalizedRoot,
    existed: result.existingRoots.includes(normalizedRoot),
    changed: result.registeredRoots.includes(normalizedRoot),
    roots: result.roots
  };
}

export async function ensureGeneratedFlattenRootsRegistered(roots, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId })
} = {}) {
  const requestedRoots = Array.from(new Set((Array.isArray(roots) ? roots : [roots])
    .map((value) => normalizeGeneratedFlattenRoot(value, { assetsDir }))
    .filter(Boolean)));
  const current = readRegisteredGeneratedFlattenRoots({ moduleId, assetsDir });
  const existingRoots = requestedRoots.filter((root) => current.includes(root));
  const registeredRoots = requestedRoots.filter((root) => !current.includes(root));

  if (!registeredRoots.length) {
    return {
      requestedRoots,
      registeredRoots: [],
      existingRoots,
      changed: false,
      roots: current
    };
  }

  const next = [...current, ...registeredRoots].sort((left, right) => left.localeCompare(right));
  await game?.settings?.set?.(moduleId, 'generatedFlattenRoots', JSON.stringify(next));
  return {
    requestedRoots,
    registeredRoots,
    existingRoots,
    changed: true,
    roots: next
  };
}

export async function ensureGeneratedFlattenRootRegisteredFromPath(path, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  worldId = getCurrentWorldId(),
  sceneId = getSceneId()
} = {}) {
  const root = extractGeneratedFlattenRootFromPath(path, {
    moduleId,
    assetsDir,
    worldId,
    sceneId
  });
  return ensureGeneratedFlattenRootRegistered(root, { moduleId, assetsDir });
}

export async function ensureGeneratedFlattenRootsRegisteredFromPaths(paths, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  worldId = getCurrentWorldId(),
  sceneId = getSceneId()
} = {}) {
  const requestedRoots = Array.from(new Set((Array.isArray(paths) ? paths : [paths])
    .map((path) => extractGeneratedFlattenRootFromPath(path, {
      moduleId,
      assetsDir,
      worldId,
      sceneId
    }))
    .filter(Boolean)));
  const result = await ensureGeneratedFlattenRootsRegistered(requestedRoots, { moduleId, assetsDir });
  return {
    ...result,
    requestedRoots
  };
}
