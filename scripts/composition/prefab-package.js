import { collectPrefabResources, prefabHash, readLocalPrefab } from './prefab-library.js';
import { validateCompositionSnapshot } from './scene-group-snapshot.js';
import { PREFAB_ARTIFACT_ROOT, PREFAB_ROOT } from '../storage/prefab-paths.js';

// A versioned gzip JSON envelope. No ZIP extraction or caller-supplied disk paths.
export const PREFAB_PACKAGE_LIMIT = 256 * 1024 * 1024;
const IMAGE_LIMIT = 16 * 1024 * 1024;
const fail = message => { throw new Error(`Invalid Prefab package: ${message}`); };
const encode = bytes => {
  let value = '';
  for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(value);
};
const decode = value => {
  if (typeof value !== 'string' || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('invalid file encoding.');
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
};

async function boundedBlob(stream, limit = PREFAB_PACKAGE_LIMIT) {
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('file exceeds the 256 MiB unpacked limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return new Blob(chunks);
}

function rejectUnsafeKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe object key.');
    rejectUnsafeKeys(entry);
  }
}

export async function validatePrefabPackage(envelope) {
  if (envelope?.kind !== 'fa-nexus-prefab-package' || envelope.version !== 1) fail('unsupported format or version.');
  rejectUnsafeKeys(envelope.record);
  const record = envelope.record;
  validateCompositionSnapshot(record);
  if (!/^[A-Za-z0-9]{16}$/.test(record.id || '') || typeof record.name !== 'string' || !record.name.trim()
    || !Number.isSafeInteger(record.revision) || record.revision < 1) fail('invalid record identity.');
  const { hash, ...payload } = record;
  if (hash !== await prefabHash(JSON.stringify(payload))) fail('manifest integrity check failed.');
  if (!Array.isArray(envelope.files) || !Array.isArray(record.artifacts)) fail('missing files or artifacts.');
  const artifacts = new Map();
  for (const item of record.artifacts) {
    const name = String(item.path).split('/').at(-1);
    if (!/^[a-f0-9]{64}\.(webp|png|jpe?g|avif)$/.test(name) || item.path !== `${PREFAB_ARTIFACT_ROOT}/${name}`
      || name.split('.')[0] !== item.hash || artifacts.has(item.path) || !Number.isSafeInteger(item.bytes) || item.bytes < 1) fail('invalid artifact path or hash.');
    artifacts.set(item.path, item);
  }
  const required = collectPrefabResources(record.documents).filter(item => item.artifact);
  if (required.length !== artifacts.size || required.some(item => !artifacts.has(item.path))) fail('artifact list does not match the composition.');
  const expected = new Set(['preview.webp', 'thumbnail.webp', ...[...artifacts.keys()].map(path => `artifacts/${path.split('/').at(-1)}`)]);
  const files = new Map();
  let total = 0;
  for (const file of envelope.files) {
    if (!expected.has(file.name) || files.has(file.name)) fail('unexpected or duplicate file.');
    const bytes = decode(file.data);
    total += bytes.byteLength;
    if (total > PREFAB_PACKAGE_LIMIT || file.bytes !== bytes.byteLength || await prefabHash(bytes) !== file.hash) fail('file size or integrity check failed.');
    const artifact = artifacts.get(`${PREFAB_ARTIFACT_ROOT}/${file.name.slice('artifacts/'.length)}`);
    if (file.name.startsWith('artifacts/') && (artifact.hash !== file.hash || artifact.bytes !== file.bytes)) fail('artifact integrity check failed.');
    if (!file.name.startsWith('artifacts/') && bytes.byteLength > IMAGE_LIMIT) fail('preview is too large.');
    const ext = file.name.split('.').at(-1);
    files.set(file.name, new Blob([bytes], { type: `image/${ext === 'jpg' ? 'jpeg' : ext}` }));
  }
  if (files.size !== expected.size) fail('required files are missing.');
  return { record, files };
}

export async function exportPrefabPackage(id) {
  const record = await readLocalPrefab(id), files = [];
  const sources = [
    ['preview.webp', `${PREFAB_ROOT}/records/${id}/preview.webp`],
    ['thumbnail.webp', `${PREFAB_ROOT}/records/${id}/thumbnail.webp`],
    ...(record.artifacts || []).map(item => [`artifacts/${item.path.split('/').at(-1)}`, item.path])
  ];
  for (const [name, path] of sources) {
    const response = await fetch(foundry.utils.getRoute(path), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not export required Prefab file: ${path}`);
    const bytes = new Uint8Array(await (await boundedBlob(response.body)).arrayBuffer());
    files.push({ name, bytes: bytes.length, hash: await prefabHash(bytes), data: encode(bytes) });
  }
  if ((await readLocalPrefab(id)).hash !== record.hash) throw new Error('This Prefab changed while exporting. Please retry.');
  const envelope = { kind: 'fa-nexus-prefab-package', version: 1, record, files };
  await validatePrefabPackage(envelope);
  const json = new Blob([JSON.stringify(envelope)], { type: 'application/json' });
  if (json.size > PREFAB_PACKAGE_LIMIT) fail('file exceeds the 256 MiB unpacked limit.');
  return boundedBlob(json.stream().pipeThrough(new CompressionStream('gzip')));
}

export async function readPrefabPackage(file) {
  if (!(file instanceof Blob) || file.size > PREFAB_PACKAGE_LIMIT) fail('file is too large.');
  let json;
  try { json = await (await boundedBlob(file.stream().pipeThrough(new DecompressionStream('gzip')))).text(); }
  catch (error) { throw new Error('Could not unpack the Prefab file. It may be damaged or too large.', { cause: error }); }
  const bundle = await validatePrefabPackage(JSON.parse(json));
  // Verify previews can be rendered before creating any library files.
  for (const name of ['preview.webp', 'thumbnail.webp']) {
    const bitmap = await createImageBitmap(bundle.files.get(name));
    try { if (bitmap.width > 4096 || bitmap.height > 4096) fail('preview dimensions are too large.'); }
    finally { bitmap.close(); }
  }
  return bundle;
}
