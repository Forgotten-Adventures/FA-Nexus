// One shared planned-vs-live rule for the whole Commit path; see building-fill-document-operations.js.
import { ownedSourceDifferences } from './building-fill-document-operations.js';

const MODULE_ID = 'fa-nexus';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function normalizeIdentity(value) {
  return String(value || '').trim();
}

function documentSource(document) {
  return typeof document?.toObject === 'function'
    ? document.toObject(true)
    : clone(document?._source || document);
}

function collectionFor(scene, documentName) {
  if (documentName === 'Tile') return scene?.tiles;
  if (documentName === 'Wall') return scene?.walls;
  if (documentName === 'Region') return scene?.regions;
  return null;
}

function recordFor(scene, documentName, document) {
  if (!document) return null;
  const id = normalizeIdentity(document.id || document._id);
  return {
    documentName,
    uuid: normalizeIdentity(document.uuid) || `${normalizeIdentity(scene?.uuid)}.${documentName}.${id}`,
    source: documentSource(document)
  };
}

function isAuthoritativeMissingDocumentError(error, documentName, id) {
  const message = String(error?.message || error);
  return message.includes(`${normalizeIdentity(documentName)} "${normalizeIdentity(id)}" does not exist`);
}

// Foundry returns NOTHING from an update whose computed diff is empty — a successful no-change
// write and a rejected write look identical from the return value alone. Treating the empty result
// as a failure broke every Commit whose patch happened to already hold (it surfaced as
// "did not return an updated document", rolled back, and left the session open with no explanation).
// Assuming success instead would be worse. So the live document is READ BACK and the intended
// after-state is proven: a document that already satisfies the patch is done, and anything else
// still fails loudly with the fields that did not take.
function verifiedNoChangeUpdate({ scene, documentName, id, changes } = {}) {
  const live = collectionFor(scene, documentName)?.get?.(id) || null;
  if (!live) {
    throw new Error(`Foundry ${documentName}.${id} returned no updated document and is no longer readable.`);
  }
  const mergeObject = globalThis.foundry?.utils?.mergeObject;
  if (typeof mergeObject !== 'function') {
    throw new Error(`Foundry ${documentName}.${id} returned no updated document and its result cannot be verified without Foundry object utilities.`);
  }
  const liveSource = clone(live.toObject(true));
  const patch = clone(changes || {});
  delete patch._id;
  const intended = mergeObject(clone(liveSource), patch, { inplace: false, performDeletions: true });
  // The SAME planned-vs-live rule the Commit transaction uses. A Region's `shapes` and `behaviors`
  // are authored by the Building and then augmented by Foundry's own document schema, so a raw
  // comparison reports a mismatch on a document that satisfies every field the Building owns.
  const fields = ownedSourceDifferences(documentName, liveSource, intended);
  if (fields.length) {
    throw new Error(
      `Foundry ${documentName}.${id} returned no updated document and does not match the requested update (${fields.join(', ')}).`
    );
  }
  return recordFor(scene, documentName, live);
}

export class FoundryBuildingSceneAdapter {
  constructor({ resolveScene = (sceneId) => {
    const active = globalThis.canvas?.scene;
    if (normalizeIdentity(active?.id) === normalizeIdentity(sceneId)) return active;
    return globalThis.game?.scenes?.get?.(sceneId) || null;
  } } = {}) {
    this._resolveScene = resolveScene;
    this._lastSceneId = null;
  }

  _scene(sceneId) {
    const scene = this._resolveScene(normalizeIdentity(sceneId));
    if (!scene) throw new Error(`Foundry Scene ${normalizeIdentity(sceneId)} is unavailable.`);
    return scene;
  }

  async readAggregate({ sceneId, rootTileId } = {}) {
    const scene = this._scene(sceneId);
    this._lastSceneId = normalizeIdentity(scene.id);
    const root = scene.tiles?.get?.(rootTileId) || scene.getEmbeddedDocument?.('Tile', rootTileId) || null;
    if (!root) return null;
    const documents = [];
    for (const [documentName, collection] of [
      ['Tile', scene.tiles],
      ['Wall', scene.walls],
      ['Region', scene.regions]
    ]) {
      for (const document of Array.from(collection || [])) {
        if (documentName === 'Tile' && normalizeIdentity(document.id) === normalizeIdentity(rootTileId)) continue;
        documents.push(recordFor(scene, documentName, document));
      }
    }
    return {
      sceneId: normalizeIdentity(scene.id),
      sceneGridSize: Number(scene.grid?.size),
      root: recordFor(scene, 'Tile', root),
      documents,
      registry: clone(scene.getFlag?.(MODULE_ID, 'compositionRegistry') || null)
    };
  }

  async readDocument({ sceneId, documentName, id } = {}) {
    const scene = this._scene(sceneId);
    this._lastSceneId = normalizeIdentity(scene.id);
    const collection = collectionFor(scene, documentName);
    const document = collection?.get?.(id) || scene.getEmbeddedDocument?.(documentName, id) || null;
    return recordFor(scene, documentName, document);
  }

  async readRegistry({ sceneId } = {}) {
    const scene = this._scene(sceneId);
    this._lastSceneId = normalizeIdentity(scene.id);
    return clone(scene.getFlag?.(MODULE_ID, 'compositionRegistry') || null);
  }

  async createDocument({ documentName, source, reason = 'building-current-create' } = {}) {
    const sceneId = this._lastSceneId || normalizeIdentity(globalThis.canvas?.scene?.id);
    const scene = this._scene(sceneId);
    const requestedId = normalizeIdentity(source?._id);
    const created = await scene.createEmbeddedDocuments(documentName, [clone(source)], {
      keepId: true,
      faNexusBuildingCurrentEdit: true,
      faNexusBuildingCurrentEditReason: normalizeIdentity(reason)
    });
    // PERMANENT guards: the create must return the exact requested document, and it must be
    // present in the Scene collection immediately afterwards. A create that fails either is a
    // hard failure here, never a silent divergence discovered after the Commit reports success.
    const document = Array.isArray(created) ? created[0] : null;
    if (!document || normalizeIdentity(document.id) !== requestedId) {
      throw new Error(`Foundry ${documentName}.${requestedId} creation returned no exact document.`);
    }
    if (!collectionFor(scene, documentName)?.get?.(requestedId)) {
      throw new Error(`Foundry ${documentName}.${requestedId} was created but is not present in the Scene.`);
    }
    return recordFor(scene, documentName, document);
  }

  async deleteDocument({ documentName, id, reason = 'building-current-create-rollback' } = {}) {
    const sceneId = this._lastSceneId || normalizeIdentity(globalThis.canvas?.scene?.id);
    const scene = this._scene(sceneId);
    let deleted;
    try {
      deleted = await scene.deleteEmbeddedDocuments(documentName, [id], {
        faNexusBuildingCurrentEdit: true,
        faNexusBuildingCurrentEditReason: normalizeIdentity(reason)
      });
    } catch (error) {
      if (isAuthoritativeMissingDocumentError(error, documentName, id)) return null;
      throw error;
    }
    return Array.isArray(deleted) ? deleted[0] || null : null;
  }

  async replaceRegistry({ sceneId, registry, reason = 'building-current-create' } = {}) {
    const scene = this._scene(sceneId || this._lastSceneId);
    this._lastSceneId = normalizeIdentity(scene.id);
    const current = clone(scene.getFlag?.(MODULE_ID, 'compositionRegistry') || null);
    let changes;
    if (registry == null) {
      changes = { [`flags.${MODULE_ID}.-=compositionRegistry`]: null };
    } else if (current == null) {
      changes = { [`flags.${MODULE_ID}.compositionRegistry`]: clone(registry) };
    } else {
      const diffObject = globalThis.foundry?.utils?.diffObject;
      if (typeof diffObject !== 'function') throw new Error('Foundry registry diff support is unavailable.');
      changes = { flags: { [MODULE_ID]: { compositionRegistry: diffObject(current, registry, { bidirectional: true }) } } };
    }
    await scene.update(changes, {
      faNexusBuildingCurrentEdit: true,
      faNexusBuildingCurrentEditReason: normalizeIdentity(reason)
    });
    const live = clone(scene.getFlag?.(MODULE_ID, 'compositionRegistry') || null);
    if (JSON.stringify(live) !== JSON.stringify(registry ?? null)) {
      throw new Error('Foundry Building composition registry replacement could not be verified exactly.');
    }
    return live;
  }

  async replaceDocumentSource({ documentName, id, source, reason = 'building-current-edit' } = {}) {
    const sceneId = this._lastSceneId || normalizeIdentity(globalThis.canvas?.scene?.id);
    const scene = this._scene(sceneId);
    if (!collectionFor(scene, documentName)?.get?.(id)) {
      throw new Error(`Foundry ${documentName}.${id} is unavailable for Building Edit.`);
    }
    const update = clone(source);
    update._id = normalizeIdentity(id);
    const updated = await scene.updateEmbeddedDocuments(documentName, [update], {
      faNexusBuildingCurrentEdit: true,
      faNexusBuildingCurrentEditReason: normalizeIdentity(reason),
      diff: false,
      recursive: false
    });
    const document = Array.isArray(updated) ? updated[0] : null;
    if (document) return recordFor(scene, documentName, document);
    return verifiedNoChangeUpdate({ scene, documentName, id, changes: update });
  }

  async updateDocumentPatch({ documentName, id, changes, reason = 'building-current-edit' } = {}) {
    const sceneId = this._lastSceneId || normalizeIdentity(globalThis.canvas?.scene?.id);
    const scene = this._scene(sceneId);
    if (!collectionFor(scene, documentName)?.get?.(id)) {
      throw new Error(`Foundry ${documentName}.${id} is unavailable for Building Edit.`);
    }
    const update = { _id: normalizeIdentity(id), ...clone(changes || {}) };
    const updated = await scene.updateEmbeddedDocuments(documentName, [update], {
      faNexusBuildingCurrentEdit: true,
      faNexusBuildingCurrentEditReason: normalizeIdentity(reason)
    });
    const document = Array.isArray(updated) ? updated[0] : null;
    if (document) return recordFor(scene, documentName, document);
    return verifiedNoChangeUpdate({ scene, documentName, id, changes: update });
  }


}


export default FoundryBuildingSceneAdapter;
