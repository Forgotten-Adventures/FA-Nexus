const MODULE_ID = 'fa-nexus';
export const LAYER_HIDDEN_FLAG = 'layerHidden';

function getDocumentId(document) {
  return String(document?.id || document?._id || '').trim();
}

export function isLayerHidden(document) {
  const direct = document?.getFlag?.(MODULE_ID, LAYER_HIDDEN_FLAG);
  if (direct !== undefined) return !!direct;
  const flags = document?.flags?.[MODULE_ID] || document?._source?.flags?.[MODULE_ID];
  return !!flags?.[LAYER_HIDDEN_FLAG];
}

export function buildLayerHiddenUpdate(document, hidden) {
  const id = getDocumentId(document);
  if (!id) return null;
  return hidden
    ? { _id: id, flags: { [MODULE_ID]: { [LAYER_HIDDEN_FLAG]: true } } }
    : { _id: id, flags: { [MODULE_ID]: { [`-=${LAYER_HIDDEN_FLAG}`]: null } } };
}

export function hasLayerHiddenChange(changes) {
  if (!changes?.flags) return false;
  const scoped = changes.flags[MODULE_ID];
  if (scoped === null) return true;
  if (!scoped) return false;
  if (Object.prototype.hasOwnProperty.call(scoped, LAYER_HIDDEN_FLAG)) return true;
  return Object.prototype.hasOwnProperty.call(scoped, `-=${LAYER_HIDDEN_FLAG}`);
}
