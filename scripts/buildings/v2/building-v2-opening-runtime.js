// Public admission of compiler-produced Opening cuts. The premium authoring
// compiler owns carrier resolution; committed playback never imports it.
import { normalizeBuildingV2PortalTiming, normalizeBuildingV2PortalSound } from './building-v2-portal-options.js';
import { roundBuildingV2NativeCoordinate } from './building-v2-spatial-transform.js';
import { evaluateBuildingV2Conic } from './building-v2-curve-runtime.js';
import { normalizeBuildingV2DoorAppearance, materializeBuildingV2DoorTextureGridSize } from './building-v2-door-appearance.js';
import { deriveBuildingV2DoorShadow, materializeBuildingV2DoorShadow, normalizeBuildingV2DoorShadow } from './building-v2-door-shadow.js';
import { normalizeBuildingV2DoorFrame, compileBuildingV2DoorFrame } from './building-v2-door-frame.js';
import { transformBuildingV2SeamlessSurface, buildingV2SeamlessSurfacesEqual } from './building-v2-seamless.js';
import {
  compileBuildingV2WindowArtwork,
  materializeBuildingV2WindowWall,
  normalizeBuildingV2WindowSetup
} from './building-v2-window.js';
export { normalizeBuildingV2DoorAppearance } from './building-v2-door-appearance.js';
const EPSILON = 1e-7;
const PORTAL_CHORD_WIDTH_TOLERANCE = 1e-5;

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const sameDerivedDoorShadow = (left, right) => {
  const { normal: a, ...appearanceA } = normalizeBuildingV2DoorShadow(left);
  const { normal: b, ...appearanceB } = normalizeBuildingV2DoorShadow(right);
  return same(appearanceA, appearanceB) && Math.abs(a.x - b.x) <= EPSILON && Math.abs(a.y - b.y) <= EPSILON;
};
const FRAME_BOUNDS_GEOMETRY_KEYS = new Set(['minX', 'minY', 'maxX', 'maxY', 'width', 'height']);
const FRAME_ARTWORK_GEOMETRY_KEYS = new Set(['x', 'y', 'width', 'height', 'rotation']);

const isTolerantFrameGeometryPath = path => (path.length === 3 && Number.isInteger(path[0])
    && path[1] === 'bounds' && FRAME_BOUNDS_GEOMETRY_KEYS.has(path[2]))
  || (path.length === 4 && Number.isInteger(path[0]) && path[1] === 'artwork'
    && Number.isInteger(path[2]) && FRAME_ARTWORK_GEOMETRY_KEYS.has(path[3]));

const samePortalFrameArtwork = (actual, expected, path = []) => {
  if (isTolerantFrameGeometryPath(path) && typeof actual === 'number' && typeof expected === 'number') {
    return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= EPSILON;
  }
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== typeof expected || actual == null || expected == null) return false;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
      && Array.from({ length: actual.length }, (_, index) => index).every(index => Object.hasOwn(actual, index) === Object.hasOwn(expected, index)
        && samePortalFrameArtwork(actual[index], expected[index], [...path, index]));
  }
  if (typeof actual !== 'object') return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]
    && samePortalFrameArtwork(actual[key], expected[key], [...path, key]));
};

// Foundry v14 common/documents/wall.mjs owns these persisted native defaults.
// Native `flip` flips the texture vertically; it is not the authored Flip Hinge.
export const BUILDING_V2_DOOR_ANIMATION_TYPES = Object.freeze(['ascend', 'descend', 'slide', 'swing', 'swivel']);

export function normalizeBuildingV2DoorTextureFlip(textureFlip = {}) {
  if (!textureFlip || typeof textureFlip !== 'object' || Array.isArray(textureFlip)
    || Object.keys(textureFlip).some(key => !['horizontal', 'vertical'].includes(key) || typeof textureFlip[key] !== 'boolean')) {
    throw new Error('Building V2 Door texture flips require horizontal/vertical boolean intent.');
  }
  return { horizontal: textureFlip.horizontal === true, vertical: textureFlip.vertical === true };
}

export function materializeBuildingV2DoorAnimation(animation, textureFlip) {
  const flip = normalizeBuildingV2DoorTextureFlip(textureFlip);
  if (!animation || !BUILDING_V2_DOOR_ANIMATION_TYPES.includes(animation.type)
    || typeof animation.texture !== 'string' || !animation.texture.trim()
    || ![1, -1].includes(animation.direction) || typeof animation.directionFlip !== 'boolean'
    || typeof animation.double !== 'boolean'
    || Object.keys(animation).some(key => !['type', 'texture', 'direction', 'directionFlip', 'double', 'duration', 'strength'].includes(key))) {
    throw new Error('Building V2 Door requires supported Foundry v14 animation intent.');
  }
  return { direction: animation.direction, double: animation.double, ...normalizeBuildingV2PortalTiming(animation), flip: flip.vertical,
    texture: animation.texture, type: animation.type };
}

// The compiler's chord remains negative-carrier jamb -> positive-carrier jamb.
// Only this v14 adapter swaps native endpoints for Flip Hinge. Preserve one-way
// structural restrictions when changing the native Wall's endpoint orientation.
export function materializeBuildingV2DoorWall(door, { a, b, dir = 0, scale = 1, reflected = false, sceneGridSize } = {}) {
  const seamless = door?.type === 2 && door.portalKind === 'seamlessSecretDoor';
  if ((!seamless && door?.type !== 1) || ![a, b].every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    || ![0, 1, 2].includes(dir)) throw new Error('Building V2 Door requires an exact chord and native direction.');
  const textureFlip = normalizeBuildingV2DoorTextureFlip(door.textureFlip);
  if (reflected) { if (!seamless) textureFlip.vertical = !textureFlip.vertical; dir = dir ? 3 - dir : 0; }
  const animation = materializeBuildingV2DoorAnimation(door.animation, textureFlip);
  if (reflected) animation.direction *= -1;
  const appearance = normalizeBuildingV2DoorAppearance(door.appearance);
  const textureGridSize = seamless ? Number(door.surfacePlan?.textureGridSize || door.seamlessSource?.sceneGridSize)
    : materializeBuildingV2DoorTextureGridSize(appearance, scale, sceneGridSize);
  if (!(textureGridSize > 0)) throw new Error('Seamless Secret Door requires its compiled texture grid basis.');
  const endpoints = door.animation.directionFlip ? [b, a] : [a, b];
  return { c: endpoints.flatMap(point => [roundBuildingV2NativeCoordinate(point.x), roundBuildingV2NativeCoordinate(point.y)]), animation,
    ...(door.doorSound !== undefined ? { doorSound: normalizeBuildingV2PortalSound(door.doorSound) } : {}),
    dir: door.animation.directionFlip && dir ? 3 - dir : dir, textureFlip, appearance, textureGridSize };
}

export function validateBuildingV2DoorWall(occupation, projection, wall, { scale = 1, worldEndpoints = null, reflected = false, sceneGridSize } = {}) {
  normalizeBuildingV2DoorFrame(occupation?.setup?.frame);
  const appearance = normalizeBuildingV2DoorAppearance(occupation?.setup?.appearance);
  const seamless = occupation?.kind === 'seamlessSecretDoor';
  const surfacePlan = projection?.door?.surfacePlan;
  if (seamless && (Object.keys(occupation.setup).some(key => !['animation', 'frame', 'doorSound'].includes(key))
    || occupation.setup.animation.texture != null)) throw new Error('Building V2 Seamless Secret Door requires derived Wall artwork without an authored Door texture.');
  if (seamless && (surfacePlan?.version !== 2 || surfacePlan.portalId !== occupation.id || !surfacePlan.parts?.length
    || surfacePlan.hingeFlip !== occupation.setup.animation.directionFlip
    || Math.abs(surfacePlan.spanLength - occupation.width) > PORTAL_CHORD_WIDTH_TOLERANCE
    || !same(surfacePlan.span, { start: projection.localEndpoints?.[0], end: projection.localEndpoints?.[1] }))) {
    throw new Error('Building V2 Seamless Secret Door surface must match its compiled chord, width, and hinge.');
  }
  const animation = seamless ? { ...occupation.setup.animation, texture: surfacePlan.sourceTexture } : occupation?.setup?.animation;
  const textureFlip = normalizeBuildingV2DoorTextureFlip(occupation?.setup?.textureFlip);
  const worldTextureFlip = { ...textureFlip, vertical: textureFlip.vertical !== (reflected && !seamless) };
  const nativeAnimation = materializeBuildingV2DoorAnimation(animation, worldTextureFlip);
  if (reflected) nativeAnimation.direction *= -1;
  const projectionDoor = { ...projection?.door };
  const projectedShadow = projectionDoor.shadow == null ? null : normalizeBuildingV2DoorShadow(projectionDoor.shadow);
  delete projectionDoor.shadow;
  if (seamless) { delete projectionDoor.surfacePlan; delete projectionDoor.portalKind; }
  if ((!seamless && occupation?.kind !== 'door') || Object.keys(occupation.setup).some(key => !['animation', 'textureFlip', 'appearance', 'frame', 'doorSound'].includes(key))
    || !same({ ...projectionDoor, appearance: normalizeBuildingV2DoorAppearance(projectionDoor.appearance), textureFlip: normalizeBuildingV2DoorTextureFlip(projectionDoor.textureFlip) },
      { type: seamless ? 2 : 1, animation, textureFlip, appearance,
        ...(occupation.setup.doorSound !== undefined ? { doorSound: normalizeBuildingV2PortalSound(occupation.setup.doorSound) } : {}) }) || projection?.portalId !== occupation.id
    || projection.semanticWallId !== occupation.id || projection.fragmentOrdinal !== 0
    || !same(projection.semanticRange, { start: 0, end: 1 })) {
    throw new Error('Building V2 Door requires one exact native animation projection without durable live state.');
  }
  const endpoints = projection.localEndpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 2
    || !endpoints.every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    || Math.abs(Math.hypot(endpoints[1].x - endpoints[0].x, endpoints[1].y - endpoints[0].y) - occupation.width) > PORTAL_CHORD_WIDTH_TOLERANCE) {
    throw new Error('Building V2 Door native chord must match its exact authored width.');
  }
  const textureGridSize = wall ? (seamless ? Number(surfacePlan.textureGridSize) : materializeBuildingV2DoorTextureGridSize(appearance, scale, sceneGridSize)) : null;
  const nativeShadow = projectedShadow ? materializeBuildingV2DoorShadow(projectedShadow, { scale }) : null;
  const actualTextureGridSize = wall?.flags?.core?.textureGridSize === undefined ? 200 : wall.flags.core.textureGridSize;
  if (wall && (!Number.isFinite(actualTextureGridSize)
    || !same(normalizeBuildingV2DoorAppearance(wall.flags?.['fa-nexus']?.buildingGenerated?.appearance), appearance)
    || Math.abs(actualTextureGridSize - textureGridSize) > 1e-7
    || (occupation.setup.doorSound !== undefined && wall.doorSound !== occupation.setup.doorSound)
    || wall.door !== (seamless ? 2 : 1) || ![0, 1, 2].includes(wall.ds) || !same(wall.animation, nativeAnimation)
    || !same(normalizeBuildingV2DoorTextureFlip(wall.flags?.['fa-nexus']?.buildingGenerated?.textureFlip), worldTextureFlip))) {
      throw new Error('Building V2 Door native Wall configuration differs from its authored setup.');
  }
  if (seamless && wall) {
    const actual = wall.flags?.['fa-nexus']?.buildingSeamlessSecretDoor;
    if (actual?.gapId !== occupation.id || actual.surfacePlan?.version !== 2
      || Math.abs(actual.surfacePlan.spanLength - surfacePlan.spanLength * scale) > 1e-5) throw new Error('Building V2 Seamless Secret Door lost its generated surface.');
    if (worldEndpoints && !buildingV2SeamlessSurfacesEqual(actual.surfacePlan, transformBuildingV2SeamlessSurface(surfacePlan, {
      a: worldEndpoints[0], b: worldEndpoints[1], scale, reflected
    }))) throw new Error('Building V2 Seamless Secret Door surface differs from its current Root transform.');
  }
  if (wall && nativeShadow) {
    const actualShadow = wall.flags?.['fa-nexus']?.doorShadow;
    const actualNormal = wall.flags?.['fa-nexus']?.buildingGenerated?.doorShadowNormal;
    const expectedShadow = {
      enabled: nativeShadow.enabled, alpha: nativeShadow.alpha, blur: nativeShadow.blur,
      dilation: nativeShadow.dilation, offset: nativeShadow.offset
    };
    if (!same(actualShadow, expectedShadow)
      || ![Number(actualNormal?.x), Number(actualNormal?.y)].every(Number.isFinite)
      || Math.abs(Math.hypot(actualNormal.x, actualNormal.y) - 1) > 1e-7) {
      throw new Error('Building V2 Door shadow differs from its exact derived projection.');
    }
  } else if (wall && !nativeShadow && (wall.flags?.['fa-nexus']?.doorShadow != null
    || wall.flags?.['fa-nexus']?.buildingGenerated?.doorShadowNormal != null)) {
    throw new Error('Building V2 legacy Door without shadow projection cannot retain generated shadow fields.');
  }
}

export function validateBuildingV2WindowWall(occupation, projection, wall = null, {
  scale = 1,
  sceneGridSize,
  worldEndpoints = null, reflected = false
} = {}) {
  const setup = normalizeBuildingV2WindowSetup(occupation?.setup);
  const door = projection?.door;
  if (occupation?.kind !== 'window' || !door || door.portalKind !== 'window'
    || Object.keys(door).some((key) => !['portalKind', 'type', 'state', 'setup'].includes(key))
    || !same(door.setup, setup)
    || door.type !== (setup.animated ? 2 : 0)
    || ![0, 1, 2].includes(door.state)
    || (!setup.animated && door.state !== 0)
    || projection?.portalId !== occupation.id
    || projection.semanticWallId !== occupation.id || projection.fragmentOrdinal !== 0
    || !same(projection.semanticRange, { start: 0, end: 1 })) {
    throw new Error('Building V2 Window requires one exact native Portal projection without hidden setup state.');
  }
  const endpoints = projection.localEndpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 2
    || !endpoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
    || Math.abs(Math.hypot(endpoints[1].x - endpoints[0].x, endpoints[1].y - endpoints[0].y) - occupation.width) > PORTAL_CHORD_WIDTH_TOLERANCE) {
    throw new Error('Building V2 Window native chord must match its exact authored width.');
  }
  if (wall) {
    const materializedEndpoints = worldEndpoints ?? endpoints;
    if (!Array.isArray(materializedEndpoints) || materializedEndpoints.length !== 2
      || !materializedEndpoints.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) {
      throw new Error('Building V2 Window native Wall validation requires two exact world endpoints.');
    }
    const native = materializeBuildingV2WindowWall(setup, {
      a: materializedEndpoints[0], b: materializedEndpoints[1], dir: projection.resolvedBehavior?.dir || 0,
      state: door.state, scale, sceneGridSize, reflected, behavior: occupation.behavior
    });
    const actualTextureGridSize = wall.flags?.core?.textureGridSize === undefined
      ? 200
      : Number(wall.flags.core.textureGridSize);
    const generated = wall.flags?.['fa-nexus']?.buildingGenerated;
    if (!same(wall.c, native.c) || wall.door !== native.door || wall.ds !== native.ds
      || wall.dir !== native.dir || wall.light !== native.light || wall.sight !== native.sight
      || !same(wall.threshold, native.threshold)
      || (setup.doorSound !== undefined && wall.doorSound !== setup.doorSound)
      || !same(wall.animation ?? null, native.animation ?? null)
      || !Number.isFinite(actualTextureGridSize)
      || Math.abs(actualTextureGridSize - native.textureGridSize) > 1e-7
      || !same(generated?.windowSetup, setup)
      || !same(generated?.textureFlip, native.textureFlip)
      || !same(wall.flags?.['fa-nexus']?.windowShadow ?? null, native.windowShadow ?? null)) {
      throw new Error('Building V2 Window native Wall differs from its exact authored setup.');
    }
  }
  return setup;
}

export function buildingV2HasFullyOpenedArtwork(building) {
  if (!Array.isArray(building?.wall?.renderSegments) || building.wall.renderSegments.length
    || !Array.isArray(building?.runtime?.nativeWallProjection) || building.runtime.nativeWallProjection.some(entry => !entry.portalId)) return false;
  return validateBuildingV2OpeningProjection(building).openingCount > 0;
}

function requireInterval(start, end, label) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < -EPSILON
    || end > 1 + EPSILON || end - start <= 0) throw new Error(`${label} requires an ordered finite semantic interval.`);
  return [start, end];
}

export function validateBuildingV2OpeningProjection(building) {
  const authoring = building?.authoring || {}, runtime = building?.runtime || {};
  const occupations = Object.entries(authoring.portalsById || {});
  const projection = runtime.openingProjection || [];
  const portalArtwork = runtime.portalArtwork ?? [];
  if (!Array.isArray(portalArtwork)) throw new Error('Building V2 Portal artwork must be an array.');
  const expectedArtwork = [];
  if (!Array.isArray(projection)) throw new Error('Building V2 Opening projection must be an array.');
  if (!occupations.length) {
    if (projection.length || portalArtwork.length) throw new Error('Building V2 cannot retain Opening cuts or Portal artwork without authored Openings.');
    return { fullyOpenedSemanticIds: new Set(), openingCount: 0 };
  }
  const segments = { ...(authoring.semanticWallsById || {}), ...(authoring.interiorPathSegmentsById || {}) };
  const eligible = new Set(Object.values(segments).filter(segment => segment.owner?.kind === 'outer-loop'
    || (segment.owner?.kind === 'interior-path' && authoring.interiorPathsById?.[segment.owner.id]?.purpose !== 'fill-divider'))
    .map(segment => segment.id));
  const cutsById = new Map();
  const projectionIds = new Set();
  for (const [id, occupation] of occupations) {
    if (occupation?.id !== id || !['opening', 'door', 'window', 'seamlessSecretDoor'].includes(occupation.kind) || !eligible.has(occupation.attachment?.semanticWallId)
      || occupation.attachment?.unresolved || !Number.isFinite(occupation.attachment?.centerT)
      || occupation.attachment.centerT < 0 || occupation.attachment.centerT > 1
      || !Number.isFinite(occupation.width) || occupation.width <= 0
      || (occupation.setupNominalWidth != null && (!Number.isFinite(occupation.setupNominalWidth) || occupation.setupNominalWidth <= 0))
      || (occupation.kind === 'opening' && Object.keys(occupation.setup || {}).some(key => key !== 'frame'))) {
      throw new Error('Building V2 requires resolved occupations on exact structural Wall carriers.');
    }
    const matches = projection.filter(entry => entry?.openingId === id);
    if (matches.length !== 1 || !Array.isArray(matches[0].cuts) || !matches[0].cuts.length) {
      throw new Error(`Building V2 Opening ${id} requires one exact compiled cut projection.`);
    }
    projectionIds.add(id);
    if (occupation.kind === 'opening' && occupation.setup?.frame) {
      const endpoints = matches[0].localEndpoints;
      if (!Array.isArray(endpoints) || endpoints.length !== 2
        || endpoints.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
        || Math.abs(Math.hypot(endpoints[1].x - endpoints[0].x, endpoints[1].y - endpoints[0].y) - occupation.width) > PORTAL_CHORD_WIDTH_TOLERANCE) {
        throw new Error('Building V2 Framed Opening requires exact jamb endpoints.');
      }
      const boundaries = matches[0].cuts.flatMap(cut => {
        const wall = segments[cut.semanticWallId], geometry = wall?.geometry;
        const spline = geometry?.kind === 'spline-span' ? resolveBuildingV2SplineSpan(authoring, wall) : null;
        const start = spline?.start || authoring.topologyVerticesById?.[geometry?.startVertexId];
        const end = spline?.end || authoring.topologyVerticesById?.[geometry?.endVertexId];
        if (!start || !end) throw new Error('Building V2 Framed Opening cut requires exact endpoints.');
        return [cut.start, cut.end].map(t => spline ? evaluateBuildingV2Cubic(start, spline.geometry, end, t)
          : geometry.kind === 'conic' ? evaluateBuildingV2Conic(start, geometry, end, t)
            : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
      });
      const jambs = boundaries.filter(point => boundaries.filter(other => Math.hypot(point.x - other.x, point.y - other.y) < 1e-5).length === 1);
      if (jambs.length !== 2 || !endpoints.every(point => jambs.some(jamb => Math.hypot(point.x - jamb.x, point.y - jamb.y) < 1e-5))) {
        throw new Error('Building V2 Opening frame is detached from its cut boundaries.');
      }
      const frame = normalizeBuildingV2DoorFrame(occupation.setup.frame);
      expectedArtwork.push(compileBuildingV2DoorFrame({ portalId: id, frame, endpointsLocal: endpoints, gridSize: frame.gridSize,
        shadow: deriveBuildingV2DoorShadow(authoring, occupation.attachment.semanticWallId, { a: endpoints[0], b: endpoints[1] }) }));
    }
    if (['door', 'window', 'seamlessSecretDoor'].includes(occupation.kind)) {
      if (segments[id]) throw new Error('Building V2 Portal identity must be distinct from its structural carriers.');
      const native = (runtime.nativeWallProjection || []).filter(entry => entry.portalId === id || entry.semanticWallId === id);
      if (native.length !== 1) throw new Error('Building V2 Portal requires exactly one native Portal Wall.');
      if (['door', 'seamlessSecretDoor'].includes(occupation.kind) && native[0].door?.shadow != null && !sameDerivedDoorShadow(native[0].door.shadow,
        deriveBuildingV2DoorShadow(authoring, occupation.attachment.semanticWallId, {
          a: native[0].localEndpoints?.[0], b: native[0].localEndpoints?.[1]
        }))) {
        throw new Error('Building V2 Door shadow must derive from its exact carrier Wall appearance.');
      }
      if (['door', 'seamlessSecretDoor'].includes(occupation.kind)) {
        validateBuildingV2DoorWall(occupation, native[0]);
        const frame = normalizeBuildingV2DoorFrame(occupation.setup?.frame);
        if (frame) expectedArtwork.push(compileBuildingV2DoorFrame({
          portalId: id, frame, endpointsLocal: native[0].localEndpoints,
          gridSize: frame.gridSize,
          shadow: deriveBuildingV2DoorShadow(authoring, occupation.attachment.semanticWallId, {
            a: native[0].localEndpoints[0], b: native[0].localEndpoints[1]
          })
        }));
      } else {
        validateBuildingV2WindowWall(occupation, native[0]);
        expectedArtwork.push(...compileBuildingV2WindowArtwork({
          portalId: id, setup: occupation.setup, endpointsLocal: native[0].localEndpoints
        }));
      }
      const boundaryPoints = matches[0].cuts.flatMap(cut => {
        const segment = segments[cut.semanticWallId], geometry = segment?.geometry;
        if (geometry?.kind === 'spline-span') {
          const spline = resolveBuildingV2SplineSpan(authoring, segment);
          return [cut.start, cut.end].map(t => evaluateBuildingV2Cubic(spline.start, spline.geometry, spline.end, t));
        }
        const start = authoring.topologyVerticesById?.[geometry?.startVertexId];
        const end = authoring.topologyVerticesById?.[geometry?.endVertexId];
        if (!start || !end) throw new Error('Building V2 Door cut requires exact carrier endpoints.');
        return [cut.start, cut.end].map(t => geometry.kind === 'conic'
          ? evaluateBuildingV2Conic(start, geometry, end, t)
          : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t });
      });
      const jambPoints = boundaryPoints.filter(point => boundaryPoints.filter(other => Math.hypot(point.x - other.x, point.y - other.y) < 1e-5).length === 1);
      if (jambPoints.length !== 2 || !native[0].localEndpoints.every(point => jambPoints.some(boundary => Math.hypot(point.x - boundary.x, point.y - boundary.y) < 1e-5))) {
        throw new Error('Building V2 Door jambs differ from its compiled cut boundaries.');
      }
      if (occupation.kind === 'seamlessSecretDoor') {
        const surface = native[0].door.surfacePlan;
        const [a, b] = native[0].localEndpoints;
        const dx = (b.x - a.x) / occupation.width, dy = (b.y - a.y) / occupation.width;
        const nearPoint = (p, q) => p && q && Math.hypot(p.x - q.x, p.y - q.y) < 1e-5;
        if (surface.parts.length !== matches[0].cuts.length || surface.sourceTexture !== surface.parts[0].sourceTexture) {
          throw new Error('Building V2 Seamless Secret Door requires one derived surface part per carrier cut.');
        }
        const remaining = [...surface.parts];
        for (const cut of matches[0].cuts) {
          const wall = segments[cut.semanticWallId], geometry = wall.geometry;
          const spline = geometry.kind === 'spline-span' ? resolveBuildingV2SplineSpan(authoring, wall) : null;
          const start = spline?.start || authoring.topologyVerticesById[geometry.startVertexId];
          const end = spline?.end || authoring.topologyVerticesById[geometry.endVertexId];
          const at = t => spline ? evaluateBuildingV2Cubic(start, spline.geometry, end, t)
            : geometry.kind === 'conic' ? evaluateBuildingV2Conic(start, geometry, end, t)
              : { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t };
          const sample = [0, .25, .5, .75, 1].map(t => at(cut.start + (cut.end - cut.start) * t));
          const index = remaining.findIndex(part => part.semanticWallId === cut.semanticWallId
            && [sample[0], sample.at(-1)].every(p => [part.sourcePath?.[0], part.sourcePath?.at(-1)].some(q => nearPoint(p, q))));
          const part = remaining.splice(index, index < 0 ? 0 : 1)[0];
          if (part && !nearPoint(part.sourcePath[0], sample[0])) sample.reverse();
          // Version 2 straight recipes predating curved support used just two
          // source endpoints; retain them only when the entire cut is collinear.
          const sourceSamples = part?.sourcePath?.length === 2 && sample.every(p => {
            const u = sample[0], v = sample.at(-1);
            return Math.abs((p.x - u.x) * (v.y - u.y) - (p.y - u.y) * (v.x - u.x)) < 1e-6;
          }) ? [sample[0], sample.at(-1)] : sample;
          if (!part || part.sourcePath?.length !== sourceSamples.length
            || !sourceSamples.every((p, i) => nearPoint(p, part.sourcePath[i]))
            || !(part.wallWidth > 0) || !(part.repeatDistance > 0)
            || ![part.wallWidth, part.repeatDistance, part.phaseDistance, part.startDistance, part.endDistance, part.spanLength].every(Number.isFinite)) {
            throw new Error('Building V2 Seamless Secret Door surface is detached from its exact carrier cut.');
          }
        }
        const lengths = surface.parts.map(part => part.sourcePath.slice(1).reduce((sum, p, i) =>
          sum + Math.hypot(p.x - part.sourcePath[i].x, p.y - part.sourcePath[i].y), 0));
        const totalLength = lengths.reduce((sum, length) => sum + length, 0);
        const atChord = distance => ({ x: a.x + dx * distance, y: a.y + dy * distance });
        let travelled = 0, cursor = a;
        for (const [index, part] of surface.parts.entries()) {
          const startDistance = travelled * occupation.width / totalLength;
          travelled += lengths[index];
          const endDistance = travelled * occupation.width / totalLength;
          if (!(lengths[index] > 0) || !nearPoint(part.sourcePath[0], cursor)
            || Math.abs(part.startDistance - startDistance) > 1e-5 || Math.abs(part.endDistance - endDistance) > 1e-5
            || Math.abs(part.spanLength - (endDistance - startDistance)) > 1e-5
            || !nearPoint(part.span?.start, atChord(startDistance)) || !nearPoint(part.span?.end, atChord(endDistance))) {
            throw new Error('Building V2 Seamless Secret Door surface has a gap, overlap, or detached chord.');
          }
          cursor = part.sourcePath.at(-1);
        }
        if (!nearPoint(cursor, b)) throw new Error('Building V2 Seamless Secret Door surface coverage is incomplete.');
      }
    }
    for (const cut of matches[0].cuts) {
      if (!eligible.has(cut.semanticWallId)) throw new Error('Building V2 Opening cut references a missing or non-Wall Segment.');
      const interval = requireInterval(cut.start, cut.end, 'Building V2 Opening cut');
      const intervals = cutsById.get(cut.semanticWallId) || [];
      intervals.push(interval); cutsById.set(cut.semanticWallId, intervals);
    }
  }
  if (projection.length !== projectionIds.size) throw new Error('Building V2 Opening projection contains an unknown or duplicate occupation.');
  const sortArtwork = entries => [...entries].sort((a, b) => String(a?.portalId).localeCompare(String(b?.portalId)));
  if (!samePortalFrameArtwork(sortArtwork(portalArtwork), sortArtwork(expectedArtwork))) {
    throw new Error('Building V2 Portal artwork must match its exact authored setup and jamb chord.');
  }
  if ((runtime.nativeWallProjection || []).some((entry) => {
    if (!entry.portalId) return false;
    const occupation = authoring.portalsById?.[entry.portalId];
    return occupation?.kind === 'seamlessSecretDoor' ? entry.door?.type !== 2 || entry.door?.portalKind !== 'seamlessSecretDoor'
      : occupation?.kind === 'door' ? entry.door?.type !== 1
      : occupation?.kind === 'window' ? ![0, 2].includes(entry.door?.type)
        : true;
  })) {
    throw new Error('Building V2 native Portal projection references an unknown or incompatible Portal role.');
  }
  if ((runtime.nativeWallProjection || []).some(entry => !entry.portalId && entry.door)) {
    throw new Error('Building V2 structural Wall projection cannot carry native Door configuration.');
  }
  const fullyOpenedSemanticIds = new Set();
  for (const semanticId of eligible) {
    const cuts = cutsById.get(semanticId) || [];
    const walls = (runtime.nativeWallProjection || []).filter(fragment => fragment.semanticWallId === semanticId);
    const ranges = [...cuts.map(range => ({ range, cut: true })), ...walls.map(fragment => ({
      range: requireInterval(Number(fragment.semanticRange?.start), Number(fragment.semanticRange?.end), 'Building V2 native Wall'), cut: false
    }))].sort((a, b) => a.range[0] - b.range[0]);
    let cursor = 0;
    for (const { range } of ranges) {
      if (Math.abs(range[0] - cursor) > EPSILON) throw new Error(`Building V2 Opening/native coverage overlaps or omits part of Semantic Wall ${semanticId}.`);
      cursor = range[1];
    }
    if (Math.abs(cursor - 1) > EPSILON) throw new Error(`Building V2 Opening/native coverage is incomplete for Semantic Wall ${semanticId}.`);
    if (cuts.length && !walls.length) fullyOpenedSemanticIds.add(semanticId);
  }
  return { fullyOpenedSemanticIds, openingCount: occupations.length };
}
import { resolveBuildingV2SplineSpan, evaluateBuildingV2Cubic } from './building-v2-spline-runtime.js';
