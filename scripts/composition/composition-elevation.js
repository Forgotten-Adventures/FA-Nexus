/** Shift isolated composition sources without changing automatic Level membership.
 * Used by placement and archive restoration; never pass live Scene documents.
 */
export function offsetCompositionDocumentElevations(documents, delta) {
  if (!Number.isFinite(delta)) throw new Error('Composition elevation offset must be finite.');
  for (const { source } of documents) {
    if (typeof source.elevation === 'number') source.elevation += delta;
    else if (source.elevation) for (const key of ['bottom', 'top']) {
      if (Number.isFinite(source.elevation[key])) source.elevation[key] += delta;
    }
    for (const flags of [source.flags?.core, source.flags?.['fa-nexus']?.buildingWall,
      source.flags?.['fa-nexus']?.pathWall]) {
      if (Number.isFinite(flags?.elevation)) flags.elevation += delta;
    }
  }
}

/** The immutable image archive stays at its captured elevation. Derive the
 * current source elevation from the live primary Tile whenever it is restored.
 */
export function restoreCompositionArchiveElevation(snapshot, capturedElevation, currentElevation) {
  if (!Number.isFinite(capturedElevation) || !Number.isFinite(currentElevation)) {
    throw new Error('Cannot restore Flatten: its captured or current elevation is invalid.');
  }
  const archive = structuredClone(snapshot);
  const delta = currentElevation - capturedElevation;
  offsetCompositionDocumentElevations(archive.documents, delta);
  for (const level of archive.levels) for (const key of ['bottom', 'top', 'base']) {
    if (Number.isFinite(level.elevation?.[key])) level.elevation[key] += delta;
  }
  return archive;
}
