import {deriveBuildingV2SpatialPose} from './building-v2-spatial-transform.js';
import {materializeBuildingV2DoorTextureGridSize} from './building-v2-door-appearance.js';
import {materializeBuildingV2WindowWall} from './building-v2-window.js';

const MODULE_ID = 'fa-nexus';

// Native DoorMesh sizing reads the current Scene grid. Keep that derived native
// flag in the same Scene update as the grid, without changing captured authoring
// or resetting document-owned gameplay state. This also covers inactive Levels.
export function projectBuildingV2PortalScalesForSceneGrid(scene, changes) {
  const sceneGridSize = Number(changes['grid.size'] ?? changes.grid?.size);
  if (!Number.isFinite(sceneGridSize) || sceneGridSize <= 0 || sceneGridSize === scene.grid.size) return;
  const wallChanges = new Map((changes.walls || []).map(change => [change._id, change]));
  let changed = false;
  const patchTextureGrid = (wall, textureGridSize) => {
    if (textureGridSize === wall.flags.core?.textureGridSize) return;
    const patch = wallChanges.get(wall.id) || {_id: wall.id};
    if (Object.hasOwn(patch, 'flags.core.textureGridSize')) patch['flags.core.textureGridSize'] = textureGridSize;
    else foundry.utils.setProperty(patch, 'flags.core.textureGridSize', textureGridSize);
    wallChanges.set(wall.id, patch);
    changed = true;
  };
  for (const root of scene.tiles) {
    const building = root.flags?.[MODULE_ID]?.building;
    if (![4, 5].includes(Number(building?.schemaVersion))) continue;
    const rootChange = changes.tiles?.find(change => change._id === root.id);
    const nextRoot = rootChange ? foundry.utils.mergeObject(root.toObject(), rootChange, {inplace: false}) : root.toObject();
    const scale = deriveBuildingV2SpatialPose(nextRoot, building).scale;
    // A Building without doors or windows stores no Portal list: nothing to project.
    for (const portal of Object.values(building.authoring.portalsById || {})) {
      // Released Doors without a captured basis intentionally remain relative
      // to the Scene grid. Seamless surfaces have their own compiled projection.
      if (portal.kind !== 'window' && !(portal.kind === 'door' && portal.setup.appearance.gridSize !== undefined)) continue;
      const entries = building.runtime.expectedGeneratedDocuments.filter(entry => entry.documentName === 'Wall'
        && entry.role === 'portal' && entry.semanticId === portal.id);
      const wall = entries.length === 1 ? scene.walls.get(entries[0].documentId) : null;
      const generated = wall?.flags?.[MODULE_ID]?.buildingGenerated;
      if (!wall || generated?.rootTileId !== root.id || generated.buildingId !== building.buildingId
        || generated.generationId !== building.runtime.generationId || generated.semanticId !== portal.id || generated.role !== 'portal') {
        throw new Error(`Cannot change Scene grid: Building ${root.id} Portal ${portal.id} has no exact owned native Wall.`);
      }
      const textureGridSize = portal.kind === 'door'
        ? materializeBuildingV2DoorTextureGridSize(portal.setup.appearance, scale, sceneGridSize)
        : materializeBuildingV2WindowWall(portal.setup, {a: {x: wall.c[0], y: wall.c[1]}, b: {x: wall.c[2], y: wall.c[3]},
          state: wall.ds, scale, sceneGridSize}).textureGridSize;
      patchTextureGrid(wall, textureGridSize);
    }
  }
  for (const wall of scene.walls) {
    const generated = wall.flags?.[MODULE_ID]?.buildingGenerated;
    if (generated?.version !== 1 || generated.role !== 'portal' || wall.flags[MODULE_ID].buildingSeamlessSecretDoor
      || !(generated.appearance?.gridSize > 0 || generated.windowSetup?.surface?.gridSize > 0)) continue;
    const owner = scene.tiles.get(generated.rootTileId);
    if (owner?.flags?.[MODULE_ID]?.flattened?.composition?.version !== 1) continue;
    const relationships = (scene.flags?.[MODULE_ID]?.compositionRegistry?.relationships || []).filter(relation =>
      relation.type === 'generated-by' && relation.generator === 'flatten' && relation.dependentUuid === wall.uuid);
    if (relationships.length !== 1 || relationships[0].ownerUuid !== owner.uuid
      || owner.flags[MODULE_ID].flattened.composition.ownerUuid !== owner.uuid) {
      throw new Error(`Cannot change Scene grid: flattened Portal ${wall.id} has no exact composition owner.`);
    }
    // Flatten's live native Wall projection carries its current world scale;
    // semantic authoring is archived in the WebP. Use the same native texture
    // scale rule as supported flattened-owner transforms, without copying or
    // rewriting that archive merely to change the Scene grid.
    const textureGridSize = Number(wall.flags.core?.textureGridSize);
    const nextOwner = changes.tiles?.find(change => change._id === owner.id);
    const scaleX = Number(nextOwner?.width ?? owner.width) / owner.width;
    const scaleY = Number(nextOwner?.height ?? owner.height) / owner.height;
    if (!Number.isFinite(textureGridSize) || textureGridSize <= 0 || !(scaleX > 0 && scaleY > 0)
      || Math.abs(scaleX - scaleY) > .5 / owner.width + .5 / owner.height + 1e-8) {
      throw new Error(`Cannot change Scene grid: flattened Portal ${wall.id} requires a valid texture basis and uniform owner scale.`);
    }
    patchTextureGrid(wall, textureGridSize * (sceneGridSize / scene.grid.size) / ((scaleX + scaleY) / 2));
  }
  if (changed) changes.walls = [...wallChanges.values()];
}
