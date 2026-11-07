import { deriveBuildingV2InstanceScale } from './building-v2-instance-scale.js';

export const BUILDING_V2_ROOT_FRAME_VERSION = 1;
export const BUILDING_V2_PRESENTATION_PADDING = 6;

export function resolveBuildingV2PresentationFrame(building) {
  const runtime = building?.runtime || {};
  const envelope = runtime.renderEnvelope || {};
  const minX = Number(envelope.minX);
  const minY = Number(envelope.minY);
  const maxX = Number(envelope.maxX);
  const maxY = Number(envelope.maxY);
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || !(maxX > minX) || !(maxY > minY)) {
    throw new Error('Building V2 presentation frame requires a finite non-empty Render Envelope.');
  }
  const authoredPadding = Number(runtime.presentationPadding);
  const padding = Number.isFinite(authoredPadding) && authoredPadding >= 0 ? authoredPadding : 0;
  return Object.freeze({
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
    width: (maxX - minX) + (padding * 2),
    height: (maxY - minY) + (padding * 2),
    padding
  });
}

export function resolveBuildingV2RootFrameOffset(building) {
  const runtime = building?.runtime;
  if (Number(runtime?.rootFrameVersion) !== BUILDING_V2_ROOT_FRAME_VERSION) {
    return Object.freeze({ version: 0, minX: 0, minY: 0 });
  }
  const frame = resolveBuildingV2PresentationFrame(building);
  return Object.freeze({ version: BUILDING_V2_ROOT_FRAME_VERSION, minX: frame.minX, minY: frame.minY });
}

export function readBuildingV2Data(document) {
  return document?.getFlag?.('fa-nexus', 'building')
    || document?.flags?.['fa-nexus']?.building
    || document?._source?.flags?.['fa-nexus']?.building
    || null;
}

export function resolveBuildingV2ContainerTransform({
  docWidth,
  docHeight,
  docX,
  docY,
  docRotation,
  anchorX,
  anchorY,
  flipX = false, flipY = false,
  toMeshLocal,
  building
}) {
  const width = Math.max(1, Number(docWidth) || 1);
  const height = Math.max(1, Number(docHeight) || 1);
  const ax = Number.isFinite(Number(anchorX)) ? Number(anchorX) : 0.5;
  const ay = Number.isFinite(Number(anchorY)) ? Number(anchorY) : 0.5;
  const x = Number(docX) || 0;
  const y = Number(docY) || 0;
  const rotation = Number(docRotation) || 0;
  if (typeof toMeshLocal !== 'function') {
    throw new Error('Building V2 container transform requires the live Tile mesh coordinate converter.');
  }
  const frame = resolveBuildingV2RootFrameOffset(building);
  if (frame.version !== BUILDING_V2_ROOT_FRAME_VERSION) {
    throw new Error('Building V2 container transform requires an envelope-framed Root.');
  }
  const radians = rotation * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const presentationFrame = resolveBuildingV2PresentationFrame(building);
  const { scale } = deriveBuildingV2InstanceScale({
    width,
    height,
    envelopeWidth: presentationFrame.width,
    envelopeHeight: presentationFrame.height
  });
  const signX = flipX ? -1 : 1, signY = flipY ? -1 : 1;
  const anchorWorldX = (signX * frame.minX * scale) + (width * (ax - Number(flipX)));
  const anchorWorldY = (signY * frame.minY * scale) + (height * (ay - Number(flipY)));
  const originScene = {
    x: x - (anchorWorldX * cosine) + (anchorWorldY * sine),
    y: y - (anchorWorldX * sine) - (anchorWorldY * cosine)
  };
  const xAxisScene = { x: originScene.x + (signX * scale * cosine), y: originScene.y + (signX * scale * sine) };
  const yAxisScene = { x: originScene.x - (signY * scale * sine), y: originScene.y + (signY * scale * cosine) };
  const origin = toMeshLocal(originScene);
  const xAxis = toMeshLocal(xAxisScene);
  const yAxis = toMeshLocal(yAxisScene);
  if (![origin?.x, origin?.y, xAxis?.x, xAxis?.y, yAxis?.x, yAxis?.y]
    .every((value) => Number.isFinite(Number(value)))) {
    throw new Error('Building V2 container transform produced a non-finite Tile-mesh-local basis.');
  }
  return Object.freeze({
    a: Number(xAxis.x) - Number(origin.x),
    b: Number(xAxis.y) - Number(origin.y),
    c: Number(yAxis.x) - Number(origin.x),
    d: Number(yAxis.y) - Number(origin.y),
    tx: Number(origin.x),
    ty: Number(origin.y)
  });
}
