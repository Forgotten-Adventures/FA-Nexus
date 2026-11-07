import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { isPrefabArtifactPath } from '../storage/prefab-paths.js';
import { forgeIntegration } from '../storage/forge-integration.js';
import {
  isGeneratedCleanupBackupPath,
  SUPPORTED_GENERATED_CLEANUP_EXTENSIONS
} from './generated-cleanup-mark-workflow.js';
import {
  buildWorldGeneratedFolder,
  getConfiguredAssetsDir,
  getCurrentWorldId
} from '../storage/generated-paths.js';
import {
  ensureGeneratedFlattenRootsRegistered,
  extractGeneratedFlattenRootFromPath,
  getGeneratedCleanupRootSpecs
} from '../storage/generated-output-roots.js';
import { sanitizeStorageTargetPath } from '../storage/path-utils.js';

const MODULE_ID = 'fa-nexus';
const MASKED_TILING_FLAG = 'maskedTiling';
const STANDARD_TILE_MASK_FLAG = 'standardTileMask';
const FLATTENED_FLAG = 'flattened';

function sanitizeTargetPath(value) {
  return sanitizeStorageTargetPath(value);
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

function sortEntries(entries) {
  entries.sort((a, b) => String(a.target || a.path || '').localeCompare(String(b.target || b.path || '')));
  return entries;
}

export class GeneratedCleanupScanWorkflow {
  constructor(options = {}) {
    this._logger = options.logger || Logger;
    this._getFilePicker = options.getFilePicker || (() => {
      const FilePickerImpl = foundry?.applications?.apps?.FilePicker?.implementation;
      if (!FilePickerImpl?.browse) throw new Error('Foundry FilePicker implementation is unavailable');
      return FilePickerImpl;
    });
    this._getAssetsDir = options.getAssetsDir || (() => getConfiguredAssetsDir({ moduleId: MODULE_ID }));
    this._getCurrentWorldId = options.getCurrentWorldId || (() => getCurrentWorldId());
    this._ensureGeneratedFlattenRootsRegistered = options.ensureGeneratedFlattenRootsRegistered || ensureGeneratedFlattenRootsRegistered;
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
    if (isPrefabArtifactPath(path)) return null;
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
    if (ref.sceneId) target.sceneIds.add(ref.sceneId);
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
      sceneIds: new Set(ref.sceneId ? [ref.sceneId] : []),
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
    const archiveReferences = flattened?.composition?.sourceAssets || [];
    if (!entries.length && !archiveReferences.length) return refs;
    const details = {
      sceneId: scene?.id || null,
      sceneName: scene?.name || '',
      tileId: doc?.id || null,
      fallbackContext
    };
    const visited = new WeakSet();

    for (const asset of archiveReferences) {
      const ref = this._buildReferenceEntry(asset.path, { ...details, category: asset.category,
        origin: 'deconstruct', refKind: 'deconstruct-composition-archive', path: asset.path });
      if (ref?.skip) skipped.push(ref.skip);
      else if (ref) refs.push(ref);
    }

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

  collectLiveReferences(scenes, skipped) {
    const liveRefs = new Map();
    const counters = { direct: 0, deconstruct: 0 };
    const defaultAssetsContext = forgeIntegration.resolveFilePickerContext(this._getAssetsDir());

    for (const scene of scenes || []) {
      for (const doc of scene?.tiles || []) {
        const directRefs = this._extractDirectReferences(scene, doc, defaultAssetsContext, skipped, counters);
        const deconstructRefs = this._extractDeconstructReferences(scene, doc, defaultAssetsContext, skipped, counters);
        for (const ref of [...directRefs, ...deconstructRefs]) {
          this._accumulateReference(liveRefs, ref);
        }
      }
    }

    return { liveRefs, counters };
  }

  collectTileGeneratedReferences(docs, skipped) {
    const liveRefs = new Map();
    const counters = { direct: 0, deconstruct: 0 };
    const defaultAssetsContext = forgeIntegration.resolveFilePickerContext(this._getAssetsDir());
    const list = Array.isArray(docs) ? docs : [docs];

    for (const doc of list) {
      if (!doc) continue;
      const scene = doc?.parent || canvas?.scene || game?.scenes?.current || null;
      const directRefs = this._extractDirectReferences(scene, doc, defaultAssetsContext, skipped, counters);
      const deconstructRefs = this._extractDeconstructReferences(scene, doc, defaultAssetsContext, skipped, counters);
      for (const ref of [...directRefs, ...deconstructRefs]) {
        this._accumulateReference(liveRefs, ref);
      }
    }

    return { liveRefs, counters };
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

  upsertRoot(map, root) {
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

  buildOwnedRoots(skipped) {
    const roots = new Map();
    const assetsDir = this._getAssetsDir();
    const worldId = this._getCurrentWorldId();
    const rootSpecs = getGeneratedCleanupRootSpecs({
      moduleId: MODULE_ID,
      assetsDir
    });

    for (const spec of rootSpecs) {
      let storedPath = '';
      try {
        const normalizedRoot = sanitizeTargetPath(spec.storedRoot);
        storedPath = pathBasename(normalizedRoot) === worldId
          ? spec.storedRoot
          : buildWorldGeneratedFolder(spec.storedRoot, { worldId });
      } catch (error) {
        skipped.push(this._buildSkipEntry('resolve-root', 'unresolved-world-root', {
          category: spec.category,
          path: spec.storedRoot,
          error: String(error?.message || error)
        }));
        this._logger.error('GeneratedCleanup.root.worldResolveFailed', {
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
        this._logger.warn('GeneratedCleanup.root.resolveFailed', { category: spec.category, path: storedPath });
        continue;
      }
      this.upsertRoot(roots, root);
    }
    this._logger.info('GeneratedCleanup.root.owned', {
      count: roots.size,
      roots: [...roots.values()].map((root) => ({
        source: root.source,
        target: root.target,
        categories: [...root.categories],
        reasons: [...root.reasons]
      }))
    });
    return roots;
  }

  collectExtraRoots(liveRefs, defaultRoots, skipped) {
    const roots = new Map();
    const defaultList = [...defaultRoots.values()];
    for (const ref of liveRefs.values()) {
      if (!ref?.target || !ref.parentTarget) continue;
      if (ref.category !== 'flattened') continue;
      const sceneIds = [...(ref.sceneIds || [])].filter(Boolean);
      const generatedRoot = sceneIds
        .map((sceneId) => extractGeneratedFlattenRootFromPath(ref.target, {
          moduleId: MODULE_ID,
          assetsDir: this._getAssetsDir(),
          worldId: this._getCurrentWorldId(),
          sceneId
        }))
        .find(Boolean);
      if (!generatedRoot) continue;
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
      this._logger.info('GeneratedCleanup.root.extra', {
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
      this.upsertRoot(roots, root);
    }
    return roots;
  }

  collectDiscoveredGeneratedFlattenRoots(liveRefs) {
    const roots = new Set();
    const assetsDir = this._getAssetsDir();
    const worldId = this._getCurrentWorldId();

    for (const ref of liveRefs.values()) {
      if (ref?.category !== 'flattened' || !ref?.target) continue;
      const sceneIds = [...(ref.sceneIds || [])].filter(Boolean);
      const rootCandidates = sceneIds.length
        ? sceneIds.map((sceneId) => extractGeneratedFlattenRootFromPath(ref.target, {
          moduleId: MODULE_ID,
          assetsDir,
          worldId,
          sceneId
        }))
        : [extractGeneratedFlattenRootFromPath(ref.target, {
          moduleId: MODULE_ID,
          assetsDir,
          worldId
        })];

      for (const root of rootCandidates) {
        if (root) roots.add(root);
      }
    }

    return Array.from(roots).sort((left, right) => left.localeCompare(right));
  }

  async registerDiscoveredGeneratedFlattenRoots(liveRefs, skipped) {
    const discoveredRoots = this.collectDiscoveredGeneratedFlattenRoots(liveRefs);
    if (!discoveredRoots.length) {
      return {
        requestedRoots: [],
        registeredRoots: [],
        existingRoots: [],
        changed: false,
        roots: []
      };
    }

    try {
      const result = await this._ensureGeneratedFlattenRootsRegistered(discoveredRoots, {
        moduleId: MODULE_ID,
        assetsDir: this._getAssetsDir()
      });
      this._logger.info('GeneratedCleanup.root.discovery', {
        requestedRoots: result.requestedRoots,
        registeredRoots: result.registeredRoots,
        existingRoots: result.existingRoots,
        changed: result.changed
      });
      return result;
    } catch (error) {
      const message = String(error?.message || error);
      this._logger.error('GeneratedCleanup.root.discoveryFailed', {
        requestedRoots: discoveredRoots,
        error: message
      });
      skipped.push(this._buildSkipEntry('register-root', 'register-generated-root-failed', {
        category: 'flattened',
        path: discoveredRoots.join(', '),
        error: message
      }));
      return {
        requestedRoots: discoveredRoots,
        registeredRoots: [],
        existingRoots: [],
        changed: false,
        roots: []
      };
    }
  }

  materializeRoots(liveRefs, skipped) {
    const ownedRoots = this.buildOwnedRoots(skipped);
    const extraRoots = this.collectExtraRoots(liveRefs, ownedRoots, skipped);
    const roots = new Map(ownedRoots);
    for (const root of extraRoots.values()) {
      this.upsertRoot(roots, root);
    }
    return roots;
  }

  _isWithinOwnedRoots(entry, ownedRoots) {
    if (!entry?.target) return false;
    for (const root of ownedRoots?.values?.() || []) {
      if (root?.signature !== entry?.signature) continue;
      if (comparePathWithinRoot(entry.target, root.target)) return true;
    }
    return false;
  }

  assessCrossWorldSafety(ownedRoots, serializeReferenceSet) {
    const worldId = this._getCurrentWorldId();
    const ownedList = [...(ownedRoots?.values?.() || [])];
    const crossWorldUnsafe = !worldId || !ownedList.length;
    const warning = !crossWorldUnsafe
      ? ''
      : (!worldId
        ? 'Current world id is unavailable. Mark Unused is disabled.'
        : 'No current-world generated roots could be resolved. Mark Unused is disabled.');

    const ownedRootSummaries = sortEntries(ownedList.map((root) => ({
      source: root.source,
      target: root.target,
      reasons: serializeReferenceSet(root.reasons)
    })));

    if (crossWorldUnsafe) {
      this._logger.warn('GeneratedCleanup.scope.unsafe', {
        worldId,
        ownedRoots: ownedRootSummaries
      });
    } else {
      this._logger.info('GeneratedCleanup.scope.safe', {
        worldId,
        ownedRoots: ownedRootSummaries
      });
    }

    return {
      worldId,
      crossWorldUnsafe,
      warning,
      ownedRoots: ownedRootSummaries,
      unsafeRoots: [],
      unsafeRefs: [],
      markingAllowed: !crossWorldUnsafe
    };
  }

  scopeLiveReferences(liveRefs, roots, skipped, serializeReferenceSet) {
    const scopedLiveRefs = new Map();

    for (const ref of liveRefs.values()) {
      if (this._isWithinOwnedRoots(ref, roots)) {
        scopedLiveRefs.set(ref.key, ref);
        continue;
      }
      this._logger.warn('GeneratedCleanup.ref.outsideOwnedScope', {
        source: ref.source,
        target: ref.target,
        path: ref.path,
        category: ref.category,
        refKind: ref.refKind,
        sceneName: serializeReferenceSet(ref.sceneNames)
      });
      skipped.push(this._buildSkipEntry('reference-scope', 'outside-owned-root', {
        category: ref.category,
        path: ref.path,
        source: ref.source,
        target: ref.target,
        sceneName: serializeReferenceSet(ref.sceneNames).join(', '),
        refKind: serializeReferenceSet(ref.refKinds).join(', ')
      }));
    }

    return scopedLiveRefs;
  }

  _fileKey(source, options, target) {
    return `${sourceSignature(source, options)}|${sanitizeTargetPath(target)}`;
  }

  _createFileEntry(path, root) {
    if (isPrefabArtifactPath(path)) return null;
    const context = this._resolvePathContext(path, { source: root.source, options: root.options });
    if (!context?.target) return null;
    if (isGeneratedCleanupBackupPath(context.target)) return null;
    const filename = pathBasename(context.target);
    const extension = extname(filename);
    if (!SUPPORTED_GENERATED_CLEANUP_EXTENSIONS.has(extension)) return null;
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

  async scanRoot(root, files, skipped) {
    const FilePickerImpl = this._getFilePicker();
    const queue = [root.target];
    const visited = new Set();
    while (queue.length) {
      const dir = queue.shift();
      if (!dir || visited.has(dir)) continue;
      if (isPrefabArtifactPath(dir)) continue;
      visited.add(dir);
      try {
        const result = await FilePickerImpl.browse(root.source, dir, Object.assign({}, root.options || {}));
        this._logger.info('GeneratedCleanup.root.scan', {
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
            if (isGeneratedCleanupBackupPath(normalized)) continue;
            queue.push(normalized);
          }
        }
      } catch (error) {
        const message = String(error?.message || error);
        this._logger.warn('GeneratedCleanup.root.browseFailed', { source: root.source, target: dir, error: message });
        skipped.push(this._buildSkipEntry('browse-root', 'browse-failed', {
          source: root.source,
          target: dir,
          error: message
        }));
      }
    }
  }

  async scanRoots(roots, skipped) {
    const files = new Map();
    for (const root of roots.values()) {
      await this.scanRoot(root, files, skipped);
    }
    return files;
  }
}
