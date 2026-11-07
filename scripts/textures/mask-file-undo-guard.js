import { NexusLogger as Logger } from '../core/nexus-logger.js';

const MODULE_ID = 'fa-nexus';
const MASK_FLAG_KEYS = ['maskedTiling', 'standardTileMask'];

/**
 * The Texture editor keeps a Tile's mask in two alternating files, so each commit overwrites
 * the file written two edits earlier. Foundry's Undo restores only the Tile's flags. One step
 * back finds its file intact. A second step would point the Tile at a file which now holds a
 * later edit's mask, and every client would draw that mask under the older edit's crop and
 * size. That Undo is refused with its reason.
 *
 * Each mask file's content is the last mask path a commit stored for it. Undo history does not
 * outlive the session either, so a file with no recorded commit still holds what the Tile says.
 */
const latestCommittedMaskSrc = new Map();

function maskFileOf(maskSrc) {
  return String(maskSrc).split('?')[0];
}

function readMaskSrcChanges(changes) {
  const moduleFlags = changes?.flags?.[MODULE_ID];
  return MASK_FLAG_KEYS.flatMap((flagKey) => {
    const maskSrc = moduleFlags?.[flagKey]?.maskSrc
      ?? changes?.[`flags.${MODULE_ID}.${flagKey}`]?.maskSrc
      ?? changes?.[`flags.${MODULE_ID}.${flagKey}.maskSrc`];
    return typeof maskSrc === 'string' && maskSrc ? [{ flagKey, maskSrc }] : [];
  });
}

function recordCommittedMaskFiles(tile, changes, options = {}) {
  if (options?.isUndo === true) return;
  for (const { maskSrc } of readMaskSrcChanges(changes)) {
    latestCommittedMaskSrc.set(maskFileOf(maskSrc), maskSrc);
  }
}

function blockUndoToReplacedMaskFile(tile, changes, options = {}, userId = null) {
  if (options?.isUndo !== true) return true;
  if (userId && userId !== globalThis.game?.user?.id) return true;
  if (Object.keys(options).some((key) => key.startsWith('faNexus'))) return true;
  const replaced = readMaskSrcChanges(changes).filter(({ maskSrc }) => {
    const committed = latestCommittedMaskSrc.get(maskFileOf(maskSrc));
    return committed !== undefined && committed !== maskSrc;
  });
  if (!replaced.length) return true;
  Logger.warn('MaskFileUndoGuard.undo.blocked', {
    tileUuid: String(tile?.uuid || ''),
    restored: replaced.map(({ maskSrc }) => maskSrc),
    committed: replaced.map(({ maskSrc }) => latestCommittedMaskSrc.get(maskFileOf(maskSrc)))
  });
  globalThis.ui?.notifications?.warn?.(
    'Undo cannot restore this mask: a later edit has replaced its file. The Tile keeps its current mask.'
  );
  return false;
}

if (globalThis.Hooks?.on) {
  Hooks.on('createTile', (tile, options) => recordCommittedMaskFiles(tile, tile?._source, options));
  Hooks.on('updateTile', recordCommittedMaskFiles);
  Hooks.on('preUpdateTile', blockUndoToReplacedMaskFile);
}
