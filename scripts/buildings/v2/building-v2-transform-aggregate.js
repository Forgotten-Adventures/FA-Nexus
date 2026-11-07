import {
  validateBuildingV2OpeningProjection,
  validateBuildingV2DoorWall,
  validateBuildingV2WindowWall,
  materializeBuildingV2DoorWall
} from './building-v2-opening-runtime.js';
import { deriveBuildingV2SpatialPose, createBuildingV2SpatialTransform, roundBuildingV2NativeCoordinate } from './building-v2-spatial-transform.js';
import { transformBuildingV2SeamlessSurface } from './building-v2-seamless.js';
import { materializeBuildingV2DoorShadowForChord } from './building-v2-door-shadow.js';
import { materializeBuildingV2SurfaceRegionShapes } from './building-v2-surface-region-runtime.js';
import {
  materializeBuildingV2WindowSills,
  materializeBuildingV2WindowWall
} from './building-v2-window.js';
import {
  compileBuildingV2FillMaskSource,
  representativeBuildingV2Fill,
  materializeBuildingV2FillMask,
  projectBuildingV2FillMaskToManagedTile,
  validateBuildingV2FillMaskSource
} from './building-v2-fill-mask-runtime.js';

const MODULE_ID = 'fa-nexus';
const BUILDING_SILLS_SOURCE = 'building-v2-window-sills';
const BUILDING_SILLS_FLAG_KEYS = Object.freeze([
  'version', 'source', 'wallTileId', 'buildingId', 'partsKey', 'parts'
]);

export const BUILDING_V2_SCENE_COLLECTION_KEYS = Object.freeze({
  Tile: 'tiles',
  Wall: 'walls',
  Region: 'regions',
  AmbientLight: 'lights',
  AmbientSound: 'sounds'
});

function readFaNexusFlag(document, key) {
  const direct = document?.getFlag?.(MODULE_ID, key);
  if (direct !== undefined) return direct;
  return document?._source?.flags?.[MODULE_ID]?.[key]
    ?? document?.flags?.[MODULE_ID]?.[key]
    ?? null;
}

function sceneDocumentById(scene, documentName, documentId) {
  const collectionKey = BUILDING_V2_SCENE_COLLECTION_KEYS[documentName];
  const collection = collectionKey ? scene?.[collectionKey] : null;
  if (!collection) return null;
  return collection.get?.(documentId)
    || Array.from(collection).find((entry) => String(entry?.id || '') === documentId)
    || null;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function fingerprint(value) {
  const input = JSON.stringify(canonicalize(value));
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function readCompositionRegistry(scene) {
  return scene?.getFlag?.(MODULE_ID, 'compositionRegistry')
    ?? scene?._source?.flags?.[MODULE_ID]?.compositionRegistry
    ?? scene?.flags?.[MODULE_ID]?.compositionRegistry
    ?? null;
}

export function collectBuildingV2SceneDocuments(scene) {
  return Object.values(BUILDING_V2_SCENE_COLLECTION_KEYS)
    .flatMap((collectionKey) => Array.from(scene?.[collectionKey] || []));
}

export function readBuildingV2TransformManifest(root, building = readFaNexusFlag(root, 'building')) {
  if (![4, 5].includes(Number(building?.schemaVersion))) return null;
  const scene = root?.parent;
  const sceneId = String(scene?.id || '').trim();
  const rootTileId = String(root?.id || '').trim();
  const rootUuid = String(root?.uuid || '').trim();
  const buildingId = String(building?.buildingId || '').trim();
  const generationId = String(building?.runtime?.generationId || '').trim();
  const exactRootUuid = `Scene.${sceneId}.Tile.${rootTileId}`;
  if (!scene
    || !sceneId
    || !rootTileId
    || String(root?.documentName || root?.constructor?.documentName || '') !== 'Tile'
    || rootUuid !== exactRootUuid
    || !buildingId
    || !generationId) {
    throw new Error('Building Editor V2 transform requires exact Root, Building, and generation identities.');
  }

  const expectedSource = building?.runtime?.expectedGeneratedDocuments;
  if (!Array.isArray(expectedSource)) {
    throw new Error('Building Editor V2 transform requires an exact generated-document manifest.');
  }
  const expectedUuids = new Set();
  let fillCount = 0;
  let regionCount = 0;
  let sillCount = 0;
  const expected = expectedSource.map((entry) => {
    const documentName = String(entry?.documentName || '').trim();
    const documentId = String(entry?.documentId || '').trim();
    const role = String(entry?.role || '').trim();
    const fragmentOrdinal = Number(entry?.fragmentOrdinal);
    const isWall = documentName === 'Wall' && role === 'wall';
    const isFill = documentName === 'Tile' && role === 'fill';
    const isRegion = documentName === 'Region' && role === 'surface-region';
    const isSill = documentName === 'Tile' && role === 'sill';
    const semanticId = isFill || isRegion || isSill ? null : String(entry?.semanticId || '').trim();
    if (!BUILDING_V2_SCENE_COLLECTION_KEYS[documentName]
      || !documentId
      || !role
      || !Number.isInteger(fragmentOrdinal)
      || fragmentOrdinal < 0) {
      throw new Error('Building Editor V2 transform found an invalid generated-document manifest entry.');
    }
    if (isWall && !semanticId) {
      throw new Error('Building Editor V2 transform found an invalid generated Wall manifest entry.');
    }
    if (isFill) {
      if (entry?.semanticId !== null || fragmentOrdinal !== 0 || ++fillCount !== 1) {
        throw new Error('Building Editor V2 transform found an invalid managed Fill manifest entry.');
      }
    } else if (isRegion) {
      if (entry?.semanticId !== null || fragmentOrdinal !== 0 || ++regionCount !== 1) {
        throw new Error('Building Editor V2 transform found an invalid Surface Region manifest entry.');
      }
    } else if (isSill) {
      if (entry?.semanticId !== null || fragmentOrdinal !== 0 || ++sillCount !== 1) {
        throw new Error('Building Editor V2 transform found an invalid managed Sills manifest entry.');
      }
    } else if (role === 'sill') {
      throw new Error('Building Editor V2 transform found an invalid managed Sills manifest entry.');
    } else if (!semanticId) {
      throw new Error('Building Editor V2 transform found an invalid generated-document manifest entry.');
    }
    const dependentUuid = `Scene.${sceneId}.${documentName}.${documentId}`;
    if (expectedUuids.has(dependentUuid)) {
      throw new Error(`Building Editor V2 transform found duplicate generated identity ${dependentUuid}.`);
    }
    expectedUuids.add(dependentUuid);
    return { documentName, documentId, role, semanticId, fragmentOrdinal, dependentUuid };
  });
  return {
    scene,
    sceneId,
    rootTileId,
    rootUuid,
    buildingId,
    generationId,
    expected,
    expectedUuids,
    building
  };
}

export function validateBuildingV2TransformAggregate(manifest, {
  registry,
  expectedDocuments,
  sceneDocuments
}) {
  if (!manifest) return [];
  if (!Array.isArray(expectedDocuments) || expectedDocuments.length !== manifest.expected.length) {
    throw new Error('Building Editor V2 transform is missing exact generated documents.');
  }

  for (let index = 0; index < manifest.expected.length; index += 1) {
    const expected = manifest.expected[index];
    const dependent = expectedDocuments[index];
    if (!dependent || String(dependent.uuid || '') !== expected.dependentUuid) {
      throw new Error(`Building Editor V2 transform is missing exact generated document ${expected.dependentUuid}.`);
    }
    if (String(dependent.documentName || dependent.constructor?.documentName || '') !== expected.documentName) {
      throw new Error(`Building Editor V2 transform found a mismatched document type for ${expected.dependentUuid}.`);
    }
    const owner = readFaNexusFlag(dependent, 'buildingGenerated') || {};
    if (String(owner.buildingId || '') !== manifest.buildingId
      || String(owner.rootTileId || '') !== manifest.rootTileId
      || String(owner.generationId || '') !== manifest.generationId
      || String(owner.role || '') !== expected.role
      || (expected.semanticId === null
        ? owner.semanticId !== null
        : String(owner.semanticId || '') !== expected.semanticId)
      || Number(owner.fragmentOrdinal) !== expected.fragmentOrdinal) {
      throw new Error(`Building Editor V2 transform found mismatched generated ownership on ${expected.dependentUuid}.`);
    }
    if (expected.documentName === 'Tile' && expected.role === 'fill') {
      const fill = readFaNexusFlag(dependent, 'buildingFill') || {};
      if (String(fill.wallTileId || '') !== manifest.rootTileId) {
        throw new Error(`Building Editor V2 transform found a Fill Tile without its exact Root identity ${expected.dependentUuid}.`);
      }
    }
    if (expected.documentName === 'Region' && expected.role === 'surface-region') {
      const region = readFaNexusFlag(dependent, 'buildingRegion') || {};
      if (String(region.wallTileId || '') !== manifest.rootTileId
        || String(region.wallGroupId || '') !== manifest.buildingId) {
        throw new Error(`Building Editor V2 transform found a Surface Region without its exact Root identity ${expected.dependentUuid}.`);
      }
    }
    if (expected.documentName === 'Tile' && expected.role === 'sill') {
      const sills = readFaNexusFlag(dependent, 'buildingSills');
      const source = dependent?._source || dependent || {};
      const rootDocument = sceneDocumentById(manifest.scene, 'Tile', manifest.rootTileId);
      const rootSource = rootDocument?._source || rootDocument || {};
      const poseMatchesRoot = [
        ['x'], ['y'], ['width'], ['height'], ['rotation'],
        ['texture', 'anchorX'], ['texture', 'anchorY']
      ].every((path) => {
        const read = (value) => path.reduce((current, key) => current?.[key], value);
        const actual = Number(read(source));
        const rootValue = Number(read(rootSource));
        return Number.isFinite(actual) && Number.isFinite(rootValue) && actual === rootValue;
      });
      if (!sills
        || Object.keys(sills).sort().join('|') !== [...BUILDING_SILLS_FLAG_KEYS].sort().join('|')
        || Number(sills.version) !== 1
        || sills.source !== BUILDING_SILLS_SOURCE
        || String(sills.wallTileId || '') !== manifest.rootTileId
        || String(sills.buildingId || '') !== manifest.buildingId
        || !Array.isArray(sills.parts)
        || !sills.parts.length
        || sills.partsKey !== fingerprint(sills.parts)
        || !poseMatchesRoot) {
        throw new Error(`Building Editor V2 transform found a managed Sills Tile without its exact Root backlink and pose ${expected.dependentUuid}.`);
      }
    }
  }

  const ownedRelationships = (Array.isArray(registry?.relationships) ? registry.relationships : []).filter((entry) => (
    String(entry?.type || '') === 'generated-by'
    && String(entry?.generator || '') === 'building'
    && String(entry?.ownerUuid || '') === manifest.rootUuid
  ));
  const relationshipDependents = ownedRelationships.map((entry) => String(entry?.dependentUuid || '').trim());
  if (ownedRelationships.length !== manifest.expectedUuids.size
    || new Set(relationshipDependents).size !== manifest.expectedUuids.size
    || relationshipDependents.some((uuid) => !manifest.expectedUuids.has(uuid))) {
    throw new Error('Building Editor V2 transform requires one exact generated-by relationship per generated document.');
  }

  const actualOwnedUuids = new Set();
  for (const candidate of sceneDocuments || []) {
    const owner = readFaNexusFlag(candidate, 'buildingGenerated');
    if (!owner
      || String(owner.buildingId || '') !== manifest.buildingId
      || String(owner.rootTileId || '') !== manifest.rootTileId) continue;
    actualOwnedUuids.add(String(candidate.uuid || '').trim());
  }
  if (actualOwnedUuids.size !== manifest.expectedUuids.size
    || [...actualOwnedUuids].some((uuid) => !manifest.expectedUuids.has(uuid))) {
    throw new Error('Building Editor V2 transform found generated ownership outside the exact runtime manifest.');
  }
  return expectedDocuments;
}

export function collectBuildingV2SceneTransformDependents(root, building) {
  const manifest = readBuildingV2TransformManifest(root, building);
  if (!manifest) return [];
  const expectedDocuments = manifest.expected.map((entry) => (
    sceneDocumentById(manifest.scene, entry.documentName, entry.documentId)
  ));
  const registry = readCompositionRegistry(manifest.scene);
  return validateBuildingV2TransformAggregate(manifest, {
    registry,
    expectedDocuments,
    sceneDocuments: collectBuildingV2SceneDocuments(manifest.scene)
  });
}

export function buildBuildingV2GeneratedTransformTargets(root, rootTarget, expectedDocuments, { targetSceneGridSize = null } = {}) {
  const manifest = readBuildingV2TransformManifest(root);
  if (!manifest) return new Map();
  // Validate the existing native aggregate in its source Scene, then materialize
  // destination-grid artwork/geometry for cross-Scene copy or Prefab placement.
  const outputGridSize = targetSceneGridSize ?? Number(manifest.scene?.grid?.size);
  if (!Array.isArray(expectedDocuments) || expectedDocuments.length !== manifest.expected.length) {
    throw new Error('Building Editor V2 transform target planning requires the exact generated aggregate.');
  }
  const rootSource = {
    ...(root?._source || root || {}),
    x: Number(rootTarget?.x),
    y: Number(rootTarget?.y),
    width: Number(rootTarget?.width),
    height: Number(rootTarget?.height),
    rotation: Number(rootTarget?.rotation),
    texture: {
      ...(root?._source?.texture || root?.texture || {}),
      scaleX: rootTarget?.["texture.scaleX"] ?? rootTarget?.texture?.scaleX ?? root.texture.scaleX ?? 1,
      scaleY: rootTarget?.["texture.scaleY"] ?? rootTarget?.texture?.scaleY ?? root.texture.scaleY ?? 1,
      anchorX: Number(rootTarget?.['texture.anchorX']
        ?? rootTarget?.texture?.anchorX
        ?? root?.texture?.anchorX
        ?? root?._source?.texture?.anchorX
        ?? 0.5),
      anchorY: Number(rootTarget?.['texture.anchorY']
        ?? rootTarget?.texture?.anchorY
        ?? root?.texture?.anchorY
        ?? root?._source?.texture?.anchorY
        ?? 0.5)
    }
  };
  const targetPose = deriveBuildingV2SpatialPose(rootSource, manifest.building);
  const transform = createBuildingV2SpatialTransform(targetPose);
  const reflected = targetPose.flipX !== targetPose.flipY;
  let currentPose = null;
  let currentTransform = null;
  const requiresWallProjection = manifest.expected.some((entry) => (
    entry.documentName === 'Wall' && ['wall', 'portal'].includes(entry.role)
  ));
  validateBuildingV2OpeningProjection(manifest.building);
  const projections = manifest.building?.runtime?.nativeWallProjection;
  if (requiresWallProjection && !Array.isArray(projections)) {
    throw new Error('Building Editor V2 transform requires exact local native-Wall projection data.');
  }
  const runtimeSills = manifest.building?.runtime?.sills ?? [];
  const expectsSills = manifest.expected.some((entry) => (
    entry.documentName === 'Tile' && entry.role === 'sill'
  ));
  if (!Array.isArray(runtimeSills)
    || (expectsSills && runtimeSills.length === 0)
    || (!expectsSills && runtimeSills.length > 0)) {
    throw new Error('Building Editor V2 transform requires exact Building-local managed Sills projection authority.');
  }
  // Scene Group Hide neutralizes a Wall's sense and Door fields and keeps the authored
  // values in the registry. Validate the configuration Show restores. A transform never
  // writes those fields, so a hidden Wall stays hidden while its Building moves.
  const hiddenWallStates = readCompositionRegistry(manifest.scene)?.wallVisibilityStates || {};
  const authoredWallSource = (document) => {
    const source = document?._source || document;
    const hidden = hiddenWallStates[String(document?.id ?? source?._id ?? '')];
    return hidden ? { ...source, ...hidden } : source;
  };
  const targets = new Map();
  for (let index = 0; index < manifest.expected.length; index += 1) {
    const expected = manifest.expected[index];
    const document = expectedDocuments[index];
    if (expected.documentName === 'Region' && expected.role === 'surface-region') {
      const regions = manifest.building?.runtime?.regions;
      if (!Array.isArray(regions) || regions.length !== 1) {
        throw new Error('Building Editor V2 transform requires one exact local Surface Region projection.');
      }
      targets.set(String(document?.uuid || ''), {
        shapes: materializeBuildingV2SurfaceRegionShapes(regions[0], {
          transform, sceneGridSize: outputGridSize
        })
      });
      continue;
    }
    if (expected.documentName === 'Tile' && expected.role === 'fill') {
      const fillProjection = manifest.building?.runtime?.fillProjection;
      const authoredFill = representativeBuildingV2Fill(manifest.building?.authoring?.fill || manifest.building?.fill);
      const sceneGridSize = outputGridSize;
      if (fillProjection?.active !== true
        || authoredFill?.active !== true
        || !String(authoredFill?.asset?.src || '').trim()
        || !(sceneGridSize > 0)) {
        throw new Error('Building Editor V2 transform requires exact managed Fill projection authority.');
      }
      const maskSource = validateBuildingV2FillMaskSource(fillProjection.maskSource);
      if (String(fillProjection.maskSourceFingerprint || '') !== maskSource.fingerprint) {
        throw new Error('Building Editor V2 transform found mismatched managed Fill projection authority.');
      }
      if (manifest.building?.authoring?.fill?.default
        && JSON.stringify(validateBuildingV2FillMaskSource(compileBuildingV2FillMaskSource(manifest.building.authoring))) !== JSON.stringify(maskSource)) {
        throw new Error('Building Editor V2 transform found mismatched composite Fill intent.');
      }
      const materialization = materializeBuildingV2FillMask(maskSource, { sceneGridSize });
      const sourceFlags = document?._source?.flags?.[MODULE_ID]
        || document?.flags?.[MODULE_ID]
        || {};
      const maskedTiling = {
        baseSrc: authoredFill.asset.src,
        textureScale: 1,
        textureRotation: 0,
        ...projectBuildingV2FillMaskToManagedTile({
          materialization,
          building: manifest.building,
          rootSource,
          textureBasis: authoredFill.textureBasis,
          appearance: authoredFill.appearance
        })
      };
      targets.set(String(document?.uuid || ''), {
        x: rootSource.x,
        y: rootSource.y,
        width: rootSource.width,
        height: rootSource.height,
        rotation: rootSource.rotation,
        'texture.anchorX': rootSource.texture.anchorX,
        'texture.anchorY': rootSource.texture.anchorY,
        'texture.scaleX': rootSource.texture.scaleX, 'texture.scaleY': rootSource.texture.scaleY,
        'flags.fa-nexus': {
          ...structuredClone(sourceFlags),
          maskedTiling
        }
      });
      continue;
    }
    if (expected.documentName === 'Tile' && expected.role === 'sill') {
      const source = document?._source || document || {};
      const sourceFlags = source?.flags?.[MODULE_ID]
        || document?.flags?.[MODULE_ID]
        || {};
      const elevation = Number(source?.elevation ?? document?.elevation);
      const sort = Number(source?.sort ?? document?.sort);
      const storedParts = sourceFlags.buildingSills?.parts;
      const storedElevation = Number(storedParts?.[0]?.elevation);
      const storedSort = Number(storedParts?.[0]?.sort);
      const currentParts = materializeBuildingV2WindowSills(runtimeSills, {
        rootSource: root?._source || root,
        building: manifest.building,
        elevation: storedElevation,
        sort: storedSort
      });
      if (JSON.stringify(canonicalize(storedParts))
        !== JSON.stringify(canonicalize(currentParts))) {
        throw new Error('Building Editor V2 transform found managed Sills parts outside their exact Building-local projection.');
      }
      const parts = materializeBuildingV2WindowSills(runtimeSills, {
        rootSource,
        building: manifest.building,
        elevation,
        sort
      });
      targets.set(String(document?.uuid || ''), {
        x: rootSource.x,
        y: rootSource.y,
        width: rootSource.width,
        height: rootSource.height,
        rotation: rootSource.rotation,
        'texture.anchorX': rootSource.texture.anchorX,
        'texture.anchorY': rootSource.texture.anchorY,
        'texture.scaleX': rootSource.texture.scaleX, 'texture.scaleY': rootSource.texture.scaleY,
        'flags.fa-nexus': {
          ...structuredClone(sourceFlags),
          buildingSills: {
            ...structuredClone(sourceFlags.buildingSills),
            partsKey: fingerprint(parts),
            parts
          }
        }
      });
      continue;
    }
    if (expected.documentName !== 'Wall' || !['wall', 'portal'].includes(expected.role)) {
      throw new Error(`Building Editor V2 cannot transform generated role ${expected.documentName}:${expected.role}.`);
    }
    const matches = projections.filter((entry) => (
      String(entry?.semanticWallId || '') === expected.semanticId
      && Number(entry?.fragmentOrdinal) === expected.fragmentOrdinal
    ));
    const endpoints = matches[0]?.localEndpoints;
    if (matches.length !== 1 || !Array.isArray(endpoints) || endpoints.length !== 2) {
      throw new Error(`Building Editor V2 transform is missing exact local Wall projection ${expected.semanticId}:${expected.fragmentOrdinal}.`);
    }
    const start = transform.localToWorld(endpoints[0]);
    const end = transform.localToWorld(endpoints[1]);
    const occupation = expected.role === 'portal'
      ? manifest.building.authoring?.portalsById?.[expected.semanticId]
      : null;
    let nativeDoor = null;
    let nativeWindow = null;
    if (expected.role === 'portal' && occupation?.kind === 'window') {
      currentPose ||= deriveBuildingV2SpatialPose(root?._source || root, manifest.building);
      currentTransform ||= createBuildingV2SpatialTransform(currentPose);
      const wallSource = authoredWallSource(document);
      const currentState = Number(wallSource?.ds);
      const liveProjection = structuredClone(matches[0]);
      if (liveProjection?.door) liveProjection.door.state = currentState;
      const currentEndpoints = endpoints.map((point) => currentTransform.localToWorld(point));
      validateBuildingV2WindowWall(occupation, liveProjection, wallSource, {
        scale: currentPose.scale, reflected: currentPose.flipX !== currentPose.flipY,
        sceneGridSize: Number(manifest.scene?.grid?.size),
        worldEndpoints: currentEndpoints
      });
      nativeWindow = materializeBuildingV2WindowWall(occupation.setup, {
        a: start,
        b: end,
        dir: matches[0]?.resolvedBehavior?.dir || 0,
        state: currentState, behavior: occupation.behavior,
        scale: targetPose.scale, reflected,
        sceneGridSize: outputGridSize
      });
    } else if (expected.role === 'portal' && ['door', 'seamlessSecretDoor'].includes(occupation?.kind)) {
      currentPose ||= deriveBuildingV2SpatialPose(root?._source || root, manifest.building);
      validateBuildingV2DoorWall(occupation, matches[0], authoredWallSource(document), { scale: currentPose.scale, reflected: currentPose.flipX !== currentPose.flipY,
        sceneGridSize: Number(manifest.scene?.grid?.size) });
      nativeDoor = materializeBuildingV2DoorWall(matches[0].door, { a: start, b: end, dir: matches[0].resolvedBehavior?.dir || 0, scale: targetPose.scale, reflected, sceneGridSize: outputGridSize });
    } else if (expected.role === 'portal') {
      throw new Error('Building V2 transform requires an exact supported Door or Window Portal occupation.');
    } else if (matches[0]?.portalId) {
      throw new Error('Building V2 Door transform requires the exact Portal role.');
    }
    const nativeDoorShadow = ['door', 'seamlessSecretDoor'].includes(occupation?.kind) && matches[0].door?.shadow
      ? materializeBuildingV2DoorShadowForChord(matches[0].door.shadow, {
          sourceA: endpoints[0], sourceB: endpoints[1], targetA: start, targetB: end, scale: targetPose.scale, reflected
        }) : null;
    targets.set(String(document?.uuid || ''), {
      ...(occupation?.kind === 'seamlessSecretDoor' ? { 'flags.fa-nexus.buildingSeamlessSecretDoor': {
        gapId: occupation.id, surfacePlan: transformBuildingV2SeamlessSurface(matches[0].door.surfacePlan, {
          a: start, b: end, scale: targetPose.scale, reflected })
      } } : {}),
      dir: (nativeDoor || nativeWindow)?.dir ?? (reflected && matches[0].resolvedBehavior?.dir ? 3 - matches[0].resolvedBehavior.dir : matches[0].resolvedBehavior?.dir ?? 0),
      ...((nativeDoor || nativeWindow)?.animation ? {animation: (nativeDoor || nativeWindow).animation} : {}),
      ...(nativeDoor || nativeWindow ? {
        'flags.fa-nexus.buildingGenerated.textureFlip': (nativeDoor || nativeWindow).textureFlip,
        'flags.core.textureGridSize': (nativeDoor || nativeWindow).textureGridSize
      } : {}),
      ...(nativeDoorShadow ? {
        'flags.fa-nexus.doorShadow': {
          enabled: nativeDoorShadow.enabled, alpha: nativeDoorShadow.alpha, blur: nativeDoorShadow.blur,
          dilation: nativeDoorShadow.dilation, offset: nativeDoorShadow.offset
        },
        'flags.fa-nexus.buildingGenerated.doorShadowNormal': nativeDoorShadow.normal
      } : {}),
      c: nativeDoor?.c || nativeWindow?.c || [
        roundBuildingV2NativeCoordinate(start.x), roundBuildingV2NativeCoordinate(start.y),
        roundBuildingV2NativeCoordinate(end.x), roundBuildingV2NativeCoordinate(end.y)
      ]
    });
  }
  return targets;
}
