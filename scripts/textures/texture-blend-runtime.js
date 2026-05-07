import { NexusLogger as Logger } from '../core/nexus-logger.js';
import {
  applyHsbcToDisplayObject,
  readDocumentHsbc
} from '../core/hsbc.js';
import { getMaxTextureSize } from './texture-runtime-core.js';

const MASKED_TILING_FLAG = 'maskedTiling';
const MASKED_TEXTURE_BLEND_FILTER_KEY = Symbol('faNexusMaskedTextureBlendFilter');
const MASKED_TEXTURE_BLEND_FILTER_KIND_KEY = Symbol('faNexusMaskedTextureBlendFilterKind');
const MASKED_TEXTURE_BLEND_FILTER_MODE_KEY = Symbol('faNexusMaskedTextureBlendFilterMode');
const MASKED_TEXTURE_BLEND_FILTER_BACKDROP_KEY = Symbol('faNexusMaskedTextureBlendFilterBackdrop');
const MASKED_TEXTURE_BLEND_FILTER_BACKDROP_OWNED_KEY = Symbol('faNexusMaskedTextureBlendFilterBackdropOwned');
const MASKED_TEXTURE_BACKDROP_FILTER_PATCHED_KEY = Symbol.for('faNexusMaskedTextureBackdropFilterPatched');
const MASKED_TEXTURE_BACKDROP_FILTER_STATE_KEY = Symbol('faNexusMaskedTextureBackdropFilterState');
const MASKED_TEXTURE_BLEND_BACKDROP_FRAME_KEY = Symbol('faNexusMaskedTextureBlendBackdropFrame');
const MASKED_TEXTURE_BLEND_BACKDROP_FRAME_PROP = 'faNexusMaskedTextureBlendBackdropFrame';

export const DEFAULT_MASKED_TEXTURE_BLEND_MODE = 'normal';

const MASKED_TEXTURE_BLEND_MODE_DEFS = Object.freeze([
  Object.freeze({ id: 'normal', label: 'Normal', pixiKey: 'NORMAL' }),
  Object.freeze({ id: 'overlay', label: 'Overlay', pixiKey: 'OVERLAY', customMode: true }),
  Object.freeze({ id: 'soft-light', label: 'Soft Light', pixiKey: 'SOFT_LIGHT', customMode: true }),
  Object.freeze({ id: 'multiply', label: 'Multiply', pixiKey: 'MULTIPLY' }),
  Object.freeze({ id: 'screen', label: 'Screen', pixiKey: 'SCREEN' }),
  Object.freeze({ id: 'add', label: 'Add', pixiKey: 'ADD' })
]);

const DISTINCT_MASKED_TEXTURE_BLEND_MODE_KEYS = Object.freeze(['ADD', 'MULTIPLY', 'SCREEN']);

const MASKED_TEXTURE_BLEND_FILTER_FRAGMENT = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;

void main() {
\tgl_FragColor = texture2D(uSampler, vTextureCoord);
}
`;

const MASKED_TEXTURE_ADVANCED_BLEND_FILTER_FRAGMENT = `
varying vec2 vTextureCoord;

uniform sampler2D uSampler;
uniform sampler2D backdrop;
uniform vec2 backdrop_flipY;
uniform float blendModeIndex;

float softLightD(float value) {
  if (value <= 0.25) {
    return ((16.0 * value - 12.0) * value + 4.0) * value;
  }
  return sqrt(max(value, 0.0));
}

float overlayChannel(float base, float blend) {
  return base <= 0.5
    ? (2.0 * base * blend)
    : (1.0 - (2.0 * (1.0 - base) * (1.0 - blend)));
}

float softLightChannel(float base, float blend) {
  return blend <= 0.5
    ? (base - ((1.0 - 2.0 * blend) * base * (1.0 - base)))
    : (base + ((2.0 * blend - 1.0) * (softLightD(base) - base)));
}

vec3 applyAdvancedBlend(vec3 base, vec3 blend, float modeIndex) {
  if (modeIndex >= 0.5) {
    return vec3(
      softLightChannel(base.r, blend.r),
      softLightChannel(base.g, blend.g),
      softLightChannel(base.b, blend.b)
    );
  }
  return vec3(
    overlayChannel(base.r, blend.r),
    overlayChannel(base.g, blend.g),
    overlayChannel(base.b, blend.b)
  );
}

void main() {
  vec4 src = texture2D(uSampler, vTextureCoord);
  float sourceAlpha = clamp(src.a, 0.0, 1.0);
\tif (sourceAlpha <= 0.0) {
\t  gl_FragColor = vec4(0.0);
\t  return;
\t}

\tvec2 backdropCoord = vec2(vTextureCoord.x, backdrop_flipY.x + (backdrop_flipY.y * vTextureCoord.y));
\tvec2 safeBackdropCoord = clamp(backdropCoord, vec2(0.0), vec2(1.0));
\tvec4 backdropColor = texture2D(backdrop, safeBackdropCoord);
\tfloat backdropAlpha = clamp(backdropColor.a, 0.0, 1.0);
\tvec3 base = backdropColor.rgb / max(backdropAlpha, 1.0e-6);
\tvec3 blend = src.rgb / max(sourceAlpha, 1.0e-6);
  vec3 blended = clamp(applyAdvancedBlend(base, blend, blendModeIndex), 0.0, 1.0);

  // Match the spec's "blend in place, then source-over composite" model.
  vec3 blendedSource = clamp(mix(blend, blended, backdropAlpha), 0.0, 1.0);
  gl_FragColor = vec4(blendedSource * sourceAlpha, sourceAlpha);
}
`;

function getMaskedTextureBlendModeDef(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return null;
  return MASKED_TEXTURE_BLEND_MODE_DEFS.find((entry) => entry.id === normalized) || null;
}

function getRendererBlendModeMappings() {
  try {
    return canvas?.app?.renderer?.state?.blendModes || null;
  } catch (_) {
    return null;
  }
}

function normalizeBlendModeMappingSignature(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const normalized = [];
  for (const entry of value) {
    const numeric = Number(entry);
    if (!Number.isFinite(numeric)) return null;
    normalized.push(numeric);
  }
  return normalized.join(',');
}

function getMaskedTextureBlendModeSupport(definition) {
  if (!definition) {
    return {
      supported: false,
      reason: 'unknown'
    };
  }
  const blendModes = PIXI?.BLEND_MODES ?? null;
  const mode = definition.customMode ? (blendModes?.NORMAL ?? 0) : blendModes?.[definition.pixiKey];
  if (definition.customMode) {
    return {
      supported: !!(PIXI?.Filter && canvas?.app?.renderer && canvas?.primary),
      reason: (PIXI?.Filter && canvas?.app?.renderer && canvas?.primary) ? null : 'missing-custom-filter-runtime',
      mode
    };
  }
  if (mode === undefined) {
    return {
      supported: false,
      reason: 'missing-enum',
      mode: null
    };
  }
  if (definition.id === DEFAULT_MASKED_TEXTURE_BLEND_MODE) {
    return {
      supported: true,
      reason: null,
      mode
    };
  }

  const mappings = getRendererBlendModeMappings();
  const normalMode = blendModes?.NORMAL;
  const signature = normalizeBlendModeMappingSignature(mappings?.[mode]);
  const normalSignature = normalizeBlendModeMappingSignature(mappings?.[normalMode]);
  if (signature && normalSignature) {
    return {
      supported: signature !== normalSignature,
      reason: signature !== normalSignature ? null : 'same-as-normal',
      mode
    };
  }

  const supported = DISTINCT_MASKED_TEXTURE_BLEND_MODE_KEYS.includes(definition.pixiKey);
  return {
    supported,
    reason: supported ? null : 'not-whitelisted',
    mode
  };
}

function getFirstSupportedMaskedTextureBlendModeId() {
  const definition = MASKED_TEXTURE_BLEND_MODE_DEFS.find((entry) => getMaskedTextureBlendModeSupport(entry).supported) || null;
  return definition?.id || DEFAULT_MASKED_TEXTURE_BLEND_MODE;
}

function markMaskedTextureBlendFilter(filter, kind = 'state') {
  if (!filter) return filter;
  try {
    Object.defineProperty(filter, MASKED_TEXTURE_BLEND_FILTER_KEY, {
      value: true,
      configurable: true
    });
  } catch (_) {
    try { filter[MASKED_TEXTURE_BLEND_FILTER_KEY] = true; } catch (_) {}
  }
  try {
    Object.defineProperty(filter, MASKED_TEXTURE_BLEND_FILTER_KIND_KEY, {
      value: kind,
      configurable: true,
      writable: true
    });
  } catch (_) {
    try { filter[MASKED_TEXTURE_BLEND_FILTER_KIND_KEY] = kind; } catch (_) {}
  }
  return filter;
}

function isMaskedTextureBlendFilter(filter) {
  return !!filter?.[MASKED_TEXTURE_BLEND_FILTER_KEY];
}

function setMaskedTextureBlendFilterMode(filter, modeId) {
  if (!filter) return filter;
  try {
    Object.defineProperty(filter, MASKED_TEXTURE_BLEND_FILTER_MODE_KEY, {
      value: modeId,
      configurable: true,
      writable: true
    });
  } catch (_) {
    try { filter[MASKED_TEXTURE_BLEND_FILTER_MODE_KEY] = modeId; } catch (_) {}
  }
  return filter;
}

function updateManagedMaskedTextureBlendFilter(filter, resolved) {
  if (!filter || filter.destroyed || !resolved) return false;
  const kind = filter?.[MASKED_TEXTURE_BLEND_FILTER_KIND_KEY] || null;
  if (resolved.customMode) {
    if (kind !== 'advanced') return false;
    try {
      if (filter.uniforms) filter.uniforms.blendModeIndex = resolved.id === 'soft-light' ? 1 : 0;
    } catch (_) {}
    setMaskedTextureBlendFilterMode(filter, resolved.id);
    return true;
  }
  if (kind !== 'state') return false;
  try {
    if (filter.state) filter.state.blendMode = resolved.mode;
  } catch (_) {}
  setMaskedTextureBlendFilterMode(filter, resolved.id);
  return true;
}

function destroyMaskedTextureBlendFilter(filter) {
  if (!filter || filter.destroyed) return;
  const backdropTexture = filter?.[MASKED_TEXTURE_BLEND_FILTER_BACKDROP_KEY] || null;
  const ownsBackdrop = filter?.[MASKED_TEXTURE_BLEND_FILTER_BACKDROP_OWNED_KEY] === true;
  if (ownsBackdrop && backdropTexture && !backdropTexture.destroyed) {
    try { backdropTexture.destroy(true); } catch (_) {}
  }
  scheduleMaskedTextureBlendFilterDestroy(filter);
}

function scheduleMaskedTextureBlendFilterDestroy(filter) {
  if (!filter || filter.destroyed) return;
  const destroy = () => {
    try {
      if (!filter.destroyed) filter.destroy?.();
    } catch (_) {}
  };
  try {
    if (typeof globalThis?.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => {
        try { globalThis.setTimeout?.(destroy, 0); }
        catch (_) { destroy(); }
      });
      return;
    }
  } catch (_) {}
  try { globalThis.setTimeout?.(destroy, 0); }
  catch (_) { destroy(); }
}

function createPassThroughMaskedTextureBlendFilter(mode) {
  const filter = markMaskedTextureBlendFilter(new PIXI.Filter(
    PIXI.Filter.defaultVertexSrc,
    MASKED_TEXTURE_BLEND_FILTER_FRAGMENT,
    {}
  ), 'state');
  filter.padding = 0;
  try {
    if (filter.state) filter.state.blendMode = mode;
  } catch (_) {}
  return filter;
}

function ensureMaskedTextureBackdropFilterSupport(logger = Logger) {
  try {
    const FilterSystem = PIXI?.FilterSystem || null;
    const TextureSystem = PIXI?.TextureSystem || null;
    if (!FilterSystem?.prototype) return false;
    if (FilterSystem.prototype[MASKED_TEXTURE_BACKDROP_FILTER_PATCHED_KEY]) return true;
    const originalPush = FilterSystem.prototype.push;
    const originalPop = FilterSystem.prototype.pop;
    if (typeof originalPush !== 'function' || typeof originalPop !== 'function') return false;

    const containsRect = (outer, inner) => {
      const r1 = Number(inner?.x || 0) + Number(inner?.width || 0);
      const b1 = Number(inner?.y || 0) + Number(inner?.height || 0);
      const r2 = Number(outer?.x || 0) + Number(outer?.width || 0);
      const b2 = Number(outer?.y || 0) + Number(outer?.height || 0);
      return (Number(inner?.x || 0) >= Number(outer?.x || 0))
        && (Number(inner?.x || 0) <= r2)
        && (Number(inner?.y || 0) >= Number(outer?.y || 0))
        && (Number(inner?.y || 0) <= b2)
        && (r1 >= Number(outer?.x || 0))
        && (r1 <= r2)
        && (b1 >= Number(outer?.y || 0))
        && (b1 <= b2);
    };

    if (TextureSystem?.prototype && (typeof TextureSystem.prototype.bindForceLocation !== 'function')) {
      TextureSystem.prototype.bindForceLocation = function bindForceLocation(texture, location = 0) {
        const gl = this.gl;
        if (this.currentLocation !== location) {
          this.currentLocation = location;
          gl.activeTexture(gl.TEXTURE0 + location);
        }
        this.bind(texture, location);
      };
    }

    FilterSystem.prototype.prepareBackdrop = function prepareBackdrop(bounds, flipY) {
      const renderer = this.renderer;
      const renderTarget = renderer.renderTexture.current;
      const sourceFrame = renderer.renderTexture.sourceFrame;
      const transform = renderer.projection.transform || PIXI.Matrix.IDENTITY;

      let resolution = 1;
      if (renderTarget) {
        resolution = renderTarget.baseTexture.resolution;
        flipY[1] = 1.0;
      } else {
        if (renderer.background?.alpha >= 1) {
          logger?.error?.('TextureRender.maskedTiling.blendMode.backdropMainFramebufferUnsupported', {});
          return null;
        }
        resolution = renderer.resolution;
        flipY[1] = -1.0;
      }

      const x = Math.round((bounds.x - sourceFrame.x + transform.tx) * resolution);
      const dy = bounds.y - sourceFrame.y + transform.ty;
      const y = Math.round((flipY[1] < 0.0 ? sourceFrame.height - (dy + bounds.height) : dy) * resolution);
      const w = Math.max(1, Math.round(bounds.width * resolution));
      const h = Math.max(1, Math.round(bounds.height * resolution));
      const backdrop = this.getOptimalFilterTexture(w, h, 1);
      if (flipY[1] < 0) flipY[0] = h / Math.max(1, backdrop.height);
      else flipY[0] = 0;
      backdrop.filterFrame = sourceFrame;
      backdrop.setResolution(resolution);
      renderer.texture.bindForceLocation(backdrop.baseTexture, 0);
      renderer.gl.copyTexSubImage2D(renderer.gl.TEXTURE_2D, 0, 0, 0, x, y, w, h);
      return backdrop;
    };

    FilterSystem.prototype.push = function maskedTextureBackdropPush(target, filters) {
      const backdropFilters = Array.isArray(filters) ? filters.filter((filter) => !!filter?.backdropUniformName) : [];
      if (!backdropFilters.length) return originalPush.call(this, target, filters);

      const renderer = this.renderer;
      const filterStack = this.defaultFilterStack;
      const state = this.statePool.pop() || new PIXI.FilterState();
      const renderTextureSystem = renderer.renderTexture;
      let currentResolution;
      let currentMultisample;
      if (renderTextureSystem.current) {
        const renderTexture = renderTextureSystem.current;
        currentResolution = renderTexture.resolution;
        currentMultisample = renderTexture.multisample;
      } else {
        currentResolution = renderer.resolution;
        currentMultisample = renderer.multisample;
      }

      let resolution = filters[0].resolution || currentResolution;
      let multisample = filters[0].multisample ?? currentMultisample;
      let padding = filters[0].padding;
      let autoFit = filters[0].autoFit;
      let legacy = filters[0].legacy ?? true;
      for (let i = 1; i < filters.length; i += 1) {
        const filter = filters[i];
        resolution = Math.min(resolution, filter.resolution || currentResolution);
        multisample = Math.min(multisample, filter.multisample ?? currentMultisample);
        padding = this.useMaxPadding ? Math.max(padding, filter.padding) : (padding + filter.padding);
        autoFit = autoFit && filter.autoFit;
        legacy = legacy || (filter.legacy ?? true);
      }

      if (filterStack.length === 1) {
        this.defaultFilterStack[0].renderTexture = renderTextureSystem.current;
      }

      filterStack.push(state);
      state.resolution = resolution;
      state.multisample = multisample;
      state.legacy = legacy;
      state.target = target;
      state.sourceFrame.copyFrom(target.filterArea || target.getBounds(true));
      state.sourceFrame.pad(padding);

      const sourceFrameProjected = this.tempRect.copyFrom(renderTextureSystem.sourceFrame);
      if (renderer.projection.transform) {
        this.transformAABB(
          new PIXI.Matrix().copyFrom(renderer.projection.transform).invert(),
          sourceFrameProjected
        );
      }

      let canUseBackdrop = true;
      if (autoFit) {
        state.sourceFrame.fit(sourceFrameProjected);
        if ((state.sourceFrame.width <= 0) || (state.sourceFrame.height <= 0)) {
          state.sourceFrame.width = 0;
          state.sourceFrame.height = 0;
        }
      } else {
        canUseBackdrop = containsRect(this.renderer.renderTexture.sourceFrame, state.sourceFrame);
        if (!state.sourceFrame.intersects(sourceFrameProjected)) {
          state.sourceFrame.width = 0;
          state.sourceFrame.height = 0;
        }
      }

      this.roundFrame(
        state.sourceFrame,
        renderTextureSystem.current ? renderTextureSystem.current.resolution : renderer.resolution,
        renderTextureSystem.sourceFrame,
        renderTextureSystem.destinationFrame,
        renderer.projection.transform
      );

      if (canUseBackdrop) {
        let backdropTexture = null;
        let backdropFlip = null;
        for (const filter of backdropFilters) {
          const uniformName = filter.backdropUniformName;
          const uniforms = filter.uniforms || (filter.uniforms = {});
          if (!uniforms[`${uniformName}_flipY`]) {
            uniforms[`${uniformName}_flipY`] = new Float32Array([0.0, 1.0]);
          }
          const flip = uniforms[`${uniformName}_flipY`];
          if (!backdropTexture) {
            backdropTexture = this.prepareBackdrop(state.sourceFrame, flip);
            backdropFlip = flip;
          } else if (backdropFlip) {
            flip[0] = backdropFlip[0];
            flip[1] = backdropFlip[1];
          }
          uniforms[uniformName] = backdropTexture;
          if (backdropTexture) filter._backdropActive = true;
        }
        if (backdropTexture) state.resolution = resolution = backdropTexture.resolution;
      }

      state.renderTexture = this.getOptimalFilterTexture(
        state.sourceFrame.width,
        state.sourceFrame.height,
        resolution,
        multisample
      );
      state.filters = filters;
      state[MASKED_TEXTURE_BACKDROP_FILTER_STATE_KEY] = true;
      state.destinationFrame.width = state.renderTexture.width;
      state.destinationFrame.height = state.renderTexture.height;

      const destinationFrame = this.tempRect;
      destinationFrame.x = 0;
      destinationFrame.y = 0;
      destinationFrame.width = state.sourceFrame.width;
      destinationFrame.height = state.sourceFrame.height;

      state.renderTexture.filterFrame = state.sourceFrame;
      state.bindingSourceFrame.copyFrom(renderTextureSystem.sourceFrame);
      state.bindingDestinationFrame.copyFrom(renderTextureSystem.destinationFrame);
      state.transform = renderer.projection.transform;
      renderer.projection.transform = null;
      renderTextureSystem.bind(state.renderTexture, state.sourceFrame, destinationFrame);
      const clearColor = filters[filters.length - 1].clearColor;
      if (clearColor) renderer.framebuffer.clear(clearColor[0], clearColor[1], clearColor[2], clearColor[3]);
      else renderer.framebuffer.clear(0, 0, 0, 0);
    };

    FilterSystem.prototype.pop = function maskedTextureBackdropPop() {
      const state = this.defaultFilterStack?.[this.defaultFilterStack.length - 1] || null;
      const backdropFilters = Array.isArray(state?.filters)
        ? state.filters.filter((filter) => !!filter?.backdropUniformName)
        : [];
      try {
        return originalPop.call(this);
      } finally {
        let released = false;
        for (const filter of backdropFilters) {
          if (!filter?._backdropActive) continue;
          const uniformName = filter.backdropUniformName;
          const texture = filter.uniforms?.[uniformName] || null;
          if (!released && texture) {
            try { this.returnFilterTexture(texture); } catch (_) {}
            released = true;
          }
          try { if (filter.uniforms) filter.uniforms[uniformName] = null; } catch (_) {}
          try { filter._backdropActive = false; } catch (_) {}
        }
      }
    };

    try {
      Object.defineProperty(FilterSystem.prototype, MASKED_TEXTURE_BACKDROP_FILTER_PATCHED_KEY, {
        value: true,
        configurable: true
      });
    } catch (_) {
      FilterSystem.prototype[MASKED_TEXTURE_BACKDROP_FILTER_PATCHED_KEY] = true;
    }
    return true;
  } catch (error) {
    logger?.error?.('TextureRender.maskedTiling.blendMode.filterSystemPatchFailed', {
      error: String(error?.message || error)
    });
    return false;
  }
}

function createAdvancedMaskedTextureBlendFilter(resolved) {
  if (!ensureMaskedTextureBackdropFilterSupport()) return null;
  const filter = markMaskedTextureBlendFilter(new PIXI.Filter(
    PIXI.Filter.defaultVertexSrc,
    MASKED_TEXTURE_ADVANCED_BLEND_FILTER_FRAGMENT,
    {
      backdrop: null,
      backdrop_flipY: new Float32Array([0.0, 1.0]),
      blendModeIndex: resolved?.id === 'soft-light' ? 1 : 0
    }
  ), 'advanced');
  filter.padding = 0;
  try {
    if (filter.state) filter.state.blendMode = PIXI?.BLEND_MODES?.NORMAL ?? 0;
  } catch (_) {}
  try { filter.backdropUniformName = 'backdrop'; } catch (_) {}
  try { filter._backdropActive = false; } catch (_) {}
  try { filter.clearColor = null; } catch (_) {}
  try { filter[MASKED_TEXTURE_BLEND_FILTER_BACKDROP_KEY] = null; } catch (_) {}
  try { filter[MASKED_TEXTURE_BLEND_FILTER_BACKDROP_OWNED_KEY] = false; } catch (_) {}
  return filter;
}

function hidePrimaryChildrenAtAndAbove(primary, currentObject) {
  const hidden = [];
  try {
    if (!primary || !currentObject) return hidden;
    if (primary.sortDirty && typeof primary.sortChildren === 'function') {
      try { primary.sortChildren(); } catch (_) {}
    }
    const children = Array.isArray(primary.children) ? primary.children : [];
    const index = children.indexOf(currentObject);
    if (index < 0) {
      Logger.error?.('TextureRender.maskedTiling.backdrop.captureTargetMissing', {
        currentName: currentObject?.name || null
      });
      return hidden;
    }
    for (let i = index; i < children.length; i += 1) {
      const child = children[i];
      if (!child || child.destroyed) continue;
      hidden.push({
        child,
        visible: child.visible !== false,
        renderable: child.renderable !== false
      });
      try { child.visible = false; } catch (_) {}
      try { if (typeof child.renderable === 'boolean') child.renderable = false; } catch (_) {}
    }
  } catch (error) {
    Logger.error?.('TextureRender.maskedTiling.backdrop.captureHideFailed', {
      error: String(error?.message || error),
      currentName: currentObject?.name || null
    });
  }
  return hidden;
}

function restorePrimaryHiddenChildren(hidden = []) {
  for (const entry of hidden) {
    const child = entry?.child;
    if (!child || child.destroyed) continue;
    try { child.visible = entry.visible !== false; } catch (_) {}
    try { if (typeof child.renderable === 'boolean') child.renderable = entry.renderable !== false; } catch (_) {}
  }
}

function resolveBackdropCaptureSize(width, height) {
  const maxTextureSize = getMaxTextureSize();
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const scale = Math.min(1, maxTextureSize / Math.max(safeWidth, safeHeight));
  return {
    pixelWidth: Math.max(1, Math.round(safeWidth * scale)),
    pixelHeight: Math.max(1, Math.round(safeHeight * scale)),
    scaleX: Math.max(1e-6, (Math.max(1, Math.round(safeWidth * scale))) / safeWidth),
    scaleY: Math.max(1e-6, (Math.max(1, Math.round(safeHeight * scale))) / safeHeight)
  };
}

function setMaskedTextureBlendBackdropFrame(target, frame) {
  if (!target || typeof frame !== 'object') return target;
  const normalized = {
    x: Number.isFinite(Number(frame.x)) ? Number(frame.x) : 0,
    y: Number.isFinite(Number(frame.y)) ? Number(frame.y) : 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1)
  };
  try {
    Object.defineProperty(target, MASKED_TEXTURE_BLEND_BACKDROP_FRAME_KEY, {
      value: normalized,
      configurable: true,
      writable: true
    });
  } catch (_) {
    try { target[MASKED_TEXTURE_BLEND_BACKDROP_FRAME_KEY] = normalized; } catch (_) {}
  }
  try { target[MASKED_TEXTURE_BLEND_BACKDROP_FRAME_PROP] = normalized; } catch (_) {}
  return target;
}

export function isCustomMaskedTextureBlendMode(value) {
  const resolved = getMaskedTextureBlendModeDef(value);
  return !!resolved?.customMode;
}

export function captureMaskedTextureBlendBackdrop({
  currentObject = null,
  bounds = null,
  logger = Logger,
  logTag = 'TextureRender.maskedTiling.backdrop.captureFailed'
} = {}) {
  let renderTexture = null;
  let hiddenChildren = [];
  let updateTexture = null;
  let captureSprite = null;
  try {
    const renderer = canvas?.app?.renderer || null;
    const primary = canvas?.primary || null;
    const stage = canvas?.stage || null;
    if (!renderer || !primary || !currentObject || currentObject.destroyed) return null;
    const x = Number(bounds?.x);
    const y = Number(bounds?.y);
    const width = Number(bounds?.width);
    const height = Number(bounds?.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;

    hiddenChildren = hidePrimaryChildrenAtAndAbove(primary, currentObject);
    const worldTransform = stage?.worldTransform || null;
    const topLeft = worldTransform?.apply?.(new PIXI.Point(x, y)) || new PIXI.Point(x, y);
    const bottomRight = worldTransform?.apply?.(new PIXI.Point(x + width, y + height)) || new PIXI.Point(x + width, y + height);
    const screenFrame = {
      x: Math.min(Number(topLeft.x) || 0, Number(bottomRight.x) || 0),
      y: Math.min(Number(topLeft.y) || 0, Number(bottomRight.y) || 0),
      width: Math.max(1, Math.abs((Number(bottomRight.x) || 0) - (Number(topLeft.x) || 0))),
      height: Math.max(1, Math.abs((Number(bottomRight.y) || 0) - (Number(topLeft.y) || 0)))
    };
    const { pixelWidth, pixelHeight, scaleX, scaleY } = resolveBackdropCaptureSize(screenFrame.width, screenFrame.height);
    renderTexture = PIXI.RenderTexture.create({
      width: pixelWidth,
      height: pixelHeight,
      resolution: 1,
      scaleMode: PIXI.SCALE_MODES.LINEAR
    });
    try {
      if (renderTexture?.baseTexture) renderTexture.baseTexture.clearColor = [0, 0, 0, 0];
    } catch (_) {}
    setMaskedTextureBlendBackdropFrame(renderTexture, screenFrame);

    updateTexture = PIXI.RenderTexture.create({ width: 1, height: 1, resolution: 1 });
    try { primary.renderDirty = true; } catch (_) {}
    renderer.render(primary, {
      renderTexture: updateTexture,
      clear: false,
      skipUpdateTransform: false
    });
    captureSprite = new PIXI.Sprite(primary.renderTexture);
    captureSprite.eventMode = 'none';
    captureSprite.position.set(0, 0);
    captureSprite.width = renderer.screen.width;
    captureSprite.height = renderer.screen.height;
    const transform = new PIXI.Matrix(scaleX, 0, 0, scaleY, -screenFrame.x * scaleX, -screenFrame.y * scaleY);
    renderer.render(captureSprite, {
      renderTexture,
      clear: true,
      transform,
      skipUpdateTransform: false
    });
    return renderTexture;
  } catch (error) {
    logger?.error?.(logTag, {
      error: String(error?.message || error),
      currentName: currentObject?.name || null,
      bounds: bounds || null
    });
    if (renderTexture && !renderTexture.destroyed) {
      try { renderTexture.destroy(true); } catch (_) {}
    }
    return null;
  } finally {
    try { restorePrimaryHiddenChildren(hiddenChildren); } catch (_) {}
    try { captureSprite?.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
    try { updateTexture?.destroy?.(true); } catch (_) {}
  }
}

function syncMaskedTextureBlendFilter(displayObject, resolved, {
  logger = Logger,
  backdropTexture = null
} = {}) {
  if (!displayObject || displayObject.destroyed || !resolved) return resolved?.id || DEFAULT_MASKED_TEXTURE_BLEND_MODE;
  const currentFilters = Array.isArray(displayObject.filters) ? displayObject.filters.filter(Boolean) : [];
  const nextFilters = [];
  let reusableManagedFilter = null;
  const desiredKind = resolved.customMode ? 'advanced' : 'state';
  for (const filter of currentFilters) {
    if (isMaskedTextureBlendFilter(filter)) {
      if (!reusableManagedFilter && resolved.id !== DEFAULT_MASKED_TEXTURE_BLEND_MODE && filter?.[MASKED_TEXTURE_BLEND_FILTER_KIND_KEY] === desiredKind) {
        reusableManagedFilter = filter;
        continue;
      }
      destroyMaskedTextureBlendFilter(filter);
      continue;
    }
    nextFilters.push(filter);
  }

  try {
    displayObject.blendMode = PIXI?.BLEND_MODES?.NORMAL ?? 0;
  } catch (error) {
    logger?.error?.('TextureRender.maskedTiling.blendMode.resetFailed', {
      value: resolved.id,
      error: String(error?.message || error)
    });
  }

  if (resolved.id !== DEFAULT_MASKED_TEXTURE_BLEND_MODE) {
    let managedFilter = reusableManagedFilter;
    if (managedFilter) {
      updateManagedMaskedTextureBlendFilter(managedFilter, resolved);
    } else if (resolved.customMode) {
      managedFilter = createAdvancedMaskedTextureBlendFilter(resolved, backdropTexture);
      if (!managedFilter) {
        logger?.error?.('TextureRender.maskedTiling.blendMode.filterCreateFailed', {
          value: resolved.id
        });
      }
    } else {
      managedFilter = createPassThroughMaskedTextureBlendFilter(resolved.mode);
    }
    if (managedFilter) {
      setMaskedTextureBlendFilterMode(managedFilter, resolved.id);
      nextFilters.push(managedFilter);
    }
  }

  try {
    displayObject.filters = nextFilters.length ? nextFilters : null;
  } catch (error) {
    logger?.error?.('TextureRender.maskedTiling.blendMode.filterApplyFailed', {
      value: resolved.id,
      error: String(error?.message || error)
    });
  }

  return resolved.id;
}

export function normalizeMaskedTextureBlendMode(value, {
  fallback = DEFAULT_MASKED_TEXTURE_BLEND_MODE,
  supportedOnly = true
} = {}) {
  const resolved = getMaskedTextureBlendModeDef(value);
  if (resolved && (!supportedOnly || getMaskedTextureBlendModeSupport(resolved).supported)) return resolved.id;
  const fallbackResolved = getMaskedTextureBlendModeDef(fallback);
  if (fallbackResolved && (!supportedOnly || getMaskedTextureBlendModeSupport(fallbackResolved).supported)) {
    return fallbackResolved.id;
  }
  return supportedOnly ? getFirstSupportedMaskedTextureBlendModeId() : DEFAULT_MASKED_TEXTURE_BLEND_MODE;
}

export function getMaskedTextureBlendModeOptions({ includeUnsupported = false } = {}) {
  const options = MASKED_TEXTURE_BLEND_MODE_DEFS
    .map((entry) => {
      const support = getMaskedTextureBlendModeSupport(entry);
      return {
        value: entry.id,
        label: entry.label,
        supported: support.supported
      };
    })
    .filter((entry) => includeUnsupported || entry.supported);
  if (options.length) return options;
  return [{ value: DEFAULT_MASKED_TEXTURE_BLEND_MODE, label: 'Normal', supported: true }];
}

function resolveMaskedTextureBlendModeConfig(value, {
  logger = Logger,
  logTag = 'TextureRender.maskedTiling.blendMode.invalid'
} = {}) {
  const requested = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const fallbackId = getFirstSupportedMaskedTextureBlendModeId();
  let definition = getMaskedTextureBlendModeDef(requested);
  if (!definition) {
    if (requested) {
      logger?.error?.(logTag, {
        value: value ?? null,
        fallback: fallbackId
      });
    }
    definition = getMaskedTextureBlendModeDef(fallbackId);
  }
  let support = getMaskedTextureBlendModeSupport(definition);
  if (!support.supported) {
    logger?.error?.(`${logTag}.unsupported`, {
      value: definition?.id || fallbackId,
      pixiKey: definition?.pixiKey || 'NORMAL',
      reason: support.reason || 'unsupported',
      fallback: fallbackId
    });
    definition = getMaskedTextureBlendModeDef(fallbackId);
    support = getMaskedTextureBlendModeSupport(definition);
  }
  return {
    id: definition?.id || fallbackId,
    label: definition?.label || 'Normal',
    pixiKey: definition?.pixiKey || 'NORMAL',
    customMode: !!definition?.customMode,
    mode: support.mode === undefined ? 0 : support.mode
  };
}

export function applyMaskedTextureBlendMode(displayObject, value, options = {}) {
  const resolved = resolveMaskedTextureBlendModeConfig(value, options);
  return syncMaskedTextureBlendFilter(displayObject, resolved, options);
}

export function applyTileHsbcToMesh(tile, mesh = null) {
  try {
    const maskedContainer = tile?.faNexusMaskContainer
      || tile?.mesh?.faNexusMaskContainer
      || mesh?.faNexusMaskContainer
      || null;
    const standardContainer = tile?.faNexusStandardMaskContainer
      || tile?.mesh?.faNexusStandardMaskContainer
      || mesh?.faNexusStandardMaskContainer
      || null;
    const target = maskedContainer?.faNexusTilingSprite
      || standardContainer?.faNexusBaseDisplayObject
      || standardContainer?.faNexusBaseSprite
      || null;
    if (!target || target.destroyed) return null;
    if (standardContainer && (
      standardContainer.faNexusBaseKind === 'custom-render'
      || target.faNexusStandardMaskCustomBase
    )) {
      applyHsbcToDisplayObject(target, null, { slot: 'standard-tile-mask' });
      return null;
    }
    const result = applyHsbcToDisplayObject(
      target,
      readDocumentHsbc(tile?.document, { nullIfMissing: true, nullIfNeutral: true }),
      { slot: maskedContainer ? 'masked-tiling' : 'standard-tile-mask' }
    );
    if (maskedContainer) {
      const maskedFlags = tile?.document?.getFlag?.('fa-nexus', MASKED_TILING_FLAG)
        || tile?.document?.flags?.['fa-nexus']?.[MASKED_TILING_FLAG]
        || tile?.document?._source?.flags?.['fa-nexus']?.[MASKED_TILING_FLAG]
        || null;
      applyMaskedTextureBlendMode(target, maskedFlags?.blendMode, {
        logger: Logger,
        logTag: 'TextureRender.applyTileHsbcToMesh.blendMode.invalid'
      });
    }
    return result;
  } catch (_) {
    return null;
  }
}
