const MODULE_ID = 'fa-nexus';
const EDITING_TILE_SET_KEY = '__faNexusBuildingEditingTileIds';
const EDITOR_DOCUMENT_WRITE_OPTION = 'faNexusBuildingEditorDocumentWrite';

function readFlag(document, key) {
  try {
    const value = document?.getFlag?.(MODULE_ID, key);
    if (value !== undefined) return value;
  } catch (_) {}
  return document?._source?.flags?.[MODULE_ID]?.[key]
    ?? document?.flags?.[MODULE_ID]?.[key]
    ?? null;
}

export function getActiveBuildingEditingTileIds(root = globalThis) {
  const editing = root?.[EDITING_TILE_SET_KEY];
  return editing instanceof Set ? editing : new Set();
}

export function resolveBuildingEditProtectedRootId(document, { root = globalThis } = {}) {
  const editing = getActiveBuildingEditingTileIds(root);
  if (!editing.size) return null;
  const documentId = String(document?.id || document?._id || '').trim();
  if (documentId && editing.has(documentId)) return documentId;
  const generatedRootId = String(readFlag(document, 'buildingGenerated')?.rootTileId || '').trim();
  if (generatedRootId && editing.has(generatedRootId)) return generatedRootId;
  const linkedRootId = String(
    readFlag(document, 'buildingFill')?.wallTileId
      || readFlag(document, 'buildingSills')?.wallTileId
      || readFlag(document, 'buildingComposite')?.wallTileId
      || ''
  ).trim();
  return linkedRootId && editing.has(linkedRootId) ? linkedRootId : null;
}

export function isBuildingEditProtectedTile(document, options = {}) {
  return Boolean(resolveBuildingEditProtectedRootId(document, options));
}

export function canDeleteTileDuringBuildingEdit(document, deleteOptions = {}, options = {}) {
  if (!isBuildingEditProtectedTile(document, options)) return true;
  return deleteOptions?.[EDITOR_DOCUMENT_WRITE_OPTION] === true;
}

export { EDITOR_DOCUMENT_WRITE_OPTION };

// The host's existing editing-root set is the single session guard. It belongs to the active Scene.
export function isBuildingEditSessionActive({ sceneId, rootTileId } = {}, { root = globalThis } = {}) {
  return String(root?.canvas?.scene?.id || '') === String(sceneId || '')
    && getActiveBuildingEditingTileIds(root).has(String(rootTileId || ''));
}
