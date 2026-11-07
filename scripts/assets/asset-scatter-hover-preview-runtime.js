export const SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA = 0.85;

export class AssetScatterHoverPreviewRuntime {
  constructor(manager, { scatterModeBrush } = {}) {
    this.manager = manager;
    this.scatterModeBrush = scatterModeBrush;
    this._overlay = null;
    this._gfx = null;
    this._ghostContainer = null;
    this._ghostSprites = [];
  }

  ensure() {
    if (
      this._overlay
      && !this._overlay.destroyed
      && this._gfx
      && this._ghostContainer
      && !this._ghostContainer.destroyed
    ) {
      this.applyOrdering();
      return;
    }
    try {
      const PIXI = globalThis.PIXI;
      const overlay = new PIXI.Container();
      overlay.eventMode = 'none';
      overlay.name = 'fa-nexus-scatter-hover-overlay';
      overlay.zIndex = 999999;
      const ghostContainer = new PIXI.Container();
      ghostContainer.eventMode = 'none';
      ghostContainer.sortableChildren = false;
      ghostContainer.name = 'fa-nexus-scatter-hover-preview';
      ghostContainer.visible = false;
      const gfx = new PIXI.Graphics();
      gfx.eventMode = 'none';
      overlay.addChild(gfx);
      const overlayParent = globalThis.canvas?.stage || globalThis.canvas?.primary;
      overlayParent?.addChild?.(overlay);
      if (overlayParent && 'sortDirty' in overlayParent) overlayParent.sortDirty = true;
      overlayParent?.sortChildren?.();
      const ghostParent = globalThis.canvas?.primary || globalThis.canvas?.stage;
      ghostParent?.addChild?.(ghostContainer);
      if (ghostParent && 'sortDirty' in ghostParent) ghostParent.sortDirty = true;
      ghostParent?.sortChildren?.();
      this._overlay = overlay;
      this._gfx = gfx;
      this._ghostContainer = ghostContainer;
      this.applyOrdering();
    } catch (_) {
      this._overlay = null;
      this._gfx = null;
      this._ghostContainer = null;
    }
  }

  clear() {
    if (Array.isArray(this._ghostSprites)) {
      for (const sprite of this._ghostSprites) {
        try { sprite.parent?.removeChild?.(sprite); } catch (_) {}
        try { sprite.destroy?.({ children: true, texture: false, baseTexture: false }); } catch (_) {}
      }
    }
    this._ghostSprites = [];
    if (this._ghostContainer) {
      try { this._ghostContainer.parent?.removeChild?.(this._ghostContainer); } catch (_) {}
      try { this._ghostContainer.destroy?.({ children: true }); } catch (_) {}
    }
    this._ghostContainer = null;
    if (this._gfx) {
      try { this._gfx.clear(); } catch (_) {}
    }
    if (this._overlay) {
      try { this._overlay.parent?.removeChild?.(this._overlay); } catch (_) {}
      try { this._overlay.destroy?.({ children: true }); } catch (_) {}
    }
    this._overlay = null;
    this._gfx = null;
  }

  applyOrdering() {
    const manager = this.manager;
    const container = this._ghostContainer;
    if (!container || container.destroyed) return;
    const nextSort = Number.isFinite(manager._previewSort) ? manager._previewSort : 0;
    const nextPreviewSort = Number.isFinite(manager._previewRenderSort) ? manager._previewRenderSort : nextSort;
    const elevation = Number.isFinite(manager._previewElevation) ? manager._previewElevation : 0;
    const renderOrder = manager._resolvePreviewRenderOrder(elevation, nextPreviewSort);
    try { container.sortLayer = renderOrder.sortLayer; } catch (_) {}
    try { container.sort = renderOrder.sort; } catch (_) {}
    try { container.faNexusSort = renderOrder.sort; } catch (_) {}
    try { container.faNexusPlacementSort = nextSort; } catch (_) {}
    try { container.faNexusPreviewSort = nextPreviewSort; } catch (_) {}
    try { container.faNexusElevationDoc = elevation; } catch (_) {}
    try { container.faNexusElevation = renderOrder.elevation; } catch (_) {}
    try { container.faNexusPlacementLevelId = renderOrder.placementLevelId || null; } catch (_) {}
    try { container.faNexusBandKind = renderOrder.kind || 'normal'; } catch (_) {}
    try { container.elevation = renderOrder.elevation; } catch (_) {}
    try { container.zIndex = renderOrder.kind !== 'normal' ? nextPreviewSort : 0; } catch (_) {}
    const parent = container.parent;
    if (parent && 'sortDirty' in parent) parent.sortDirty = true;
    parent?.sortChildren?.();
  }

  syncPreview(worldX = null, worldY = null) {
    const manager = this.manager;
    const container = this._ghostContainer;
    if (!container) return;
    this.applyOrdering();
    const instances = manager._buildScatterHoverPreviewInstances(worldX, worldY);
    if (!instances.length) {
      container.visible = false;
      for (const sprite of this._ghostSprites) {
        if (sprite) sprite.visible = false;
      }
      return;
    }

    const PIXI = globalThis.PIXI;
    while (this._ghostSprites.length < instances.length) {
      const sprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
      sprite.anchor.set(0.5);
      sprite.eventMode = 'none';
      container.addChild(sprite);
      this._ghostSprites.push(sprite);
    }

    for (let i = 0; i < this._ghostSprites.length; i += 1) {
      const sprite = this._ghostSprites[i];
      const instance = instances[i];
      if (!sprite) continue;
      if (!instance) {
        sprite.visible = false;
        continue;
      }
      const texture = manager._getScatterPreviewTexture(instance.src) || PIXI.Texture.EMPTY;
      if (sprite.texture !== texture) sprite.texture = texture;
      sprite.scale.set(1, 1);
      sprite.width = instance.w;
      sprite.height = instance.h;
      if (instance.flipH) sprite.scale.x *= -1;
      if (instance.flipV) sprite.scale.y *= -1;
      sprite.position.set(instance.x, instance.y);
      sprite.rotation = ((instance.r || 0) * Math.PI) / 180;
      sprite.alpha = Math.min(1, Math.max(0.05, Number(instance.previewAlpha) || SCATTER_HOVER_PREVIEW_PRIMARY_ALPHA));
      sprite.visible = true;
    }

    container.visible = true;
  }

  drawSpacingMarkers(gfx, pos, spacingWorld, color, alpha, brushRadius) {
    if (!gfx || !pos || !Number.isFinite(spacingWorld) || spacingWorld <= 0) return;
    const markerRadius = Math.max(4, Math.min(10, brushRadius * 0.05));
    const connectorPadding = markerRadius + 5;
    for (const direction of [-1, 1]) {
      const markerX = pos.x + spacingWorld * direction;
      const startX = pos.x + (brushRadius + 5) * direction;
      const endX = markerX - connectorPadding * direction;
      if (Math.abs(endX - startX) > 2) {
        gfx.lineStyle(1, color, alpha);
        gfx.moveTo(startX, pos.y);
        gfx.lineTo(endX, pos.y);
      }
      gfx.beginFill(color, alpha * 0.35);
      gfx.lineStyle(1, color, alpha);
      gfx.drawCircle(markerX, pos.y, markerRadius);
      gfx.endFill();
    }
  }

  updateCursor(worldX = null, worldY = null) {
    const manager = this.manager;
    if (manager._scatterMode !== this.scatterModeBrush) return;
    if (!this._gfx) return;
    const gfx = this._gfx;
    const pos = (() => {
      if (Number.isFinite(worldX) && Number.isFinite(worldY)) return { x: worldX, y: worldY };
      return manager._getPreviewAnchorWorld();
    })();
    gfx.clear();
    this.syncPreview(pos?.x ?? null, pos?.y ?? null);
    if (!pos) return;
    const radius = manager._getScatterBrushRadius();
    const eraseActive = manager._isScatterEraseActive();
    const color = eraseActive ? 0xff6666 : 0x66ccff;
    gfx.beginFill(color, eraseActive ? 0.08 : 0.04);
    gfx.lineStyle(2, color, 0.85);
    gfx.drawCircle(pos.x, pos.y, Math.max(1, radius));
    gfx.endFill();
    if (!eraseActive) {
      this.drawSpacingMarkers(
        gfx,
        pos,
        manager._getScatterSpacingWorld(),
        color,
        0.28,
        radius
      );
    }
  }
}
