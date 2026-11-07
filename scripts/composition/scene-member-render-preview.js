import {
  applyAssetScatterTransformPreview,
  clearAssetScatterTransformPreview
} from '../assets/asset-scatter-native-tile-transform.js';
import { doorTransformPreviewRuntime } from '../portals/door-transform-preview-runtime.js';
import { syncFlattenedNativeTransformPreview } from '../flatten/flatten-native-tile-transform.js';
import {
  syncMaskedTilingTransformPreview,
  syncStandardMaskNativeTransformPreview
} from '../textures/texture-mask-runtime.js';

const PATH_SCENE_GROUP_PREVIEW_SLOT = Symbol.for('fa-nexus.path-scene-group-preview');
const DISPLAY_TRANSFORM_PREVIEW_SLOT = Symbol.for('fa-nexus.scene-group-display-transform-preview');
const MEMBER_PREVIEW_RENDER_FLAGS = Object.freeze({
  Tile: Object.freeze({ refreshTransform: true }),
  Wall: Object.freeze({ refreshLine: true }),
  AmbientLight: Object.freeze({ refreshTransform: true, refreshField: true }),
  AmbientSound: Object.freeze({ refreshTransform: true, refreshField: true }),
  Region: Object.freeze({ refreshShapes: true })
});
const PRESERVED_TILE_PREVIEW_CONTAINER_KEYS = Object.freeze([
  'faNexusBuildingContainer',
  'faNexusBuildingCompositeContainer',
  'faNexusDoorFrameContainer',
  'faNexusMaskContainer',
  'faNexusPathContainer',
  'faNexusAssetScatterContainer',
  'faNexusFlattenChunkContainer'
]);

export function memberPreviewChanges(state) {
  // updateSource does not fire persisted update hooks. Keeping the semantic
  // flags in the transient document lets family renderers preview the exact
  // authoritative target without rebuilding through updateTile on mousemove.
  return { ...state };
}

export function refreshMemberPreviewObject(document, {operation = 'transform'} = {}) {
  doorTransformPreviewRuntime.sync(document);
  const flags = MEMBER_PREVIEW_RENDER_FLAGS[document?.documentName];
  const object = document?.object;
  const renderFlags = object?.renderFlags;
  if (!flags || typeof renderFlags?.set !== 'function') return;
  // Moving a Tile does not change its artwork or alpha mask. refreshTransform
  // includes refreshSize, which needlessly re-rasterizes custom Tile proxies.
  renderFlags.set(document.documentName === 'Tile' && operation === 'move' ? {refreshPosition:true} : flags);
  if (document.documentName === 'AmbientLight') object.initializeLightSource();
  else if (document.documentName === 'AmbientSound') object.initializeSoundSource();
}

function captureDisplayTransform(display) {
  const {position, scale, pivot, skew, rotation} = display;
  return {position:{x:position.x,y:position.y},scale:{x:scale.x,y:scale.y},
    pivot:{x:pivot.x,y:pivot.y},skew:{x:skew.x,y:skew.y},rotation};
}

function restoreDisplayTransform(display, original) {
  // Matrix decomposition may represent a negative scale as positive scale plus
  // PI skew. Normal renderer synchronization subsequently sets scale directly;
  // retaining that equivalent skew would reflect the artwork a second time.
  // Preserve the actual components, including signed scale, across the handoff.
  for (const key of ['position','scale','pivot','skew']) display[key].set(original[key].x,original[key].y);
  display.rotation = original.rotation;
}

function tileSourceDisplacementInParent(document, parent) {
  const x = document?._source?.x ?? document?.x;
  const y = document?._source?.y ?? document?.y;
  if (x === document.x && y === document.y) return {x: 0, y: 0};
  const nativeParent = document.object?.mesh?.parent;
  if (!nativeParent) throw new Error(`Tile ${document.uuid} has no mounted native pose for its semantic preview.`);
  const stored = parent.toLocal(new PIXI.Point(x, y), nativeParent);
  const prepared = parent.toLocal(new PIXI.Point(document.x, document.y), nativeParent);
  return {x: stored.x - prepared.x, y: stored.y - prepared.y};
}

export function captureTilePreviewDisplay(document) {
  if (document?.documentName !== 'Tile') return null;
  const display = document?.object?.mesh || document?.object?.bg || null;
  if (!display || display.destroyed || !display.parent) return null;
  display.transform?.updateLocalTransform?.();
  return {
    display,
    parent: display.parent,
    originalTransform: captureDisplayTransform(display)
  };
}

export function capturePreservedTilePreviewDisplays(document) {
  if (document?.documentName !== 'Tile') return [];
  const tile = document.object;
  const mesh = tile?.mesh;
  const displays = Array.from(new Set(PRESERVED_TILE_PREVIEW_CONTAINER_KEYS
    .flatMap((key) => [tile?.[key], mesh?.[key]])
    .filter((display) => display && !display.destroyed && display.parent)));
  return displays.map((display) => {
    display.transform?.updateLocalTransform?.();
    return {
      display,
      key: PRESERVED_TILE_PREVIEW_CONTAINER_KEYS.find(key => tile?.[key] === display || mesh?.[key] === display),
      parent: display.parent,
      originalTransform: captureDisplayTransform(display),
      originalSourceDisplacement: tileSourceDisplacementInParent(document, display.parent)
    };
  });
}

function applyPreservedDisplayTransformPreview(record, { acceptReplacement = false } = {}) {
  for (const preview of record?.preservedDisplayPreviews || []) {
    const { display, parent, originalTransform } = preview;
    if (!display || display.destroyed || !parent || parent.destroyed || display.parent !== parent || !originalTransform) {
      // A persisted rollback can rebuild a mask before returning to the overlay.
      // That renderer's replacement already owns the restored document pose;
      // never overwrite it with the retired preview display's local matrix.
      const tile = record?.document?.object;
      const replacement = preview.key && (tile?.[preview.key] || tile?.mesh?.[preview.key]);
      if (acceptReplacement && replacement && replacement !== display && !replacement.destroyed && replacement.parent) continue;
      throw new Error(
        `Semantic Tile ${record?.document?.uuid || record?.document?.id || 'unknown'} lost a custom preview display.`
      );
    }
    // Building geometry is authored in Tile-local pixels. The normal custom
    // overhead sync counter-scales that geometry after refreshTransform so a
    // persisted Tile resize does not stretch stale content. During a live
    // Scene Group preview the mesh transform is the intended affine preview,
    // while authoritative scaled geometry is committed only on mouse-up.
    // Preserve the pre-drag local matrix so Wall, composite portal/frame, and
    // fill participants all follow the same native mesh transform while held.
    restoreDisplayTransform(display, originalTransform);
    // The preserved local matrix already contains the original renderer's
    // stored-position correction. Replace that correction for this preview's
    // native mesh pose; otherwise clamping leaves held artwork stationary.
    const displacement = tileSourceDisplacementInParent(record.document, parent);
    display.position.x += displacement.x - preview.originalSourceDisplacement.x;
    display.position.y += displacement.y - preview.originalSourceDisplacement.y;
  }
}

export function syncMemberSemanticPreview(record, { acceptReplacement = false } = {}) {
  const document = record?.document;
  if (document?.documentName !== 'Tile' || document.viewed === false) return;
  const flags = document?._source?.flags?.['fa-nexus'] || null;
  if (flags?.assetScatter) {
    applyAssetScatterTransformPreview(document.object, {
      scaleX: Number(document.width) / Number(record.originalTileSize?.width),
      scaleY: Number(document.height) / Number(record.originalTileSize?.height)
    });
  }
  if (flags?.maskedTiling) {
    syncMaskedTilingTransformPreview(document.object, flags.maskedTiling, {
      geometryCompensationX: Number(record.originalTileSize?.width) / Number(document.width),
      geometryCompensationY: Number(record.originalTileSize?.height) / Number(document.height)
    });
  }
  if (flags?.flattened) {
    syncFlattenedNativeTransformPreview(record.originalTileDocument, document.object, {
      documentPoseApplied: true
    });
  } else if (flags?.standardTileMask) {
    syncStandardMaskNativeTransformPreview(document.object);
  }
  applyPreservedDisplayTransformPreview(record, { acceptReplacement });
}

export function beginMemberSemanticPreview(record) {
  const document = record?.document;
  // Off-Level members still receive the common document transform. Foundry
  // mounts their artwork only when that Level is viewed, so there is no local
  // display to mark or synchronize during this gesture.
  if (document?.documentName !== 'Tile' || document.viewed === false) return;
  document.object[DISPLAY_TRANSFORM_PREVIEW_SLOT] = true;
  for (const { display } of record.preservedDisplayPreviews || []) {
    display[DISPLAY_TRANSFORM_PREVIEW_SLOT] = true;
  }
  const flags = record?.original?.['flags.fa-nexus'] || {};
  if (!flags.pathV2 && !flags.pathsV2) return;
  const tile = document.object;
  if (!tile) return;
  tile[PATH_SCENE_GROUP_PREVIEW_SLOT] = {
    width: Number(record?.originalTileSize?.width),
    height: Number(record?.originalTileSize?.height)
  };
}

export function clearMemberSemanticPreview(record, {
  sync = true,
  preservePathPreview = false,
  preserveDisplayPreview = false
} = {}) {
  if (record?.document?.documentName !== 'Tile') return;
  // The authoritative update must be allowed to rebuild masks at commit time,
  // even while the old display matrix remains held until that update arrives.
  if (record.document.object) delete record.document.object[DISPLAY_TRANSFORM_PREVIEW_SLOT];
  if (!preserveDisplayPreview) {
    for (const { display } of record.preservedDisplayPreviews || []) {
      delete display[DISPLAY_TRANSFORM_PREVIEW_SLOT];
    }
  }
  if (!preservePathPreview && record.document.object) {
    delete record.document.object[PATH_SCENE_GROUP_PREVIEW_SLOT];
  }
  clearAssetScatterTransformPreview(record.document.object, { sync });
}

export function restoreTilePreviewDisplay(record) {
  const preview = record?.displayPreview;
  if (!preview) return false;
  const { display, parent, originalTransform } = preview;
  if (!display || display.destroyed || !parent || parent.destroyed || display.parent !== parent || !originalTransform) {
    throw new Error(`Tile ${record?.document?.uuid || record?.document?.id || 'unknown'} lost its original preview display.`);
  }
  restoreDisplayTransform(display, originalTransform);
  return true;
}

