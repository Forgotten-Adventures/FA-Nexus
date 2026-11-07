import { notifySceneGroupFailure } from './scene-group-notifications.js';
import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { writeSceneDocumentDragData } from './scene-group-drag-data.js';
import { resolveSceneGroupDragSelection } from './scene-group-drag-selection.js';

const PATCH_MARKER = Symbol.for('fa-nexus.placeable-scene-group-drag');
const SUPPORTED_TYPES = new Set(['Tile', 'Wall', 'AmbientLight', 'AmbientSound', 'Region']);

function documentType(document) {
  return String(document?.documentName || document?.constructor?.metadata?.name || '').trim();
}

function reportFailure(error, document = null) {
  Logger.error('PlaceableSceneGroupDrag.dragStart.failed', {
    documentUuid: document?.uuid || null,
    documentName: documentType(document) || null,
    error: String(error?.message || error)
  });
  notifySceneGroupFailure(error, 'Unable to drag the complete selection');
}

class PlaceableSceneGroupDragRuntime {
  initialize() {
    const PlaceableTab = foundry?.applications?.sidebar?.tabs?.PlaceableTab;
    const prototype = PlaceableTab?.prototype;
    if (!prototype || typeof prototype._onDragStart !== 'function') {
      throw new Error('Foundry v14 PlaceableTab._onDragStart is unavailable.');
    }
    if (prototype[PATCH_MARKER]) return;
    const original = prototype._onDragStart;
    Object.defineProperty(prototype, PATCH_MARKER, { value: original, configurable: false });
    prototype._onDragStart = function faNexusSceneGroupPlaceableDragStart(event) {
      original.call(this, event);
      const document = this._getPlaceableFromElement?.(event?.currentTarget) || null;
      const type = documentType(document);
      if (!document || !SUPPORTED_TYPES.has(type)) return;
      try {
        const selectedDocuments = Array.from(this.layer?.controlled || [])
          .map((placeable) => placeable?.document)
          .filter((candidate) => candidate && documentType(candidate) === type);
        const resolved = resolveSceneGroupDragSelection({
          origin: { kind: 'document', id: document.uuid },
          selected: selectedDocuments.map((candidate) => ({ kind: 'document', id: candidate.uuid }))
        });
        const selectedByUuid = new Map(selectedDocuments.map((candidate) => [candidate.uuid, candidate]));
        selectedByUuid.set(document.uuid, document);
        writeSceneDocumentDragData(event.dataTransfer, resolved.memberUuids.map((uuid) => ({
          uuid: selectedByUuid.get(uuid)?.uuid || uuid
        })));
      } catch (error) {
        reportFailure(error, document);
        throw error;
      }
    };
    Logger.info('PlaceableSceneGroupDrag.initialized');
  }
}

export const placeableSceneGroupDragRuntime = new PlaceableSceneGroupDragRuntime();
placeableSceneGroupDragRuntime.initialize();
