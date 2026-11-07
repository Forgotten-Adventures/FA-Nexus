import {
  BUILDING_V2_PRESENTATION_PADDING,
  BUILDING_V2_ROOT_FRAME_VERSION,
  resolveBuildingV2PresentationFrame,
  resolveBuildingV2RootFrameOffset
} from './building-v2-root-frame.js';
import { deriveBuildingV2InstanceScale } from './building-v2-instance-scale.js';

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Building V2 ${label} must be finite.`);
  return number;
}

// Compound affine transforms can place the same exact half-pixel endpoint a
// few ulps on either side of the native integer rounding boundary.
export function roundBuildingV2NativeCoordinate(value) {
  const coordinate = finite(value, 'native Wall coordinate');
  const half = Math.floor(coordinate) + 0.5;
  return Math.round(Math.abs(coordinate - half) <= 1e-9 ? half : coordinate);
}

function immutableCopy(value) {
  const copy = globalThis.structuredClone ? globalThis.structuredClone(value) : JSON.parse(JSON.stringify(value));
  const freeze = (entry) => {
    if (!entry || typeof entry !== 'object' || Object.isFrozen(entry)) return entry;
    for (const child of Object.values(entry)) freeze(child);
    return Object.freeze(entry);
  };
  return freeze(copy);
}

export function createBuildingV2SpatialTransform(pose) {
  const originX = finite(pose?.originX, 'spatial transform originX');
  const originY = finite(pose?.originY, 'spatial transform originY');
  const rotation = finite(pose?.rotation ?? 0, 'spatial transform rotation') * (Math.PI / 180);
  const scale = finite(pose?.scale ?? 1, 'spatial transform scale');
  if (!(scale > 0)) throw new Error('Building V2 spatial transform scale must be greater than zero.');
  const signX = pose?.flipX ? -1 : 1, signY = pose?.flipY ? -1 : 1;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  return Object.freeze({
    worldToLocal(point) {
      const dx = finite(point?.x, 'world point x') - originX;
      const dy = finite(point?.y, 'world point y') - originY;
      return {
        x: ((dx * cosine) + (dy * sine)) / (scale * signX),
        y: ((-dx * sine) + (dy * cosine)) / (scale * signY)
      };
    },
    localToWorld(point) {
      const x = finite(point?.x, 'local point x') * scale * signX;
      const y = finite(point?.y, 'local point y') * scale * signY;
      return {
        x: originX + (x * cosine) - (y * sine),
        y: originY + (x * sine) + (y * cosine)
      };
    },
    localDirectionToWorld(direction) {
      const x = finite(direction?.x, 'local direction x');
      const y = finite(direction?.y, 'local direction y');
      const length = Math.hypot(x, y);
      if (!(length > 0)) throw new Error('Building V2 local direction must be non-zero.');
      const normalizedX = signX * x / length;
      const normalizedY = signY * y / length;
      return {
        x: (normalizedX * cosine) - (normalizedY * sine),
        y: (normalizedX * sine) + (normalizedY * cosine)
      };
    }
  });
}

export function deriveBuildingV2SpatialPose(rootSource, building) {
  // Foundry clamps prepared display positions to Scene bounds. The stored Root
  // remains the pose authority for generated geometry and shadow projection.
  rootSource = rootSource?._source || rootSource;
  const width = finite(rootSource?.width, 'Root width');
  const height = finite(rootSource?.height, 'Root height');
  const presentationFrame = resolveBuildingV2PresentationFrame(building);
  const { scale } = deriveBuildingV2InstanceScale({
    width,
    height,
    envelopeWidth: presentationFrame.width,
    envelopeHeight: presentationFrame.height
  });
  const x = finite(rootSource?.x, 'Root x');
  const y = finite(rootSource?.y, 'Root y');
  const rotation = finite(rootSource?.rotation ?? 0, 'Root rotation');
  const anchorX = finite(rootSource?.texture?.anchorX ?? rootSource?.anchorX ?? 0.5, 'Root anchorX');
  const anchorY = finite(rootSource?.texture?.anchorY ?? rootSource?.anchorY ?? 0.5, 'Root anchorY');
  const flipX = Number(rootSource?.texture?.scaleX) < 0, flipY = Number(rootSource?.texture?.scaleY) < 0;
  const signX = flipX ? -1 : 1, signY = flipY ? -1 : 1;
  const frame = resolveBuildingV2RootFrameOffset(building);
  const radians = rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const anchorWorldX = (signX * frame.minX * scale) + (width * (anchorX - Number(flipX)));
  const anchorWorldY = (signY * frame.minY * scale) + (height * (anchorY - Number(flipY)));
  return immutableCopy({
    x,
    y,
    width,
    height,
    rotation,
    anchorX,
    anchorY,
    flipX, flipY,
    originX: x - (anchorWorldX * cosine) + (anchorWorldY * sine),
    originY: y - (anchorWorldX * sine) - (anchorWorldY * cosine),
    scale
  });
}

export function createBuildingV2UniformScaleRootTarget(rootSource, building, { pivot, factor } = {}) {
  const pivotX = finite(pivot?.x, 'Scene Group scale pivot x');
  const pivotY = finite(pivot?.y, 'Scene Group scale pivot y');
  const scaleFactor = finite(factor, 'Scene Group scale factor');
  if (!(scaleFactor > 0)) throw new Error('Building V2 Scene Group scale factor must be greater than zero.');
  const currentPose = deriveBuildingV2SpatialPose(rootSource, building);
  const presentationFrame = resolveBuildingV2PresentationFrame(building);
  const minX = presentationFrame.minX;
  const minY = presentationFrame.minY;
  const maxX = presentationFrame.maxX;
  const maxY = presentationFrame.maxY;
  const envelopeWidth = presentationFrame.width;
  const envelopeHeight = presentationFrame.height;
  const requestedScale = currentPose.scale * scaleFactor;
  const width = Math.max(1, Math.ceil((envelopeWidth * requestedScale) - 1e-6));
  const height = Math.max(1, Math.ceil((envelopeHeight * requestedScale) - 1e-6));
  const { scale } = deriveBuildingV2InstanceScale({ width, height, envelopeWidth, envelopeHeight });
  const currentTransform = createBuildingV2SpatialTransform(currentPose);
  const localCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const currentCenter = currentTransform.localToWorld(localCenter);
  const targetCenter = {
    x: pivotX + ((currentCenter.x - pivotX) * scaleFactor),
    y: pivotY + ((currentCenter.y - pivotY) * scaleFactor)
  };
  const radians = currentPose.rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const signX = currentPose.flipX ? -1 : 1, signY = currentPose.flipY ? -1 : 1;
  const scaledCenterX = localCenter.x * scale * signX;
  const scaledCenterY = localCenter.y * scale * signY;
  const targetPose = {
    originX: targetCenter.x - (scaledCenterX * cosine) + (scaledCenterY * sine),
    originY: targetCenter.y - (scaledCenterX * sine) - (scaledCenterY * cosine),
    rotation: currentPose.rotation, flipX: currentPose.flipX, flipY: currentPose.flipY,
    scale
  };
  const targetTransform = createBuildingV2SpatialTransform(targetPose);
  const x = Math.round(pivotX + ((currentPose.x - pivotX) * scaleFactor));
  const y = Math.round(pivotY + ((currentPose.y - pivotY) * scaleFactor));
  const anchorLocal = targetTransform.worldToLocal({ x, y });
  const anchorX = Number(currentPose.flipX) + (signX * (anchorLocal.x - minX) * scale) / width;
  const anchorY = Number(currentPose.flipY) + (signY * (anchorLocal.y - minY) * scale) / height;
  if (![anchorX, anchorY].every(Number.isFinite)) {
    throw new Error('Building V2 Scene Group scale produced an invalid Root anchor.');
  }
  return immutableCopy({
    x, y, width, height, rotation: currentPose.rotation, anchorX, anchorY, scale
  });
}

export function createBuildingV2RefitPlan(pose, {
  renderEnvelope,
  nativeFragments,
  presentationPadding = BUILDING_V2_PRESENTATION_PADDING
} = {}) {
  const minX = finite(renderEnvelope?.minX, 'refit Render Envelope minX');
  const minY = finite(renderEnvelope?.minY, 'refit Render Envelope minY');
  const maxX = finite(renderEnvelope?.maxX, 'refit Render Envelope maxX');
  const maxY = finite(renderEnvelope?.maxY, 'refit Render Envelope maxY');
  if (!(maxX > minX) || !(maxY > minY)) {
    throw new Error('Building V2 Root refit requires a finite non-empty Building-local Render Envelope.');
  }
  if (!Array.isArray(nativeFragments)) {
    throw new Error('Building V2 Root refit requires exact Building-local native fragments.');
  }
  const currentTransform = createBuildingV2SpatialTransform(pose);
  const requestedScale = finite(pose?.scale ?? 1, 'refit Building Instance Scale');
  if (!(requestedScale > 0)) throw new Error('Building V2 Root refit requires a positive Building Instance Scale.');
  const padding = finite(presentationPadding, 'refit presentation padding');
  if (padding < 0) throw new Error('Building V2 Root refit requires non-negative presentation padding.');
  const frameMinX = minX - padding;
  const frameMinY = minY - padding;
  const frameMaxX = maxX + padding;
  const frameMaxY = maxY + padding;
  const envelopeWidth = frameMaxX - frameMinX;
  const envelopeHeight = frameMaxY - frameMinY;
  const width = Math.max(1, Math.ceil((envelopeWidth * requestedScale) - 1e-6));
  const height = Math.max(1, Math.ceil((envelopeHeight * requestedScale) - 1e-6));
  const { scale } = deriveBuildingV2InstanceScale({ width, height, envelopeWidth, envelopeHeight });
  const localCenter = { x: (frameMinX + frameMaxX) / 2, y: (frameMinY + frameMaxY) / 2 };
  const centerWorld = currentTransform.localToWorld(localCenter);
  const rotation = finite(pose?.rotation ?? 0, 'refit Root rotation');
  const radians = rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const signX = pose.flipX ? -1 : 1, signY = pose.flipY ? -1 : 1;
  const scaledCenterX = localCenter.x * scale * signX;
  const scaledCenterY = localCenter.y * scale * signY;
  const transform = createBuildingV2SpatialTransform({
    originX: centerWorld.x - (scaledCenterX * cosine) + (scaledCenterY * sine),
    originY: centerWorld.y - (scaledCenterX * sine) - (scaledCenterY * cosine),
    rotation, flipX: pose.flipX, flipY: pose.flipY,
    scale
  });
  const x = Math.round(centerWorld.x);
  const y = Math.round(centerWorld.y);
  const anchorLocal = transform.worldToLocal({ x, y });
  const anchorX = Number(!!pose.flipX) + (signX * (anchorLocal.x - frameMinX) * scale) / width;
  const anchorY = Number(!!pose.flipY) + (signY * (anchorLocal.y - frameMinY) * scale) / height;
  if (![anchorX, anchorY].every(Number.isFinite)) {
    throw new Error('Building V2 Root refit produced an invalid rotation-preserving anchor.');
  }
  const root = { x, y, width, height, rotation, anchorX, anchorY };
  // Native outputs must use the pose recovered from the stored Root. The
  // anchor round trip can change a half-pixel endpoint by floating-point noise
  // and put a pre-storage transform on the other side of Math.round's tie.
  const storedTransform = createBuildingV2SpatialTransform(deriveBuildingV2SpatialPose({
    ...root, texture: { anchorX, anchorY, scaleX: signX, scaleY: signY }
  }, { runtime: {
    rootFrameVersion: BUILDING_V2_ROOT_FRAME_VERSION,
    renderEnvelope: { minX, minY, maxX, maxY }, presentationPadding: padding
  } }));
  return immutableCopy({
    scale,
    root,
    wallCoordinates: nativeFragments.map((fragment) => {
      const start = storedTransform.localToWorld(fragment?.a);
      const end = storedTransform.localToWorld(fragment?.b);
      return {
        semanticWallId: String(fragment?.semanticWallId || ''),
        fragmentOrdinal: Number(fragment?.fragmentOrdinal || 0),
        exactEndpoints: [start, end],
        c: [
          roundBuildingV2NativeCoordinate(start.x), roundBuildingV2NativeCoordinate(start.y),
          roundBuildingV2NativeCoordinate(end.x), roundBuildingV2NativeCoordinate(end.y)
        ]
      };
    })
  });
}
