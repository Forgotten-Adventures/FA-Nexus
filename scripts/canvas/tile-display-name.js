const MODULE_ID = 'fa-nexus';

function normalizeName(value) {
  return String(value ?? '').trim();
}

function readFaFlags(document) {
  return document?.flags?.[MODULE_ID]
    || document?._source?.flags?.[MODULE_ID]
    || null;
}

/**
 * Resolve one stable Tile label for every FA Nexus surface.
 *
 * Precedence intentionally matches Layer Manager's established behavior.
 */
export function resolveTileDisplayName(tileOrDocument, index = 0) {
  const document = tileOrDocument?.document || tileOrDocument || null;
  const sourceName = normalizeName(document?._source?.name);
  if (sourceName) return sourceName;

  const documentName = normalizeName(document?.name);
  if (documentName) return documentName;

  const flags = readFaFlags(document);
  const explicitName = normalizeName(flags?.name);
  if (explicitName) return explicitName;

  const legacyLabel = normalizeName(flags?.label || document?.label);
  if (legacyLabel) return legacyLabel;

  if (flags?.maskedTiling?.baseColor) return 'Solid Color';

  const source = normalizeName(document?.texture?.src || document?._source?.texture?.src);
  if (source) {
    const filename = source.split('/').pop() || source;
    const base = filename.replace(/\.[^/.]+$/, '');
    return base || filename;
  }

  const fallbackIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  return `Tile ${fallbackIndex + 1}`;
}
