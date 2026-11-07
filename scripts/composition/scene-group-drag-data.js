import { COMPOSITION_COLLECTIONS } from './scene-group-snapshot.js';

export const SCENE_DOCUMENT_DRAG_MIME = 'application/x-fa-nexus-scene-documents';
export const SCENE_GROUP_DRAG_MIME = 'application/x-fa-nexus-scene-groups';
export const LAYER_TREE_DRAG_MIME = 'application/x-fa-nexus-layer-tree';

export function writeLayerTreeDragData(dataTransfer, sceneId, tree) {
  dataTransfer.setData(LAYER_TREE_DRAG_MIME, JSON.stringify({sceneId, ...tree}));
}

const SUPPORTED_TYPES = new Set(Object.keys(COMPOSITION_COLLECTIONS));

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function parseTransferJson(dataTransfer, mime) {
  const raw = normalizeIdentity(dataTransfer?.getData?.(mime));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Invalid Scene Group drag payload for ${mime}.`, { cause });
  }
}

export function writeSceneDocumentDragData(dataTransfer, documents = []) {
  if (!dataTransfer?.setData) throw new Error('Scene document drag data requires a DataTransfer object.');
  const uuids = Array.from(new Set((Array.isArray(documents) ? documents : [])
    .map((document) => normalizeIdentity(document?.uuid))
    .filter(Boolean)));
  if (!uuids.length) throw new Error('Scene document drag data requires at least one document UUID.');
  dataTransfer.setData(SCENE_DOCUMENT_DRAG_MIME, JSON.stringify({
    kind: 'scene-documents',
    uuids
  }));
  return uuids;
}

export function writeSceneGroupDragData(dataTransfer, groupIds = [], sceneId = globalThis.canvas?.scene?.id) {
  if (!dataTransfer?.setData) throw new Error('Scene Group drag data requires a DataTransfer object.');
  const normalized = Array.from(new Set((Array.isArray(groupIds) ? groupIds : [])
    .map(normalizeIdentity)
    .filter(Boolean)));
  if (!normalized.length) throw new Error('Scene Group drag data requires at least one group identity.');
  dataTransfer.setData(SCENE_GROUP_DRAG_MIME, JSON.stringify({
    kind: 'scene-groups',
    sceneId,
    groupIds: normalized
  }));
  return normalized;
}

export function readSceneGroupDropData(event, {
  TextEditor = globalThis.foundry?.applications?.ux?.TextEditor
} = {}) {
  const dataTransfer = event?.dataTransfer;
  if (!dataTransfer) throw new Error('Scene Group drop requires a DataTransfer object.');

  const documentPayload = parseTransferJson(dataTransfer, SCENE_DOCUMENT_DRAG_MIME);
  if (documentPayload) {
    const memberUuids = Array.from(new Set((Array.isArray(documentPayload.uuids)
      ? documentPayload.uuids
      : []).map(normalizeIdentity).filter(Boolean)));
    if (documentPayload.kind !== 'scene-documents' || !memberUuids.length) {
      throw new Error('Invalid FA Nexus scene-document drag payload.');
    }
    const layerTree = parseTransferJson(dataTransfer, LAYER_TREE_DRAG_MIME);
    return { memberUuids, groupIds: [], source: 'layer-manager', ...(layerTree ? {layerTree} : {}) };
  }

  const groupPayload = parseTransferJson(dataTransfer, SCENE_GROUP_DRAG_MIME);
  if (groupPayload) {
    const groupIds = Array.from(new Set((Array.isArray(groupPayload.groupIds)
      ? groupPayload.groupIds
      : []).map(normalizeIdentity).filter(Boolean)));
    if (groupPayload.kind !== 'scene-groups' || !groupIds.length) {
      throw new Error('Invalid FA Nexus Scene Group drag payload.');
    }
    return { memberUuids: [], groupIds, source: 'groups-window', ...(groupPayload.sceneId ? {sceneId:groupPayload.sceneId} : {}) };
  }

  const nativeData = TextEditor?.implementation?.getDragEventData?.(event)
    || TextEditor?.getDragEventData?.(event)
    || {};
  const documentName = normalizeIdentity(nativeData?.type);
  const uuid = normalizeIdentity(nativeData?.uuid);
  if (!SUPPORTED_TYPES.has(documentName) || !uuid) {
    throw new Error(`Unsupported Scene Group drop payload: ${documentName || 'unknown document type'}.`);
  }
  return { memberUuids: [uuid], groupIds: [], source: 'foundry-placeables' };
}
