import {
  getSectionMoveRootIds,
  getSectionTileIds,
  getTileSectionId,
  normalizeLayerManagerSections
} from '../model/section-metadata.js';

function docId(doc) {
  return String(doc?.id || doc?._id || '').trim();
}

function quantizeElevation(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const quantized = Math.round(numeric * 10000) / 10000;
  return Object.is(quantized, -0) ? 0 : quantized;
}

export function getLayerManagerFolderDepthColor(depth = 0) {
  const normalizedDepth = Math.max(0, Number(depth) || 0);
  const lightness = 60 + (34 * (1 - (0.8 ** normalizedDepth)));
  return `hsl(36 82% ${lightness.toFixed(1)}%)`;
}

export function planElevationGroupToFolder({
  sourceDocs = [],
  targetDocs = [],
  targetElevation = 0,
  placement = 'above',
  sortStep = 2
} = {}) {
  const elevation = quantizeElevation(targetElevation);
  const step = Number(sortStep);
  if (!Number.isFinite(step) || step <= 0) throw new Error('Invalid Folder conversion sort step.');
  const orderedSource = (Array.isArray(sourceDocs) ? sourceDocs : []).filter((doc) => docId(doc));
  if (!orderedSource.length) throw new Error('An Elevation must contain layers before it can be converted to a Folder.');
  const targetSorts = (Array.isArray(targetDocs) ? targetDocs : [])
    .map((doc) => Number(doc?.sort))
    .filter(Number.isFinite);
  const placeBelow = placement === 'below';
  const targetEdgeSort = placeBelow
    ? Math.min(0, ...targetSorts)
    : Math.max(0, ...targetSorts);
  return orderedSource.map((doc, index) => ({
    _id: docId(doc),
    elevation,
    sort: placeBelow
      ? targetEdgeSort - ((index + 1) * step)
      : targetEdgeSort + ((orderedSource.length - index) * step)
  }));
}

export function resolveSectionWrapSelection({
  metadata = null,
  selectedDocs = [],
  selectedSectionIds = []
} = {}) {
  const normalized = normalizeLayerManagerSections(metadata);
  const sectionIds = getSectionMoveRootIds(normalized, selectedSectionIds);
  const sectionTileIds = new Set(sectionIds.flatMap((id) => getSectionTileIds(normalized, id)));
  const looseDocs = Array.from(new Map((Array.isArray(selectedDocs) ? selectedDocs : [])
    .filter((doc) => docId(doc) && !sectionTileIds.has(docId(doc)))
    .map((doc) => [docId(doc), doc])).values());
  if (!sectionIds.length && !looseDocs.length) return null;
  const parentIds = new Set([
    ...sectionIds.map((id) => normalized.sections[id]?.parentId || ''),
    ...looseDocs.map((doc) => getTileSectionId(normalized, docId(doc)) || '')
  ]);
  if (parentIds.size !== 1) return null;
  return {
    sectionIds,
    looseDocs,
    parentId: String(parentIds.values().next().value || '').trim() || null
  };
}

export function getContiguousSectionSlice(orderedDocs = [], tileIds = []) {
  const wanted = new Set((Array.isArray(tileIds) ? tileIds : []).map(String).filter(Boolean));
  const indexes = orderedDocs
    .map((doc, index) => wanted.has(docId(doc)) ? index : -1)
    .filter((index) => index >= 0);
  if (!wanted.size || indexes.length !== wanted.size) return null;
  const start = Math.min(...indexes);
  const end = Math.max(...indexes);
  if ((end - start + 1) !== indexes.length) return null;
  return {
    start,
    end,
    above: orderedDocs.slice(0, start),
    selected: orderedDocs.slice(start, end + 1),
    below: orderedDocs.slice(end + 1)
  };
}

export function planSectionPromotion({
  orderedDocs = [],
  sectionTileIds = [],
  sourceElevation = 0,
  step = 0.001
} = {}) {
  const slice = getContiguousSectionSlice(orderedDocs, sectionTileIds);
  if (!slice) throw new Error('A Folder must occupy one contiguous stack range before it can be promoted.');
  const base = Number(sourceElevation);
  const increment = Number(step);
  if (!Number.isFinite(base) || !Number.isFinite(increment) || increment <= 0) {
    throw new Error('Invalid Folder promotion elevation.');
  }
  const promotedElevation = base + (slice.below.length ? increment : 0);
  const upperElevation = slice.above.length ? promotedElevation + increment : null;
  const insertedDepthLevels = (slice.below.length ? 1 : 0) + (slice.above.length ? 1 : 0);
  return {
    ...slice,
    promotedElevation,
    upperElevation,
    insertedDepthLevels
  };
}

export function planHigherElevationShifts({
  groups = [],
  occupiedThrough,
  step = 0.001
} = {}) {
  const increment = Number(step);
  let highestOccupied = quantizeElevation(occupiedThrough);
  if (!Number.isFinite(Number(occupiedThrough)) || !Number.isFinite(increment) || increment <= 0) {
    throw new Error('Invalid higher elevation shift plan.');
  }
  return [...groups]
    .sort((left, right) => Number(left?.elevation) - Number(right?.elevation))
    .map((group) => {
      const elevation = quantizeElevation(group?.elevation);
      const targetElevation = elevation <= highestOccupied
        ? quantizeElevation(highestOccupied + increment)
        : elevation;
      highestOccupied = targetElevation;
      return {
        ...group,
        targetElevation,
        shifted: targetElevation !== elevation
      };
    });
}
