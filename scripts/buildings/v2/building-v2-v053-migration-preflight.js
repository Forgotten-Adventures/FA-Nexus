const MODULE_ID = 'fa-nexus';

export const BUILDING_V053_EXPECTED_PROVENANCE = Object.freeze({
  premiumArtifactVersion: '0.0.111',
  premiumArtifactSha256: 'b6ef68ec0baf1e272f2cab7174f90f22b5b38078be411d85a432fd0e278dee35',
  publicModuleVersion: '0.5.3',
  publicRuntimeCommit: '420e4638bc387f393b8b355d7c5dc14d1e961d42'
});

const PORTAL_TILE_FLAGS = Object.freeze([
  'buildingDoorFrame',
  'buildingWindowSill',
  'buildingWindowWindow',
  'buildingWindowFrame'
]);

function clone(value) {
  if (value === undefined) return undefined;
  return globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}

function sourceOf(document) {
  // Prepared Tile tint and Region colors are boxed values, and positions can
  // be clamped. Capture the durable document source for every migration owner.
  return clone(document?.toObject?.() || document?._source || document || {});
}
function idOf(document) { return String(document?.id || document?._id || '').trim(); }
function readFlag(document, key) {
  try {
    const result = document?.getFlag?.(MODULE_ID, key);
    if (result !== undefined) return result;
  } catch (_) { /* Read-only capture tolerates non-Foundry test doubles. */ }
  return document?.flags?.[MODULE_ID]?.[key] ?? document?._source?.flags?.[MODULE_ID]?.[key];
}
function get(collection, id) {
  return collection?.get?.(id) || Array.from(collection || []).find((entry) => idOf(entry) === id) || null;
}
function values(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  return Array.from(collection);
}
function ids(value) {
  return [...new Set((Array.isArray(value) ? value : [value]).flat(Infinity)
    .map((entry) => String(entry || '').trim()).filter(Boolean))];
}
function intersects(valuesToCheck, accepted) {
  return ids(valuesToCheck).some((value) => accepted.has(value));
}
function finitePoint(point) {
  return Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y));
}
function orientation(a, b, c) {
  const value = ((Number(b.y) - Number(a.y)) * (Number(c.x) - Number(b.x)))
    - ((Number(b.x) - Number(a.x)) * (Number(c.y) - Number(b.y)));
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}
function onSegment(a, b, c) {
  return Number(b.x) <= Math.max(Number(a.x), Number(c.x)) + 1e-9
    && Number(b.x) >= Math.min(Number(a.x), Number(c.x)) - 1e-9
    && Number(b.y) <= Math.max(Number(a.y), Number(c.y)) + 1e-9
    && Number(b.y) >= Math.min(Number(a.y), Number(c.y)) - 1e-9;
}
function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return (o1 !== o2 && o3 !== o4)
    || (o1 === 0 && onSegment(a, c, b))
    || (o2 === 0 && onSegment(a, d, b))
    || (o3 === 0 && onSegment(c, a, d))
    || (o4 === 0 && onSegment(c, b, d));
}
function edgePairs(points, closed = true) {
  const count = closed ? points.length : points.length - 1;
  return Array.from({ length: Math.max(0, count) }, (_, index) => [points[index], points[(index + 1) % points.length], index]);
}
function selfIntersects(points, closed = true) {
  const edges = edgePairs(points, closed);
  for (let left = 0; left < edges.length; left += 1) {
    for (let right = left + 1; right < edges.length; right += 1) {
      const adjacent = Math.abs(edges[left][2] - edges[right][2]) === 1
        || (closed && left === 0 && right === edges.length - 1);
      if (!adjacent && segmentsIntersect(edges[left][0], edges[left][1], edges[right][0], edges[right][1])) return true;
    }
  }
  return false;
}
function ringsIntersect(left, right) {
  return edgePairs(left).some(([a, b]) => edgePairs(right).some(([c, d]) => segmentsIntersect(a, b, c, d)));
}
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, prior = polygon.length - 1; index < polygon.length; prior = index, index += 1) {
    const a = polygon[index];
    const b = polygon[prior];
    if (((Number(a.y) > Number(point.y)) !== (Number(b.y) > Number(point.y)))
      && Number(point.x) < ((Number(b.x) - Number(a.x)) * (Number(point.y) - Number(a.y)) / (Number(b.y) - Number(a.y))) + Number(a.x)) inside = !inside;
  }
  return inside;
}
function geometryFacts(building) {
  const rawShapes = Array.isArray(building?.shapes) && building.shapes.length
    ? building.shapes
    : (building?.polygon ? [building.polygon] : []);
  const issues = [];
  if (!rawShapes.length) issues.push('No released semantic shape or polygon is present.');
  rawShapes.forEach((shape, shapeIndex) => {
    const inner = shape?.wallType === 'inner' || shape?.closed === false;
    const minimum = inner ? 2 : 3;
    if (!Array.isArray(shape?.outer) || shape.outer.length < minimum || !shape.outer.every(finitePoint)) {
      issues.push(`Shape ${shapeIndex} requires at least ${minimum} finite ordered points.`);
    } else if (selfIntersects(shape.outer, !inner)) {
      issues.push(`Shape ${shapeIndex} has self-intersecting semantic geometry.`);
    }
    for (const [holeIndex, hole] of (shape?.holes || []).entries()) {
      const holePoints = Array.isArray(hole?.points) ? hole.points : hole;
      if (!Array.isArray(holePoints) || holePoints.length < 3 || !holePoints.every(finitePoint)) {
        issues.push(`Shape ${shapeIndex} hole ${holeIndex} requires at least three finite ordered points.`);
      } else if (selfIntersects(holePoints)) {
        issues.push(`Shape ${shapeIndex} hole ${holeIndex} is self-intersecting.`);
      } else if (Array.isArray(shape?.outer) && shape.outer.length >= 3
        && (ringsIntersect(shape.outer, holePoints) || !pointInPolygon(holePoints[0], shape.outer))) {
        issues.push(`Shape ${shapeIndex} hole ${holeIndex} is not strictly contained by its exterior.`);
      }
    }
    const holes = Array.isArray(shape?.holes) ? shape.holes
      .map((hole) => (Array.isArray(hole?.points) ? hole.points : hole))
      .filter((hole) => Array.isArray(hole) && hole.length >= 3 && hole.every(finitePoint)) : [];
    for (let left = 0; left < holes.length; left += 1) {
      for (let right = left + 1; right < holes.length; right += 1) {
        if (ringsIntersect(holes[left], holes[right]) || pointInPolygon(holes[left][0], holes[right]) || pointInPolygon(holes[right][0], holes[left])) {
          issues.push(`Shape ${shapeIndex} holes ${left} and ${right} overlap.`);
        }
      }
    }
  });
  return { present: rawShapes.length > 0, valid: rawShapes.length > 0 && issues.length === 0, issues };
}
function foundryCenteredIntegerOriginMatches({ origin, position, dimension, anchor }) {
  const expected = position - (dimension * anchor);
  const delta = Math.abs(origin - expected);
  if (delta <= 1e-4) return true;
  return Math.abs(delta - 0.5) <= 1e-4
    && Math.abs(anchor - 0.5) <= 1e-4
    && Number.isInteger(origin)
    && Number.isInteger(position)
    && Number.isInteger(dimension)
    && Math.abs(dimension % 2) === 1;
}
function rootBoundsFacts(rootSource, building) {
  const width = Number(rootSource?.width);
  const height = Number(rootSource?.height);
  const x = Number(rootSource?.x);
  const y = Number(rootSource?.y);
  const anchorX = Number(rootSource?.texture?.anchorX ?? 0.5);
  const anchorY = Number(rootSource?.texture?.anchorY ?? 0.5);
  const world = building?.meta?.world;
  const issues = [];
  if (![width, height, x, y, anchorX, anchorY].every(Number.isFinite) || width <= 0 || height <= 0) {
    issues.push('Root pose requires finite x/y/anchor and positive width/height.');
    return { valid: false, issues };
  }
  if (world?.origin) {
    if (!Number.isFinite(Number(world.origin.x)) || !Number.isFinite(Number(world.origin.y))) {
      issues.push('meta.world.origin requires finite x/y coordinates.');
      return { valid: false, issues };
    }
    if (!foundryCenteredIntegerOriginMatches({ origin: Number(world.origin.x), position: x, dimension: width, anchor: anchorX })
      || !foundryCenteredIntegerOriginMatches({ origin: Number(world.origin.y), position: y, dimension: height, anchor: anchorY })) {
      issues.push('Root document bounds disagree with meta.world.origin.');
    }
  }
  if (world?.bounds) {
    const bounds = world.bounds;
    const numbers = [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, bounds.width, bounds.height].map(Number);
    if (!numbers.every(Number.isFinite)
      || Math.abs((numbers[2] - numbers[0]) - numbers[4]) > 1e-4
      || Math.abs((numbers[3] - numbers[1]) - numbers[5]) > 1e-4) {
      issues.push('meta.world.bounds is internally inconsistent.');
    } else if (world.origin) {
      const localMinX = numbers[0] - Number(world.origin.x);
      const localMinY = numbers[1] - Number(world.origin.y);
      const localMaxX = numbers[2] - Number(world.origin.x);
      const localMaxY = numbers[3] - Number(world.origin.y);
      if (localMinX < -1e-4 || localMinY < -1e-4 || localMaxX > width + 1e-4 || localMaxY > height + 1e-4) {
        issues.push('meta.world.bounds lies outside the Root document bounds.');
      }
    }
  }
  return { valid: issues.length === 0, issues };
}
function sceneFlag(scene, key) {
  try {
    const value = scene?.getFlag?.(MODULE_ID, key);
    if (value !== undefined) return value;
  } catch (_) { /* Test doubles may not implement Foundry flag access. */ }
  return scene?.flags?.[MODULE_ID]?.[key] ?? scene?._source?.flags?.[MODULE_ID]?.[key];
}
function exactFact({ code, documentType, role, id = null, message, details = null }) {
  return { code, documentType, role, id, message, ...(details ? { details } : {}) };
}
function buildingMeta(document) { return readFlag(document, 'building')?.meta || {}; }
function ownerGroupIds(meta = {}, composite = null) {
  return ids([
    meta.wallGroupId, meta.wallGroupIds, meta.outerWallGroupIds, meta.innerWallGroupIds,
    meta.composite?.wallGroupId, meta.composite?.wallGroupIds,
    meta.composite?.outerWallGroupIds, meta.composite?.innerWallGroupIds,
    composite?.wallGroupId, composite?.wallGroupIds,
    composite?.outerWallGroupIds, composite?.innerWallGroupIds
  ]);
}
function wallCandidate(document, storedIds, tileIds, groupIds) {
  const id = idOf(document);
  const owner = clone(readFlag(document, 'buildingWall')) || null;
  const tileId = String(owner?.tileId || '').trim();
  const groupId = String(owner?.groupId || '').trim();
  const tileMatch = !!tileId && tileIds.has(tileId);
  const groupMatch = !!groupId && groupIds.has(groupId);
  const storedId = storedIds.has(id);
  if (!storedId && !tileMatch && !groupMatch) return null;
  return {
    id, storedId, tileMatch, groupMatch,
    ownerConflict: (!!tileId && !tileMatch) || (!!groupId && !groupMatch),
    owner,
    portal: {
      door: clone(readFlag(document, 'buildingDoor')) || null,
      window: clone(readFlag(document, 'buildingWindow')) || null
    },
    source: sourceOf(document)
  };
}
function tileCandidate(document, storedIds, tileIds, groupIds, gapIds) {
  const id = idOf(document);
  const flags = {
    building: clone(readFlag(document, 'building')) || null,
    buildingFill: clone(readFlag(document, 'buildingFill')) || null,
    buildingComposite: clone(readFlag(document, 'buildingComposite')) || null
  };
  for (const key of PORTAL_TILE_FLAGS) flags[key] = clone(readFlag(document, key)) || null;
  const owners = [flags.buildingFill, flags.buildingComposite, ...PORTAL_TILE_FLAGS.map((key) => flags[key])].filter(Boolean);
  const tileMatch = owners.some((owner) => intersects([owner.wallTileId, owner.parentWallTileId], tileIds));
  const groupMatch = owners.some((owner) => intersects([
    owner.wallGroupId, owner.parentWallGroupId, owner.wallGroupIds,
    owner.outerWallGroupIds, owner.innerWallGroupIds
  ], groupIds));
  const gapMatch = owners.some((owner) => gapIds.has(String(owner.gapId || '').trim()));
  const ownerConflict = owners.some((owner) => {
    const ownerTiles = ids([owner.wallTileId, owner.parentWallTileId]);
    const ownerGroups = ids([owner.wallGroupId, owner.parentWallGroupId, owner.wallGroupIds, owner.outerWallGroupIds, owner.innerWallGroupIds]);
    const ownerGap = String(owner.gapId || '').trim();
    return (ownerTiles.length > 0 && !intersects(ownerTiles, tileIds))
      || (ownerGroups.length > 0 && !intersects(ownerGroups, groupIds))
      || (!!ownerGap && !gapIds.has(ownerGap));
  });
  const storedId = storedIds.has(id);
  if (!storedId && !tileMatch && !groupMatch && !gapMatch) return null;
  return { id, storedId, tileMatch, groupMatch, gapMatch, ownerConflict, flags, source: sourceOf(document) };
}
function regionCandidate(document, storedIds, tileIds, groupIds) {
  const id = idOf(document);
  const owner = clone(readFlag(document, 'buildingRegion')) || null;
  const tileMatch = intersects(owner?.wallTileId, tileIds);
  const groupMatch = intersects(owner?.wallGroupId, groupIds);
  const ownerTiles = ids(owner?.wallTileId);
  const ownerGroups = ids(owner?.wallGroupId);
  const ownerConflict = (ownerTiles.length > 0 && !tileMatch) || (ownerGroups.length > 0 && !groupMatch);
  const storedId = storedIds.has(id);
  if (!storedId && !tileMatch && !groupMatch) return null;
  return { id, storedId, tileMatch, groupMatch, ownerConflict, owner, source: sourceOf(document) };
}
function fixtureClass(building, linked) {
  const tools = ids((building?.operations || []).map((operation) => operation?.tool || operation?.type)).sort();
  const shapes = Array.isArray(building?.shapes) ? building.shapes : [];
  const gapKinds = ids(linked.semanticGaps.map((entry) => entry.gap?.kind)).sort();
  const roles = ids(linked.tiles.flatMap((tile) => [
    tile.flags?.buildingFill ? 'fill' : null,
    tile.flags?.buildingComposite?.role,
    ...PORTAL_TILE_FLAGS.filter((key) => tile.flags?.[key]).map((key) => key)
  ])).sort();
  return {
    schema: Number(building?.schemaVersion ?? building?.version ?? NaN),
    editorVersion: String(building?.editorVersion || building?.meta?.editorVersion || building?.meta?.version || '').trim() || null,
    geometryTools: tools,
    outerShapeCount: shapes.filter((shape) => shape?.wallType !== 'inner' && shape?.closed !== false).length,
    innerShapeCount: shapes.filter((shape) => shape?.wallType === 'inner' || shape?.closed === false).length,
    linkedInnerRootCount: linked.innerRoots.length,
    fill: linked.fillIds.length > 0,
    region: linked.regionIds.length > 0,
    gapKinds,
    generatedTileRoles: roles
  };
}

/**
 * Captures exact stored references and exact released owner flags only. It does
 * not infer ownership by geometry/proximity, acquire a lease, mount a draft,
 * suppress committed rendering, or mutate a Foundry document.
 */
export function createBuildingV053MigrationPreflightCapture({ getCanvas = () => globalThis.canvas } = {}) {
  return function captureBuildingV053MigrationPreflight({ sceneId, rootTileId } = {}) {
    const scene = getCanvas()?.scene;
    const normalizedSceneId = String(sceneId || '').trim();
    const normalizedRootId = String(rootTileId || '').trim();
    const missing = [];
    const ambiguous = [];
    if (!scene || String(scene.id || '') !== normalizedSceneId || !normalizedRootId) {
      return freeze({ status: 'missing', code: 'building-v053-preflight-root-scene-missing', message: 'Building V2 migration preflight requires the active Scene and Root Tile.', expectedProvenance: BUILDING_V053_EXPECTED_PROVENANCE, observed: {}, facts: { missing, ambiguous } });
    }
    const root = get(scene.tiles, normalizedRootId);
    if (!root) {
      return freeze({ status: 'missing', code: 'building-v053-preflight-root-missing', message: `Building V2 migration preflight could not find Root Tile ${normalizedRootId}.`, expectedProvenance: BUILDING_V053_EXPECTED_PROVENANCE, observed: { sceneId: normalizedSceneId, rootTileId: normalizedRootId }, facts: { missing, ambiguous } });
    }
    const building = clone(readFlag(root, 'building'));
    const rootSource = sourceOf(root);
    if (!building || typeof building !== 'object') {
      return freeze({ status: 'missing', code: 'building-v053-preflight-building-missing', message: `Root Tile ${normalizedRootId} has no FA Nexus Building semantic flag.`, expectedProvenance: BUILDING_V053_EXPECTED_PROVENANCE, observed: { sceneId: normalizedSceneId, rootTileId: normalizedRootId, root: rootSource }, facts: { missing, ambiguous } });
    }

    const rootMeta = building.meta || {};
    const rootComposite = clone(readFlag(root, 'buildingComposite')) || null;
    const rootGroupIds = new Set(ownerGroupIds(rootMeta, rootComposite));
    const rootParentGroupIds = new Set(ids([
      rootMeta.wallGroupId, rootMeta.outerWallGroupIds,
      rootMeta.composite?.wallGroupId, rootMeta.composite?.outerWallGroupIds,
      rootComposite?.wallGroupId, rootComposite?.outerWallGroupIds
    ]));
    const rootUuid = String(root?.uuid || rootSource?.uuid || `Scene.${normalizedSceneId}.Tile.${normalizedRootId}`);
    const compositionRegistry = clone(sceneFlag(scene, 'compositionRegistry')) ?? null;
    const sceneModuleFlagsPresent = Object.prototype.hasOwnProperty.call(scene.flags || scene._source?.flags || {}, MODULE_ID);
    const sceneGroupIds = Object.values(compositionRegistry?.groups || {})
      .filter((group) => ids(group?.directMemberUuids).includes(rootUuid))
      .map((group) => String(group?.id || '').trim()).filter(Boolean).sort();
    if (sceneGroupIds.length) ambiguous.push(exactFact({
      code: 'scene-group-transform-history-ambiguous', documentType: 'Scene', role: 'composition', id: normalizedRootId,
      message: `Legacy Root Tile ${normalizedRootId} is a Scene Group member, so unsupported transform history cannot be excluded.`,
      details: { sceneGroupIds }
    }));
    const allTiles = values(scene.tiles);
    const innerParentConflicts = [];
    const innerRoots = allTiles.filter((tile) => {
      if (idOf(tile) === normalizedRootId) return false;
      const childBuilding = readFlag(tile, 'building');
      if (!childBuilding || typeof childBuilding !== 'object') return false;
      const meta = childBuilding.meta || {};
      const parentTileId = String(meta.parentWallTileId || '').trim();
      const parentGroupId = String(meta.parentWallGroupId || '').trim();
      const tileMatches = parentTileId === normalizedRootId;
      const groupMatches = rootParentGroupIds.has(parentGroupId);
      if (parentTileId && parentGroupId) {
        if (tileMatches !== groupMatches) innerParentConflicts.push({ tileId: idOf(tile), parentTileId, parentGroupId });
        return tileMatches && groupMatches;
      }
      if (parentTileId) return tileMatches;
      if (parentGroupId) return groupMatches;
      return intersects(meta.wallGroupId, new Set(ids(rootMeta.innerWallGroupIds)));
    }).sort((a, b) => idOf(a).localeCompare(idOf(b)));
    for (const conflict of innerParentConflicts) ambiguous.push(exactFact({
      code: 'linked-inner-parent-ambiguous', documentType: 'Tile', role: 'inner-wall-root', id: conflict.tileId,
      message: `Inner Wall Tile ${conflict.tileId} has conflicting exact parent Tile and parent Wall Group fields.`,
      details: { parentTileId: conflict.parentTileId, parentGroupId: conflict.parentGroupId }
    }));
    const expectedInnerGroups = ids(rootMeta.innerWallGroupIds);

    const tileIds = new Set([normalizedRootId, ...innerRoots.map(idOf)]);
    const groupIds = new Set([...rootGroupIds]);
    for (const inner of innerRoots) for (const groupId of ownerGroupIds(buildingMeta(inner), readFlag(inner, 'buildingComposite'))) groupIds.add(groupId);
    const linkedBuildingRoots = [
      { document: root, building, ownerTileId: normalizedRootId },
      ...innerRoots.map((document) => ({ document, building: clone(readFlag(document, 'building')), ownerTileId: idOf(document) }))
    ];
    const semanticGaps = linkedBuildingRoots.flatMap((entry) => (entry.building?.meta?.wallGaps || []).map((gap) => ({
      ownerTileId: entry.ownerTileId,
      ownerGroupIds: ownerGroupIds(entry.building?.meta, readFlag(entry.document, 'buildingComposite')),
      gap: clone(gap)
    })));
    const storedWallIds = new Set(ids([rootMeta.wallIds, ...innerRoots.map((tile) => buildingMeta(tile).wallIds)]));
    const storedFillIds = ids([rootMeta.fillTileId, rootMeta.backgroundTileId, rootMeta.composite?.backgroundTileId]);
    const storedSillIds = ids([rootMeta.sillTileId, rootMeta.composite?.sillTileId]);
    const storedTileIds = new Set([...storedFillIds, ...storedSillIds]);
    const storedRegionIds = ids(rootMeta.regionIds);
    const gapIds = new Set(ids(semanticGaps.map((entry) => entry.gap?.id)));

    const walls = values(scene.walls).map((document) => wallCandidate(document, storedWallIds, tileIds, groupIds))
      .filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const tiles = allTiles.map((document) => tileCandidate(document, storedTileIds, tileIds, groupIds, gapIds))
      .filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
    const regions = values(scene.regions).map((document) => regionCandidate(document, new Set(storedRegionIds), tileIds, groupIds))
      .filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));

    const wallById = new Map(walls.map((entry) => [entry.id, entry]));
    const exactOwnedWalls = walls.filter((entry) => (entry.tileMatch || entry.groupMatch) && !entry.ownerConflict);
    const staleStoredWallIds = [...storedWallIds].filter((id) => {
      const entry = wallById.get(id);
      return !entry || entry.ownerConflict || (!entry.tileMatch && !entry.groupMatch);
    });
    if (storedWallIds.size > 0 && exactOwnedWalls.length === 0) missing.push(exactFact({ code: 'linked-walls-missing', documentType: 'Wall', role: 'generated-wall', message: `No live Wall has exact owner flags for Root Tile ${normalizedRootId}.`, details: { storedIds: [...storedWallIds] } }));
    for (const groupId of expectedInnerGroups) {
      const childMatches = innerRoots.filter((tile) => String(buildingMeta(tile).wallGroupId || '').trim() === groupId);
      const sameRootWalls = exactOwnedWalls.filter((wall) => String(wall.owner?.tileId || '').trim() === normalizedRootId
        && String(wall.owner?.groupId || '').trim() === groupId);
      const sameRootComposite = sameRootWalls.length > 0 && sameRootWalls.every((wall) => {
          const index = Number(wall.owner?.loopRef?.shapeIndex);
          if (!Number.isInteger(index) || index < 0) return false;
          const shape = building.shapes?.[Number(index)];
          return !!shape && (shape.wallType === 'inner' || shape.closed === false);
        });
      const authorityCount = childMatches.length + (sameRootComposite ? 1 : 0);
      if (authorityCount === 0) missing.push(exactFact({
        code: 'linked-inner-wall-missing', documentType: 'Tile', role: 'inner-wall-root', id: groupId,
        message: `No exact composite Root group or linked Inner Wall Tile owns group ${groupId}.`
      }));
      if (authorityCount > 1) ambiguous.push(exactFact({
        code: 'linked-inner-wall-ambiguous', documentType: 'Tile', role: 'inner-wall-root', id: groupId,
        message: `More than one Inner Wall authority owns group ${groupId}.`,
        details: { childTileIds: childMatches.map(idOf), sameRootComposite }
      }));
    }

    const exactFillTiles = tiles.filter((entry) => entry.flags?.buildingFill && !entry.ownerConflict && (entry.tileMatch || entry.groupMatch));
    const exactSillTiles = tiles.filter((entry) => !entry.ownerConflict && (entry.tileMatch || entry.groupMatch || entry.gapMatch)
      && (entry.flags?.buildingComposite?.role === 'sill' || entry.flags?.buildingWindowSill));
    const validateTileRole = (storedIds, candidates, role) => {
      if (candidates.length > 1) {
        ambiguous.push(exactFact({ code: `linked-${role}-ambiguous`, documentType: 'Tile', role, message: `More than one exact ${role} Tile is owned by Root Tile ${normalizedRootId}.`, details: { candidateIds: candidates.map((entry) => entry.id) } }));
        return;
      }
      for (const id of storedIds) {
        if (candidates.some((entry) => entry.id === id)) continue;
        if (storedIds.length === 1 && candidates.length === 1) continue;
        const storedExists = !!get(scene.tiles, id);
        const fact = storedExists ? ambiguous : missing;
        fact.push(exactFact({
          code: storedExists ? `linked-${role}-owner-ambiguous` : `linked-${role}-missing`,
          documentType: 'Tile', role, id,
          message: storedExists
            ? `Stored ${role} Tile ${id} has no exact owner flag for Root Tile ${normalizedRootId}.`
            : `Stored ${role} Tile ${id} is missing and no unique exact owner replacement exists.`,
          details: { storedIds }
        }));
      }
    };
    validateTileRole(storedFillIds, exactFillTiles, 'fill');
    validateTileRole(storedSillIds, exactSillTiles, 'sill');

    const exactRegions = regions.filter((entry) => !entry.ownerConflict && (entry.tileMatch || entry.groupMatch));
    if (exactRegions.length > 1) {
      ambiguous.push(exactFact({ code: 'linked-region-ambiguous', documentType: 'Region', role: 'surface-region', message: `More than one exact Surface Region is owned by Root Tile ${normalizedRootId}.`, details: { candidateIds: exactRegions.map((entry) => entry.id) } }));
    } else {
      for (const id of storedRegionIds) {
        if (exactRegions.some((entry) => entry.id === id)) continue;
        if (storedRegionIds.length === 1 && exactRegions.length === 1) continue;
        const storedExists = !!get(scene.regions, id);
        const fact = storedExists ? ambiguous : missing;
        fact.push(exactFact({
          code: storedExists ? 'linked-region-owner-ambiguous' : 'linked-region-missing',
          documentType: 'Region', role: 'surface-region', id,
          message: storedExists
            ? `Stored Surface Region ${id} has no exact owner flag for Root Tile ${normalizedRootId}.`
            : `Stored Surface Region ${id} is missing and no unique exact owner replacement exists.`,
          details: { storedIds: storedRegionIds }
        }));
      }
    }

    const compositeDocuments = [...new Map([
      root, ...innerRoots, ...tiles.map((entry) => get(scene.tiles, entry.id)).filter(Boolean)
    ].map((document) => [idOf(document), document])).values()];
    const compositeParts = compositeDocuments.flatMap((tile) => {
      const composite = clone(readFlag(tile, 'buildingComposite'));
      return (composite?.parts || []).map((part) => ({ documentId: idOf(tile), role: composite.role || null, part }));
    });
    const semanticGapById = new Map(semanticGaps.map((entry) => [String(entry.gap?.id || '').trim(), entry]));
    const normalizeVisualEvidence = ({ documentId, documentRole = null, flagKey, payload, part = null }) => {
      const gapId = String(payload?.gapId || part?.gapId || '').trim();
      const semantic = semanticGapById.get(gapId) || null;
      const ownerTileIds = ids([payload?.wallTileId, part?.wallTileId]);
      const ownerGroupIds = ids([payload?.wallGroupId, part?.wallGroupId]);
      const expectedTileIds = new Set(semantic ? [semantic.ownerTileId] : []);
      const expectedGroupIds = new Set(semantic?.ownerGroupIds || []);
      const exactOwner = !!semantic
        && ownerTileIds.length > 0 && ownerTileIds.every((id) => expectedTileIds.has(id))
        && ownerGroupIds.length > 0 && ownerGroupIds.every((id) => expectedGroupIds.has(id));
      const compatibleRole = flagKey === 'buildingWindowSill'
        ? (documentRole === 'sill' || part?.role === 'sill')
        : (documentRole !== 'sill' && part?.role !== 'sill');
      const semanticKind = String(semantic?.gap?.kind || '').trim();
      // Released 0.0.111 serializes both Door frames and Window frames under
      // buildingDoorFrame. The other Window-specific outputs remain Window-only.
      const compatiblePortalKind = flagKey === 'buildingDoorFrame'
        ? (semanticKind === 'door' || (semanticKind === 'window' && !!semantic?.gap?.window?.frame))
        : semanticKind === 'window';
      return { documentId, documentRole, flagKey, gapId, exactOwner, compatibleRole, compatiblePortalKind, payload: clone(payload), part: clone(part) };
    };
    const visualEvidence = [];
    for (const entry of compositeParts) {
      const flagKey = PORTAL_TILE_FLAGS.includes(entry.part?.flagKey)
        ? entry.part.flagKey
        : PORTAL_TILE_FLAGS.find((key) => entry.part?.flags?.[key]);
      if (!flagKey) continue;
      visualEvidence.push(normalizeVisualEvidence({
        documentId: entry.documentId, documentRole: entry.role, flagKey,
        payload: entry.part?.flags?.[flagKey] || entry.part, part: entry.part
      }));
    }
    for (const tile of tiles) {
      for (const flagKey of PORTAL_TILE_FLAGS) {
        const payload = tile.flags?.[flagKey];
        if (!payload) continue;
        visualEvidence.push(normalizeVisualEvidence({
          documentId: tile.id, documentRole: tile.flags?.buildingComposite?.role || null,
          flagKey, payload
        }));
      }
    }
    for (const evidence of visualEvidence) {
      if (!evidence.gapId || !semanticGapById.has(evidence.gapId)) {
        ambiguous.push(exactFact({
          code: 'portal-visual-gap-ambiguous', documentType: 'Tile', role: evidence.flagKey,
          id: evidence.documentId,
          message: `${evidence.flagKey} output on Tile ${evidence.documentId} does not resolve an exact semantic Wall Occupation.`,
          details: { gapId: evidence.gapId }
        }));
      } else if (!evidence.exactOwner || !evidence.compatibleRole || !evidence.compatiblePortalKind) {
        ambiguous.push(exactFact({
          code: 'portal-visual-owner-ambiguous', documentType: 'Tile', role: evidence.flagKey,
          id: evidence.documentId,
          message: `${evidence.flagKey} output for ${evidence.gapId} has conflicting owner, composite-role, or Portal-kind fields.`,
          details: { exactOwner: evidence.exactOwner, compatibleRole: evidence.compatibleRole, compatiblePortalKind: evidence.compatiblePortalKind }
        }));
      }
    }
    const requireVisualOutput = (semantic, role, acceptedFlagKeys) => {
      const gapId = String(semantic.gap?.id || '').trim();
      const matches = visualEvidence.filter((entry) => entry.gapId === gapId
        && acceptedFlagKeys.includes(entry.flagKey) && entry.exactOwner && entry.compatibleRole && entry.compatiblePortalKind);
      const documentIds = [...new Set(matches.map((entry) => entry.documentId))];
      if (documentIds.length === 0) missing.push(exactFact({
        code: `portal-${role}-missing`, documentType: 'Tile', role, id: gapId,
        message: `No exact ${role} output is linked to Wall Occupation ${gapId}.`
      }));
      if (documentIds.length > 1) ambiguous.push(exactFact({
        code: `portal-${role}-ambiguous`, documentType: 'Tile', role, id: gapId,
        message: `More than one ${role} output is linked to Wall Occupation ${gapId}.`,
        details: { documentIds }
      }));
    };
    for (const semantic of semanticGaps) {
      const gap = semantic.gap;
      if (gap?.door?.frame || gap?.window?.frame) requireVisualOutput(semantic, 'frame', ['buildingDoorFrame', 'buildingWindowFrame']);
      if (gap?.window?.sill) requireVisualOutput(semantic, 'window-sill', ['buildingWindowSill']);
      if (gap?.window?.texture && gap.window.animated !== true) requireVisualOutput(semantic, 'static-window', ['buildingWindowWindow']);
    }
    for (const entry of semanticGaps) {
      const gap = entry.gap;
      const gapId = String(gap?.id || '').trim();
      if (!gapId || !['door', 'window'].includes(gap?.kind)) continue;
      const expectedGroups = new Set(entry.ownerGroupIds);
      const gapMatches = walls.filter((wall) => String(wall.portal?.door?.gapId || wall.portal?.window?.gapId || '').trim() === gapId);
      const conflictedMatches = gapMatches.filter((wall) => wall.ownerConflict && (wall.tileMatch || wall.groupMatch));
      const nativeMatches = gapMatches.filter((wall) => {
        if (wall.ownerConflict) return false;
        const ownerTileId = String(wall.owner?.tileId || '').trim();
        const ownerGroupId = String(wall.owner?.groupId || '').trim();
        return ownerTileId === entry.ownerTileId || expectedGroups.has(ownerGroupId);
      });
      if (conflictedMatches.length) ambiguous.push(exactFact({ code: 'native-portal-owner-ambiguous', documentType: 'Wall', role: `native-${gap.kind}`, id: gapId, message: `A native Portal Wall linked to ${gap.kind} ${gapId} has conflicting owner fields.`, details: { ownerTileId: entry.ownerTileId, candidateIds: conflictedMatches.map((candidate) => candidate.id) } }));
      else if (nativeMatches.length === 0) missing.push(exactFact({ code: 'native-portal-missing', documentType: 'Wall', role: `native-${gap.kind}`, id: gapId, message: `No exact native Portal Wall is linked to ${gap.kind} ${gapId} on Building Tile ${entry.ownerTileId}.`, details: { ownerTileId: entry.ownerTileId, ownerGroupIds: entry.ownerGroupIds } }));
      if (nativeMatches.length > 1) ambiguous.push(exactFact({ code: 'native-portal-ambiguous', documentType: 'Wall', role: `native-${gap.kind}`, id: gapId, message: `More than one native Portal Wall is linked to ${gap.kind} ${gapId} on Building Tile ${entry.ownerTileId}.`, details: { ownerTileId: entry.ownerTileId, candidateIds: nativeMatches.map((candidate) => candidate.id) } }));
    }

    const linked = {
      rootId: normalizedRootId,
      rootGroupIds: [...rootGroupIds].sort(),
      ownerTileIds: [...tileIds].sort(),
      ownerGroupIds: [...groupIds].sort(),
      wallIds: walls.map((entry) => entry.id),
      staleStoredWallIds,
      fillIds: storedFillIds,
      sillIds: storedSillIds,
      regionIds: storedRegionIds,
      innerRoots: innerRoots.map((document) => ({ id: idOf(document), source: sourceOf(document) })),
      semanticGaps, visualEvidence, walls, tiles, regions, compositeParts
    };
    const editorVersion = String(building.editorVersion || building.meta?.editorVersion || building.meta?.version || building.meta?.premiumArtifactVersion || building.provenance?.premiumArtifactVersion || '').trim() || null;
    const semanticGeometry = geometryFacts(building);
    const rootBounds = rootBoundsFacts(rootSource, building);
    const observed = {
      sceneId: normalizedSceneId,
      rootTileId: normalizedRootId,
      schemaVersion: Number(building.schemaVersion ?? building.version ?? NaN),
      editorVersion,
      currentFoundryVersion: String(globalThis.game?.version || globalThis.game?.release?.version || '').trim() || null,
      currentModuleVersion: String(globalThis.game?.modules?.get?.(MODULE_ID)?.version || '').trim() || null,
      sourceTimestamp: building.updatedAt ?? null,
      fixtureClass: fixtureClass(building, linked),
      fixtureCapabilities: {
        semanticGeometry: semanticGeometry.present,
        semanticGeometryValid: semanticGeometry.valid,
        semanticGeometryIssues: semanticGeometry.issues,
        rootBoundsConsistent: rootBounds.valid,
        rootBoundsIssues: rootBounds.issues,
        sceneGroupIds,
        rotated: Math.abs(Number(rootSource.rotation || 0)) > 1e-6,
        nonUnitScale: Number(rootSource.texture?.scaleX ?? rootSource.texture?.scale?.x ?? 1) !== 1 || Number(rootSource.texture?.scaleY ?? rootSource.texture?.scale?.y ?? 1) !== 1,
        storedWallIds: [...storedWallIds],
        staleStoredWallIds,
        storedFillIds, storedSillIds, storedRegionIds,
        exactOwnedWallCount: exactOwnedWalls.length,
        exactLinkedInnerRootCount: innerRoots.length
      }
    };
    return freeze({
      status: 'captured', code: 'building-v053-preflight-captured',
      message: `Captured immutable Building migration preflight for Root Tile ${normalizedRootId}.`,
      expectedProvenance: clone(BUILDING_V053_EXPECTED_PROVENANCE), observed,
      facts: { missing, ambiguous },
      aggregate: { root: rootSource, building, compositionRegistry, sceneModuleFlagsPresent, linked }
    });
  };
}
