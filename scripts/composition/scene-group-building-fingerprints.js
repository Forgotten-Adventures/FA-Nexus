import { fingerprintBuildingV2Authoring } from '../buildings/v2/building-v2-existing-edit-runtime.js';
import { compileBuildingV2FillMaskSource, validateBuildingV2FillMaskSource } from '../buildings/v2/building-v2-fill-mask-runtime.js';

const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const equal = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));

// Copying may replace document references or asset paths in otherwise identical
// authoring and runtime payloads. Validate the source before updating that
// derived fingerprint; never use copying to repair an inconsistent Building.
export function preserveBuildingFingerprints(originalDocuments, changedDocuments) {
  for (let index = 0; index < originalDocuments.length; index++) {
    const original = originalDocuments[index].source.flags?.['fa-nexus']?.building;
    if (![4, 5].includes(Number(original?.schemaVersion))) continue;
    if (!original.authoring || !original.runtime || fingerprintBuildingV2Authoring(original.authoring) !== original.runtime.authoringFingerprint) {
      throw new Error('The source Building has inconsistent authoring and rendered data. Reopen and repair it before continuing.');
    }
    const changed = changedDocuments[index].source.flags['fa-nexus'].building;
    const projection = original.runtime.fillProjection;
    if (projection) {
      const priorMask = validateBuildingV2FillMaskSource(projection.maskSource);
      if (projection.maskSourceFingerprint !== priorMask.fingerprint) throw new Error('The source Building Fill projection has an inconsistent fingerprint.');
      const nextMask = compileBuildingV2FillMaskSource(changed.authoring);
      const nextProjection = changed.runtime.fillProjection;
      // Rebind derived integrity after an intentional reference/path rewrite,
      // without accepting unrelated changes to the compiled Fill authority.
      if (!equal({ ...nextProjection?.maskSource, fingerprint: nextMask.fingerprint }, nextMask)) {
        throw new Error('The copied Building Fill projection does not match its authoring.');
      }
      nextProjection.maskSource = structuredClone(nextMask);
      nextProjection.maskSourceFingerprint = nextMask.fingerprint;
      for (let dependent = 0; dependent < originalDocuments.length; dependent++) {
        const flags = originalDocuments[dependent].source.flags?.['fa-nexus'];
        if (flags?.buildingFill?.wallTileId !== originalDocuments[index].source._id) continue;
        if (flags.maskedTiling?.sourceFingerprint !== priorMask.fingerprint) throw new Error('The source managed Fill has an inconsistent fingerprint.');
        changedDocuments[dependent].source.flags['fa-nexus'].maskedTiling.sourceFingerprint = nextMask.fingerprint;
      }
    }
    changed.runtime.authoringFingerprint = fingerprintBuildingV2Authoring(changed.authoring);
  }
  return changedDocuments;
}
