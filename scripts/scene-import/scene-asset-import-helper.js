import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { NexusContentService } from '../content/nexus-content-service.js';
import { NexusDownloadManager } from '../content/nexus-download-manager.js';
import { getSceneLevels } from '../canvas/elevation-band-utils.js';
import { invalidateSharedAssetCatalog } from '../assets/assets-tab-controller.js';
import {
  appendStoragePath,
  getConfiguredAssetsDir,
  getCurrentWorldId,
  getSceneId
} from '../storage/generated-paths.js';
import { detectGeneratedOutputPath } from '../storage/generated-output-policy.js';
import { ensureGeneratedFlattenRootsRegisteredFromPaths } from '../storage/generated-output-roots.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const MODULE_ID = 'fa-nexus';
const IMAGE_REF_RE = /\.(avif|jpe?g|png|webp)(?:$|[?#])/i;
const DIRECT_FREE_ASSET_URL_RE = /^https:\/\/r2-public\.forgotten-adventures\.net\/assets\/free_assets\//i;
const MAX_DETAIL_ROWS = 80;
const LOCAL_MASKS_DIR = 'masks';
const GENERATED_MASKS_ROOT = '__generated/masks';
const LOCAL_MASK_TIER = 'local-mask';
const MASK_FLAG_PATHS = new Set([
  'maskedTiling.maskSrc',
  'standardTileMask.maskSrc'
]);
const BUILDING_FLAG_SEGMENTS = new Set([
  'building',
  'buildingComposite',
  'buildingDoor',
  'buildingDoorFrame',
  'buildingFill',
  'buildingWall',
  'buildingWindow',
  'buildingWindowFrame',
  'buildingWindowSill',
  'buildingWindowWindow'
]);
const BUILDING_NAMED_KEY_PARENTS = new Set([
  'fillTexture',
  'wallTexture'
]);

const STATUS = Object.freeze({
  current: 'current',
  ready: 'ready',
  downloadable: 'downloadable',
  repaired: 'repaired',
  localOnlyMissing: 'localOnlyMissing',
  unmatched: 'unmatched',
  ambiguous: 'ambiguous',
  auth: 'auth',
  failed: 'failed'
});

const REPORTABLE_STATUSES = new Set([
  STATUS.ready,
  STATUS.downloadable,
  STATUS.repaired,
  STATUS.localOnlyMissing,
  STATUS.unmatched,
  STATUS.ambiguous,
  STATUS.auth,
  STATUS.failed
]);

const STATUS_VIEW = Object.freeze({
  [STATUS.current]: { label: 'Already linked', css: 'is-current' },
  [STATUS.ready]: { label: 'Local file', css: 'is-ready' },
  [STATUS.downloadable]: { label: 'Missing', css: 'is-missing' },
  [STATUS.repaired]: { label: 'Repaired', css: 'is-repaired' },
  [STATUS.localOnlyMissing]: { label: 'Missing local output', css: 'is-failed' },
  [STATUS.unmatched]: { label: 'No cloud match', css: 'is-unmatched' },
  [STATUS.ambiguous]: { label: 'Ambiguous', css: 'is-ambiguous' },
  [STATUS.auth]: { label: 'Auth required', css: 'is-auth' },
  [STATUS.failed]: { label: 'Failed', css: 'is-failed' }
});

function cleanString(value) {
  return String(value ?? '').trim();
}

function stripQueryAndHash(value) {
  return String(value || '').split(/[?#]/)[0];
}

function safeDecode(value) {
  let current = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    try {
      const next = decodeURI(current);
      if (!next || next === current) break;
      current = next;
    } catch (_) {
      try {
        const next = decodeURIComponent(current);
        if (!next || next === current) break;
        current = next;
      } catch (_) {
        break;
      }
    }
  }
  return current;
}

function normalizeSlashes(value) {
  return cleanString(value).replace(/\\/g, '/');
}

function normalizeReferencePath(value) {
  let raw = normalizeSlashes(value);
  if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return '';
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      raw = url.pathname || '';
    } catch (error) {
      Logger.warn('SceneImportHelper.normalize.urlFailed', { value: raw, error: String(error?.message || error) });
    }
  }
  raw = stripQueryAndHash(raw);
  raw = safeDecode(raw);
  return normalizeSlashes(raw).replace(/^\/+/, '');
}

function encodeTexturePath(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try { return encodeURI(decodeURI(String(path))); }
  catch (_) {
    try { return encodeURI(String(path)); }
    catch (_) { return path; }
  }
}

function isImageReference(value) {
  const raw = cleanString(value);
  if (!raw || /^data:/i.test(raw) || /^blob:/i.test(raw)) return false;
  return IMAGE_REF_RE.test(raw);
}

function basename(path) {
  const clean = normalizeReferencePath(path);
  return clean.split('/').pop() || '';
}

function isMaskFlagReference(ref) {
  if (ref?.scope !== 'tile-flag') return false;
  const path = Array.isArray(ref.flagPath) ? ref.flagPath : [];
  const flagPath = path.slice(-2).join('.');
  return MASK_FLAG_PATHS.has(flagPath);
}

function isPathEditorFilenameMetadata(flagPath) {
  const path = Array.isArray(flagPath) ? flagPath.map((part) => String(part || '')) : [];
  if (path.at(-1) !== 'filename') return false;
  return path.some((part) => part === 'path' || part === 'pathV2' || part === 'pathsV2');
}

function isBuildingAssetKeyMetadata(flagPath) {
  const path = Array.isArray(flagPath) ? flagPath.map((part) => String(part || '')) : [];
  if (!path.some((part) => BUILDING_FLAG_SEGMENTS.has(part))) return false;
  const last = path.at(-1) || '';
  if (/Key$/.test(last)) return true;
  return last === 'key' && BUILDING_NAMED_KEY_PARENTS.has(path.at(-2) || '');
}

function shouldSkipFlagImageReference(flagPath, value) {
  if (isPathEditorFilenameMetadata(flagPath)) {
    Logger.debug('SceneImportHelper.flag.skipPathFilename', {
      flagPath: Array.isArray(flagPath) ? flagPath.join('.') : '',
      value
    });
    return true;
  }
  if (isBuildingAssetKeyMetadata(flagPath)) {
    Logger.debug('SceneImportHelper.flag.skipBuildingAssetKey', {
      flagPath: Array.isArray(flagPath) ? flagPath.join('.') : '',
      value
    });
    return true;
  }
  return false;
}

function isStaticLocalReference(source, normalized = normalizeReferencePath(source)) {
  const raw = cleanString(source);
  if (!raw || /^https?:\/\//i.test(raw)) return false;
  return /^(worlds|modules|systems)\//i.test(normalized);
}

function dirname(path) {
  const clean = normalizeReferencePath(path);
  const index = clean.lastIndexOf('/');
  return index >= 0 ? clean.slice(0, index) : '';
}

function localReferenceEntry(ref, localPath, reason = 'local-file-current') {
  return {
    ref,
    status: STATUS.current,
    reason,
    source: ref.src,
    localPath,
    cloudPath: '',
    localOnly: true
  };
}

function readModuleFlag(doc, flag) {
  try {
    const value = doc?.getFlag?.(MODULE_ID, flag);
    if (value !== undefined) return value;
  } catch (_) {}
  return doc?.flags?.[MODULE_ID]?.[flag] || doc?._source?.flags?.[MODULE_ID]?.[flag] || null;
}

function isFlattenedTileTextureReference(ref) {
  return ref?.scope === 'tile-texture' && !!readModuleFlag(ref?.doc, 'flattened');
}

function isFlattenedOutputFlagReference(ref) {
  if (ref?.scope !== 'tile-flag') return false;
  const path = Array.isArray(ref.flagPath) ? ref.flagPath.map((part) => String(part || '')) : [];
  if (!path.includes('flattened')) return false;
  const last = path.at(-1);
  if (last === 'filePath') return true;
  return last === 'src' && path.includes('chunks');
}

function shouldRegisterGeneratedFlattenRootEntry(entry) {
  const ref = entry?.ref;
  if (!ref?.src) return false;
  if (isFlattenedTileTextureReference(ref) || isFlattenedOutputFlagReference(ref)) return true;
  const generatedPath = detectGeneratedOutputPath(ref.src, {
    assetsDir: getConfiguredAssetsDir({ moduleId: MODULE_ID }),
    kind: 'flattened'
  });
  return generatedPath?.kind === 'flattened';
}

function isGeneratedLocalSourceReference(source) {
  const normalized = normalizeReferencePath(source).toLowerCase();
  if (!normalized) return false;
  if (detectGeneratedOutputPath(normalized, { assetsDir: getConfiguredAssetsDir({ moduleId: MODULE_ID }) })) return true;
  if (/(^|\/)assets\/tiles\/[^/]+-texture-src\.png$/.test(normalized)) return true;
  return /(^|\/)fa-nexus-assets\/masks\/[^/]+\.(avif|jpe?g|png|webp)$/.test(normalized);
}

function isTransparentPlaceholderReference(source) {
  const normalized = normalizeReferencePath(source).toLowerCase();
  return normalized === 'modules/fa-nexus/images/transparent.png'
    || normalized === 'fa-nexus/images/transparent.png'
    || normalized === 'images/transparent.png';
}

function isLocalOnlyReference(ref) {
  return isMaskFlagReference(ref)
    || isFlattenedTileTextureReference(ref)
    || isFlattenedOutputFlagReference(ref)
    || isGeneratedLocalSourceReference(ref?.src)
    || isTransparentPlaceholderReference(ref?.src);
}

function isReportableEntry(entry) {
  return !!entry && REPORTABLE_STATUSES.has(entry.status);
}

function addReportEntry(report, entry) {
  if (!isReportableEntry(entry)) return false;
  report.entries.push(entry);
  return true;
}

function getConfiguredAssetPath(relativePath) {
  return appendStoragePath(getConfiguredAssetsDir({ moduleId: MODULE_ID }), relativePath);
}

function buildLocalMaskCandidates(filename, scene = null) {
  const cleanFilename = cleanString(filename);
  if (!cleanFilename) return [];

  const candidates = [];
  const seen = new Set();
  const add = (relativePath, reason) => {
    const cleanRelativePath = normalizeSlashes(relativePath).replace(/^\/+/, '');
    const key = cleanRelativePath.toLowerCase();
    if (!cleanRelativePath || seen.has(key)) return;
    seen.add(key);
    candidates.push({
      filename: cleanFilename,
      relativePath: cleanRelativePath,
      expectedPath: getConfiguredAssetPath(cleanRelativePath),
      reason,
      record: {
        filename: cleanFilename,
        file_path: cleanRelativePath,
        path: cleanRelativePath,
        tier: LOCAL_MASK_TIER
      }
    });
  };

  add(appendStoragePath(LOCAL_MASKS_DIR, cleanFilename), 'local-mask-folder');

  const worldId = getCurrentWorldId();
  const sceneId = getSceneId(scene);
  if (worldId && sceneId) {
    add(
      appendStoragePath(appendStoragePath(GENERATED_MASKS_ROOT, worldId), appendStoragePath(sceneId, cleanFilename)),
      'generated-mask-folder'
    );
  }

  return candidates;
}

function uniquePush(set, value) {
  const clean = normalizeReferencePath(value);
  if (clean) set.add(clean);
}

function buildSourceCandidates(source) {
  const normalized = normalizeReferencePath(source);
  const candidates = new Set();
  uniquePush(candidates, normalized);

  const markers = [
    '/assets/free_assets/',
    '/assets/premium_assets/',
    '/assets/thumbnails/',
    '/free_assets/',
    '/premium_assets/',
    '/fa-nexus-assets/',
    'assets/free_assets/',
    'assets/premium_assets/',
    'assets/thumbnails/',
    'free_assets/',
    'premium_assets/',
    'fa-nexus-assets/'
  ];

  for (const marker of markers) {
    const index = normalized.indexOf(marker);
    if (index >= 0) uniquePush(candidates, normalized.slice(index + marker.length));
  }

  const segments = normalized.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    uniquePush(candidates, segments.slice(i).join('/'));
  }

  return Array.from(candidates.values()).filter((candidate) => IMAGE_REF_RE.test(candidate));
}

function normalizeCloudPath(record) {
  return normalizeReferencePath(record?.file_path || record?.path || '');
}

function normalizeFilename(record) {
  return cleanString(record?.filename || basename(record?.file_path || record?.path || ''));
}

function readAuthState() {
  try { return game?.settings?.get?.(MODULE_ID, 'patreon_auth_data') || null; }
  catch (_) { return null; }
}

function isPremiumRecord(record) {
  return String(record?.tier || '').toLowerCase() === 'premium';
}

function isFreeRecord(record) {
  const tier = String(record?.tier || '').toLowerCase();
  return tier === 'free' || tier === '';
}

function useDirectCloudUrlsEnabled() {
  try { return game?.settings?.get?.(MODULE_ID, 'useDirectCloudUrls') === true; }
  catch (_) { return false; }
}

function isCurrentDirectFreeCloudReference(source, record, cloudPath = '') {
  const raw = cleanString(source);
  if (!raw || !DIRECT_FREE_ASSET_URL_RE.test(raw)) return false;
  if (!useDirectCloudUrlsEnabled()) return false;
  if (!isFreeRecord(record)) return false;

  const normalizedSource = normalizeReferencePath(raw).toLowerCase();
  const normalizedCloud = normalizeReferencePath(cloudPath || normalizeCloudPath(record)).toLowerCase();
  return !!normalizedCloud && normalizedSource === `assets/free_assets/${normalizedCloud}`;
}

function hasPremiumAuth() {
  const auth = readAuthState();
  return !!(auth && auth.authenticated && auth.state);
}

function clonePlain(value) {
  const deepClone = foundry?.utils?.deepClone;
  if (typeof deepClone === 'function') return deepClone(value);
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function setPath(target, path, value) {
  if (!target || !Array.isArray(path) || !path.length) return false;
  let cursor = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    if (cursor?.[key] == null) return false;
    cursor = cursor[key];
  }
  cursor[path[path.length - 1]] = value;
  return true;
}

function valuesFromCollection(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection.filter(Boolean);
  if (Array.isArray(collection.contents)) return collection.contents.filter(Boolean);
  if (typeof collection.values === 'function') return Array.from(collection.values()).filter(Boolean);
  try { return Array.from(collection).filter(Boolean); }
  catch (_) { return []; }
}

function getTileDocuments(scene) {
  return valuesFromCollection(scene?.tiles);
}

function getDocumentName(doc, fallback = '') {
  return cleanString(doc?.name || doc?.id || fallback);
}

function getObjectValue(root, path) {
  let cursor = root;
  for (const key of path) {
    if (cursor == null) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function walkImageStrings(value, path, onString) {
  if (typeof value === 'string') {
    if (isImageReference(value)) onString(value, path);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkImageStrings(item, path.concat(String(index)), onString));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walkImageStrings(child, path.concat(key), onString);
  }
}

function collectTileReferences(scene) {
  const refs = [];
  const tiles = getTileDocuments(scene);
  for (const doc of tiles) {
    const src = cleanString(doc?.texture?.src || doc?._source?.texture?.src || '');
    if (isImageReference(src)) {
      refs.push({
        scope: 'tile-texture',
        documentType: 'Tile',
        documentId: doc.id,
        documentName: getDocumentName(doc, `Tile ${refs.length + 1}`),
        updatePath: 'texture.src',
        src,
        doc
      });
    }

    const moduleFlags = doc?.flags?.[MODULE_ID] || doc?._source?.flags?.[MODULE_ID] || null;
    if (!moduleFlags || typeof moduleFlags !== 'object') continue;

    walkImageStrings(moduleFlags, [], (value, flagPath) => {
      if (shouldSkipFlagImageReference(flagPath, value)) return;
      refs.push({
        scope: 'tile-flag',
        documentType: 'Tile',
        documentId: doc.id,
        documentName: getDocumentName(doc, `Tile ${refs.length + 1}`),
        updatePath: `flags.${MODULE_ID}.${flagPath.join('.')}`,
        flagPath,
        src: value,
        doc
      });
    });
  }
  return refs;
}

function collectLevelReferences(scene) {
  const refs = [];
  const levels = getSceneLevels(scene);
  for (const level of levels) {
    const levelName = getDocumentName(level, 'Level');
    for (const path of [['background', 'src'], ['foreground', 'src'], ['fog', 'src']]) {
      const src = cleanString(getObjectValue(level, path) || getObjectValue(level?._source, path) || '');
      if (!isImageReference(src)) continue;
      refs.push({
        scope: 'level-field',
        documentType: 'Level',
        documentId: level.id,
        documentName: levelName,
        updatePath: path.join('.'),
        src,
        doc: level
      });
    }
  }
  return refs;
}

function summarizeEntries(entries, scannedRefs = entries.length) {
  const summary = {
    totalRefs: Number.isFinite(Number(scannedRefs)) ? Number(scannedRefs) : entries.length,
    repairRefs: entries.length,
    current: 0,
    ready: 0,
    downloadable: 0,
    repaired: 0,
    localOnlyMissing: 0,
    unmatched: 0,
    ambiguous: 0,
    auth: 0,
    failed: 0,
    actionable: 0,
    blocked: 0
  };
  for (const entry of entries) {
    if (Object.prototype.hasOwnProperty.call(summary, entry.status)) summary[entry.status] += 1;
  }
  summary.actionable = summary.ready + summary.downloadable;
  summary.blocked = summary.localOnlyMissing + summary.unmatched + summary.ambiguous + summary.auth + summary.failed;
  return summary;
}

function buildLocalOnlyMissingEntry(ref, scene = null) {
  if (!ref || isTransparentPlaceholderReference(ref?.src)) return null;

  if (isMaskFlagReference(ref)) {
    const filename = basename(ref.src);
    if (!filename) {
      return {
        ref,
        status: STATUS.localOnlyMissing,
        reason: 'local-mask-missing-filename',
        source: ref.src,
        localPath: '',
        cloudPath: '',
        error: 'Mask reference has no filename to resolve.',
        localOnly: true
      };
    }
    const candidates = buildLocalMaskCandidates(filename, scene);
    const expectedLocalPaths = candidates.map((entry) => entry.expectedPath);
    return {
      ref,
      status: STATUS.localOnlyMissing,
      reason: 'local-mask-missing',
      source: ref.src,
      localPath: '',
      cloudPath: '',
      expectedLocalPaths,
      error: expectedLocalPaths.length
        ? `No local mask file was found. Expected one of: ${expectedLocalPaths.join(', ')}`
        : 'No local mask file was found for this reference.',
      localOnly: true
    };
  }

  const flattenedReference = isFlattenedTileTextureReference(ref) || isFlattenedOutputFlagReference(ref);
  const generatedPath = detectGeneratedOutputPath(ref?.src || '', {
    assetsDir: getConfiguredAssetsDir({ moduleId: MODULE_ID }),
    kind: flattenedReference ? 'flattened' : null
  });
  if (!flattenedReference && !generatedPath) return null;

  const expectedPath = normalizeReferencePath(ref?.src || '');
  const kindLabel = generatedPath?.kind === 'mask' ? 'generated mask output' : 'generated flattened output';
  return {
    ref,
    status: STATUS.localOnlyMissing,
    reason: 'local-only-generated-missing',
    source: ref.src,
    localPath: '',
    cloudPath: '',
    expectedLocalPaths: expectedPath ? [expectedPath] : [],
    error: expectedPath
      ? `Missing ${kindLabel}. Expected local file: ${expectedPath}`
      : `Missing ${kindLabel}.`,
    localOnly: true
  };
}

function statusView(status) {
  return STATUS_VIEW[status] || { label: status || 'Unknown', css: 'is-unknown' };
}

function logHiddenRows(report, reason = 'report') {
  const entries = Array.isArray(report?.entries) ? report.entries : [];
  if (entries.length <= MAX_DETAIL_ROWS) return;
  const hidden = entries.slice(MAX_DETAIL_ROWS).map((entry) => ({
    status: entry.status || '',
    reason: entry.reason || '',
    documentType: entry.ref?.documentType || '',
    documentName: entry.ref?.documentName || '',
    updatePath: entry.ref?.updatePath || '',
    source: entry.source || entry.ref?.src || '',
    cloudPath: entry.cloudPath || '',
    localPath: entry.localPath || '',
    error: entry.error || ''
  }));
  try {
    console.info('[fa-nexus] SceneImportHelper.hiddenRows', {
      reason,
      hiddenCount: hidden.length,
      rows: hidden
    });
  } catch (_) {}
}

class CloudAssetIndex {
  constructor(records = []) {
    this.byPath = new Map();
    this.byFilename = new Map();
    for (const record of records) {
      const path = normalizeCloudPath(record);
      const filename = normalizeFilename(record);
      if (!path || !filename) {
        Logger.warn('SceneImportHelper.cloudRecord.invalid', { path, filename, record });
        continue;
      }
      this.byPath.set(path.toLowerCase(), { record, path, filename });
      const filenameKey = filename.toLowerCase();
      const list = this.byFilename.get(filenameKey) || [];
      list.push({ record, path, filename });
      this.byFilename.set(filenameKey, list);
    }
  }

  match(source) {
    const candidates = buildSourceCandidates(source);
    for (const candidate of candidates) {
      const hit = this.byPath.get(candidate.toLowerCase());
      if (hit) return { status: 'matched', reason: 'path', record: hit.record, cloudPath: hit.path };
    }

    const filename = basename(source);
    const filenameMatches = filename ? (this.byFilename.get(filename.toLowerCase()) || []) : [];
    if (!filenameMatches.length) {
      Logger.debug('SceneImportHelper.match.none', { source, candidates });
      return { status: STATUS.unmatched, reason: 'no-match' };
    }

    for (const candidate of candidates.filter((value) => value.includes('/'))) {
      const suffixMatches = filenameMatches.filter((hit) => hit.path.toLowerCase().endsWith(candidate.toLowerCase()));
      if (suffixMatches.length === 1) {
        return { status: 'matched', reason: 'path-suffix', record: suffixMatches[0].record, cloudPath: suffixMatches[0].path };
      }
      if (suffixMatches.length > 1) {
        Logger.warn('SceneImportHelper.match.ambiguousSuffix', {
          source,
          candidate,
          matches: suffixMatches.map((hit) => hit.path)
        });
        return { status: STATUS.ambiguous, reason: 'ambiguous-suffix', matches: suffixMatches.map((hit) => hit.path) };
      }
    }

    if (filenameMatches.length === 1) {
      Logger.warn('SceneImportHelper.match.filenameOnlyBlocked', {
        source,
        filename,
        cloudPath: filenameMatches[0].path
      });
      return { status: STATUS.unmatched, reason: 'filename-only-blocked', matches: [filenameMatches[0].path] };
    }

    Logger.warn('SceneImportHelper.match.ambiguousFilename', {
      source,
      filename,
      matches: filenameMatches.map((hit) => hit.path)
    });
    return { status: STATUS.ambiguous, reason: 'ambiguous-filename', matches: filenameMatches.map((hit) => hit.path) };
  }
}

export class SceneAssetImportHelperService {
  constructor(options = {}) {
    this.contentService = options.contentService || null;
    this.downloadManager = options.downloadManager || null;
  }

  _getNexusApp() {
    try { return foundry?.applications?.instances?.get?.('fa-nexus-app') || null; }
    catch (_) { return null; }
  }

  _getContentService() {
    if (this.contentService) return this.contentService;
    const app = this._getNexusApp();
    if (app?._contentService) {
      this.contentService = app._contentService;
      return this.contentService;
    }
    const authProvider = app && typeof app._getAuthService === 'function' ? () => app._getAuthService() : undefined;
    this.contentService = new NexusContentService({ app: app || null, authService: authProvider });
    return this.contentService;
  }

  _getDownloadManager() {
    if (this.downloadManager) return this.downloadManager;
    const app = this._getNexusApp();
    this.downloadManager = app?._downloadManager || new NexusDownloadManager();
    return this.downloadManager;
  }

  async _initializeDownloadManager(download) {
    const initialized = await download?.initialize?.();
    if (initialized !== true) {
      Logger.error('SceneImportHelper.download.initialize.failed', { initialized });
      throw new Error('Scene asset import could not initialize the Nexus download manager.');
    }
  }

  _resolveScene(scene = null) {
    const resolved = scene || canvas?.scene || game?.scenes?.active || null;
    if (!resolved) throw new Error('No active scene is available.');
    return resolved;
  }

  _collectReferences(scene) {
    const refs = [
      ...collectTileReferences(scene),
      ...collectLevelReferences(scene)
    ];
    Logger.info('SceneImportHelper.refs.collected', {
      sceneId: scene?.id || null,
      sceneName: scene?.name || null,
      total: refs.length,
      tiles: refs.filter((ref) => ref.documentType === 'Tile').length,
      levels: refs.filter((ref) => ref.documentType === 'Level').length
    });
    return refs;
  }

  async _resolveExistingLocalReference(ref, cache = new Map(), { staticOnly = true, reason = 'local-file-current' } = {}) {
    const normalized = normalizeReferencePath(ref?.src || '');
    if (!normalized) return null;
    if (/^https?:\/\//i.test(cleanString(ref?.src))) return null;
    if (staticOnly && !isStaticLocalReference(ref?.src, normalized)) return null;

    const key = normalized.toLowerCase();
    if (cache.has(key)) {
      const cachedPath = cache.get(key);
      return cachedPath ? localReferenceEntry(ref, cachedPath, reason) : null;
    }

    const filename = basename(normalized);
    const parentDir = dirname(normalized);
    let localPath = '';

    try {
      const FilePickerImpl = foundry?.applications?.apps?.FilePicker?.implementation;
      if (FilePickerImpl && parentDir && filename) {
        const result = await FilePickerImpl.browse('data', parentDir, {});
        const files = Array.isArray(result?.files) ? result.files : [];
        const normalizedFiles = files.map((file) => normalizeReferencePath(file));
        const found = normalizedFiles.find((filePath) => filePath.toLowerCase() === key)
          || normalizedFiles.find((filePath) => filePath.toLowerCase().endsWith(`/${filename.toLowerCase()}`));
        if (found) localPath = found;
      }
    } catch (error) {
      Logger.debug('SceneImportHelper.localStatic.browseFailed', {
        source: ref.src,
        parentDir,
        error: String(error?.message || error)
      });
    }

    if (!localPath) {
      try {
        const response = await fetch(encodeTexturePath(normalized), { method: 'HEAD', cache: 'no-store' });
        if (response?.ok) localPath = normalized;
      } catch (error) {
        Logger.debug('SceneImportHelper.localStatic.fetchFailed', {
          source: ref.src,
          error: String(error?.message || error)
        });
      }
    }

    cache.set(key, localPath);
    if (!localPath) return null;
    Logger.info('SceneImportHelper.localStatic.found', { source: ref.src, localPath });
    return localReferenceEntry(ref, localPath, reason);
  }

  async _resolveLocalMaskReference(ref, download, scene) {
    if (!isMaskFlagReference(ref)) return null;

    const filename = basename(ref.src);
    if (!filename) {
      Logger.warn('SceneImportHelper.localMask.filenameMissing', {
        source: ref.src,
        documentId: ref.documentId,
        updatePath: ref.updatePath
      });
      return {
        ref,
        status: STATUS.unmatched,
        reason: 'local-mask-missing-filename',
        source: ref.src,
        localPath: '',
        cloudPath: '',
        error: 'Mask reference has no filename to resolve.'
      };
    }

    const candidates = buildLocalMaskCandidates(filename, scene);
    for (const candidate of candidates) {
      let localPath = '';
      try {
        localPath = download.getLocalPath('assets', candidate.record) || await download.probeLocal('assets', candidate.record) || '';
      } catch (error) {
        Logger.error('SceneImportHelper.localMask.probeFailed', {
          source: ref.src,
          expectedPath: candidate.expectedPath,
          error: String(error?.message || error)
        });
        localPath = '';
      }
      if (!localPath) continue;

      const normalizedCurrent = normalizeReferencePath(ref.src);
      const normalizedLocal = normalizeReferencePath(localPath);
      const status = normalizedCurrent === normalizedLocal ? STATUS.current : STATUS.ready;
      Logger.info('SceneImportHelper.localMask.found', {
        source: ref.src,
        localPath,
        expectedPath: candidate.expectedPath,
        reason: candidate.reason,
        status
      });
      return {
        ref,
        record: candidate.record,
        status,
        reason: status === STATUS.current ? 'local-mask-current' : candidate.reason,
        source: ref.src,
        localPath,
        cloudPath: '',
        cloudKey: `${LOCAL_MASK_TIER}:${candidate.relativePath.toLowerCase()}`,
        tier: LOCAL_MASK_TIER,
        localOnly: true,
        expectedLocalPaths: candidates.map((entry) => entry.expectedPath)
      };
    }

    Logger.debug('SceneImportHelper.localMask.missing', {
      source: ref.src,
      documentId: ref.documentId,
      updatePath: ref.updatePath,
      expectedPaths: candidates.map((entry) => entry.expectedPath)
    });
    return null;
  }

  async _loadCloudAssets({ onProgress = null } = {}) {
    const content = this._getContentService();
    try {
      onProgress?.('Syncing cloud asset index...');
      await content.sync('assets', {
        onManifestProgress: ({ phase, count, total }) => {
          const detail = Number.isFinite(total) && total > 0 ? ` ${count}/${total}` : '';
          onProgress?.(`Syncing cloud asset index (${phase || 'manifest'}${detail})...`);
        }
      });
    } catch (error) {
      Logger.error('SceneImportHelper.cloud.sync.failed', { error: String(error?.message || error) });
      throw new Error(`Cloud asset sync failed: ${error?.message || error}`);
    }

    try {
      onProgress?.('Loading cloud asset records...');
      const result = await content.list('assets', {
        onProgress: (count, total) => {
          const detail = Number.isFinite(total) && total > 0 ? `${count}/${total}` : String(count);
          onProgress?.(`Loading cloud asset records (${detail})...`);
        }
      });
      const items = Array.isArray(result?.items) ? result.items : [];
      Logger.info('SceneImportHelper.cloud.loaded', { count: items.length, total: result?.total ?? items.length });
      if (!items.length) throw new Error('Cloud asset index is empty.');
      return items;
    } catch (error) {
      Logger.error('SceneImportHelper.cloud.list.failed', { error: String(error?.message || error) });
      throw new Error(`Cloud asset list failed: ${error?.message || error}`);
    }
  }

  async analyze(scene = null, options = {}) {
    const resolvedScene = this._resolveScene(scene);
    const refs = this._collectReferences(resolvedScene);
    const report = {
      scene: resolvedScene,
      sceneId: resolvedScene.id || null,
      sceneName: resolvedScene.name || 'Current Scene',
      scannedRefs: refs.length,
      entries: [],
      summary: summarizeEntries([], refs.length)
    };
    if (!refs.length) {
      Logger.warn('SceneImportHelper.analyze.noRefs', { sceneId: report.sceneId, sceneName: report.sceneName });
      return report;
    }

    let cloudIndex = null;
    let download = null;
    const getCloudIndex = async () => {
      if (!cloudIndex) {
        const cloudItems = await this._loadCloudAssets(options);
        cloudIndex = new CloudAssetIndex(cloudItems);
      }
      return cloudIndex;
    };
    const getDownloadManager = async () => {
      if (!download) {
        download = this._getDownloadManager();
        await this._initializeDownloadManager(download);
      }
      return download;
    };
    const localProbeCache = new Map();
    const staticLocalCache = new Map();
    const authed = hasPremiumAuth();

    for (let i = 0; i < refs.length; i += 1) {
      const ref = refs[i];
      options.onProgress?.(`Checking scene reference ${i + 1}/${refs.length}...`);
      const localOnly = isLocalOnlyReference(ref);
      if (localOnly) {
        const exactLocalEntry = await this._resolveExistingLocalReference(ref, staticLocalCache, {
          staticOnly: false,
          reason: 'local-only-current'
        });
        if (exactLocalEntry) {
          addReportEntry(report, exactLocalEntry);
          continue;
        }

        if (isMaskFlagReference(ref)) {
          const localMaskEntry = await this._resolveLocalMaskReference(ref, await getDownloadManager(), resolvedScene);
          if (localMaskEntry) {
            addReportEntry(report, localMaskEntry);
            continue;
          }
        }

        const missingLocalEntry = buildLocalOnlyMissingEntry(ref, resolvedScene);
        if (missingLocalEntry) {
          Logger.warn('SceneImportHelper.localOnly.missing', {
            source: ref.src,
            updatePath: ref.updatePath,
            documentId: ref.documentId,
            reason: missingLocalEntry.reason,
            expectedLocalPaths: missingLocalEntry.expectedLocalPaths || []
          });
          addReportEntry(report, missingLocalEntry);
          continue;
        }

        Logger.debug('SceneImportHelper.localOnly.skipped', {
          source: ref.src,
          updatePath: ref.updatePath,
          documentId: ref.documentId,
          reason: 'non-reportable-local-only'
        });
        continue;
      }

      const staticLocalEntry = await this._resolveExistingLocalReference(ref, staticLocalCache);
      if (staticLocalEntry) {
        addReportEntry(report, staticLocalEntry);
        continue;
      }

      if (isMaskFlagReference(ref)) {
        const localMaskEntry = await this._resolveLocalMaskReference(ref, await getDownloadManager(), resolvedScene);
        if (localMaskEntry) {
          addReportEntry(report, localMaskEntry);
          continue;
        }
      }

      const index = await getCloudIndex();
      const match = index.match(ref.src);
      if (match.status !== 'matched') {
        const maskCandidates = isMaskFlagReference(ref) ? buildLocalMaskCandidates(basename(ref.src), resolvedScene) : [];
        addReportEntry(report, {
          ref,
          status: match.status,
          reason: maskCandidates.length && match.status === STATUS.unmatched ? 'local-mask-missing' : match.reason,
          matches: match.matches || [],
          source: ref.src,
          localPath: '',
          cloudPath: '',
          expectedLocalPaths: maskCandidates.map((entry) => entry.expectedPath),
          error: maskCandidates.length && match.status === STATUS.unmatched
            ? `No matching local mask file found. Expected one of: ${maskCandidates.map((entry) => entry.expectedPath).join(', ')}`
            : ''
        });
        continue;
      }

      const record = match.record;
      const cloudPath = match.cloudPath || normalizeCloudPath(record);
      const cloudKey = cloudPath.toLowerCase();
      if (isCurrentDirectFreeCloudReference(ref.src, record, cloudPath)) {
        Logger.debug('SceneImportHelper.directFree.current', {
          source: ref.src,
          cloudPath,
          updatePath: ref.updatePath
        });
        continue;
      }

      let localPath = localProbeCache.get(cloudKey);
      if (localPath === undefined) {
        try {
          const initializedDownload = await getDownloadManager();
          localPath = initializedDownload.getLocalPath('assets', record) || await initializedDownload.probeLocal('assets', record) || '';
        } catch (error) {
          Logger.error('SceneImportHelper.localProbe.failed', {
            cloudPath,
            source: ref.src,
            error: String(error?.message || error)
          });
          localPath = '';
        }
        localProbeCache.set(cloudKey, localPath);
      }

      const normalizedCurrent = normalizeReferencePath(ref.src);
      const normalizedLocal = normalizeReferencePath(localPath);
      let status = STATUS.downloadable;
      if (localPath && normalizedCurrent === normalizedLocal) status = STATUS.current;
      else if (localPath) status = STATUS.ready;
      else if (isPremiumRecord(record) && !authed) status = STATUS.auth;

      addReportEntry(report, {
        ref,
        record,
        status,
        reason: match.reason,
        source: ref.src,
        localPath,
        cloudPath,
        cloudKey,
        tier: record?.tier || 'free'
      });
    }

    report.summary = summarizeEntries(report.entries, report.scannedRefs ?? refs.length);
    Logger.info('SceneImportHelper.analyze.done', {
      sceneId: report.sceneId,
      sceneName: report.sceneName,
      summary: report.summary
    });
    return report;
  }

  async repair(report, options = {}) {
    if (!report?.scene) report = await this.analyze(null, options);
    const scene = report.scene;
    if (!scene?.canUserModify?.(game.user, 'update')) {
      throw new Error(`You do not have permission to update scene "${scene?.name || scene?.id || ''}".`);
    }

    const content = this._getContentService();
    const download = this._getDownloadManager();
    await this._initializeDownloadManager(download);
    const auth = readAuthState();
    const authState = auth?.authenticated && auth?.state ? auth.state : undefined;
    const downloadCache = new Map();

    const actionableEntries = report.entries.filter((entry) => {
      return entry.status === STATUS.downloadable || entry.status === STATUS.ready;
    });

    for (let i = 0; i < actionableEntries.length; i += 1) {
      const entry = actionableEntries[i];
      const record = entry.record;
      const cloudKey = entry.cloudKey || normalizeCloudPath(record).toLowerCase();
      try {
        options.onProgress?.(`Resolving ${i + 1}/${actionableEntries.length}: ${entry.cloudPath || record?.filename || entry.localPath || 'asset'}...`);
        let localPath = entry.localPath || downloadCache.get(cloudKey) || '';
        if (!localPath) {
          if (isPremiumRecord(record) && !authState) throw new Error('Authentication required for premium cloud asset.');
          const fullUrl = await content.getFullURL('assets', record, authState);
          localPath = await download.ensureLocal('assets', record, fullUrl, { forceDownload: true });
          if (/^https?:\/\//i.test(localPath)) {
            throw new Error('Download manager returned a remote URL while a local download was required.');
          }
          Logger.info('SceneImportHelper.download.done', {
            cloudPath: entry.cloudPath,
            localPath
          });
        }
        downloadCache.set(cloudKey, localPath);
        entry.localPath = localPath;
        entry.status = STATUS.repaired;
      } catch (error) {
        entry.status = STATUS.failed;
        entry.error = String(error?.message || error);
        Logger.error('SceneImportHelper.download.failed', {
          source: entry.source,
          cloudPath: entry.cloudPath,
          error: entry.error
        });
      }
    }

    await this._applyReferenceUpdates(scene, actionableEntries, options);
    if (actionableEntries.some((entry) => entry.status === STATUS.repaired)) {
      invalidateSharedAssetCatalog('scene-import-helper');
    }
    report.summary = summarizeEntries(report.entries, report.scannedRefs ?? report.summary?.totalRefs ?? report.entries.length);
    Logger.info('SceneImportHelper.repair.done', {
      sceneId: report.sceneId,
      sceneName: report.sceneName,
      summary: report.summary
    });
    return report;
  }

  async _applyReferenceUpdates(scene, entries, { onProgress = null } = {}) {
    const generatedFlattenRootPaths = new Set();
    const generatedFlattenRootEntries = [];

    for (const entry of entries) {
      if (entry.status !== STATUS.repaired || !entry.localPath) continue;
      if (!shouldRegisterGeneratedFlattenRootEntry(entry)) continue;
      generatedFlattenRootPaths.add(String(entry.localPath || '').trim());
      generatedFlattenRootEntries.push(entry);
    }

    if (generatedFlattenRootPaths.size) {
      const assetsDir = getConfiguredAssetsDir({ moduleId: MODULE_ID });
      const worldId = getCurrentWorldId();
      const sceneId = getSceneId(scene);
      try {
        onProgress?.(`Registering ${generatedFlattenRootPaths.size} generated output root(s)...`);
        const result = await ensureGeneratedFlattenRootsRegisteredFromPaths([...generatedFlattenRootPaths], {
          moduleId: MODULE_ID,
          assetsDir,
          worldId,
          sceneId
        });
        if (!Array.isArray(result?.requestedRoots) || !result.requestedRoots.length) {
          throw new Error('No generated flatten roots could be resolved from repaired local paths.');
        }
        Logger.info('SceneImportHelper.generatedRoot.sync', {
          localPaths: [...generatedFlattenRootPaths].sort((left, right) => left.localeCompare(right)),
          requestedRoots: result?.requestedRoots || [],
          registeredRoots: result?.registeredRoots || [],
          existingRoots: result?.existingRoots || [],
          worldId,
          sceneId,
          count: result?.roots?.length || 0
        });
      } catch (error) {
        const errorMessage = String(error?.message || error);
        for (const entry of generatedFlattenRootEntries) {
          entry.status = STATUS.failed;
          entry.error = `Generated output root registration failed: ${errorMessage}`;
        }
        Logger.error('SceneImportHelper.generatedRoot.register.failed', {
          localPaths: [...generatedFlattenRootPaths].sort((left, right) => left.localeCompare(right)),
          affectedEntries: generatedFlattenRootEntries.map((entry) => ({
            source: entry.source || entry.ref?.src || '',
            localPath: entry.localPath || '',
            updatePath: entry.ref?.updatePath || '',
            documentId: entry.ref?.documentId || ''
          })),
          worldId,
          sceneId,
          error: errorMessage
        });
      }
    }

    const tileUpdatesById = new Map();
    const levelUpdatesById = new Map();
    const levelUpdateCount = { value: 0 };
    const tileUpdateCount = { value: 0 };

    const getTileState = (doc) => {
      const id = doc?.id;
      if (!id) return null;
      let state = tileUpdatesById.get(id);
      if (!state) {
        state = { doc, update: { _id: id }, moduleFlags: null };
        tileUpdatesById.set(id, state);
      }
      return state;
    };

    const getLevelState = (doc) => {
      const id = doc?.id;
      if (!id) return null;
      let state = levelUpdatesById.get(id);
      if (!state) {
        state = { doc, update: { _id: id } };
        levelUpdatesById.set(id, state);
      }
      return state;
    };

    for (const entry of entries) {
      if (entry.status !== STATUS.repaired || !entry.localPath) continue;
      const ref = entry.ref;
      const encodedLocalPath = encodeTexturePath(entry.localPath);
      if (ref.scope === 'tile-texture') {
        const state = getTileState(ref.doc);
        if (!state) continue;
        state.update['texture.src'] = encodedLocalPath;
        tileUpdateCount.value += 1;
        continue;
      }
      if (ref.scope === 'tile-flag') {
        const state = getTileState(ref.doc);
        if (!state) continue;
        if (!state.moduleFlags) {
          const existing = ref.doc?.flags?.[MODULE_ID] || ref.doc?._source?.flags?.[MODULE_ID] || {};
          state.moduleFlags = clonePlain(existing);
          state.update[`flags.${MODULE_ID}`] = state.moduleFlags;
        }
        if (!setPath(state.moduleFlags, ref.flagPath, encodedLocalPath)) {
          entry.status = STATUS.failed;
          entry.error = `Unable to update ${ref.updatePath}`;
          Logger.error('SceneImportHelper.update.flagPath.failed', {
            tileId: ref.documentId,
            path: ref.updatePath,
            source: ref.src
          });
          continue;
        }
        tileUpdateCount.value += 1;
        continue;
      }
      if (ref.scope === 'level-field') {
        const state = getLevelState(ref.doc);
        if (!state) continue;
        state.update[ref.updatePath] = encodedLocalPath;
        levelUpdateCount.value += 1;
      }
    }

    const tileUpdates = Array.from(tileUpdatesById.values()).map((state) => state.update);
    const levelUpdates = Array.from(levelUpdatesById.values()).map((state) => state.update);

    if (levelUpdates.length) {
      onProgress?.(`Updating ${levelUpdateCount.value} level image reference(s)...`);
      Logger.info('SceneImportHelper.update.levels', { count: levelUpdates.length, refs: levelUpdateCount.value });
      await scene.updateEmbeddedDocuments('Level', levelUpdates);
    }

    if (tileUpdates.length) {
      onProgress?.(`Updating ${tileUpdateCount.value} tile asset reference(s)...`);
      Logger.info('SceneImportHelper.update.tiles', { count: tileUpdates.length, refs: tileUpdateCount.value });
      await scene.updateEmbeddedDocuments('Tile', tileUpdates);
    }

    if (!tileUpdates.length && !levelUpdates.length) {
      Logger.warn('SceneImportHelper.update.none', { entries: entries.length });
    }
  }
}

export class SceneAssetImportHelperDialog extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(options = {}) {
    super(options);
    this._service = options.service instanceof SceneAssetImportHelperService
      ? options.service
      : new SceneAssetImportHelperService();
    this._report = null;
    this._busy = false;
    this._busyLabel = '';
    this._error = '';
  }

  static DEFAULT_OPTIONS = {
    id: 'fa-nexus-scene-import-helper-dialog',
    classes: ['fa-nexus-scene-import-helper-window'],
    tag: 'section',
    window: {
      frame: true,
      positioned: true,
      resizable: true,
      icon: 'fas fa-cloud-download-alt',
      title: 'Backfill Scene Assets'
    },
    position: {
      width: 980,
      height: 720
    }
  };

  static PARTS = {
    content: {
      template: 'modules/fa-nexus/templates/scene-import/scene-asset-import-helper.hbs'
    }
  };

  async _prepareContext() {
    const entries = Array.isArray(this._report?.entries) ? this._report.entries : [];
    const rows = entries.slice(0, MAX_DETAIL_ROWS).map((entry) => {
      const view = statusView(entry.status);
      return {
        source: entry.source || entry.ref?.src || '',
        documentType: entry.ref?.documentType || '',
        documentName: entry.ref?.documentName || '',
        updatePath: entry.ref?.updatePath || '',
        cloudPath: entry.cloudPath || '',
        localPath: entry.localPath || '',
        error: entry.error || '',
        reason: entry.reason || '',
        statusLabel: view.label,
        statusClass: view.css,
        hasCloudPath: !!entry.cloudPath,
        hasLocalPath: !!entry.localPath,
        hasError: !!entry.error
      };
    });
    const summary = this._report?.summary || summarizeEntries([]);
    const hiddenRows = Math.max(0, entries.length - rows.length);
    return {
      busy: this._busy,
      busyLabel: this._busyLabel,
      error: this._error,
      hasError: !!this._error,
      hasReport: !!this._report,
      sceneName: this._report?.sceneName || canvas?.scene?.name || 'Current Scene',
      summary,
      referenceCount: entries.length,
      rows,
      visibleRows: rows.length,
      hasRows: rows.length > 0,
      hiddenRows,
      hasHiddenRows: hiddenRows > 0,
      canRepair: !this._busy && !!summary.actionable,
      canScan: !this._busy
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const root = this.element;
    if (!root) return;
    if (root._faNexusSceneImportClickHandler) {
      root.removeEventListener('click', root._faNexusSceneImportClickHandler);
    }
    const handler = async (event) => {
      const action = event.target.closest('[data-action]')?.dataset?.action;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'scan') {
        await this._runScan();
        return;
      }
      if (action === 'repair') {
        await this._runRepair();
        return;
      }
      if (action === 'close') {
        this.close({ force: true });
      }
    };
    root._faNexusSceneImportClickHandler = handler;
    root.addEventListener('click', handler);
  }

  async _setBusy(isBusy, label = '') {
    this._busy = !!isBusy;
    this._busyLabel = isBusy ? String(label || 'Working...') : '';
    await this.render(true);
  }

  async _setBusyLabel(label) {
    if (!this._busy) return;
    this._busyLabel = String(label || 'Working...');
    await this.render(true);
  }

  async _runScan() {
    if (this._busy) return;
    this._error = '';
    await this._setBusy(true, 'Scanning current scene...');
    try {
      this._report = await this._service.analyze(null, {
        onProgress: (message) => this._setBusyLabel(message)
      });
      logHiddenRows(this._report, 'scan');
      const summary = this._report.summary || {};
      ui?.notifications?.info?.(`Scene asset scan complete. ${summary.actionable || 0} repairable, ${summary.blocked || 0} blocked.`);
    } catch (error) {
      this._error = String(error?.message || error);
      Logger.error('SceneImportHelper.dialog.scan.failed', { error: this._error });
      ui?.notifications?.error?.(`Scene asset scan failed: ${this._error}`);
    } finally {
      await this._setBusy(false);
    }
  }

  async _runRepair() {
    if (this._busy) return;
    this._error = '';
    await this._setBusy(true, 'Repairing scene asset references...');
    try {
      if (!this._report) {
        this._report = await this._service.analyze(null, {
          onProgress: (message) => this._setBusyLabel(message)
        });
      }
      this._report = await this._service.repair(this._report, {
        onProgress: (message) => this._setBusyLabel(message)
      });
      logHiddenRows(this._report, 'repair');
      const summary = this._report.summary || {};
      ui?.notifications?.info?.(`Scene asset repair complete. ${summary.repaired || 0} reference(s) updated, ${summary.failed || 0} failed.`);
    } catch (error) {
      this._error = String(error?.message || error);
      Logger.error('SceneImportHelper.dialog.repair.failed', { error: this._error });
      ui?.notifications?.error?.(`Scene asset repair failed: ${this._error}`);
    } finally {
      await this._setBusy(false);
    }
  }
}

export function openSceneAssetImportHelper(options = {}) {
  const dialog = new SceneAssetImportHelperDialog(options);
  dialog.render(true);
  return dialog;
}

export async function backfillSceneAssets(options = {}) {
  const service = options.service instanceof SceneAssetImportHelperService
    ? options.service
    : new SceneAssetImportHelperService(options);
  const report = await service.analyze(options.scene || null, options);
  return service.repair(report, options);
}

try {
  window.faNexus = Object.assign(window.faNexus || {}, {
    openSceneAssetImportHelper,
    backfillSceneAssets
  });
} catch (_) {}
