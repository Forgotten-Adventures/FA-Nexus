function cloneRectangle(rectangle, PIXI) {
  if (!rectangle) return null;
  if (typeof rectangle.clone === 'function') return rectangle.clone();
  return new PIXI.Rectangle(
    Number(rectangle.x) || 0,
    Number(rectangle.y) || 0,
    Number(rectangle.width) || 0,
    Number(rectangle.height) || 0
  );
}

/**
 * Create a private Pixi Texture/BaseTexture sampler around a loaded static
 * image source. Pixel storage remains shared with the loader-owned source
 * image, while WebGL sampler state and GPU texture lifetime are private.
 */
export function createOwnedSamplerTexture(sourceTexture, {
  pixi = globalThis.PIXI,
  wrapMode,
  mipmap
} = {}) {
  const sourceBase = sourceTexture?.baseTexture;
  const sourceResource = sourceBase?.resource;
  const imageSource = sourceResource?.source;
  if (!sourceBase?.valid || !imageSource) {
    throw new Error('Owned sampler textures require a valid static Pixi image source.');
  }
  if (!pixi?.BaseImageResource || !pixi?.BaseTexture || !pixi?.Texture || !pixi?.Rectangle) {
    throw new Error('Owned sampler textures require the PixiJS 7 BaseImageResource, BaseTexture, Texture, and Rectangle APIs.');
  }

  const resource = new pixi.BaseImageResource(imageSource);
  let baseTexture = null;
  let texture = null;
  try {
    const alphaMode = Number.isFinite(sourceResource.alphaMode)
      ? sourceResource.alphaMode
      : sourceBase.alphaMode;
    baseTexture = new pixi.BaseTexture(resource, {
      resolution: sourceBase.resolution,
      format: sourceBase.format,
      type: sourceBase.type,
      target: sourceBase.target,
      alphaMode,
      scaleMode: sourceBase.scaleMode,
      anisotropicLevel: sourceBase.anisotropicLevel,
      wrapMode,
      mipmap
    });
    if (!baseTexture.valid) throw new Error('Owned sampler texture could not bind the loaded image dimensions.');

    const sourceFrame = sourceTexture.frame;
    const frame = cloneRectangle(sourceFrame, pixi);
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)
      || frame.width <= 0 || frame.height <= 0) {
      throw new Error('Owned sampler texture requires a finite non-empty source frame.');
    }
    const orig = sourceTexture.orig === sourceFrame
      ? frame
      : cloneRectangle(sourceTexture.orig, pixi);
    texture = new pixi.Texture(
      baseTexture,
      frame,
      orig || frame,
      cloneRectangle(sourceTexture.trim, pixi),
      sourceTexture.rotate,
      sourceTexture.defaultAnchor,
      sourceTexture.defaultBorders
    );
    if (!texture.valid) throw new Error('Owned sampler texture could not reproduce the loaded source frame.');
  } catch (error) {
    try { texture?.destroy?.(false); } catch (_) {}
    try { baseTexture?.destroy?.(); } catch (_) {}
    try { resource.destroy?.(); } catch (_) {}
    throw error;
  }

  let released = false;
  return Object.freeze({
    texture,
    baseTexture,
    resource,
    sourceTexture,
    release() {
      if (released) return false;
      released = true;
      try { texture.destroy(false); } finally {
        try { baseTexture.destroy(); } finally {
          resource.destroy();
        }
      }
      return true;
    }
  });
}
