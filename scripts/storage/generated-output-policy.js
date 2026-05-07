import {
  appendStoragePath,
  buildGeneratedRoot,
  getConfiguredAssetsDir
} from './generated-paths.js';
import { sanitizeStorageTargetPath, sanitizeStoragePathSegments } from './path-utils.js';

const MODULE_ID = 'fa-nexus';

function trimTrailingSlashes(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function comparePathWithinRoot(path, root) {
  if (!path || !root) return false;
  if (String(path) === String(root)) return true;
  return String(path).startsWith(`${root}/`);
}

export function getGeneratedFlattenRootAliases({ assetsDir = getConfiguredAssetsDir({ moduleId: MODULE_ID }) } = {}) {
  const cleanAssetsDir = String(assetsDir || '').trim();
  const currentDefault = trimTrailingSlashes(buildGeneratedRoot('flattened', { assetsDir: cleanAssetsDir }));
  const legacyDefault = trimTrailingSlashes(appendStoragePath(cleanAssetsDir, 'flattened'));
  const previousDefault = trimTrailingSlashes(appendStoragePath(appendStoragePath(cleanAssetsDir, 'generated'), 'flattened'));
  return {
    currentDefault,
    legacyDefault,
    previousDefault,
    aliases: [currentDefault, legacyDefault, previousDefault].filter(Boolean)
  };
}

export function getGeneratedMaskRoot({ assetsDir = getConfiguredAssetsDir({ moduleId: MODULE_ID }) } = {}) {
  return trimTrailingSlashes(buildGeneratedRoot('masks', { assetsDir }));
}

export function normalizeGeneratedFlattenRoot(root, { assetsDir = getConfiguredAssetsDir({ moduleId: MODULE_ID }) } = {}) {
  const normalized = trimTrailingSlashes(sanitizeStoragePathSegments(root));
  if (!normalized) return '';
  const aliases = getGeneratedFlattenRootAliases({ assetsDir });
  if (normalized === aliases.legacyDefault || normalized === aliases.previousDefault) {
    return aliases.currentDefault;
  }
  return normalized;
}

export function readRegisteredGeneratedFlattenRoots({
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId })
} = {}) {
  const raw = game?.settings?.get?.(moduleId, 'generatedFlattenRoots');
  let parsed = [];
  try {
    parsed = JSON.parse(String(raw || '[]'));
  } catch (error) {
    throw new Error(`Failed to parse generated flatten roots: ${error?.message || error}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Generated flatten roots setting is not an array');
  }
  return Array.from(new Set(parsed
    .map((value) => normalizeGeneratedFlattenRoot(value, { assetsDir }))
    .filter(Boolean)));
}

export function readConfiguredFlattenOutputRoot({
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  options = null
} = {}) {
  const stored = options ?? game?.settings?.get?.(moduleId, 'flattenOptions');
  return normalizeGeneratedFlattenRoot(stored?.flattenOutputFolder || '', { assetsDir });
}

export async function registerGeneratedFlattenRoot(root, {
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId })
} = {}) {
  const normalizedRoot = normalizeGeneratedFlattenRoot(root, { assetsDir });
  if (!normalizedRoot) throw new Error('Generated flatten root is required');
  const current = readRegisteredGeneratedFlattenRoots({ moduleId, assetsDir });
  if (current.includes(normalizedRoot)) return current;
  const next = [...current, normalizedRoot].sort((a, b) => a.localeCompare(b));
  await game?.settings?.set?.(moduleId, 'generatedFlattenRoots', JSON.stringify(next));
  return next;
}

export function getGeneratedFlattenRootCandidates({
  moduleId = MODULE_ID,
  assetsDir = getConfiguredAssetsDir({ moduleId }),
  flattenOptions = null
} = {}) {
  const aliases = getGeneratedFlattenRootAliases({ assetsDir });
  const configured = readConfiguredFlattenOutputRoot({ moduleId, assetsDir, options: flattenOptions });
  const registered = readRegisteredGeneratedFlattenRoots({ moduleId, assetsDir });
  return Array.from(new Set([
    aliases.currentDefault,
    configured,
    ...registered
  ].filter(Boolean)));
}

export function detectGeneratedOutputPath(path, {
  assetsDir = getConfiguredAssetsDir({ moduleId: MODULE_ID }),
  kind = null
} = {}) {
  const normalized = trimTrailingSlashes(sanitizeStorageTargetPath(path));
  if (!normalized) return null;

  if (kind !== 'mask') {
    const aliases = getGeneratedFlattenRootAliases({ assetsDir });
    for (const candidate of aliases.aliases) {
      if (!candidate) continue;
      if (comparePathWithinRoot(normalized, candidate)) {
        return {
          kind: 'flattened',
          matchedRoot: candidate,
          canonicalRoot: aliases.currentDefault,
          target: normalized
        };
      }
    }
  }

  if (kind !== 'flattened') {
    const maskRoot = getGeneratedMaskRoot({ assetsDir });
    if (maskRoot && comparePathWithinRoot(normalized, maskRoot)) {
      return {
        kind: 'mask',
        matchedRoot: maskRoot,
        canonicalRoot: maskRoot,
        target: normalized
      };
    }
  }

  return null;
}
