const MODULE_ID = 'fa-nexus';
const SECTIONS_FLAG = 'layerManagerSections';
const updateQueues = new WeakMap();

function normalizeId(value) {
  return String(value || '').trim();
}

function readFaFlag(doc, key) {
  if (typeof doc?.getFlag === 'function') return doc.getFlag(MODULE_ID, key);
  return doc?.flags?.[MODULE_ID]?.[key] ?? doc?._source?.flags?.[MODULE_ID]?.[key] ?? null;
}

export function sectionKey(sectionId) {
  const id = normalizeId(sectionId);
  return id ? `section:${id}` : '';
}

export function normalizeLayerManagerSections(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rawSections = Array.isArray(source.sections)
    ? Object.fromEntries(source.sections.map((section) => [normalizeId(section?.id), section]).filter(([id]) => id))
    : (source.sections && typeof source.sections === 'object' ? source.sections : {});
  const sections = {};
  for (const [rawId, value] of Object.entries(rawSections)) {
    const id = normalizeId(rawId);
    const name = String(value?.name || '').trim();
    if (!id || !name) continue;
    sections[id] = {
      name,
      parentId: normalizeId(value?.parentId) || null,
      elevationKey: normalizeId(value?.elevationKey) || null
    };
  }

  for (const [id, section] of Object.entries(sections)) {
    if (section.parentId === id || !sections[section.parentId]) section.parentId = null;
    const seen = new Set([id]);
    let parentId = section.parentId;
    while (parentId) {
      if (seen.has(parentId)) {
        section.parentId = null;
        break;
      }
      seen.add(parentId);
      parentId = sections[parentId]?.parentId || null;
    }
  }

  const rawMemberships = Array.isArray(source.memberships)
    ? Object.fromEntries(source.memberships
      .map((membership) => [normalizeId(membership?.tileId), normalizeId(membership?.sectionId)])
      .filter(([tileId]) => tileId))
    : (source.memberships && typeof source.memberships === 'object' ? source.memberships : {});
  const memberships = {};
  for (const [rawTileId, rawSectionId] of Object.entries(rawMemberships)) {
    const tileId = normalizeId(rawTileId);
    const sectionId = normalizeId(rawSectionId);
    if (tileId && sections[sectionId]) memberships[tileId] = sectionId;
  }

  return { version: 1, sections, memberships };
}

export function cloneLayerManagerSections(metadata = {}) {
  const normalized = normalizeLayerManagerSections(metadata);
  return {
    version: 1,
    sections: Object.fromEntries(Object.entries(normalized.sections).map(([id, section]) => [id, { ...section }])),
    memberships: { ...normalized.memberships }
  };
}

export function serializeLayerManagerSections(metadata = {}) {
  const normalized = normalizeLayerManagerSections(metadata);
  return {
    version: 1,
    sections: Object.entries(normalized.sections).map(([id, section]) => ({ id, ...section })),
    memberships: Object.entries(normalized.memberships).map(([tileId, sectionId]) => ({ tileId, sectionId }))
  };
}

export function getSceneLayerManagerSections(scene = globalThis.canvas?.scene) {
  return normalizeLayerManagerSections(readFaFlag(scene, SECTIONS_FLAG));
}

export function applySceneLayerManagerSectionsLocally(scene, metadata) {
  if (!scene) throw new Error('No active scene available for local layer Folder update.');
  if (typeof scene.updateSource !== 'function') {
    throw new Error('The active scene does not support local source updates for layer Folders.');
  }
  const normalized = normalizeLayerManagerSections(metadata);
  scene.updateSource({
    [`flags.${MODULE_ID}.${SECTIONS_FLAG}`]: serializeLayerManagerSections(normalized)
  });
}

/**
 * Save the Folders of a Scene. `force` sends the whole value whatever the local Scene holds: Undo and Redo show the
 * restored Folders locally first, and a save that only sends differences would then find nothing to send and
 * leave the server with the state that was undone.
 */
export async function setSceneLayerManagerSections(scene, metadata, { force = false } = {}) {
  if (!scene) throw new Error('No active scene available for layer Folder update.');
  if (!scene?.canUserModify?.(globalThis.game?.user, 'update')) {
    throw new Error('You do not have permission to edit layer Folders.');
  }
  const normalized = normalizeLayerManagerSections(metadata);
  const serialized = serializeLayerManagerSections(normalized);
  if (force) await scene.update({ flags: { [MODULE_ID]: { [SECTIONS_FLAG]: serialized } } }, { diff: false });
  else await scene.setFlag(MODULE_ID, SECTIONS_FLAG, serialized);
  applySceneLayerManagerSectionsLocally(scene, normalized);
  return normalized;
}

export function updateSceneLayerManagerSections(scene, updater) {
  if (!scene) return Promise.reject(new Error('No active scene available for layer Folder update.'));
  if (typeof updater !== 'function') return Promise.reject(new TypeError('Layer Folder updater must be a function.'));
  const previous = updateQueues.get(scene) || Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const current = getSceneLayerManagerSections(scene);
    const updated = await updater(cloneLayerManagerSections(current));
    if (updated === undefined) return current;
    return setSceneLayerManagerSections(scene, updated);
  });
  updateQueues.set(scene, next);
  return next.finally(() => {
    if (updateQueues.get(scene) === next) updateQueues.delete(scene);
  });
}

export function getTileSectionId(metadata, tileId) {
  const id = normalizeId(tileId);
  if (!id) return null;
  return normalizeLayerManagerSections(metadata).memberships[id] || null;
}

export function getSectionDescendantIds(metadata, sectionId) {
  const normalized = normalizeLayerManagerSections(metadata);
  const rootId = normalizeId(sectionId);
  if (!normalized.sections[rootId]) return [];
  const result = [];
  const visit = (id) => {
    result.push(id);
    for (const [childId, section] of Object.entries(normalized.sections)) {
      if (section.parentId === id) visit(childId);
    }
  };
  visit(rootId);
  return result;
}

export function getSectionMoveRootIds(metadata, sectionIds = []) {
  const normalized = normalizeLayerManagerSections(metadata);
  const candidates = Array.from(new Set(sectionIds
    .map((id) => normalizeId(id))
    .filter((id) => normalized.sections[id])));
  const selected = new Set(candidates);
  return candidates.filter((id) => {
    let parentId = normalized.sections[id]?.parentId || null;
    while (parentId) {
      if (selected.has(parentId)) return false;
      parentId = normalized.sections[parentId]?.parentId || null;
    }
    return true;
  });
}

export function getSectionTileIds(metadata, sectionId) {
  const normalized = normalizeLayerManagerSections(metadata);
  const sectionIds = new Set(getSectionDescendantIds(normalized, sectionId));
  if (!sectionIds.size) return [];
  return Object.entries(normalized.memberships)
    .filter(([, memberSectionId]) => sectionIds.has(memberSectionId))
    .map(([tileId]) => tileId);
}

export function removeLayerManagerSection(metadata, sectionId) {
  const normalized = cloneLayerManagerSections(metadata);
  const id = normalizeId(sectionId);
  const section = normalized.sections[id];
  if (!section) return normalized;
  const parentId = section.parentId && normalized.sections[section.parentId] ? section.parentId : null;
  for (const child of Object.values(normalized.sections)) {
    if (child.parentId === id) child.parentId = parentId;
  }
  for (const [tileId, memberSectionId] of Object.entries(normalized.memberships)) {
    if (memberSectionId !== id) continue;
    if (parentId) normalized.memberships[tileId] = parentId;
    else delete normalized.memberships[tileId];
  }
  delete normalized.sections[id];
  return normalized;
}
