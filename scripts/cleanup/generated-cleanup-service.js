import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { forgeIntegration } from '../storage/forge-integration.js';
import { encodeTexturePath } from '../textures/texture-runtime-core.js';
import {
  GeneratedCleanupMarkWorkflow,
  resolveGeneratedCleanupMimeType
} from './generated-cleanup-mark-workflow.js';
import { GeneratedCleanupScanWorkflow } from './generated-cleanup-scan-workflow.js';
import {
  getConfiguredAssetsDir,
  getCurrentWorldId
} from '../storage/generated-paths.js';
import { sanitizeStorageTargetPath } from '../storage/path-utils.js';
import {
  ensureFilePickerDirectory,
  ensureNestedFilePickerDirectory
} from '../storage/file-picker-directory.js';

const MODULE_ID = 'fa-nexus';
const MASK_DIR = 'masks';

function ensureTrailingSlash(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return '';
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}

function buildS3ObjectUrl(bucket, key) {
  const cleanBucket = String(bucket ?? '').trim();
  const cleanKey = sanitizeStorageTargetPath(key);
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
  constructor(options = {}) {
    const { markWorkflow = null, scanWorkflow = null } = options || {};
    this._scanWorkflow = scanWorkflow || new GeneratedCleanupScanWorkflow({
      getFilePicker: () => this._getFilePicker(),
      getAssetsDir: () => this._getAssetsDir(),
      getCurrentWorldId: () => this._getCurrentWorldId()
    });
    this._markWorkflow = markWorkflow || new GeneratedCleanupMarkWorkflow({
      getFilePicker: () => this._getFilePicker(),
      ensureNestedDir: (targetDir, context) => this._ensureNestedDir(targetDir, context),
      buildFetchCandidates: (entry) => this._buildFetchCandidates(entry),
      createPlaceholderFile: (filename, extension) => this._createPlaceholderFile(filename, extension),
      extractUploadPath: (uploadResult) => this._extractUploadPath(uploadResult),
      buildSkipEntry: (stage, reason, details) => this._buildSkipEntry(stage, reason, details)
    });
  }

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

  _serializeReferenceSet(values) {
    return Array.from(values || []).filter(Boolean).sort((a, b) => String(a).localeCompare(String(b)));
  }

  async _collectLiveSceneDocuments() {
    const scenes = [...(game?.scenes?.contents || [])];
    const packs = game?.packs?.contents || [];
    for (const pack of packs) {
      if (pack?.documentName !== 'Scene') continue;
      const packId = pack?.collection || pack?.metadata?.id || 'unknown';
      try {
        if (typeof pack.getIndex !== 'function') throw new Error('Scene pack getIndex() is unavailable');
        const index = await pack.getIndex({ fields: ['tiles.flags.fa-nexus'] });
        if (typeof index?.values !== 'function') throw new Error('Scene pack getIndex() returned an invalid result');
        scenes.push(...index.values());
      } catch (error) {
        Logger.error('GeneratedCleanup.scenePack.readFailed', {
          packId,
          error: String(error?.message || error)
        });
        throw error;
      }
    }
    return scenes;
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
    await ensureFilePickerDirectory(dir, {
      source: context?.source || 'data',
      options: context?.options || {},
      filePicker: this._getFilePicker(),
      cloneOptions: true,
      onCreate: ({ source }) => Logger.info('GeneratedCleanup.mkdir', { source, dir })
    });
  }

  async _ensureNestedDir(targetDir, context) {
    await ensureNestedFilePickerDirectory(targetDir, {
      source: context?.source || 'data',
      options: context?.options || {},
      filePicker: this._getFilePicker(),
      cloneOptions: true,
      onCreate: ({ source, dir }) => Logger.info('GeneratedCleanup.mkdir', { source, dir })
    });
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
    return this._markWorkflow.fetchOriginalBlob(entry);
  }

  async _uploadBackup(entry, blob, backupStamp) {
    return this._markWorkflow.uploadBackup(entry, blob, backupStamp);
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
    const type = resolveGeneratedCleanupMimeType(extension);
    const blob = await new Promise((resolve) => canvasEl.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error(`Failed to create ${type} placeholder`);
    return new File([blob], filename, { type });
  }

  async _overwriteWithPlaceholder(entry) {
    return this._markWorkflow.overwriteWithPlaceholder(entry);
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

    Logger.info('GeneratedCleanup.scan.start', { assetsRoot: this._getAssetsDir() });

    const scenes = await this._collectLiveSceneDocuments();
    const { liveRefs, counters } = this._scanWorkflow.collectLiveReferences(scenes, skipped);

    summary.directLiveRefs = counters.direct;
    summary.deconstructLiveRefs = counters.deconstruct;
    summary.uniqueLiveFiles = liveRefs.size;
    Logger.info('GeneratedCleanup.refs.counts', {
      directLiveRefs: summary.directLiveRefs,
      deconstructLiveRefs: summary.deconstructLiveRefs,
      uniqueLiveFiles: summary.uniqueLiveFiles
    });

    await this._scanWorkflow.registerDiscoveredGeneratedFlattenRoots(liveRefs, skipped);
    const roots = this._scanWorkflow.materializeRoots(liveRefs, skipped);
    const serializeReferenceSet = (values) => this._serializeReferenceSet(values);
    const scope = this._scanWorkflow.assessCrossWorldSafety(roots, serializeReferenceSet);
    const scopedLiveRefs = this._scanWorkflow.scopeLiveReferences(liveRefs, roots, skipped, serializeReferenceSet);
    const files = await this._scanWorkflow.scanRoots(roots, skipped);

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
        options: Object.assign({}, file.options || {}),
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
      const result = await this._markWorkflow.markEntry(entry, { backupFirst, backupStamp });
      if (result.marked) {
        summary.markedCount += 1;
      } else {
        summary.markSkippedCount += 1;
        report.skipped = Array.isArray(report.skipped) ? report.skipped : [];
        report.skipped.push(result.skip);
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

  /** Generated files the given Tiles reference, keyed like cleanup file entries. */
  async collectTileGeneratedFiles(docs) {
    await forgeIntegration.initialize();
    return this._scanWorkflow.collectTileGeneratedReferences(docs, []).liveRefs;
  }

  async fetchGeneratedFile(entry) {
    return this._markWorkflow.fetchOriginalBlob(entry);
  }

  async restoreGeneratedFile(entry, blob) {
    return this._markWorkflow.restoreOriginal(entry, blob);
  }

  /**
   * `canMark` limits marking to files the caller can still bring back. The deleting
   * session passes it so that an undoable deletion never destroys its only copy.
   */
  async markDeletedTileGeneratedFiles(docs, { backupFirst = false, canMark = null } = {}) {
    await forgeIntegration.initialize();
    const skipped = [];
    const { liveRefs: candidates } = this._scanWorkflow.collectTileGeneratedReferences(docs, skipped);
    if (!candidates.size) return { candidates: 0, marked: 0, skipped: skipped.length };

    const roots = this._scanWorkflow.materializeRoots(candidates, skipped);
    const serializeReferenceSet = (values) => this._serializeReferenceSet(values);
    const scope = this._scanWorkflow.assessCrossWorldSafety(roots, serializeReferenceSet);
    if (scope.markingAllowed === false) {
      Logger.warn('GeneratedCleanup.deletedTile.skipUnsafeScope', {
        candidates: candidates.size,
        warning: scope.warning || ''
      });
      return { candidates: candidates.size, marked: 0, skipped: skipped.length + 1 };
    }

    const latestSkipped = [];
    const latestScenes = await this._collectLiveSceneDocuments();
    const { liveRefs: latestLiveRefs } = this._scanWorkflow.collectLiveReferences(latestScenes, latestSkipped);
    skipped.push(...latestSkipped);
    const unusedCandidates = new Map([...candidates].filter(([key]) => !latestLiveRefs.has(key)));
    const scopedCandidates = this._scanWorkflow.scopeLiveReferences(
      unusedCandidates,
      roots,
      skipped,
      serializeReferenceSet
    );
    if (!scopedCandidates.size) {
      Logger.info('GeneratedCleanup.deletedTile.noUnusedCandidates', { candidates: candidates.size });
      return { candidates: candidates.size, marked: 0, skipped: skipped.length };
    }

    const candidateRoots = new Map();
    for (const candidate of scopedCandidates.values()) {
      if (!candidate?.parentTarget) continue;
      const key = `${candidate.signature}|${candidate.parentTarget}`;
      const root = candidateRoots.get(key);
      if (root) {
        root.categories.add(candidate.category);
        continue;
      }
      candidateRoots.set(key, {
        key,
        source: candidate.source,
        options: Object.assign({}, candidate.options || {}),
        signature: candidate.signature,
        target: candidate.parentTarget,
        recursive: false,
        categories: new Set([candidate.category]),
        reasons: new Set(['deleted-tile-candidate'])
      });
    }

    const files = await this._scanWorkflow.scanRoots(candidateRoots, skipped);
    const existingCandidates = [...files.values()]
      .filter((entry) => scopedCandidates.has(entry.key))
      .filter((entry) => (typeof canMark === 'function' ? canMark(entry) === true : true));
    const unusedMasks = existingCandidates.filter((entry) => entry.categories.has('mask'));
    const unusedFlattened = existingCandidates.filter((entry) => !entry.categories.has('mask'));
    if (!unusedMasks.length && !unusedFlattened.length) {
      Logger.info('GeneratedCleanup.deletedTile.noUnusedCandidates', { candidates: candidates.size });
      return { candidates: candidates.size, marked: 0, skipped: skipped.length };
    }

    const markReport = {
      scope,
      summary: buildBlankSummary(),
      unusedMasks,
      unusedFlattened,
      skipped
    };
    const markedReport = await this.markUnused(markReport, { backupFirst });
    return {
      candidates: candidates.size,
      marked: Number(markedReport?.summary?.markedCount || 0),
      skipped: Number(markedReport?.summary?.skipped || 0)
    };
  }
}
