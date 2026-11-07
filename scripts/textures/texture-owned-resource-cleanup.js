const CLEANUP_FAILURE_MARKER = 'faNexusTextureCleanupFailure';

export function isTextureCleanupFailure(error) {
  return error?.[CLEANUP_FAILURE_MARKER] === true;
}

export function destroyOwnedTextureResources({
  displayObjects = [],
  textures = [],
  context = 'Texture resource cleanup'
} = {}) {
  const failures = [];
  let destroyedDisplayObjects = 0;
  let destroyedTextures = 0;

  for (const displayObject of displayObjects || []) {
    if (!displayObject?.destroy) continue;
    try {
      displayObject.destroy({ children: true, texture: false, baseTexture: false });
      destroyedDisplayObjects += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  for (const texture of textures || []) {
    if (!texture?.destroy) continue;
    try {
      texture.destroy(true);
      destroyedTextures += 1;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length) {
    const aggregate = new AggregateError(
      failures,
      `${context} failed for ${failures.length} owned resource(s).`
    );
    aggregate[CLEANUP_FAILURE_MARKER] = true;
    aggregate.cleanupContext = context;
    throw aggregate;
  }

  return { destroyedDisplayObjects, destroyedTextures };
}
