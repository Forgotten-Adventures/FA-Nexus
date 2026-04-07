import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../core/forge-integration.js';
import { encodeTexturePath } from '../textures/texture-render.js';
import {
  appendStoragePath,
  buildGeneratedRoot,
  buildWorldGeneratedFolder,
  getConfiguredAssetsDir,
  getCurrentWorldId,
  sanitizeStoragePathSegments
} from '../core/generated-asset-paths.js';

const MODULE_ID = 'fa-nexus';
const MASK_DIR = 'masks';
const FLATTENED_DIR = 'flattened';
const BACKUP_ROOT = '__fa-nexus-cleanup-backups__';
const SUPPORTED_SCAN_EXTENSIONS = new Set(['.png', '.webp']);
const MASKED_TILING_FLAG = 'maskedTiling';
const STANDARD_TILE_MASK_FLAG = 'standardTileMask';
const FLATTENED_FLAG = 'flattened';

function stripQueryAndHash(value) {
  return String(value ?? '').split(/[?#]/, 1)[0] || '';
}

function safeDecode(value) {
  if (typeof value !== 'string') return value;
  try {
    return decodeURI(value);
  } catch (_) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }
}

function sanitizeTargetPath(value) {
  let normalized = String(value ?? '').trim().replace(/\\/g, '/');
  normalized = stripQueryAndHash(normalized);
  for (let i = 0; i < 3; i += 1) {
    const next = safeDecode(normalized);
    if (!next || next === normalized) break;
    normalized = next;
  }
  while (normalized.startsWith('/')) normalized = normalized.slice(1);
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  return normalized;
}

function pathBasename(value) {
  const normalized = sanitizeTargetPath(value);
  if (!normalized) return '';
  return normalized.split('/').pop() || '';
}

function pathDirname(value) {
  const normalized = sanitizeTargetPath(value);
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '';
  return normalized.slice(0, idx);
}

function extname(value) {
  const basename = pathBasename(value);
  const idx = basename.lastIndexOf('.');
  if (idx <= 0) return '';
  return basename.slice(idx).toLowerCase();
}

function sourceSignature(source, options = {}) {
  return JSON.stringify({
    source: String(source || 'data').toLowerCase(),
    bucket: options?.bucket ?? null,
    bucketKey: options?.bucketKey ?? null,
    cookieKey: !!options?.cookieKey
  });
}

function comparePathWithinRoot(path, root) {
  if (!path || !root) return false;
  if (String(path) === String(root)) return true;
  return String(path).startsWith(`${root}/`);
}

function resolveMimeType(extension) {
  if (extension === '.png') return 'image/png';
  if (extension === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function ensureTrailingSlash(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function buildS3ObjectUrl(bucket, key) {
  const cleanBucket = String(bucket ?? '').trim();
  const cleanKey = sanitizeTargetPath(key);
  if (!cleanBucket || !cleanKey) return '';

  const s3 = game?.data?.files?.s3 ?? {};
  const forcePathStyle = Boolean(s3.forcePathStyle || s3.pathStyle || s3.usePathStyle);
  const endpointCandidate = s3.endpoint || s3.url || s3.publicUrl || s3.publicURL || '';

  let endpointUrl = null;
  try {
    if (endpointCandidate instanceof URL) endpointUrl = endpointCandidate;
    else if (typeof endpointCandidate === 'string' && endpointCandidate.trim()) {
      const raw = endpointCandidate.trim();
      endpointUrl = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
    } else if (endpointCandidate && typeof endpointCandidate === 'object') {
      const protocol = String(endpointCandidate.protocol || 'https:');
      const host = String(endpointCandidate.host || endpointCandidate.hostname || '').trim();
      if (host) endpointUrl = new URL(`${protocol.endsWith(':') ? protocol : `${protocol}:`}//${host}`);
    }
  } catch (_) {
    endpointUrl = null;
  }

  if (endpointUrl) {
    if (forcePathStyle) {
      return new URL(cleanKey, ensureTrailingSlash(`${endpointUrl.origin.replace(/\/+$/, '')}/${cleanBucket}`)).href;
    }
    const host = endpointUrl.hostname;
    const withBucketHost = host.startsWith(`${cleanBucket}.`) ? host : `${cleanBucket}.${host}`;
    const origin = `${endpointUrl.protocol}//${withBucketHost}${endpointUrl.port ? `:${endpointUrl.port}` : ''}`;
    return new URL(cleanKey, ensureTrailingSlash(origin)).href;
  }

  const region = s3.region || s3.awsRegion || s3.awsDefaultRegion || '';
  const host = region ? `${cleanBucket}.s3.${region}.amazonaws.com` : `${cleanBucket}.s3.amazonaws.com`;
  return new URL(cleanKey, `https://${host}/`).href;
}

function buildBlankSummary() {
  return {
    directLiveRefs: 0,
    deconstructLiveRefs: 0,
    uniqueLiveFiles: 0,
    rootsScanned: 0,
    scannedFiles: 0,
    scannedMaskFiles: 0,
    scannedFlattenedFiles: 0,
    unusedMasks: 0,
    unusedFlattened: 0,
    missingRefs: 0,
    skipped: 0,
    markedCount: 0,
    markSkippedCount: 0
  };
}

export class GeneratedCleanupService {
  _getFilePicker() {
    const FilePickerImpl = foundry?.applications?.apps?.FilePicker?.implementation;
    if (!FilePickerImpl?.browse || !FilePickerImpl?.upload) {
      throw new Error('Foundry FilePicker implementation is unavailable');
    }
    return FilePickerImpl;
  }

  _getAssetsDir() {
    return getConfiguredAssetsDir({ moduleId: MODULE_ID });
  }

  _getCurrentWorldId() {
    return getCurrentWorldId();
  }

  _readGeneratedFlattenRoots() {
    try {
      const assetsDir = this._getAssetsDir();
      const currentDefault = buildGeneratedRoot('flattened', { assetsDir }).replace(/\/+$/, '');
      const legacyDefault = appendStoragePath(assetsDir, 'flattened').replace(/\/+$/, '');
      const previousDefault = appendStoragePath(appendStoragePath(assetsDir, 'generated'), 'flattened').replace(/\/+$/, '');
      const raw = game?.settings?.get?.(MODULE_ID, 'generatedFlattenRoots');
      const parsed = JSON.parse(String(raw || '[]'));
      if (!Array.isArray(parsed)) throw new Error('Setting is not an array');
      return parsed
        .map((value) => sanitizeStoragePathSegments(String(value || '').trim()).replace(/\/+$/, ''))
        .map((value) => (value === previousDefault ? currentDefault : value))
        .filter((value) => value && value !== legacyDefault)
        .filter(Boolean);
    } catch (error) {
      Logger.error('GeneratedCleanup.generatedRoots.readFailed', { error: String(error?.message || error) });
      throw new Error(`Failed to read generated flatten roots: ${error?.message || error}`);
    }
  }

  _readCurrentFlattenConfiguredRoot() {
    try {
      const assetsDir = this._getAssetsDir();
      const currentDefault = buildGeneratedRoot('flattened', { assetsDir }).replace(/\/+$/, '');
      const legacyDefault = appendStoragePath(assetsDir, 'flattened').replace(/\/+$/, '');
      const previousDefault = appendStoragePath(appendStoragePath(assetsDir, 'generated'), 'flattened').replace(/\/+$/, '');
      const stored = game?.settings?.get?.(MODULE_ID, 'flattenOptions');
      const configured = sanitizeStoragePathSegments(String(stored?.flattenOutputFolder || '').trim()).replace(/\/+$/, '');
      if (!configured) return '';
      if (configured === legacyDefault || configured === previousDefault) return currentDefault;
      return configured;
    } catch (error) {
      Logger.error('GeneratedCleanup.flattenOptions.readFailed', { error: String(error?.message || error) });
      throw new Error(`Failed to read flatten output folder setting: ${error?.message || error}`);
    }
  }

  _isWithinOwnedRoots(entry, ownedRoots) {
    if (!entry?.target) return false;
    for (const root of ownedRoots?.values?.() || []) {
      if (root?.signature !== entry?.signature) continue;
      if (comparePathWithinRoot(entry.target, root.target)) return true;
    }
    return false;
  }

  _assessCrossWorldSafety(ownedRoots) {
    const worldId = this._getCurrentWorldId();
    const ownedList = [...(ownedRoots?.values?.() || [])];
    const crossWorldUnsafe = !worldId || !ownedList.length;
    const warning = !crossWorldUnsafe
      ? ''
      : (!worldId
        ? 'Current world id is unavailable. Mark Unused is disabled.'
        : 'No current-world generated roots could be resolved. Mark Unused is disabled.');

    if (crossWorldUnsafe) {
      Logger.warn('GeneratedCleanup.scope.unsafe', {
        worldId,
        ownedRoots: this._sortEntries(ownedList.map((root) => ({
          source: root.source,
          target: root.target,
          reasons: this._serializeReferenceSet(root.reasons)
        })))
      });
    } else {
      Logger.info('GeneratedCleanup.scope.safe', {
        worldId,
        ownedRoots: this._sortEntries(ownedList.map((root) => ({
          source: root.source,
          target: root.target,
          reasons: this._serializeReferenceSet(root.reasons)
        })))
      });
    }

    return {
      worldId,
      crossWorldUnsafe,
      warning,
      ownedRoots: this._sortEntries(ownedList.map((root) => ({
        source: root.source,
        target: root.target,
        reasons: this._serializeReferenceSet(root.reasons)
      }))),
      unsafeRoots: [],
      unsafeRefs: [],
      markingAllowed: !crossWorldUnsafe
    };
  }

  _normalizeBrowseTarget(context, value) {
    const source = String(context?.source || 'data').toLowerCase();
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || (/^[^:]+:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw))) {
      const resolved = forgeIntegration.resolveFilePickerContext(raw);
      if (resolved?.target != null && String(resolved.source || '').toLowerCase() === source) {
        return sanitizeTargetPath(resolved.target);
      }
    }
    return sanitizeTargetPath(forgeIntegration.normalizeFilePickerTarget(source, raw));
  }

  _resolvePathContext(path, fallbackContext = null) {
    const raw = String(path ?? '').trim();
    if (!raw) return null;
    const fallbackSource = String(fallbackContext?.source || 'data').toLowerCase();
    const fallbackOptions = Object.assign({}, fallbackContext?.options || {});
    let source = fallbackSource;
    let options = fallbackOptions;
    let target = raw;
    if (/^https?:\/\//i.test(raw) || (/^[^:]+:/i.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw))) {
      const resolved = forgeIntegration.resolveFilePickerContext(raw);
      if (resolved?.target != null) {
        source = String(resolved.source || fallbackSource).toLowerCase();
        options = Object.assign({}, resolved.options || fallbackOptions);
        target = resolved.target;
      }
    } else {
      target = forgeIntegration.normalizeFilePickerTarget(source, raw);
    }
    const normalizedTarget = sanitizeTargetPath(target);
    return {
      source,
      options,
      target: normalizedTarget,
      signature: sourceSignature(source, options)
    };
  }

  _buildSkipEntry(stage, reason, details = {}) {
    return {
      stage: String(stage || 'scan'),
      reason: String(reason || 'unknown'),
      category: details.category || null,
      path: details.path || '',
      source: details.source || '',
      target: details.target || '',
      error: details.error ? String(details.error) : '',
      sceneId: details.sceneId || null,
      sceneName: details.sceneName || '',
      tileId: details.tileId || null,
      refKind: details.refKind || ''
    };
  }

  _buildReferenceEntry(path, details = {}) {
    const context = this._resolvePathContext(path, details.fallbackContext);
    if (!context?.target) {
      return { error: 'Unable to resolve file reference', skip: this._buildSkipEntry('resolve-reference', 'unresolved-reference', details) };
    }
    const filename = pathBasename(context.target);
    if (!filename) {
      return { error: 'Unable to determine filename', skip: this._buildSkipEntry('resolve-reference', 'missing-filename', details) };
    }
    return {
      key: `${context.signature}|${context.target}`,
      category: details.category || 'unknown',
      origin: details.origin || 'direct',
      refKind: details.refKind || '',
      path: String(path || '').trim(),
      source: context.source,
      options: context.options,
      signature: context.signature,
      target: context.target,
      parentTarget: pathDirname(context.target),
      filename,
      sceneId: details.sceneId || null,
      sceneName: details.sceneName || '',
      tileId: details.tileId || null
    };
  }

  _mergeReference(target, ref) {
    if (!target || !ref) return target;
    target.count = Number(target.count || 0) + 1;
    target.origins.add(ref.origin);
    if (ref.refKind) target.refKinds.add(ref.refKind);
    if (ref.sceneName) target.sceneNames.add(ref.sceneName);
    if (ref.tileId) target.tileIds.add(ref.tileId);
    if (!target.path && ref.path) target.path = ref.path;
    return target;
  }

  _accumulateReference(map, ref) {
    if (!(map instanceof Map) || !ref?.key) return;
    const existing = map.get(ref.key);
    if (existing) {
      this._mergeReference(existing, ref);
      return;
    }
    map.set(ref.key, {
      key: ref.key,
      category: ref.category,
      path: ref.path,
      source: ref.source,
      options: ref.options,
      signature: ref.signature,
      target: ref.target,
      parentTarget: ref.parentTarget,
      filename: ref.filename,
      count: 1,
      origins: new Set([ref.origin]),
      refKinds: new Set(ref.refKind ? [ref.refKind] : []),
      sceneNames: new Set(ref.sceneName ? [ref.sceneName] : []),
      tileIds: new Set(ref.tileId ? [ref.tileId] : [])
    });
  }

  _getModuleFlags(docLike) {
    if (!docLike) return null;
    const sourceFlags = docLike?.flags?.[MODULE_ID] || docLike?._source?.flags?.[MODULE_ID];
    if (sourceFlags && typeof sourceFlags === 'object') return sourceFlags;
    const fallback = {};
    for (const key of [MASKED_TILING_FLAG, STANDARD_TILE_MASK_FLAG, FLATTENED_FLAG]) {
      try {
        const value = docLike.getFlag?.(MODULE_ID, key);
        if (value !== undefined) fallback[key] = value;
      } catch (_) {}
    }
    return Object.keys(fallback).length ? fallback : null;
  }

  _extractDirectReferences(scene, doc, fallbackContext, skipped, counters) {
    const refs = [];
    const flags = this._getModuleFlags(doc);
    if (!flags || typeof flags !== 'object') return refs;
    const details = {
      sceneId: scene?.id || null,
      sceneName: scene?.name || '',
      tileId: doc?.id || null,
      fallbackContext
    };

    const masked = flags[MASKED_TILING_FLAG];
    if (masked?.maskSrc) {
      const ref = this._buildReferenceEntry(masked.maskSrc, {
        ...details,
        category: 'mask',
        origin: 'direct',
        refKind: MASKED_TILING_FLAG,
        path: masked.maskSrc
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    const standardMask = flags[STANDARD_TILE_MASK_FLAG];
    if (standardMask?.maskSrc) {
      const ref = this._buildReferenceEntry(standardMask.maskSrc, {
        ...details,
        category: 'mask',
        origin: 'direct',
        refKind: STANDARD_TILE_MASK_FLAG,
        path: standardMask.maskSrc
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    const flattened = flags[FLATTENED_FLAG];
    if (flattened?.filePath) {
      const ref = this._buildReferenceEntry(flattened.filePath, {
        ...details,
        category: 'flattened',
        origin: 'direct',
        refKind: 'flattened-file',
        path: flattened.filePath
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    if (Array.isArray(flattened?.chunks)) {
      for (const chunk of flattened.chunks) {
        if (!chunk?.src) continue;
        const ref = this._buildReferenceEntry(chunk.src, {
          ...details,
          category: 'flattened',
          origin: 'direct',
          refKind: 'flattened-chunk',
          path: chunk.src
        });
        if (ref?.skip) skipped.push(ref.skip);
        else if (ref) refs.push(ref);
      }
    }

    counters.direct += refs.length;
    return refs;
  }

  _collectEmbeddedFlagReferences(candidate, details, skipped, refs, visited) {
    if (!candidate || typeof candidate !== 'object') return;
    const seen = visited instanceof WeakSet ? visited : new WeakSet();
    if (seen.has(candidate)) return;
    seen.add(candidate);

    const masked = candidate[MASKED_TILING_FLAG];
    if (masked?.maskSrc) {
      const ref = this._buildReferenceEntry(masked.maskSrc, {
        ...details,
        category: 'mask',
        origin: 'deconstruct',
        refKind: 'deconstruct-masked-tiling',
        path: masked.maskSrc
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    const standardMask = candidate[STANDARD_TILE_MASK_FLAG];
    if (standardMask?.maskSrc) {
      const ref = this._buildReferenceEntry(standardMask.maskSrc, {
        ...details,
        category: 'mask',
        origin: 'deconstruct',
        refKind: 'deconstruct-standard-tile-mask',
        path: standardMask.maskSrc
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    const flattened = candidate[FLATTENED_FLAG];
    if (flattened?.filePath) {
      const ref = this._buildReferenceEntry(flattened.filePath, {
        ...details,
        category: 'flattened',
        origin: 'deconstruct',
        refKind: 'deconstruct-flattened-file',
        path: flattened.filePath
      });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

    if (Array.isArray(flattened?.chunks)) {
      for (const chunk of flattened.chunks) {
        if (!chunk?.src) continue;
        const ref = this._buildReferenceEntry(chunk.src, {
          ...details,
          category: 'flattened',
          origin: 'deconstruct',
          refKind: 'deconstruct-flattened-chunk',
          path: chunk.src
        });
        if (ref?.skip) skipped.push(ref.skip);
        else if (ref) refs.push(ref);
      }
    }

    const nestedEntries = Array.isArray(flattened?.tiles) ? flattened.tiles : [];
    for (const entry of nestedEntries) {
      if (entry?.faFlags && typeof entry.faFlags === 'object') {
        this._collectEmbeddedFlagReferences(entry.faFlags, details, skipped, refs, seen);
      }
      const embeddedFlags = entry?.data?.flags?.[MODULE_ID];
      if (embeddedFlags && typeof embeddedFlags === 'object') {
        this._collectEmbeddedFlagReferences(embeddedFlags, details, skipped, refs, seen);
      }
    }
  }

  _extractDeconstructReferences(scene, doc, fallbackContext, skipped, counters) {
    const refs = [];
    const flags = this._getModuleFlags(doc);
    const flattened = flags?.[FLATTENED_FLAG];
    const entries = Array.isArray(flattened?.tiles) ? flattened.tiles : [];
    if (!entries.length) return refs;
    const details = {
      sceneId: scene?.id || null,
      sceneName: scene?.name || '',
      tileId: doc?.id || null,
      fallbackContext
    };
    const visited = new WeakSet();

    for (const entry of entries) {
      if (entry?.faFlags && typeof entry.faFlags === 'object') {
        this._collectEmbeddedFlagReferences(entry.faFlags, details, skipped, refs, visited);
      }
      const embeddedFlags = entry?.data?.flags?.[MODULE_ID];
      if (embeddedFlags && typeof embeddedFlags === 'object') {
        this._collectEmbeddedFlagReferences(embeddedFlags, details, skipped, refs, visited);
      }
    }

    counters.deconstruct += refs.length;
    return refs;
  }

  _buildRootDescriptor(path, category, reason, fallbackContext = null, { recursive = true } = {}) {
    const context = this._resolvePathContext(path, fallbackContext);
    if (!context?.target) return null;
    return {
      key: `${context.signature}|${context.target}`,
      storedPath: String(path || '').trim(),
      source: context.source,
      options: context.options,
      signature: context.signature,
      target: context.target,
      recursive: recursive !== false,
      categories: new Set(category ? [category] : []),
      reasons: new Set(reason ? [reason] : [])
    };
  }

  _upsertRoot(map, root) {
    if (!(map instanceof Map) || !root?.key) return;
    const existing = map.get(root.key);
    if (!existing) {
      map.set(root.key, root);
      return;
    }
    existing.recursive = existing.recursive || root.recursive !== false;
    for (const category of root.categories || []) existing.categories.add(category);
    for (const reason of root.reasons || []) existing.reasons.add(reason);
  }

  _buildOwnedRoots(skipped) {
    const roots = new Map();
    const assetsDir = this._getAssetsDir();
    const worldId = this._getCurrentWorldId();
    const defaultFlattenRoot = buildGeneratedRoot('flattened', { assetsDir });
    const configuredFlattenRoot = this._readCurrentFlattenConfiguredRoot();
    const flattenRoots = new Set([
      defaultFlattenRoot,
      configuredFlattenRoot,
      ...this._readGeneratedFlattenRoots()
    ].filter(Boolean));
    const rootSpecs = [
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

    for (const spec of rootSpecs) {
      let storedPath = '';
      try {
        storedPath = buildWorldGeneratedFolder(spec.storedRoot, { worldId });
      } catch (error) {
        skipped.push(this._buildSkipEntry('resolve-root', 'unresolved-world-root', {
          category: spec.category,
          path: spec.storedRoot,
          error: String(error?.message || error)
        }));
        Logger.error('GeneratedCleanup.root.worldResolveFailed', {
          category: spec.category,
          root: spec.storedRoot,
          error: String(error?.message || error)
        });
        continue;
      }
      const root = this._buildRootDescriptor(
        storedPath,
        spec.category,
        spec.reason,
        null,
        { recursive: true }
      );
      if (!root?.target) {
        skipped.push(this._buildSkipEntry('resolve-root', 'unresolved-root', { category: spec.category, path: storedPath }));
        Logger.warn('GeneratedCleanup.root.resolveFailed', { category: spec.category, path: storedPath });
        continue;
      }
      Logger.info('GeneratedCleanup.root.owned', {
        category: spec.category,
        storedRoot: spec.storedRoot,
        source: root.source,
        target: root.target,
        reason: spec.reason
      });
      this._upsertRoot(roots, root);
    }
    return roots;
  }

  _collectExtraRoots(liveRefs, defaultRoots, skipped) {
    const roots = new Map();
    const defaultList = [...defaultRoots.values()];
    for (const ref of liveRefs.values()) {
      if (!ref?.target || !ref.parentTarget) continue;
      const covered = defaultList.some((root) => root.signature === ref.signature && comparePathWithinRoot(ref.target, root.target));
      if (covered) continue;
      const root = {
        key: `${ref.signature}|${ref.parentTarget}`,
        storedPath: ref.parentTarget,
        source: ref.source,
        options: Object.assign({}, ref.options || {}),
        signature: ref.signature,
        target: ref.parentTarget,
        recursive: false,
        categories: new Set(ref.category ? [ref.category] : []),
        reasons: new Set(['live-reference-parent'])
      };
      Logger.info('GeneratedCleanup.root.extra', {
        category: ref.category,
        source: root.source,
        target: root.target,
        reference: ref.target
      });
      if (!root.target) {
        skipped.push(this._buildSkipEntry('resolve-root', 'missing-parent-dir', {
          category: ref.category,
          path: ref.path,
          source: ref.source,
          target: ref.target
        }));
        continue;
      }
      this._upsertRoot(roots, root);
    }
    return roots;
  }

  _fileKey(source, options, target) {
    return `${sourceSignature(source, options)}|${sanitizeTargetPath(target)}`;
  }

  _createFileEntry(path, root) {
    const context = this._resolvePathContext(path, { source: root.source, options: root.options });
    if (!context?.target) return null;
    if (
      context.target === BACKUP_ROOT
      || context.target.startsWith(`${BACKUP_ROOT}/`)
      || context.target.includes(`/${BACKUP_ROOT}/`)
    ) return null;
    const filename = pathBasename(context.target);
    const extension = extname(filename);
    if (!SUPPORTED_SCAN_EXTENSIONS.has(extension)) return null;
    return {
      key: this._fileKey(context.source, context.options, context.target),
      path: String(path || '').trim() || context.target,
      source: context.source,
      options: context.options,
      signature: context.signature,
      target: context.target,
      parentTarget: pathDirname(context.target),
      filename,
      extension,
      categories: new Set(root.categories || []),
      roots: new Set([root.target]),
      backupPath: null,
      markStatus: null,
      markError: ''
    };
  }

  async _scanRoot(root, files, skipped) {
    const FilePickerImpl = this._getFilePicker();
    const queue = [root.target];
    const visited = new Set();
    while (queue.length) {
      const dir = queue.shift();
      if (!dir || visited.has(dir)) continue;
      visited.add(dir);
      try {
        const result = await FilePickerImpl.browse(root.source, dir, Object.assign({}, root.options || {}));
        Logger.info('GeneratedCleanup.root.scan', {
          source: root.source,
          target: dir,
          files: Array.isArray(result?.files) ? result.files.length : 0,
          dirs: Array.isArray(result?.dirs) ? result.dirs.length : 0
        });
        for (const filePath of result?.files || []) {
          const entry = this._createFileEntry(filePath, root);
          if (!entry) continue;
          const existing = files.get(entry.key);
          if (existing) {
            for (const category of entry.categories) existing.categories.add(category);
            for (const scannedRoot of entry.roots) existing.roots.add(scannedRoot);
          } else {
            files.set(entry.key, entry);
          }
        }
        if (root.recursive !== false) {
          for (const subdir of result?.dirs || []) {
            const normalized = this._normalizeBrowseTarget(root, subdir);
            if (!normalized || visited.has(normalized)) continue;
            if (
              normalized === BACKUP_ROOT
              || normalized.startsWith(`${BACKUP_ROOT}/`)
              || normalized.includes(`/${BACKUP_ROOT}/`)
            ) continue;
            queue.push(normalized);
          }
        }
      } catch (error) {
        const message = String(error?.message || error);
        Logger.warn('GeneratedCleanup.root.browseFailed', { source: root.source, target: dir, error: message });
        skipped.push(this._buildSkipEntry('browse-root', 'browse-failed', {
          source: root.source,
          target: dir,
          error: message
        }));
      }
    }
  }

  _serializeReferenceSet(values) {
    return Array.from(values || []).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  }

  _buildMissingEntry(ref) {
    return {
      category: ref.category,
      path: ref.path,
      source: ref.source,
      target: ref.target,
      filename: ref.filename,
      count: ref.count,
      origins: this._serializeReferenceSet(ref.origins),
      refKinds: this._serializeReferenceSet(ref.refKinds),
      sceneNames: this._serializeReferenceSet(ref.sceneNames),
      tileIds: this._serializeReferenceSet(ref.tileIds)
    };
  }

  _pickUnusedCategory(entry) {
    if (entry.categories.has('mask')) return 'mask';
    if (entry.categories.has('flattened')) return 'flattened';
    if (entry.target.includes(`/${MASK_DIR}/`) || entry.target.startsWith(`${MASK_DIR}/`)) return 'mask';
    return 'flattened';
  }

  _sortEntries(entries) {
    entries.sort((a, b) => String(a.target || a.path || '').localeCompare(String(b.target || b.path || '')));
    return entries;
  }

  _extractUploadPath(uploadResult) {
    if (!uploadResult) return '';
    if (typeof uploadResult === 'string') return uploadResult;
    if (typeof uploadResult?.url === 'string') return uploadResult.url;
    if (typeof uploadResult?.path === 'string') return uploadResult.path;
    if (typeof uploadResult?.file === 'string') return uploadResult.file;
    if (Array.isArray(uploadResult?.files) && typeof uploadResult.files[0] === 'string') return uploadResult.files[0];
    return '';
  }

  async _ensureDir(dir, context) {
    const FilePickerImpl = this._getFilePicker();
    try {
      await FilePickerImpl.browse(context.source, dir, Object.assign({}, context.options || {}));
    } catch (_) {
      Logger.info('GeneratedCleanup.mkdir', { source: context.source, dir });
      await FilePickerImpl.createDirectory(context.source, dir, Object.assign({}, context.options || {}));
    }
  }

  async _ensureNestedDir(targetDir, context) {
    const segments = String(targetDir || '').split('/').filter(Boolean);
    if (!segments.length) return;
    let acc = segments[0];
    await this._ensureDir(acc, context);
    for (let i = 1; i < segments.length; i += 1) {
      acc = `${acc}/${segments[i]}`;
      await this._ensureDir(acc, context);
    }
  }

  _buildFetchCandidates(entry) {
    const candidates = [];
    const seen = new Set();
    const add = (value) => {
      const normalized = String(value || '').trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    };

    const rawPath = String(entry?.path || '').trim();
    const rawTarget = String(entry?.target || '').trim();
    const preferredTarget = rawTarget || rawPath;
    const source = String(entry?.source || 'data').toLowerCase();

    if (/^https?:\/\//i.test(rawPath) || /^data:/i.test(rawPath)) add(rawPath);
    if (/^https?:\/\//i.test(rawTarget) || /^data:/i.test(rawTarget)) add(rawTarget);

    if (source === 'forgevtt' && preferredTarget) {
      add(forgeIntegration.optimizeCacheURL(preferredTarget));
    }

    if (source === 's3' && preferredTarget) {
      add(buildS3ObjectUrl(entry?.options?.bucket, preferredTarget));
    }

    if (preferredTarget) {
      const encoded = encodeTexturePath(preferredTarget.replace(/^\/+/, ''));
      if (encoded) {
        try {
          add(new URL(encoded, window.location.href).href);
        } catch (_) {
          add(encoded);
        }
      }
    }

    if (rawPath && rawPath !== preferredTarget) {
      const encodedPath = encodeTexturePath(rawPath.replace(/^\/+/, ''));
      if (encodedPath) {
        try {
          add(new URL(encodedPath, window.location.href).href);
        } catch (_) {
          add(encodedPath);
        }
      }
    }

    return candidates;
  }

  async _fetchOriginalBlob(entry) {
    const candidates = this._buildFetchCandidates(entry);
    if (!candidates.length) throw new Error('Unable to resolve fetch URL');
    let lastError = null;
    for (const url of candidates) {
      try {
        Logger.info('GeneratedCleanup.mark.fetchOriginal', { source: entry.source, target: entry.target, url });
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Fetch failed with ${response.status}`);
        }
        return response.blob();
      } catch (error) {
        lastError = error;
        Logger.warn('GeneratedCleanup.mark.fetchAttemptFailed', {
          source: entry.source,
          target: entry.target,
          url,
          error: String(error?.message || error)
        });
      }
    }
    throw lastError || new Error('Fetch failed');
  }

  async _uploadBackup(entry, blob, backupStamp) {
    const FilePickerImpl = this._getFilePicker();
    const backupDir = [BACKUP_ROOT, backupStamp, entry.parentTarget].filter(Boolean).join('/');
    await this._ensureNestedDir(backupDir, entry);
    const file = new File([blob], entry.filename, { type: blob?.type || resolveMimeType(entry.extension) });
    const upload = await FilePickerImpl.upload(
      entry.source,
      backupDir,
      file,
      Object.assign({}, entry.options || {}),
      { notify: false, filename: entry.filename }
    );
    const backupPath = this._extractUploadPath(upload) || [backupDir, entry.filename].filter(Boolean).join('/');
    if (!backupPath) throw new Error('Backup upload returned no path');
    return backupPath;
  }

  async _createPlaceholderFile(filename, extension) {
    const canvasEl = document.createElement('canvas');
    canvasEl.width = 64;
    canvasEl.height = 64;
    const ctx = canvasEl.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.strokeStyle = '#7a0000';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, canvasEl.width - 4, canvasEl.height - 4);
    const type = resolveMimeType(extension);
    const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error(`Failed to create ${type} placeholder`);
    return new File([blob], filename, { type });
  }

  async _overwriteWithPlaceholder(entry) {
    const FilePickerImpl = this._getFilePicker();
    const placeholder = await this._createPlaceholderFile(entry.filename, entry.extension);
    const upload = await FilePickerImpl.upload(
      entry.source,
      entry.parentTarget,
      placeholder,
      Object.assign({}, entry.options || {}),
      { notify: false, filename: entry.filename }
    );
    const writtenPath = this._extractUploadPath(upload) || [entry.parentTarget, entry.filename].filter(Boolean).join('/');
    if (!writtenPath) throw new Error('Overwrite upload returned no path');
    return writtenPath;
  }

  _buildMarkRunStamp() {
    const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
    return `${timestamp}-${rand}`;
  }

  async scan() {
    await forgeIntegration.initialize();
    const skipped = [];
    const summary = buildBlankSummary();
    const defaultAssetsContext = forgeIntegration.resolveFilePickerContext(this._getAssetsDir());
    const liveRefs = new Map();
    const counters = { direct: 0, deconstruct: 0 };

    Logger.info('GeneratedCleanup.scan.start', { assetsRoot: this._getAssetsDir() });

    for (const scene of game?.scenes?.contents || []) {
      for (const doc of scene?.tiles || []) {
        const directRefs = this._extractDirectReferences(scene, doc, defaultAssetsContext, skipped, counters);
        const deconstructRefs = this._extractDeconstructReferences(scene, doc, defaultAssetsContext, skipped, counters);
        for (const ref of [...directRefs, ...deconstructRefs]) {
          this._accumulateReference(liveRefs, ref);
        }
      }
    }

    summary.directLiveRefs = counters.direct;
    summary.deconstructLiveRefs = counters.deconstruct;
    summary.uniqueLiveFiles = liveRefs.size;
    Logger.info('GeneratedCleanup.refs.counts', {
      directLiveRefs: summary.directLiveRefs,
      deconstructLiveRefs: summary.deconstructLiveRefs,
      uniqueLiveFiles: summary.uniqueLiveFiles
    });

    const ownedRoots = this._buildOwnedRoots(skipped);
    const roots = new Map(ownedRoots);
    const scope = this._assessCrossWorldSafety(ownedRoots);
    const scopedLiveRefs = new Map();

    for (const ref of liveRefs.values()) {
      if (this._isWithinOwnedRoots(ref, ownedRoots)) {
        scopedLiveRefs.set(ref.key, ref);
        continue;
      }
      Logger.warn('GeneratedCleanup.ref.outsideOwnedScope', {
        source: ref.source,
        target: ref.target,
        path: ref.path,
        category: ref.category,
        refKind: ref.refKind,
        sceneName: this._serializeReferenceSet(ref.sceneNames)
      });
      skipped.push(this._buildSkipEntry('reference-scope', 'outside-owned-root', {
        category: ref.category,
        path: ref.path,
        source: ref.source,
        target: ref.target,
        sceneName: this._serializeReferenceSet(ref.sceneNames).join(', '),
        refKind: this._serializeReferenceSet(ref.refKinds).join(', ')
      }));
    }

    const files = new Map();
    for (const root of roots.values()) {
      await this._scanRoot(root, files, skipped);
    }

    const unusedMasks = [];
    const unusedFlattened = [];
    const missingRefs = [];

    for (const ref of scopedLiveRefs.values()) {
      if (files.has(ref.key)) continue;
      missingRefs.push(this._buildMissingEntry(ref));
    }

    for (const file of files.values()) {
      if (scopedLiveRefs.has(file.key)) continue;
      const category = this._pickUnusedCategory(file);
      const entry = {
        key: file.key,
        category,
        path: file.path,
        source: file.source,
        target: file.target,
        parentTarget: file.parentTarget,
        filename: file.filename,
        extension: file.extension,
        markStatus: file.markStatus,
        markError: file.markError,
        backupPath: file.backupPath
      };
      if (category === 'mask') unusedMasks.push(entry);
      else unusedFlattened.push(entry);
    }

    summary.rootsScanned = roots.size;
    summary.scannedFiles = files.size;
    summary.scannedMaskFiles = [...files.values()].filter((entry) => entry.categories.has('mask')).length;
    summary.scannedFlattenedFiles = [...files.values()].filter((entry) => entry.categories.has('flattened')).length;
    summary.unusedMasks = unusedMasks.length;
    summary.unusedFlattened = unusedFlattened.length;
    summary.missingRefs = missingRefs.length;
    summary.skipped = skipped.length;

    Logger.info('GeneratedCleanup.scan.summary', {
      rootsScanned: summary.rootsScanned,
      scannedFiles: summary.scannedFiles,
      scannedMaskFiles: summary.scannedMaskFiles,
      scannedFlattenedFiles: summary.scannedFlattenedFiles,
      unusedMasks: summary.unusedMasks,
      unusedFlattened: summary.unusedFlattened,
      missingRefs: summary.missingRefs,
      skipped: summary.skipped
    });

    return {
      generatedAt: Date.now(),
      scope,
      roots: this._sortEntries([...roots.values()].map((root) => ({
        source: root.source,
        target: root.target,
        categories: this._serializeReferenceSet(root.categories),
        reasons: this._serializeReferenceSet(root.reasons)
      }))),
      summary,
      unusedMasks: this._sortEntries(unusedMasks),
      unusedFlattened: this._sortEntries(unusedFlattened),
      missingRefs: this._sortEntries(missingRefs),
      skipped: this._sortEntries(skipped)
    };
  }

  async markUnused(report, { backupFirst = true } = {}) {
    if (!report || typeof report !== 'object') throw new Error('Cleanup report is required');
    if (report?.scope?.markingAllowed === false) {
      throw new Error(report?.scope?.warning || 'Mark Unused is disabled for shared storage roots');
    }
    const entries = [
      ...(Array.isArray(report.unusedMasks) ? report.unusedMasks : []),
      ...(Array.isArray(report.unusedFlattened) ? report.unusedFlattened : [])
    ];
    const summary = report.summary || buildBlankSummary();
    summary.markedCount = 0;
    summary.markSkippedCount = 0;
    if (!entries.length) {
      Logger.info('GeneratedCleanup.mark.skipEmpty');
      return report;
    }

    const backupStamp = this._buildMarkRunStamp();
    Logger.info('GeneratedCleanup.mark.start', { count: entries.length, backupFirst, backupStamp });

    for (const entry of entries) {
      let phase = 'validate';
      try {
        if (!SUPPORTED_SCAN_EXTENSIONS.has(String(entry.extension || '').toLowerCase())) {
          throw new Error(`Unsupported extension: ${entry.extension || 'unknown'}`);
        }

        let originalBlob = null;
        let backupPath = null;
        if (backupFirst) {
          phase = 'fetch-original';
          originalBlob = await this._fetchOriginalBlob(entry);
          phase = 'upload-backup';
          backupPath = await this._uploadBackup(entry, originalBlob, backupStamp);
          entry.backupPath = backupPath;
          Logger.info('GeneratedCleanup.mark.backupCreated', { source: entry.source, target: entry.target, backupPath });
        }

        phase = 'overwrite-placeholder';
        const writtenPath = await this._overwriteWithPlaceholder(entry);
        entry.markStatus = 'marked';
        entry.markError = '';
        summary.markedCount += 1;
        Logger.info('GeneratedCleanup.mark.success', {
          source: entry.source,
          target: entry.target,
          writtenPath,
          backupPath: entry.backupPath || null
        });
      } catch (error) {
        const message = String(error?.message || error);
        const reason = phase === 'validate'
          ? 'unsupported-extension'
          : (phase === 'fetch-original'
            ? 'fetch-failed'
            : (phase === 'upload-backup'
              ? 'backup-upload-failed'
              : 'overwrite-upload-failed'));
        entry.markStatus = 'skipped';
        entry.markError = message;
        summary.markSkippedCount += 1;
        report.skipped = Array.isArray(report.skipped) ? report.skipped : [];
        report.skipped.push(this._buildSkipEntry(phase, reason, {
          category: entry.category,
          path: entry.path,
          source: entry.source,
          target: entry.target,
          error: message
        }));
        Logger.error('GeneratedCleanup.mark.failed', {
          source: entry.source,
          target: entry.target,
          error: message
        });
      }
    }

    summary.skipped = Array.isArray(report.skipped) ? report.skipped.length : 0;
    report.summary = summary;
    report.lastMarkedAt = Date.now();
    report.lastBackupFirst = !!backupFirst;
    report.unusedMasks = this._sortEntries(report.unusedMasks || []);
    report.unusedFlattened = this._sortEntries(report.unusedFlattened || []);
    report.skipped = this._sortEntries(report.skipped || []);
    Logger.info('GeneratedCleanup.mark.summary', {
      markedCount: summary.markedCount,
      markSkippedCount: summary.markSkippedCount,
      skipped: summary.skipped
    });
    return report;
  }
}
