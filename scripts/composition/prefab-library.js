import { ensureNestedFilePickerDirectory } from '../storage/file-picker-directory.js';
import { sha256Hex } from '../core/content-hash.js';
import { PREFAB_ROOT, PREFAB_ARTIFACT_ROOT, isPrefabArtifactPath } from '../storage/prefab-paths.js';
import { detectGeneratedOutputPath } from '../storage/generated-output-policy.js';
import { validateCompositionSnapshot } from './scene-group-snapshot.js';
import { CONTENT_KIND_DESCRIPTORS } from '../content/content-kind-descriptors.js';
import { preserveBuildingFingerprints } from './scene-group-building-fingerprints.js';
import { createPrefabThumbnail } from './prefab-thumbnail.js';
import { createPrefabCatalogLookup, describePrefabContent, prefabAccessBlocker, prefabPreparationError } from './prefab-content-access.js';

const libraryPath = `${PREFAB_ROOT}/library.json`;
const recordPath = id => `${PREFAB_ROOT}/records/${id}`;
const picker = () => foundry.applications.apps.FilePicker.implementation;
const requireGM = () => { if (!game.user.isGM) throw new Error('Only a GM can edit the Prefab library.'); };
const checkId = id => { if (!/^[A-Za-z0-9]{16}$/.test(id || '')) throw new Error('Invalid Prefab identity.'); return id; };
// FilePicker listings name a file by its storage path, except on The Forge: there 'data' requests go to the Forge
// assets library and its listings give each file's full assets.forge-vtt.com URL (folders stay relative). Listing
// entries are therefore compared by their storage path, and reads go to the Forge address directly once a listing has
// shown it (Foundry's route for a storage path only redirects there). Without this the library looked empty on The
// Forge, every import rewrote library.json with itself alone, and installed artwork looked missing.
const FORGE_ASSET_URL = /^https?:\/\/assets\.forge-vtt\.com\/[^/]+\//i;
let forgeAssetBase = null;
const storagePath = entry => {
  const value = String(entry || '').split('?')[0];
  const base = value.match(FORGE_ASSET_URL)?.[0];
  if (base) forgeAssetBase = base;
  let path = value.replace(FORGE_ASSET_URL, '');
  try { path = decodeURIComponent(path); } catch (_) {}
  return path.replace(/^\/+/, '');
};
const readUrl = path => forgeAssetBase ? `${forgeAssetBase}${path.split('/').map(encodeURIComponent).join('/')}` : foundry.utils.getRoute(path);
// A Scene's artwork may already be a full URL (on The Forge every stored file is); getRoute would put the game
// server's address in front of it.
const resourceUrl = path => /^https?:\/\//i.test(path) ? path : foundry.utils.getRoute(path);
const listingHasFile = (listing, path) => (listing?.files || []).some(file => storagePath(file) === path);
const listingHasDir = (listing, path) => (listing?.dirs || []).some(dir => storagePath(dir) === path);
let writeQueue = Promise.resolve();
const serialize = operation => { const next = writeQueue.catch(() => {}).then(operation); writeQueue = next; return next; };

export async function prefabHash(bytes) {
  return sha256Hex(bytes);
}
async function readJson(path) {
  const response = await fetch(readUrl(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
  return response.json();
}
async function upload(path, blob, name) {
  await ensureNestedFilePickerDirectory(path);
  const result = await picker().upload('data', path, new File([blob], name, { type: blob.type || 'application/json' }), {}, { notify: false });
  if (!result?.path) throw new Error(`Could not save ${name}.`);
  return result.path;
}
const writeJson = (folder, name, value) => upload(folder, new Blob([JSON.stringify(value)], { type: 'application/json' }), name);

export function collectPrefabResources(documents) {
  const paths = new Map();
  const visit = (value, context = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
      const next = `${context}.${key}`;
      if (typeof entry === 'string' && /^(src|baseSrc|maskSrc|textureSrc|filePath|texture|path|file_path|sound|soundSrc|open|close|locked)$/.test(key)
        && /\.(webp|png|jpe?g|avif|svg|mp4|webm|ogg|mp3|wav)(\?.*)?$/i.test(entry)) {
        const artifact = key === 'maskSrc' || /\.flattened\.(?:filePath|chunks\.\d+\.src)$/.test(next)
          || isPrefabArtifactPath(entry) || !!detectGeneratedOutputPath(entry);
        paths.set(entry, { path: entry, artifact: artifact || paths.get(entry)?.artifact === true });
      } else if (entry && typeof entry === 'object') visit(entry, next);
    }
  };
  visit(documents);
  return [...paths.values()];
}
function rewritePaths(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) || value;
  if (Array.isArray(value)) return value.map(entry => rewritePaths(entry, replacements));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewritePaths(entry, replacements)]));
}
async function preserveArtifacts(snapshot) {
  const replacements = new Map(), artifacts = new Map();
  for (const resource of collectPrefabResources(snapshot.documents).filter(item => item.artifact)) {
    const response = await fetch(resourceUrl(resource.path));
    if (!response.ok) throw new Error(`Required generated artwork is missing: ${resource.path}`);
    const bytes = await response.arrayBuffer(), hash = await prefabHash(bytes);
    if (isPrefabArtifactPath(resource.path) && resource.path.split('/').at(-1).split('.')[0] !== hash) throw new Error(`Prefab artwork integrity check failed: ${resource.path}`);
    const extension = resource.path.split('?')[0].split('.').at(-1).toLowerCase();
    const path = `${PREFAB_ARTIFACT_ROOT}/${hash}.${extension}`;
    await ensureNestedFilePickerDirectory(PREFAB_ARTIFACT_ROOT);
    const listing = await picker().browse('data', PREFAB_ARTIFACT_ROOT);
    if (!listingHasFile(listing, path)) await upload(PREFAB_ARTIFACT_ROOT, new Blob([bytes], { type: response.headers.get('content-type') || 'application/octet-stream' }), `${hash}.${extension}`);
    else if (await prefabHash(await (await readBlob(path)).arrayBuffer()) !== hash) throw new Error(`Stored Prefab artwork is corrupt: ${path}`);
    replacements.set(resource.path, path); artifacts.set(path, { path, hash, bytes: bytes.byteLength });
  }
  const documents = preserveBuildingFingerprints(snapshot.documents, rewritePaths(snapshot.documents, replacements));
  return { ...snapshot, documents, artifacts: [...artifacts.values()], contentRefs: collectPrefabContentRefs(documents) };
}

export function collectPrefabContentRefs(documents) {
  const refs = [];
  for (const resource of collectPrefabResources(documents).filter(item => !item.artifact)) {
    const path = decodeURIComponent(resource.path.split('?')[0]);
    for (const [kind, descriptor] of Object.entries(CONTENT_KIND_DESCRIPTORS)) {
      const root = game.settings.get('fa-nexus', descriptor.downloadDirSetting) || descriptor.downloadDirDefault;
      const prefixes = [root, descriptor.downloadDirDefault, descriptor.legacyDownloadDir, descriptor.freeBaseUrl];
      const prefix = prefixes.find(value => path.startsWith(`${value}/`) || path.includes(`/${value}/`));
      if (!prefix) continue;
      const relative = path.slice(path.indexOf(`${prefix}/`) + prefix.length + 1);
      if (relative.split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid Prefab content path.');
      refs.push({ provider: 'forgotten-adventures', kind, path: relative, source: resource.path });
      break;
    }
  }
  return refs;
}

// A local path is a file of the user data folder or one Foundry serves itself
// (its own icons, sounds and interface art live in the "public" source).
async function existsInSource(source, parts, listings) {
  let folder = '';
  for (let index = 0; index < parts.length; index++) {
    const key = `${source}:${folder}`;
    let listing = listings.get(key);
    if (!listing) { listing = await picker().browse(source, folder); listings.set(key, listing); }
    const next = folder ? `${folder}/${parts[index]}` : parts[index];
    if (index === parts.length - 1) return listingHasFile(listing, next);
    if (!listingHasDir(listing, next)) return false;
    folder = next;
  }
  return false;
}

async function resourceExists(path, listings = new Map()) {
  if (!/^https?:\/\//i.test(path)) {
    const parts = decodeURIComponent(path.split('?')[0]).replace(/^\/+/, '').split('/');
    return await existsInSource('data', parts, listings) || await existsInSource('public', parts, listings);
  }
  // getRoute is for Foundry-local paths and prefixes external URLs with '/'.
  try { return (await fetch(path, { method: 'HEAD' })).ok; }
  catch (cause) { return false; } // Reported as a missing dependency by the caller.
}

async function prefabContentContext() {
  const app = foundry.applications.instances.get('fa-nexus-app') || globalThis.faNexus.open();
  if (!app.rendered) await app.render({force:true});
  if (!app._contentService || !app._downloadManager) throw new Error('Open Nexus and initialize its asset catalog before preparing Prefab content.');
  return {app, lookup:createPrefabCatalogLookup(app._contentService)};
}

// One inventory pass serves browsing, import and preparation. Installed artwork
// does not require a catalog entry or an active subscription to remain usable.
async function inspectPrefabContent(snapshot, { lookup, listings = new Map(), onProgress, signal, verifyCatalog = false } = {}) {
  const replacements = new Map(), refs = snapshot.contentRefs || [], pending = [], contentRefs = [...refs];
  for (let index = 0; index < refs.length; index++) {
    signal?.throwIfAborted();
    const ref = refs[index], descriptor = CONTENT_KIND_DESCRIPTORS[ref.kind];
    if (ref.provider !== 'forgotten-adventures' || !descriptor || !ref.path || ref.path.split('/').some(part => part === '..' || part === '.')) throw new Error('Unsupported Prefab content reference.');
    onProgress?.({phase:'checking',completed:index,total:refs.length});
    const root = game.settings.get('fa-nexus', descriptor.downloadDirSetting) || descriptor.downloadDirDefault;
    const candidates = [...new Set([`${root.replace(/\/$/, '')}/${ref.path}`,
      typeof ref.source === 'string' && !/^https?:\/\//i.test(ref.source) ? ref.source : null,
      `${descriptor.downloadDirDefault}/${ref.path}`,
      `${descriptor.legacyDownloadDir}/${ref.path}`].filter(Boolean))];
    let installedPath = null;
    for (const candidate of candidates) if (await resourceExists(candidate, listings)) { installedPath = candidate; break; }
    if (installedPath) replacements.set(ref.source, installedPath);
    else pending.push({ref,index});
  }
  for (const item of pending) {
    signal?.throwIfAborted();
    if (verifyCatalog || !['free','premium'].includes(item.ref.tier)) {
      if (!lookup) lookup = (await prefabContentContext()).lookup;
      item.record = await lookup(item.ref);
      if (!item.record && verifyCatalog) throw prefabPreparationError('PREFAB_CONTENT_MISSING', `Prefab artwork is absent from the catalog: ${item.ref.path.split('/').at(-1)}. Refresh Nexus and retry.`);
      contentRefs[item.index] = {...item.ref,tier:item.record?.tier};
    }
  }
  const description = await describePrefabContent(contentRefs);
  const missing = await describePrefabContent(pending.map(item=>contentRefs[item.index]));
  return {replacements,pending,access:{...description,unknown:missing.unknown,
    missingPremium:pending.filter(item=>contentRefs[item.index].tier==='premium').length,
    missingCount:pending.length,localCount:refs.length-pending.length}};
}

export async function inspectPrefabAccess(snapshot, options) {
  return (await inspectPrefabContent(snapshot, options)).access;
}

export async function resolvePrefabContent(snapshot, { onProgress, signal } = {}) {
  signal?.throwIfAborted();
  let context;
  const lookup = async ref => { context ||= await prefabContentContext(); return context.lookup(ref); };
  const {replacements,pending,access} = await inspectPrefabContent(snapshot, {lookup,onProgress,signal,verifyCatalog:true});
  const refs = snapshot.contentRefs || [];
  const blocker = prefabAccessBlocker(access);
  if (blocker) throw prefabPreparationError(access.missingPremium ? 'PREFAB_AUTH_REQUIRED' : 'PREFAB_CONTENT_UNKNOWN', blocker);
  // Resolve all authorization URLs before the first download, premium first.
  // Expired credentials therefore cannot leave a partially downloaded free set.
  const failure = (cause, ref) => {
    if (cause.name === 'AbortError' || cause.userMessage) return cause;
    if (/auth|entitlement|patreon|unauthorized|forbidden/i.test(`${cause.code || ''} ${cause.message}`) || [401,403].includes(cause.status)) {
      return prefabPreparationError('PREFAB_AUTH_REQUIRED', 'Patreon access could not be verified for this prefab. Reconnect Patreon in Nexus and check that your membership includes its artwork.', cause);
    }
    return prefabPreparationError('PREFAB_DOWNLOAD_FAILED', `Could not download ${ref.path.split('/').at(-1)} for this prefab. Check your connection and try again.`, cause);
  };
  pending.sort((a,b)=>Number(b.record.tier==='premium')-Number(a.record.tier==='premium'));
  for (const item of pending) {
    signal?.throwIfAborted();
    try {
      const auth = game.settings.get('fa-nexus','patreon_auth_data');
      item.url = await context.app._contentService.getFullURL(item.ref.kind,item.record,auth?.authenticated ? auth.state : null);
    } catch(cause) {throw failure(cause,item.ref);}
  }
  let completed = refs.length - pending.length;
  for (const {ref,record,url} of pending) {
    signal?.throwIfAborted();
    onProgress?.({phase:'download',completed,total:refs.length,file:ref.path.split('/').at(-1)});
    signal?.throwIfAborted();
    try { replacements.set(ref.source,await context.app._downloadManager.ensureLocal(ref.kind,record,url,{forceDownload:true})); }
    catch(cause) {throw failure(cause,ref);}
    completed++;
  }
  signal?.throwIfAborted();onProgress?.({phase:'resolved',completed,total:refs.length});
  return {...snapshot,documents:preserveBuildingFingerprints(snapshot.documents,rewritePaths(snapshot.documents,replacements))};
}

export async function listLocalPrefabs() {
  // First use is an empty library, not a failed HTTP request or an error toast.
  let folder = '';
  let listing = await picker().browse('data', folder);
  for (const part of PREFAB_ROOT.split('/')) {
    folder = folder ? `${folder}/${part}` : part;
    const listed = listingHasDir(listing, folder);
    // The Forge's root listing leaves out folders that do exist; a folder the parent does not list is asked for
    // directly, and only a folder that cannot be listed either counts as missing.
    try { listing = await picker().browse('data', folder); }
    catch (error) { if (!listed) return []; throw error; }
  }
  if (!listingHasFile(listing, libraryPath)) return [];
  const index = await readJson(libraryPath);
  if (index.version !== 1 || !Array.isArray(index.entries)) throw new Error('Unsupported local Prefab library version.');
  return index.entries;
}

async function readBlob(path) {
  const response = await fetch(readUrl(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not read ${path} (${response.status}).`);
  return response.blob();
}
export async function readLocalPrefab(id) {
  const record = await readJson(`${recordPath(checkId(id))}/prefab.json`);
  if (record.deleted) throw new Error('This Prefab has been deleted.');
  if (record.id !== id) throw new Error('Prefab identity does not match its library record.');
  validateCompositionSnapshot(record);
  const { hash, ...payload } = record;
  if (hash !== await prefabHash(JSON.stringify(payload))) throw new Error('Prefab integrity check failed.');
  return record;
}
export async function readLocalPrefabPreview(id) { return readBlob(`${recordPath(checkId(id))}/preview.webp`); }

// All record writers publish the browsing index last and restore fixed paths on failure.
async function publishRecord(record, { entries, previous = null, preview, thumbnail }) {
  const folder = recordPath(record.id);
  const backup = previous ? await Promise.all(['preview.webp', 'thumbnail.webp'].map(name => readBlob(`${folder}/${name}`))) : null;
  if (JSON.stringify(await listLocalPrefabs()) !== JSON.stringify(entries)) throw new Error('The library changed. Reopen the Prefabs tab before saving.');
  const entry = { id: record.id, name: record.name, revision: record.revision, hash: record.hash,
    updatedAt: record.updatedAt, thumbnail: `${folder}/thumbnail.webp`, preview: `${folder}/preview.webp`,
    thumbnailVersion: 2, previewBounds: record.previewBounds, grid: record.grid, contentRefs: record.contentRefs || [], memberCount: record.documents.length, icon: record.registry.groups[record.rootGroupId].icon || 'fa-solid fa-object-group' };
  try {
    await upload(folder, preview, 'preview.webp');
    await upload(folder, thumbnail, 'thumbnail.webp');
    await writeJson(folder, 'prefab.json', record);
    await writeJson(PREFAB_ROOT, 'library.json', { version: 1, entries: [...entries.filter(item => item.id !== record.id), entry] });
  } catch (cause) {
    try {
      if (backup) {
        await upload(folder, backup[0], 'preview.webp');
        await upload(folder, backup[1], 'thumbnail.webp');
        await writeJson(folder, 'prefab.json', previous);
      } else await writeJson(folder, 'prefab.json', { kind: 'fa-nexus-prefab', id: record.id, deleted: true });
      await writeJson(PREFAB_ROOT, 'library.json', { version: 1, entries });
    } catch (rollback) {
      throw new Error(`Prefab save failed and its library record could not be restored: ${folder}. ${rollback.message}`, { cause });
    }
    throw cause;
  }
  Hooks.callAll('fa-nexus-prefab-library-changed');
  return record;
}

export async function saveLocalPrefab(snapshot, { name, preview, id = null, expectedRevision = null, expectedHash = null } = {}) {
  requireGM(); validateCompositionSnapshot(snapshot);
  if (!String(name || '').trim()) throw new Error('Enter a Prefab name.');
  if (!(preview instanceof Blob)) throw new Error('Capture a Prefab preview before saving.');
  return serialize(async () => {
    const entries = await listLocalPrefabs(), previous = id ? await readLocalPrefab(checkId(id)) : null;
    if (previous && (previous.revision !== expectedRevision || (expectedHash && previous.hash !== expectedHash)
      || !entries.some(entry=>entry.id===id&&entry.hash===previous.hash))) throw new Error('This Prefab changed. Reload the library before updating it.');
    const recordId = id || foundry.utils.randomID();
    const preserved = await preserveArtifacts(snapshot);
    const service = foundry.applications.instances?.get('fa-nexus-app')?._contentService;
    if (service) preserved.contentRefs = (await describePrefabContent(preserved.contentRefs, createPrefabCatalogLookup(service))).contentRefs;
    const record = { ...preserved, id: recordId, name: previous?.name || name.trim(), revision: (previous?.revision || 0) + 1,
      updatedAt: Date.now(), createdAt: previous?.createdAt || Date.now() };
    delete record.hash;
    record.hash = await prefabHash(JSON.stringify(record));
    const smallPreview = await createPrefabThumbnail(preview);
    return publishRecord(record, { entries, previous, preview, thumbnail: smallPreview });
  });
}

export async function importLocalPrefab(bundle, { mode = 'new', expectedHash = null } = {}) {
  requireGM();
  if (!['new', 'copy', 'replace'].includes(mode)) throw new Error('Unknown Prefab import action.');
  const { record: source, files } = bundle;
  checkId(source.id); validateCompositionSnapshot(source);
  return serialize(async () => {
    const entries = await listLocalPrefabs(), existing = entries.find(entry => entry.id === source.id);
    if (existing?.hash === source.hash) return { record: await readLocalPrefab(source.id), unchanged: true };
    if (existing && mode === 'new') throw new Error('This Prefab ID is already installed with different contents. Choose Import as Copy or Replace Existing.');
    const previous = mode === 'replace' && existing ? await readLocalPrefab(source.id) : null;
    if (mode === 'replace' && (!previous || previous.hash !== expectedHash || existing.hash !== previous.hash)) throw new Error('The target Prefab changed. Import the file again.');
    // Only generated artwork is installed. Normal assets remain references.
    for (const artifact of source.artifacts || []) {
      const name = artifact.path.split('/').at(-1), blob = files.get(`artifacts/${name}`);
      if (!blob || artifact.path !== `${PREFAB_ARTIFACT_ROOT}/${name}` || await prefabHash(await blob.arrayBuffer()) !== artifact.hash) throw new Error('Invalid Prefab artifact.');
      await ensureNestedFilePickerDirectory(PREFAB_ARTIFACT_ROOT);
      const listing = await picker().browse('data', PREFAB_ARTIFACT_ROOT);
      if (!listingHasFile(listing, artifact.path)) await upload(PREFAB_ARTIFACT_ROOT, blob, name);
      else if (await prefabHash(await (await readBlob(artifact.path)).arrayBuffer()) !== artifact.hash) throw new Error(`Stored Prefab artwork is corrupt: ${artifact.path}`);
    }
    const record = structuredClone(source);
    if (mode === 'copy' || previous) {
      Object.assign(record, { id: previous?.id || foundry.utils.randomID(), name: previous?.name || source.name,
        revision: (previous?.revision || 0) + 1, createdAt: previous?.createdAt || Date.now(), updatedAt: Date.now(),
        importedFrom: { id: source.id, hash: source.hash, revision: source.revision } });
      delete record.hash; record.hash = await prefabHash(JSON.stringify(record));
    }
    await publishRecord(record, { entries, previous, preview: files.get('preview.webp'), thumbnail: files.get('thumbnail.webp') });
    return { record, unchanged: false };
  });
}
export async function renameLocalPrefab(id, name, { expectedRevision = null } = {}) {
  requireGM(); checkId(id);
  if (typeof name !== 'string' || !name.trim()) throw new Error('Enter a Prefab name.');
  name = name.trim();
  return serialize(async () => {
    const entries = await listLocalPrefabs(), previous = await readLocalPrefab(id);
    const entry = entries.find(item => item.id === id);
    if (!entry || entry.hash !== previous.hash || previous.revision !== expectedRevision) {
      throw new Error('This Prefab changed. Reopen the Prefabs tab before renaming it.');
    }
    if (name === previous.name) return previous;
    const record = { ...previous, name, revision: previous.revision + 1, updatedAt: Date.now() };
    delete record.hash;
    record.hash = await prefabHash(JSON.stringify(record));
    const nextEntries = entries.map(item => item.id === id
      ? { ...item, name, revision: record.revision, updatedAt: record.updatedAt, hash: record.hash } : item);
    if (JSON.stringify(await listLocalPrefabs()) !== JSON.stringify(entries)) {
      throw new Error('The library changed. Reopen the Prefabs tab before renaming it.');
    }
    try {
      await writeJson(recordPath(id), 'prefab.json', record);
      await writeJson(PREFAB_ROOT, 'library.json', { version: 1, entries: nextEntries });
    } catch (cause) {
      try {
        await writeJson(recordPath(id), 'prefab.json', previous);
        await writeJson(PREFAB_ROOT, 'library.json', { version: 1, entries });
      } catch (rollback) {
        throw new Error(`Prefab rename failed and its library record could not be restored: ${recordPath(id)}. ${rollback.message}`, { cause });
      }
      throw cause;
    }
    Hooks.callAll('fa-nexus-prefab-library-changed');
    return record;
  });
}

export async function deleteLocalPrefab(id) {
  requireGM(); checkId(id);
  return serialize(async () => {
    const entries = await listLocalPrefabs();
    await writeJson(PREFAB_ROOT, 'library.json', { version: 1, entries: entries.filter(entry => entry.id !== id) });
    await writeJson(recordPath(id), 'prefab.json', { kind: 'fa-nexus-prefab', schemaVersion: 1, id, deleted: true });
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const placeholder = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp'));
    await upload(recordPath(id), placeholder, 'preview.webp'); await upload(recordPath(id), placeholder, 'thumbnail.webp');
    Hooks.callAll('fa-nexus-prefab-library-changed');
  });
}
export async function checkPrefabResources(snapshot) {
  const missing = [], listings = new Map();
  for (const resource of collectPrefabResources(snapshot.documents)) {
    if (!resource.artifact) {
      if (!await resourceExists(resource.path, listings)) missing.push(resource.path);
      continue;
    }
    const response = await fetch(resourceUrl(resource.path));
    if (!response.ok) {
      throw new Error(`Required Prefab artwork is missing: ${resource.path}`);
    }
    if (resource.artifact) {
      const artifact = snapshot.artifacts?.find(item => item.path === resource.path);
      if (!artifact || await prefabHash(await response.arrayBuffer()) !== artifact.hash) throw new Error(`Prefab artwork integrity check failed: ${resource.path}`);
    }
  }
  return missing;
}
