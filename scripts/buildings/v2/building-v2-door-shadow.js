import { createBuildingV2SpatialTransform, deriveBuildingV2SpatialPose } from './building-v2-spatial-transform.js';

export function normalizeBuildingV2DoorShadow(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['enabled', 'alpha', 'blur', 'dilation', 'offset', 'normal'].includes(key))
    || typeof value.enabled !== 'boolean') {
    throw new Error('Building V2 Door shadow requires exact derived Wall-shadow fields.');
  }
  const alpha = Number(value.alpha);
  const blur = Number(value.blur);
  const dilation = Number(value.dilation);
  const offset = Number(value.offset);
  const normal = value.normal;
  const length = Math.hypot(Number(normal?.x), Number(normal?.y));
  if (![alpha, blur, dilation, offset, Number(normal?.x), Number(normal?.y), length].every(Number.isFinite)
    || alpha < 0 || alpha > 1 || blur < 0 || dilation < 0 || !(length > 0)) {
    throw new Error('Building V2 Door shadow requires finite bounded settings and a non-zero carrier normal.');
  }
  return {
    enabled: value.enabled,
    alpha,
    blur,
    dilation,
    offset,
    normal: {
      x: (Number(normal.x) / length) || 0,
      y: (Number(normal.y) / length) || 0
    }
  };
}

export function materializeBuildingV2DoorShadow(value, { scale = 1, transform = null } = {}) {
  const shadow = normalizeBuildingV2DoorShadow(value);
  const instanceScale = Number(scale);
  if (!Number.isFinite(instanceScale) || !(instanceScale > 0)) throw new Error('Building V2 Door shadow requires a finite positive Building Instance Scale.');
  const normal = transform?.localDirectionToWorld
    ? transform.localDirectionToWorld(shadow.normal)
    : shadow.normal;
  return {
    enabled: shadow.enabled,
    alpha: shadow.alpha,
    blur: shadow.blur,
    dilation: shadow.dilation * instanceScale,
    offset: shadow.offset * instanceScale,
    normal
  };
}

export function materializeBuildingV2DoorShadowForChord(value, { sourceA, sourceB, targetA, targetB, scale = 1, reflected = false } = {}) {
  const shadow = normalizeBuildingV2DoorShadow(value);
  const sourceLeft = buildingV2DoorCarrierNormal(sourceA, sourceB);
  const targetLeft = buildingV2DoorCarrierNormal(targetA, targetB);
  const side = ((shadow.normal.x * sourceLeft.x) + (shadow.normal.y * sourceLeft.y)) < 0 ? -1 : 1;
  return materializeBuildingV2DoorShadow({ ...shadow,
    normal: { x: targetLeft.x * side * (reflected ? -1 : 1), y: targetLeft.y * side * (reflected ? -1 : 1) }
  }, { scale });
}

export function materializeBuildingV2DoorShadowForRoot(value, { rootSource, building, localEndpoints } = {}) {
  if (!Array.isArray(localEndpoints) || localEndpoints.length !== 2) {
    throw new Error('Building V2 Door shadow requires two exact Building-local Root projection endpoints.');
  }
  const shadow = normalizeBuildingV2DoorShadow(value);
  const localLeft = buildingV2DoorCarrierNormal(localEndpoints[0], localEndpoints[1]);
  const side = ((shadow.normal.x * localLeft.x) + (shadow.normal.y * localLeft.y)) < 0 ? -1 : 1;
  const pose = deriveBuildingV2SpatialPose(rootSource, building);
  const transform = createBuildingV2SpatialTransform(pose);
  return materializeBuildingV2DoorShadow({
    ...shadow,
    normal: { x: localLeft.x * side, y: localLeft.y * side }
  }, { scale: pose.scale, transform });
}

export function buildingV2DoorCarrierNormal(a, b, { reverse = false } = {}) {
  const dx = Number(b?.x) - Number(a?.x);
  const dy = Number(b?.y) - Number(a?.y);
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) throw new Error('Building V2 Door shadow requires an exact carrier chord.');
  const sign = reverse ? -1 : 1;
  return { x: ((-dy / length) * sign) || 0, y: ((dx / length) * sign) || 0 };
}

export function deriveBuildingV2DoorShadow(authoring, carrierSemanticWallId, { a, b } = {}) {
  const segment = authoring?.semanticWallsById?.[carrierSemanticWallId]
    || authoring?.interiorPathSegmentsById?.[carrierSemanticWallId];
  if (!segment) throw new Error('Building V2 Door shadow requires its exact authored carrier.');
  const inner = segment.owner?.kind === 'interior-path';
  const outerDefaults = authoring?.defaults?.outerWallAppearance?.pathShadow || {};
  const defaults = inner
    ? (authoring?.defaults?.innerWallAppearance?.pathShadow || outerDefaults)
    : outerDefaults;
  const pathOverride = inner
    ? authoring?.interiorPathsById?.[segment.owner?.id]?.appearanceOverride?.pathShadow
    : null;
  const segmentOverride = segment.appearanceOverride?.pathShadow;
  const geometry = { ...defaults, ...(pathOverride || {}), ...(segmentOverride || {}) };
  const reverse = segment.owner?.kind === 'outer-loop'
    && (authoring?.outerTopology?.holeLoopIds || []).includes(segment.owner.id);
  return normalizeBuildingV2DoorShadow({
    enabled: outerDefaults.enabled,
    alpha: outerDefaults.alpha,
    blur: outerDefaults.blur,
    dilation: geometry.dilation,
    offset: geometry.offset,
    normal: buildingV2DoorCarrierNormal(a, b, { reverse })
  });
}
