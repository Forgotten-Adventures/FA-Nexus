import { contentPath } from './cloud-inventory-v2.js';

export const emptyCollections = () => ({ version: 1, revision: 0, collections: [] });
const cleanName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('Enter a Collection name of 1–120 characters.');
  return value.trim();
};
const validId = value => typeof value === 'string' && /^[A-Za-z0-9]{16}$/.test(value);

export function contentReference(item, tabId, roots = {}) {
  if (item.isSolidTexture || item.isNoneTexture) return null;
  if (tabId === 'prefabs') return { type: 'prefab', id: item.id };
  const kind = tabId === 'tokens' ? 'tokens' : 'assets';
  const path = contentPath(item).replaceAll('\\', '/');
  if (!path || !/\.(webp|png|jpe?g|avif|svg|webm|mp4)$/i.test(path)) return null;
  const prefix = (roots[kind] || []).find(root => path.startsWith(`${root}/`));
  if (item.source === 'cloud' || prefix) {
    const id = (prefix ? path.slice(prefix.length + 1) : path).replace(/\.(webp|png|jpe?g|avif|svg|webm|mp4)$/i, '');
    return { type: 'fa', kind, id };
  }
  return { type: 'file', kind, path };
}

export function referenceKey(ref) {
  if (ref?.type === 'prefab' && validId(ref.id)) return `prefab:${ref.id}`;
  if (!['assets', 'tokens'].includes(ref?.kind)) throw new Error('Invalid Collection content kind.');
  const value = ref.type === 'fa' ? ref.id : ref.type === 'file' ? ref.path : null;
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw new Error('Invalid Collection content reference.');
  return `${ref.type}:${ref.kind}:${value}`;
}

export function validateCollections(library) {
  if (library?.version !== 1 || !Number.isSafeInteger(library.revision) || library.revision < 0 || !Array.isArray(library.collections)) throw new Error('Unsupported Collections library.');
  const byId = new Map();
  for (const entry of library.collections) {
    if (!validId(entry.id) || byId.has(entry.id)) throw new Error('Invalid or duplicate Collection identity.');
    cleanName(entry.name);
    if (typeof entry.icon !== 'string' || !/^(?:fa-(?:solid|regular|light|thin|duotone|brands) )?fa-[a-z0-9-]+$/.test(entry.icon)) throw new Error('Invalid Collection icon.');
    if (!/^#[a-f0-9]{6}$/i.test(entry.color)) throw new Error('Invalid Collection color.');
    if (!Array.isArray(entry.members)) throw new Error('Invalid Collection members.');
    const keys = entry.members.map(referenceKey);
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate Collection membership.');
    byId.set(entry.id, entry);
  }
  for (const entry of library.collections) {
    const visited = new Set([entry.id]);
    let parent = entry.parentId;
    while (parent !== null) {
      if (!byId.has(parent) || visited.has(parent)) throw new Error('Invalid Collection nesting.');
      visited.add(parent); parent = byId.get(parent).parentId;
    }
  }
  return library;
}

export function collectionDescendants(library, id) {
  const ids = new Set([id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of library.collections) if (ids.has(entry.parentId) && !ids.has(entry.id)) { ids.add(entry.id); changed = true; }
  }
  return ids;
}

export function collectionMemberKeys(library, id, includeChildren = true) {
  const ids = id === null ? new Set(library.collections.map(entry => entry.id)) : includeChildren ? collectionDescendants(library, id) : new Set([id]);
  return new Set(library.collections.filter(entry => ids.has(entry.id)).flatMap(entry => entry.members.map(referenceKey)));
}

export function changeCollections(library, action) {
  validateCollections(library);
  const next = structuredClone(library);
  const target = next.collections.find(entry => entry.id === action.id);
  if (action.type === 'create') {
    next.collections.push({ id: action.id, parentId: action.parentId || null, name: cleanName(action.name), icon: 'fa-solid fa-folder', color: '#e9cb68', members: [] });
  } else {
    if (!target) throw new Error('This Collection no longer exists.');
    if (action.type === 'edit') {
      for (const key of ['name', 'parentId', 'icon', 'color']) if (Object.hasOwn(action, key)) target[key] = key === 'name' ? cleanName(action[key]) : action[key];
    } else if (action.type === 'delete') {
      const removed = collectionDescendants(next, target.id);
      next.collections = next.collections.filter(entry => !removed.has(entry.id));
    } else if (action.type === 'add' || action.type === 'remove') {
      const keys = new Set(action.members.map(referenceKey));
      const targets = action.type === 'remove' && action.includeChildren ? collectionDescendants(next, target.id) : new Set([target.id]);
      for (const entry of next.collections) if (targets.has(entry.id)) entry.members = entry.members.filter(ref => !keys.has(referenceKey(ref)));
      if (action.type === 'add') target.members.push(...new Map(action.members.map(ref => [referenceKey(ref), structuredClone(ref)])).values());
    } else throw new Error('Unknown Collection action.');
  }
  next.revision++;
  return validateCollections(next);
}
