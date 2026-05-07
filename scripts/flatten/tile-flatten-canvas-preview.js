export class TileFlattenCanvasPreview {
  constructor() {
    this._container = null;
    this._graphics = null;
  }

  update({ expanded = null, snapped = null, chunk = null } = {}) {
    if (!canvas?.ready || !canvas?.interface) return;
    const graphics = this._ensureGraphics();
    if (!graphics) return;
    graphics.clear();
    if (expanded) {
      graphics.lineStyle(2, 0xff9f0a, 0.30);
      graphics.drawRect(expanded.x, expanded.y, expanded.width, expanded.height);
    }
    if (snapped && chunk) {
      const chunkWidth = Number(chunk.width);
      const chunkHeight = Number(chunk.height);
      if (Number.isFinite(chunkWidth) && Number.isFinite(chunkHeight) && chunkWidth > 0 && chunkHeight > 0) {
        const epsilon = 0.01;
        const cols = Math.max(1, Math.ceil(snapped.width / chunkWidth));
        const rows = Math.max(1, Math.ceil(snapped.height / chunkHeight));
        const partialWidth = snapped.width - (Math.floor(snapped.width / chunkWidth) * chunkWidth);
        const partialHeight = snapped.height - (Math.floor(snapped.height / chunkHeight) * chunkHeight);
        const hasPartialWidth = partialWidth > epsilon && partialWidth < (snapped.width - epsilon);
        const hasPartialHeight = partialHeight > epsilon && partialHeight < (snapped.height - epsilon);
        const highlightPartialWidth = hasPartialWidth && partialWidth < (chunkWidth * 0.5);
        const highlightPartialHeight = hasPartialHeight && partialHeight < (chunkHeight * 0.5);

        if (highlightPartialWidth || highlightPartialHeight) {
          graphics.lineStyle(0, 0, 0, 0);
        }
        if (highlightPartialWidth) {
          graphics.beginFill(0xff9f0a, 0.15);
          graphics.drawRect(
            snapped.x + (Math.floor(snapped.width / chunkWidth) * chunkWidth),
            snapped.y,
            partialWidth,
            snapped.height
          );
          graphics.endFill();
        }
        if (highlightPartialHeight) {
          graphics.beginFill(0xff9f0a, 0.15);
          graphics.drawRect(
            snapped.x,
            snapped.y + (Math.floor(snapped.height / chunkHeight) * chunkHeight),
            snapped.width,
            partialHeight
          );
          graphics.endFill();
        }

        graphics.lineStyle(8, 0x34c759, 0.65);
        for (let col = 1; col < cols; col += 1) {
          const x = snapped.x + (col * chunkWidth);
          if (x > snapped.x + epsilon && x < (snapped.x + snapped.width - epsilon)) {
            graphics.moveTo(x, snapped.y);
            graphics.lineTo(x, snapped.y + snapped.height);
          }
        }
        for (let row = 1; row < rows; row += 1) {
          const y = snapped.y + (row * chunkHeight);
          if (y > snapped.y + epsilon && y < (snapped.y + snapped.height - epsilon)) {
            graphics.moveTo(snapped.x, y);
            graphics.lineTo(snapped.x + snapped.width, y);
          }
        }
      }
    }
    if (snapped) {
      graphics.lineStyle(3, 0xff3b30, 1);
      graphics.drawRect(snapped.x, snapped.y, snapped.width, snapped.height);
    }
  }

  clear() {
    try { this._graphics?.clear(); } catch (_) {}
  }

  destroy() {
    try {
      if (this._container?.parent) this._container.parent.removeChild(this._container);
    } catch (_) {}
    try { this._graphics?.destroy?.({ children: true }); } catch (_) {}
    try { this._container?.destroy?.({ children: true }); } catch (_) {}
    this._graphics = null;
    this._container = null;
  }

  _ensureGraphics() {
    const container = this._ensureContainer();
    if (!container) return null;
    if (this._graphics && !this._graphics.destroyed) return this._graphics;
    const graphics = new PIXI.Graphics();
    graphics.eventMode = 'none';
    container.addChild(graphics);
    this._graphics = graphics;
    return graphics;
  }

  _ensureContainer() {
    if (!canvas?.interface) return null;
    if (this._container && !this._container.destroyed) {
      if (!this._container.parent) {
        try { canvas.interface.addChild(this._container); } catch (_) {}
      }
      return this._container;
    }
    const container = new PIXI.Container();
    container.name = 'fa-nexus-flatten-preview';
    container.eventMode = 'none';
    container.sortableChildren = true;
    container.zIndex = 999999;
    container.interactive = false;
    container.interactiveChildren = false;
    try { canvas.interface.addChild(container); } catch (_) {}
    this._container = container;
    return container;
  }
}
