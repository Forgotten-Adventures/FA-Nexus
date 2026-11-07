import { deriveMaskedTilingResizeCommit } from '../textures/masked-tiling-resize-contract.js';
import { reconcileBuildingEditOperationGeometry } from '../buildings/building-saved-geometry-transform.js';
import { transformScatterInstanceGeometry } from '../assets/asset-scatter-instance-transform.js';

const MODULE_ID = 'fa-nexus';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finite(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clean(value, { integer = false } = {}) {
  const normalized = integer ? Math.round(value) : Math.round(value * 1e9) / 1e9;
  return Object.is(normalized, -0) ? 0 : normalized;
}

function scaled(value, factor, options = {}) {
  const numeric = finite(value);
  return numeric == null ? value : clean(numeric * factor, options);
}

function normalizedAngle(value) {
  const numeric = finite(value);
  if (numeric == null) return value;
  return clean(((numeric % 360) + 360) % 360);
}

function transformedWorldPoint(point, pivot, transform, { integer = false } = {}) {
  const x = finite(point?.x);
  const y = finite(point?.y);
  if (x == null || y == null) return clone(point);
  const scale = transform.operation === 'scale' ? transform.factor : 1;
  const angle = transform.operation === 'rotate' ? transform.angle * (Math.PI / 180) : 0;
  const dx = (x - pivot.x) * scale;
  const dy = (y - pivot.y) * scale;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    ...clone(point),
    x: clean(pivot.x + (dx * cosine) - (dy * sine), { integer }),
    y: clean(pivot.y + (dx * sine) + (dy * cosine), { integer })
  };
}

function scaleLocalPoint(point, factor) {
  if (!point || typeof point !== 'object') return clone(point);
  return {
    ...clone(point),
    x: scaled(point.x, factor),
    y: scaled(point.y, factor)
  };
}

function scaleBounds(bounds, factor, { world = false, pivot = null } = {}) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const next = clone(bounds);
  if (world && pivot) {
    if (finite(bounds.x) != null && finite(bounds.y) != null) {
      Object.assign(next, transformedWorldPoint(bounds, pivot, { operation: 'scale', factor }));
    }
    if (finite(bounds.minX) != null && finite(bounds.minY) != null) {
      const minimum = transformedWorldPoint({ x: bounds.minX, y: bounds.minY }, pivot, {
        operation: 'scale', factor
      });
      next.minX = minimum.x;
      next.minY = minimum.y;
    }
    if (finite(bounds.maxX) != null && finite(bounds.maxY) != null) {
      const maximum = transformedWorldPoint({ x: bounds.maxX, y: bounds.maxY }, pivot, {
        operation: 'scale', factor
      });
      next.maxX = maximum.x;
      next.maxY = maximum.y;
    }
  } else {
    for (const field of ['x', 'y', 'minX', 'minY', 'maxX', 'maxY']) {
      if (finite(bounds[field]) != null) next[field] = scaled(bounds[field], factor);
    }
  }
  for (const field of ['width', 'height']) {
    if (finite(bounds[field]) != null) next[field] = scaled(bounds[field], factor);
  }
  return next;
}

function rotateWorldBounds(bounds, pivot, angle) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const x = finite(bounds.x);
  const y = finite(bounds.y);
  const width = finite(bounds.width);
  const height = finite(bounds.height);
  const minX = finite(bounds.minX) ?? x;
  const minY = finite(bounds.minY) ?? y;
  const maxX = finite(bounds.maxX) ?? (minX != null && width != null ? minX + width : null);
  const maxY = finite(bounds.maxY) ?? (minY != null && height != null ? minY + height : null);
  if ([minX, minY, maxX, maxY].some((value) => value == null)) return clone(bounds);
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ].map((point) => transformedWorldPoint(point, pivot, { operation: 'rotate', angle }));
  const xs = corners.map((point) => point.x);
  const ys = corners.map((point) => point.y);
  const rotated = {
    minX: clean(Math.min(...xs)),
    minY: clean(Math.min(...ys)),
    maxX: clean(Math.max(...xs)),
    maxY: clean(Math.max(...ys))
  };
  rotated.width = clean(rotated.maxX - rotated.minX);
  rotated.height = clean(rotated.maxY - rotated.minY);
  const next = clone(bounds);
  if ('x' in bounds) next.x = rotated.minX;
  if ('y' in bounds) next.y = rotated.minY;
  if ('minX' in bounds) next.minX = rotated.minX;
  if ('minY' in bounds) next.minY = rotated.minY;
  if ('maxX' in bounds) next.maxX = rotated.maxX;
  if ('maxY' in bounds) next.maxY = rotated.maxY;
  if ('width' in bounds) next.width = rotated.width;
  if ('height' in bounds) next.height = rotated.height;
  return next;
}

function translateWorldPoint(point, delta) {
  if (!point || typeof point !== 'object') return clone(point);
  const x = finite(point.x);
  const y = finite(point.y);
  if (x == null || y == null) return clone(point);
  return { ...clone(point), x: clean(x + delta.x), y: clean(y + delta.y) };
}

function translateWorldBounds(bounds, delta) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const next = clone(bounds);
  for (const field of ['x', 'minX', 'maxX']) {
    if (finite(bounds[field]) != null) next[field] = clean(Number(bounds[field]) + delta.x);
  }
  for (const field of ['y', 'minY', 'maxY']) {
    if (finite(bounds[field]) != null) next[field] = clean(Number(bounds[field]) + delta.y);
  }
  return next;
}

function scaleShape(shape, factor) {
  if (!shape || typeof shape !== 'object') return clone(shape);
  const next = clone(shape);
  if (Array.isArray(shape.outer)) next.outer = shape.outer.map((point) => scaleLocalPoint(point, factor));
  if (Array.isArray(shape.points)) next.points = shape.points.map((point) => scaleLocalPoint(point, factor));
  if (Array.isArray(shape.holes)) {
    next.holes = shape.holes.map((hole) => {
      if (Array.isArray(hole)) return hole.map((point) => scaleLocalPoint(point, factor));
      if (!hole || typeof hole !== 'object') return clone(hole);
      return {
        ...clone(hole),
        points: Array.isArray(hole.points) ? hole.points.map((point) => scaleLocalPoint(point, factor)) : hole.points,
        bounds: scaleBounds(hole.bounds, factor),
        area: scaled(hole.area, factor * factor),
        perimeter: scaled(hole.perimeter, factor)
      };
    });
  }
  next.bounds = scaleBounds(shape.bounds, factor);
  if (finite(shape.area) != null) next.area = scaled(shape.area, factor * factor);
  if (finite(shape.perimeter) != null) next.perimeter = scaled(shape.perimeter, factor);
  return next;
}

function scalePathShadow(shadow, factor) {
  if (!shadow || typeof shadow !== 'object') return clone(shadow);
  const next = clone(shadow);
  for (const field of ['blur', 'dilation', 'offset']) {
    if (finite(shadow[field]) != null) next[field] = scaled(shadow[field], factor);
  }
  if (Array.isArray(shadow.points)) {
    next.points = shadow.points.map((point) => ({
      ...scaleLocalPoint(point, factor),
      offset: finite(point?.offset) == null ? point?.offset : scaled(point.offset, factor)
    }));
  }
  return next;
}

function scalePathData(path, factor) {
  if (!path || typeof path !== 'object') return clone(path);
  const next = clone(path);
  if (Array.isArray(path.controlPoints)) {
    next.controlPoints = path.controlPoints.map((point) => scaleLocalPoint(point, factor));
  }
  for (const field of ['width', 'repeatSpacing']) {
    if (finite(path[field]) != null) next[field] = scaled(path[field], factor);
  }
  if (path.textureOffset && typeof path.textureOffset === 'object') {
    next.textureOffset = scaleLocalPoint(path.textureOffset, factor);
  }
  for (const field of ['feather', 'opacityFeather']) {
    if (!path[field] || typeof path[field] !== 'object') continue;
    next[field] = clone(path[field]);
    for (const lengthField of ['startLength', 'endLength']) {
      if (finite(path[field][lengthField]) != null) {
        next[field][lengthField] = scaled(path[field][lengthField], factor);
      }
    }
  }
  next.shadow = scalePathShadow(path.shadow, factor);
  return next;
}

function scaleAssetScatter(scatter, factor) {
  if (!scatter || typeof scatter !== 'object') return clone(scatter);
  const next = clone(scatter);
  if (!Array.isArray(scatter.instances)) return next;
  next.instances = scatter.instances.map((instance) => {
    if (!instance || typeof instance !== 'object') return clone(instance);
    return transformScatterInstanceGeometry(instance, { a: factor, b: 0, c: 0, d: factor });
  });
  return next;
}

function transformOperationMetadata(metadata, pivot, factor) {
  if (!metadata || typeof metadata !== 'object') return clone(metadata);
  const next = clone(metadata);
  for (const field of ['center', 'origin', 'start', 'end', 'control', 'controlPoint']) {
    if (metadata[field] && typeof metadata[field] === 'object') {
      next[field] = transformedWorldPoint(metadata[field], pivot, { operation: 'scale', factor });
    }
  }
  for (const field of ['anchors', 'points']) {
    if (Array.isArray(metadata[field])) {
      next[field] = metadata[field].map((point) => transformedWorldPoint(point, pivot, {
        operation: 'scale', factor
      }));
    }
  }
  if (metadata.bounds) next.bounds = scaleBounds(metadata.bounds, factor, { world: true, pivot });
  if (metadata.radius && typeof metadata.radius === 'object') {
    next.radius = {
      ...clone(metadata.radius),
      x: scaled(metadata.radius.x, factor),
      y: scaled(metadata.radius.y, factor)
    };
  } else if (finite(metadata.radius) != null) next.radius = scaled(metadata.radius, factor);
  if (Array.isArray(metadata.segments)) {
    next.segments = metadata.segments.map((segment) => {
      const cloneSegment = clone(segment);
      if (segment?.control && typeof segment.control === 'object') {
        cloneSegment.control = transformedWorldPoint(segment.control, pivot, { operation: 'scale', factor });
      }
      return cloneSegment;
    });
  }
  return next;
}

function rotateOperationMetadata(metadata, pivot, angle) {
  if (!metadata || typeof metadata !== 'object') return clone(metadata);
  const next = clone(metadata);
  for (const field of ['center', 'origin', 'start', 'end', 'control', 'controlPoint']) {
    if (metadata[field] && typeof metadata[field] === 'object') {
      next[field] = transformedWorldPoint(metadata[field], pivot, { operation: 'rotate', angle });
    }
  }
  for (const field of ['anchors', 'points']) {
    if (Array.isArray(metadata[field])) {
      next[field] = metadata[field].map((point) => transformedWorldPoint(point, pivot, {
        operation: 'rotate', angle
      }));
    }
  }
  if (metadata.bounds) next.bounds = rotateWorldBounds(metadata.bounds, pivot, angle);
  if (Array.isArray(metadata.segments)) {
    next.segments = metadata.segments.map((segment) => {
      const cloneSegment = clone(segment);
      if (segment?.control && typeof segment.control === 'object') {
        cloneSegment.control = transformedWorldPoint(segment.control, pivot, { operation: 'rotate', angle });
      }
      return cloneSegment;
    });
  }
  return next;
}

function translateOperationMetadata(metadata, delta) {
  if (!metadata || typeof metadata !== 'object') return clone(metadata);
  const next = clone(metadata);
  for (const field of ['center', 'origin', 'start', 'end', 'control', 'controlPoint']) {
    if (metadata[field] && typeof metadata[field] === 'object') {
      next[field] = translateWorldPoint(metadata[field], delta);
    }
  }
  for (const field of ['anchors', 'points']) {
    if (Array.isArray(metadata[field])) {
      next[field] = metadata[field].map((point) => translateWorldPoint(point, delta));
    }
  }
  if (metadata.bounds) next.bounds = translateWorldBounds(metadata.bounds, delta);
  if (Array.isArray(metadata.segments)) {
    next.segments = metadata.segments.map((segment) => ({
      ...clone(segment),
      control: segment?.control ? translateWorldPoint(segment.control, delta) : segment?.control
    }));
  }
  return next;
}

function scaleBuildingOperations(operations, pivot, factor) {
  if (!Array.isArray(operations)) return clone(operations);
  return operations.map((operation) => {
    const next = clone(operation);
    if (!operation?.payload || typeof operation.payload !== 'object') return next;
    next.payload = clone(operation.payload);
    if (Array.isArray(operation.payload.points)) {
      next.payload.points = operation.payload.points.map((point) => transformedWorldPoint(point, pivot, {
        operation: 'scale', factor
      }));
    }
    if (operation.payload.metadata) {
      next.payload.metadata = transformOperationMetadata(operation.payload.metadata, pivot, factor);
    }
    if (finite(operation.payload.wallWidth) != null) {
      next.payload.wallWidth = scaled(operation.payload.wallWidth, factor);
    }
    return next;
  });
}

function rotateBuildingOperations(operations, pivot, angle) {
  if (!Array.isArray(operations)) return clone(operations);
  return operations.map((operation) => {
    const next = clone(operation);
    if (!operation?.payload || typeof operation.payload !== 'object') return next;
    next.payload = clone(operation.payload);
    if (Array.isArray(operation.payload.points)) {
      next.payload.points = operation.payload.points.map((point) => transformedWorldPoint(point, pivot, {
        operation: 'rotate', angle
      }));
    }
    if (operation.payload.metadata) {
      next.payload.metadata = rotateOperationMetadata(operation.payload.metadata, pivot, angle);
    }
    return reconcileBuildingEditOperationGeometry(next);
  });
}

function translateBuildingOperations(operations, delta) {
  if (!Array.isArray(operations)) return clone(operations);
  return operations.map((operation) => {
    const next = clone(operation);
    if (!operation?.payload || typeof operation.payload !== 'object') return next;
    next.payload = clone(operation.payload);
    if (Array.isArray(operation.payload.points)) {
      next.payload.points = operation.payload.points.map((point) => translateWorldPoint(point, delta));
    }
    if (operation.payload.metadata) {
      next.payload.metadata = translateOperationMetadata(operation.payload.metadata, delta);
    }
    return next;
  });
}

function transformBuildingWallBehaviorPaths(wallBehavior, transformPoint) {
  if (!wallBehavior || typeof wallBehavior !== 'object') return clone(wallBehavior);
  const next = clone(wallBehavior);
  if (!Array.isArray(wallBehavior.segments)) return next;
  next.segments = wallBehavior.segments.map((segment) => ({
    ...clone(segment),
    ...(Array.isArray(segment?.path) ? {
      path: segment.path.map((point) => transformPoint(point))
    } : {})
  }));
  return next;
}

function scaleShadowFlags(target, factor) {
  if (!target || typeof target !== 'object') return;
  for (const field of ['shadowBlur', 'shadowDilation', 'shadowOffsetDistance', 'shadowOffsetX', 'shadowOffsetY']) {
    if (finite(target[field]) != null) target[field] = scaled(target[field], factor);
  }
}

function positivePortalScale(source, field, label) {
  if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
    return 1;
  }
  const numeric = Number(source[field]);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Building ${label} must be a positive number.`);
  }
  return numeric;
}

function scaleWallGap(gap, factor) {
  if (!gap || typeof gap !== 'object') return clone(gap);
  const next = clone(gap);
  for (const field of ['centerDistance', 'center', 'halfLength', 'length']) {
    if (finite(gap[field]) != null) next[field] = scaled(gap[field], factor);
  }
  if (gap.centerPoint) next.centerPoint = scaleLocalPoint(gap.centerPoint, factor);
  for (const portalKind of ['door', 'window']) {
    const portal = gap[portalKind];
    if (!portal || typeof portal !== 'object') continue;
    next[portalKind] = clone(portal);
    if (portalKind === 'door') {
      next[portalKind].widthScale = scaled(
        positivePortalScale(portal, 'widthScale', 'door widthScale'),
        factor
      );
    } else if (Object.prototype.hasOwnProperty.call(portal, 'widthScale')) {
      next[portalKind].widthScale = scaled(
        positivePortalScale(portal, 'widthScale', 'window widthScale'),
        factor
      );
    }
    for (const partName of ['frame', 'sill', 'texture']) {
      const part = portal[partName];
      if (!part || typeof part !== 'object') continue;
      next[portalKind][partName] = clone(part);
      next[portalKind][partName].scale = scaled(
        positivePortalScale(part, 'scale', `${portalKind} ${partName} scale`),
        factor
      );
    }
  }
  return next;
}

function scaleBuildingWall(wall, factor) {
  if (!wall || typeof wall !== 'object') return clone(wall);
  const next = clone(wall);
  for (const field of ['width', 'repeatDistance']) {
    if (finite(wall[field]) != null) next[field] = scaled(wall[field], factor);
  }
  if (finite(wall.scalePercent) != null) next.scalePercent = scaled(wall.scalePercent, factor);
  if (wall.textureOffset) next.textureOffset = scaleLocalPoint(wall.textureOffset, factor);
  next.pathShadow = scalePathShadow(wall.pathShadow, factor);
  if (Array.isArray(wall.renderSegments)) {
    next.renderSegments = wall.renderSegments.map((segment) => {
      const cloneSegment = clone(segment);
      if (Array.isArray(segment?.points)) {
        cloneSegment.points = segment.points.map((point) => scaleLocalPoint(point, factor));
      }
      for (const field of ['width', 'repeatDistance']) {
        if (finite(segment?.[field]) != null) cloneSegment[field] = scaled(segment[field], factor);
      }
      if (finite(segment?.texturePhaseDistance) != null) {
        cloneSegment.texturePhaseDistance = scaled(segment.texturePhaseDistance, factor);
      }
      if (finite(segment?.scalePercent) != null) {
        cloneSegment.scalePercent = scaled(segment.scalePercent, factor);
      }
      if (segment?.textureOffset) cloneSegment.textureOffset = scaleLocalPoint(segment.textureOffset, factor);
      cloneSegment.pathShadow = scalePathShadow(segment?.pathShadow, factor);
      return cloneSegment;
    });
  }
  return next;
}

function writeBuildingWorldTile(world, targetTile) {
  if (!world || typeof world !== 'object' || !targetTile) return;
  const x = finite(targetTile.x);
  const y = finite(targetTile.y);
  const width = finite(targetTile.width);
  const height = finite(targetTile.height);
  if ([x, y, width, height].some((value) => value == null) || !(width > 0) || !(height > 0)) {
    throw new Error('Building world metadata requires finite positive final Tile geometry.');
  }
  const anchorX = finite(targetTile.texture?.anchorX ?? targetTile.anchorX) ?? 0.5;
  const anchorY = finite(targetTile.texture?.anchorY ?? targetTile.anchorY) ?? 0.5;
  const rotation = finite(targetTile.rotation) ?? 0;
  const radians = rotation * (Math.PI / 180);
  const localX = -(width * anchorX);
  const localY = -(height * anchorY);
  world.origin = {
    x: clean(x + (localX * Math.cos(radians)) - (localY * Math.sin(radians))),
    y: clean(y + (localX * Math.sin(radians)) + (localY * Math.cos(radians)))
  };
  world.tile = {
    ...clone(world.tile || {}),
    x: clean(x),
    y: clean(y),
    width: clean(width),
    height: clean(height),
    rotation: clean(rotation),
    anchorX: clean(anchorX),
    anchorY: clean(anchorY)
  };
}

function scaleBuildingData(building, pivot, factor, targetTile) {
  if (!building || typeof building !== 'object') return clone(building);
  const next = clone(building);
  next.polygon = scaleShape(building.polygon, factor);
  if (Array.isArray(building.shapes)) next.shapes = building.shapes.map((shape) => scaleShape(shape, factor));
  next.operations = scaleBuildingOperations(building.operations, pivot, factor);
  next.wall = scaleBuildingWall(building.wall, factor);
  if (building.meta && typeof building.meta === 'object') {
    next.meta = clone(building.meta);
    const previousPose = building.meta.currentEditPose || {};
    const previousScaleX = finite(previousPose.scaleX) ?? 1;
    const previousScaleY = finite(previousPose.scaleY) ?? 1;
    next.meta.currentEditPose = {
      ...clone(previousPose),
      scaleX: clean(previousScaleX * factor),
      scaleY: clean(previousScaleY * factor)
    };
    if (building.meta.wallBehavior) {
      next.meta.wallBehavior = transformBuildingWallBehaviorPaths(
        building.meta.wallBehavior,
        (point) => transformedWorldPoint(point, pivot, { operation: 'scale', factor })
      );
    }
    if (Array.isArray(building.meta.wallGaps)) {
      next.meta.wallGaps = building.meta.wallGaps.map((gap) => scaleWallGap(gap, factor));
    }
    if (building.meta.innerDefaults) next.meta.innerDefaults = scaleBuildingWall(building.meta.innerDefaults, factor);
    if (building.meta.fillTexture && typeof building.meta.fillTexture === 'object') {
      next.meta.fillTexture = clone(building.meta.fillTexture);
      if (building.meta.fillTexture.offset) {
        next.meta.fillTexture.offset = scaleLocalPoint(building.meta.fillTexture.offset, factor);
      }
      if (building.meta.fillTexture.phase) {
        next.meta.fillTexture.phase = scaleLocalPoint(building.meta.fillTexture.phase, factor);
      }
    }
    if (building.meta.world && typeof building.meta.world === 'object') {
      next.meta.world = clone(building.meta.world);
      if (building.meta.world.bounds) {
        next.meta.world.bounds = scaleBounds(building.meta.world.bounds, factor, { world: true, pivot });
      }
      writeBuildingWorldTile(next.meta.world, targetTile);
    }
  }
  return next;
}

function scaleLocalPointAxes(point, scaleX, scaleY) {
  if (!point || typeof point !== 'object') return clone(point);
  const next = clone(point);
  if (finite(point.x) != null) next.x = scaled(point.x, scaleX);
  if (finite(point.y) != null) next.y = scaled(point.y, scaleY);
  return next;
}

function scaleWorldPointAxes(point, pivot, scaleX, scaleY, angleDegrees = 0) {
  if (!point || typeof point !== 'object') return clone(point);
  const x = finite(point.x);
  const y = finite(point.y);
  if (x == null || y == null) return clone(point);
  const radians = Number(angleDegrees || 0) * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = x - pivot.x;
  const dy = y - pivot.y;
  const localX = (dx * cosine) + (dy * sine);
  const localY = (-dx * sine) + (dy * cosine);
  return {
    ...clone(point),
    x: clean(pivot.x + ((localX * scaleX) * cosine) - ((localY * scaleY) * sine)),
    y: clean(pivot.y + ((localX * scaleX) * sine) + ((localY * scaleY) * cosine))
  };
}

function correctLocalBoundsAxes(bounds, scaleX, scaleY) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const next = clone(bounds);
  for (const field of ['x', 'minX', 'maxX', 'width']) {
    if (finite(bounds[field]) != null) next[field] = scaled(bounds[field], scaleX);
  }
  for (const field of ['y', 'minY', 'maxY', 'height']) {
    if (finite(bounds[field]) != null) next[field] = scaled(bounds[field], scaleY);
  }
  return next;
}

function correctWorldBoundsAxes(bounds, pivot, scaleX, scaleY, angleDegrees) {
  if (!bounds || typeof bounds !== 'object') return clone(bounds);
  const minX = finite(bounds.minX ?? bounds.x);
  const minY = finite(bounds.minY ?? bounds.y);
  const maxX = finite(bounds.maxX) ?? (minX != null && finite(bounds.width) != null
    ? minX + Number(bounds.width) : null);
  const maxY = finite(bounds.maxY) ?? (minY != null && finite(bounds.height) != null
    ? minY + Number(bounds.height) : null);
  if ([minX, minY, maxX, maxY].some((value) => value == null)) return clone(bounds);
  const points = [
    { x: minX, y: minY }, { x: maxX, y: minY },
    { x: maxX, y: maxY }, { x: minX, y: maxY }
  ].map((point) => scaleWorldPointAxes(point, pivot, scaleX, scaleY, angleDegrees));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const corrected = {
    minX: clean(Math.min(...xs)), minY: clean(Math.min(...ys)),
    maxX: clean(Math.max(...xs)), maxY: clean(Math.max(...ys))
  };
  corrected.width = clean(corrected.maxX - corrected.minX);
  corrected.height = clean(corrected.maxY - corrected.minY);
  const next = clone(bounds);
  if ('x' in next) next.x = corrected.minX;
  if ('y' in next) next.y = corrected.minY;
  for (const field of ['minX', 'minY', 'maxX', 'maxY', 'width', 'height']) {
    if (field in next) next[field] = corrected[field];
  }
  return next;
}

function correctShapeAxes(shape, scaleX, scaleY) {
  if (!shape || typeof shape !== 'object') return clone(shape);
  const next = clone(shape);
  for (const field of ['outer', 'points']) {
    if (Array.isArray(shape[field])) {
      next[field] = shape[field].map((point) => scaleLocalPointAxes(point, scaleX, scaleY));
    }
  }
  if (Array.isArray(shape.holes)) {
    next.holes = shape.holes.map((hole) => {
      if (Array.isArray(hole)) return hole.map((point) => scaleLocalPointAxes(point, scaleX, scaleY));
      const corrected = clone(hole || {});
      if (Array.isArray(hole?.points)) {
        corrected.points = hole.points.map((point) => scaleLocalPointAxes(point, scaleX, scaleY));
      }
      if (hole?.bounds) corrected.bounds = correctLocalBoundsAxes(hole.bounds, scaleX, scaleY);
      if (finite(hole?.area) != null) corrected.area = scaled(hole.area, scaleX * scaleY);
      return corrected;
    });
  }
  if (shape.bounds) next.bounds = correctLocalBoundsAxes(shape.bounds, scaleX, scaleY);
  if (finite(shape.area) != null) next.area = scaled(shape.area, scaleX * scaleY);
  return next;
}

function correctOperationMetadataAxes(metadata, pivot, scaleX, scaleY, angleDegrees) {
  if (!metadata || typeof metadata !== 'object') return clone(metadata);
  const next = clone(metadata);
  for (const field of ['center', 'origin', 'start', 'end', 'control', 'controlPoint']) {
    if (metadata[field]) {
      next[field] = scaleWorldPointAxes(metadata[field], pivot, scaleX, scaleY, angleDegrees);
    }
  }
  for (const field of ['anchors', 'points']) {
    if (Array.isArray(metadata[field])) {
      next[field] = metadata[field].map((point) => (
        scaleWorldPointAxes(point, pivot, scaleX, scaleY, angleDegrees)
      ));
    }
  }
  if (metadata.bounds) {
    next.bounds = correctWorldBoundsAxes(metadata.bounds, pivot, scaleX, scaleY, angleDegrees);
  }
  if (metadata.radius && typeof metadata.radius === 'object') {
    next.radius = scaleLocalPointAxes(metadata.radius, scaleX, scaleY);
  }
  if (Array.isArray(metadata.segments)) {
    next.segments = metadata.segments.map((segment) => ({
      ...clone(segment),
      ...(segment?.control ? {
        control: scaleWorldPointAxes(segment.control, pivot, scaleX, scaleY, angleDegrees)
      } : {})
    }));
  }
  return next;
}

function correctBuildingAxes(building, {
  correctionX,
  correctionY,
  pivot,
  angleDegrees,
  targetTile
}) {
  if (!building || typeof building !== 'object') return clone(building);
  const next = clone(building);
  if (building.polygon) next.polygon = correctShapeAxes(building.polygon, correctionX, correctionY);
  if (Array.isArray(building.shapes)) {
    next.shapes = building.shapes.map((shape) => correctShapeAxes(shape, correctionX, correctionY));
  }
  if (Array.isArray(building.operations)) {
    next.operations = building.operations.map((operation) => {
      const corrected = clone(operation);
      if (!operation?.payload) return corrected;
      corrected.payload = clone(operation.payload);
      if (Array.isArray(operation.payload.points)) {
        corrected.payload.points = operation.payload.points.map((point) => (
          scaleWorldPointAxes(point, pivot, correctionX, correctionY, angleDegrees)
        ));
      }
      if (operation.payload.metadata) {
        corrected.payload.metadata = correctOperationMetadataAxes(
          operation.payload.metadata,
          pivot,
          correctionX,
          correctionY,
          angleDegrees
        );
      }
      return reconcileBuildingEditOperationGeometry(corrected);
    });
  }
  const correctWall = (wall) => {
    if (!wall || typeof wall !== 'object') return clone(wall);
    const corrected = clone(wall);
    if (wall.textureOffset) corrected.textureOffset = scaleLocalPointAxes(wall.textureOffset, correctionX, correctionY);
    if (wall.pathShadow?.points) {
      corrected.pathShadow = clone(wall.pathShadow);
      corrected.pathShadow.points = wall.pathShadow.points.map((point) => (
        scaleLocalPointAxes(point, correctionX, correctionY)
      ));
    }
    if (Array.isArray(wall.renderSegments)) {
      corrected.renderSegments = wall.renderSegments.map((segment) => {
        const nextSegment = clone(segment);
        if (Array.isArray(segment?.points)) {
          nextSegment.points = segment.points.map((point) => scaleLocalPointAxes(point, correctionX, correctionY));
        }
        if (segment?.textureOffset) {
          nextSegment.textureOffset = scaleLocalPointAxes(segment.textureOffset, correctionX, correctionY);
        }
        return nextSegment;
      });
    }
    return corrected;
  };
  if (building.wall) next.wall = correctWall(building.wall);
  if (building.meta) {
    next.meta = clone(building.meta);
    if (building.meta.wallBehavior) {
      next.meta.wallBehavior = transformBuildingWallBehaviorPaths(
        building.meta.wallBehavior,
        (point) => scaleWorldPointAxes(point, pivot, correctionX, correctionY, angleDegrees)
      );
    }
    if (building.meta.innerDefaults) next.meta.innerDefaults = correctWall(building.meta.innerDefaults);
    if (Array.isArray(building.meta.wallGaps)) {
      next.meta.wallGaps = building.meta.wallGaps.map((gap) => ({
        ...clone(gap),
        ...(gap?.centerPoint ? {
          centerPoint: scaleLocalPointAxes(gap.centerPoint, correctionX, correctionY)
        } : {})
      }));
    }
    if (building.meta.fillTexture) {
      next.meta.fillTexture = clone(building.meta.fillTexture);
      for (const field of ['offset', 'phase']) {
        if (building.meta.fillTexture[field]) {
          next.meta.fillTexture[field] = scaleLocalPointAxes(
            building.meta.fillTexture[field], correctionX, correctionY
          );
        }
      }
    }
    if (building.meta.world) {
      next.meta.world = clone(building.meta.world);
      if (building.meta.world.origin) {
        next.meta.world.origin = scaleWorldPointAxes(
          building.meta.world.origin, pivot, correctionX, correctionY, angleDegrees
        );
      }
      if (building.meta.world.bounds) {
        next.meta.world.bounds = correctWorldBoundsAxes(
          building.meta.world.bounds, pivot, correctionX, correctionY, angleDegrees
        );
      }
      writeBuildingWorldTile(next.meta.world, targetTile);
    }
  }
  return next;
}

function correctBuildingCompositeAxes(composite, {
  correctionX,
  correctionY,
  pivot,
  angleDegrees
}) {
  if (!composite || typeof composite !== 'object') return clone(composite);
  const next = clone(composite);
  if (Array.isArray(composite.parts)) {
    next.parts = composite.parts.map((part) => {
      const corrected = scaleWorldPointAxes(part, pivot, correctionX, correctionY, angleDegrees);
      if (finite(part?.width) != null) corrected.width = Math.max(1, scaled(part.width, correctionX));
      if (finite(part?.height) != null) corrected.height = Math.max(1, scaled(part.height, correctionY));
      return corrected;
    });
  }
  return next;
}

function rotateBuildingData(building, pivot, angle, targetTile) {
  if (!building || typeof building !== 'object') return clone(building);
  const next = clone(building);
  next.operations = rotateBuildingOperations(building.operations, pivot, angle);
  if (building.meta && typeof building.meta === 'object') {
    next.meta = clone(building.meta);
    if (building.meta.wallBehavior) {
      next.meta.wallBehavior = transformBuildingWallBehaviorPaths(
        building.meta.wallBehavior,
        (point) => transformedWorldPoint(point, pivot, { operation: 'rotate', angle })
      );
    }
    if (building.meta.world && typeof building.meta.world === 'object') {
      next.meta.world = clone(building.meta.world);
      if (building.meta.world.origin) {
        next.meta.world.origin = transformedWorldPoint(
          building.meta.world.origin,
          pivot,
          { operation: 'rotate', angle }
        );
      }
      if (building.meta.world.bounds) {
        next.meta.world.bounds = rotateWorldBounds(building.meta.world.bounds, pivot, angle);
      }
      writeBuildingWorldTile(next.meta.world, targetTile);
    }
  }
  return next;
}

function translateBuildingData(building, delta, targetTile) {
  if (!building || typeof building !== 'object') return clone(building);
  const next = clone(building);
  next.operations = translateBuildingOperations(building.operations, delta);
  if (building.meta && typeof building.meta === 'object') {
    next.meta = clone(building.meta);
    if (building.meta.wallBehavior) {
      next.meta.wallBehavior = transformBuildingWallBehaviorPaths(
        building.meta.wallBehavior,
        (point) => translateWorldPoint(point, delta)
      );
    }
    if (building.meta.world && typeof building.meta.world === 'object') {
      next.meta.world = clone(building.meta.world);
      if (building.meta.world.origin) {
        next.meta.world.origin = translateWorldPoint(building.meta.world.origin, delta);
      } else if (targetTile) {
        const anchorX = finite(targetTile.anchorX) ?? 0.5;
        const anchorY = finite(targetTile.anchorY) ?? 0.5;
        next.meta.world.origin = {
          x: clean(targetTile.x - (targetTile.width * anchorX)),
          y: clean(targetTile.y - (targetTile.height * anchorY))
        };
      }
      if (building.meta.world.bounds) {
        next.meta.world.bounds = translateWorldBounds(building.meta.world.bounds, delta);
      }
      writeBuildingWorldTile(next.meta.world, targetTile);
    }
  }
  return next;
}

function scaleCompositePart(part, pivot, factor) {
  if (!part || typeof part !== 'object') return clone(part);
  const next = clone(part);
  const center = transformedWorldPoint(part, pivot, { operation: 'scale', factor });
  next.x = center.x;
  next.y = center.y;
  next.width = Math.max(1, scaled(part.width, factor));
  next.height = Math.max(1, scaled(part.height, factor));
  if (next.flags && typeof next.flags === 'object') {
    scaleShadowFlags(next.flags, factor);
    next.flags = scaleBuildingTypedFlags(next.flags, factor);
  }
  return next;
}

function scaleBuildingComposite(composite, pivot, factor) {
  if (!composite || typeof composite !== 'object') return clone(composite);
  const next = clone(composite);
  if (Array.isArray(composite.parts)) {
    next.parts = composite.parts.map((part) => scaleCompositePart(part, pivot, factor));
  }
  return next;
}

function rotateBuildingComposite(composite, pivot, angle) {
  if (!composite || typeof composite !== 'object') return clone(composite);
  const next = clone(composite);
  if (Array.isArray(composite.parts)) {
    next.parts = composite.parts.map((part) => {
      if (!part || typeof part !== 'object') return clone(part);
      const rotated = transformedWorldPoint(part, pivot, { operation: 'rotate', angle });
      const clonePart = { ...clone(part), x: rotated.x, y: rotated.y };
      clonePart.rotation = normalizedAngle((finite(part.rotation) ?? 0) + angle);
      return clonePart;
    });
  }
  return next;
}

function translateBuildingComposite(composite, delta) {
  if (!composite || typeof composite !== 'object') return clone(composite);
  const next = clone(composite);
  if (Array.isArray(composite.parts)) {
    next.parts = composite.parts.map((part) => {
      if (!part || typeof part !== 'object') return clone(part);
      return { ...clone(part), ...translateWorldPoint(part, delta) };
    });
  }
  return next;
}

function scaleBuildingTypedFlags(flags, factor) {
  if (!flags || typeof flags !== 'object') return clone(flags);
  const next = clone(flags);
  for (const [key, value] of Object.entries(flags)) {
    if (!/^building(?:DoorFrame|Window)/.test(key) || !value || typeof value !== 'object') continue;
    const typed = clone(value);
    for (const field of ['assetGridSize', 'gapLength', 'centerDistance', 'halfLength']) {
      if (finite(value[field]) != null) typed[field] = scaled(value[field], factor);
    }
    next[key] = typed;
  }
  return next;
}

function scaleMaskedTiling(masked, pivot, factor, targetTile) {
  if (!masked || typeof masked !== 'object') return clone(masked);
  if (!targetTile || !(factor > 0)) {
    throw new Error('Scene Group masked tiling scale requires a positive factor and final Tile geometry.');
  }
  const sourceMetadata = masked.maskWorld?.tile || {};
  const anchorX = finite(targetTile.texture?.anchorX ?? sourceMetadata.anchorX) ?? 0.5;
  const anchorY = finite(targetTile.texture?.anchorY ?? sourceMetadata.anchorY) ?? 0.5;
  const originalTile = {
    x: pivot.x + ((targetTile.x - pivot.x) / factor),
    y: pivot.y + ((targetTile.y - pivot.y) / factor),
    width: targetTile.width / factor,
    height: targetTile.height / factor,
    rotation: finite(targetTile.rotation) ?? finite(sourceMetadata.rotation) ?? 0,
    texture: { anchorX, anchorY }
  };
  return deriveMaskedTilingResizeCommit({
    maskedTiling: masked,
    originalTile,
    finalTile: {
      x: targetTile.x,
      y: targetTile.y,
      width: targetTile.width,
      height: targetTile.height,
      rotation: originalTile.rotation,
      texture: { anchorX, anchorY }
    }
  });
}

function rotateMaskedTiling(masked, pivot, angle, targetTile) {
  if (!masked || typeof masked !== 'object') return clone(masked);
  const next = clone(masked);
  if (!masked.maskWorld || typeof masked.maskWorld !== 'object' || !targetTile) return next;
  next.maskWorld = clone(masked.maskWorld);
  const sourceTile = masked.maskWorld.tile || {};
  const sourceX = finite(sourceTile.x);
  const sourceY = finite(sourceTile.y);
  const targetX = finite(targetTile.x);
  const targetY = finite(targetTile.y);
  if (masked.maskWorld.origin) {
    if ([sourceX, sourceY, targetX, targetY].every((value) => value != null)) {
      next.maskWorld.origin = translateWorldPoint(masked.maskWorld.origin, {
        x: targetX - sourceX,
        y: targetY - sourceY
      });
    } else {
      next.maskWorld.origin = transformedWorldPoint(
        masked.maskWorld.origin,
        pivot,
        { operation: 'rotate', angle }
      );
    }
  }
  next.maskWorld.tile = {
    ...clone(sourceTile),
    x: targetTile.x,
    y: targetTile.y,
    width: targetTile.width,
    height: targetTile.height,
    rotation: targetTile.rotation
  };
  return next;
}

function translateMaskedTiling(masked, delta, targetTile) {
  if (!masked || typeof masked !== 'object') return clone(masked);
  const next = clone(masked);
  // Every Region uses this Tile frame. Leaving its stored position behind is
  // hidden by live translation compensation until the next resize resets it.
  if (masked.maskType === 'composite') {
    next.regions = masked.regions.map((region) => ({
      ...clone(region),
      maskedTiling: translateMaskedTiling(region.maskedTiling, delta, targetTile)
    }));
  }
  if (masked.maskWorld && typeof masked.maskWorld === 'object') {
    next.maskWorld = clone(masked.maskWorld);
    if (masked.maskWorld.origin) next.maskWorld.origin = translateWorldPoint(masked.maskWorld.origin, delta);
    if (masked.maskWorld.tile && targetTile) {
      next.maskWorld.tile = {
        ...clone(masked.maskWorld.tile),
        x: targetTile.x,
        y: targetTile.y,
        width: targetTile.width,
        height: targetTile.height
      };
    }
  }
  return next;
}

function flattenedTargetPose(flattened, targetTile) {
  const wrapper = flattened?.wrapperTransform || {};
  return {
    x: finite(targetTile?.x) ?? finite(wrapper.x),
    y: finite(targetTile?.y) ?? finite(wrapper.y),
    width: finite(targetTile?.width) ?? finite(wrapper.width),
    height: finite(targetTile?.height) ?? finite(wrapper.height),
    rotation: finite(targetTile?.rotation) ?? finite(wrapper.rotation) ?? 0,
    texture: {
      anchorX: finite(targetTile?.texture?.anchorX ?? targetTile?.anchorX ?? wrapper.anchorX) ?? 0.5,
      anchorY: finite(targetTile?.texture?.anchorY ?? targetTile?.anchorY ?? wrapper.anchorY) ?? 0.5,
      scaleX: finite(targetTile?.texture?.scaleX ?? targetTile?.scaleX ?? wrapper.scaleX) ?? 1,
      scaleY: finite(targetTile?.texture?.scaleY ?? targetTile?.scaleY ?? wrapper.scaleY) ?? 1
    }
  };
}

function transformFlattenedForTarget(flattened, targetTile, flattenedTransform) {
  if (typeof flattenedTransform !== 'function') {
    throw new Error('Semantic flattened Tile transforms require an explicit flattened metadata adapter.');
  }
  return flattenedTransform(flattened, flattenedTargetPose(flattened, targetTile));
}

function transformFaNexusFlags(flags, pivot, factor, targetTile, flattenedTransform) {
  let next = scaleBuildingTypedFlags(flags, factor);
  if (next.assetScatter) next.assetScatter = scaleAssetScatter(next.assetScatter, factor);
  if (next.pathV2) next.pathV2 = scalePathData(next.pathV2, factor);
  if (next.pathsV2?.paths && Array.isArray(next.pathsV2.paths)) {
    next.pathsV2 = {
      ...clone(next.pathsV2),
      paths: next.pathsV2.paths.map((path) => scalePathData(path, factor))
    };
  }
  if (next.building) next.building = scaleBuildingData(next.building, pivot, factor, targetTile);
  if (next.buildingComposite) next.buildingComposite = scaleBuildingComposite(next.buildingComposite, pivot, factor);
  if (next.maskedTiling) next.maskedTiling = scaleMaskedTiling(next.maskedTiling, pivot, factor, targetTile);
  if (next.flattened) next.flattened = transformFlattenedForTarget(next.flattened, targetTile, flattenedTransform);
  scaleShadowFlags(next, factor);
  return next;
}

function rotateFaNexusFlags(flags, pivot, angle, targetTile, flattenedTransform) {
  if (!flags || typeof flags !== 'object') return clone(flags);
  const next = clone(flags);
  if (next.building) next.building = rotateBuildingData(next.building, pivot, angle, targetTile);
  if (next.buildingComposite) {
    next.buildingComposite = rotateBuildingComposite(next.buildingComposite, pivot, angle);
  }
  if (next.maskedTiling) {
    next.maskedTiling = rotateMaskedTiling(next.maskedTiling, pivot, angle, targetTile);
  }
  if (next.flattened) next.flattened = transformFlattenedForTarget(next.flattened, targetTile, flattenedTransform);
  return next;
}

function translateFaNexusFlags(flags, delta, targetTile, flattenedTransform) {
  if (!flags || typeof flags !== 'object') return clone(flags);
  const next = clone(flags);
  if (next.building && ![4, 5].includes(Number(next.building.schemaVersion))) {
    next.building = translateBuildingData(next.building, delta, targetTile);
  }
  if (next.buildingComposite) {
    next.buildingComposite = translateBuildingComposite(next.buildingComposite, delta);
  }
  if (next.maskedTiling) next.maskedTiling = translateMaskedTiling(next.maskedTiling, delta, targetTile);
  if (next.flattened) next.flattened = transformFlattenedForTarget(next.flattened, targetTile, flattenedTransform);
  return next;
}

export function readSemanticTileFlags(document) {
  const flags = document?._source?.flags?.[MODULE_ID] || document?.flags?.[MODULE_ID] || null;
  if (!flags || typeof flags !== 'object') return null;
  const semanticKeys = [
    'pathV2',
    'pathsV2',
    'building',
    'buildingFill',
    'buildingComposite',
    'buildingDoorFrame',
    'buildingWindowFrame',
    'buildingWindowWindow',
    'buildingWindowSill',
    'buildingSills',
    'assetScatter',
    'maskedTiling',
    'flattened'
  ];
  return semanticKeys.some((key) => flags[key]) ? clone(flags) : null;
}

export function resizeSemanticTileFlags({ flags, originalTile, finalTile }) {
  if (!flags || typeof flags !== 'object') return clone(flags);
  if ([4, 5].includes(Number(flags?.building?.schemaVersion))) {
    throw new Error('Building Editor V2 resize is unavailable until M4 rotation and uniform-scale safety.');
  }
  const originalWidth = finite(originalTile?.width);
  const originalHeight = finite(originalTile?.height);
  const finalWidth = finite(finalTile?.width);
  const finalHeight = finite(finalTile?.height);
  if ([originalWidth, originalHeight, finalWidth, finalHeight].some((value) => value == null)
    || !(originalWidth > 0) || !(originalHeight > 0) || !(finalWidth > 0) || !(finalHeight > 0)) {
    throw new Error('Semantic per-axis resize requires positive original and final Tile dimensions.');
  }
  const scaleX = finalWidth / originalWidth;
  const scaleY = finalHeight / originalHeight;
  const scalarFactor = Math.sqrt(scaleX * scaleY);
  const pivot = {
    x: finite(originalTile?.x),
    y: finite(originalTile?.y)
  };
  if ([pivot.x, pivot.y].some((value) => value == null)) {
    throw new Error('Semantic per-axis resize requires a finite original Tile anchor position.');
  }
  let next = transformFaNexusFlags(flags, pivot, scalarFactor, finalTile, null);
  const correction = {
    correctionX: scaleX / scalarFactor,
    correctionY: scaleY / scalarFactor,
    pivot,
    angleDegrees: finite(originalTile?.rotation) ?? 0,
    targetTile: finalTile
  };
  if (next.building) next.building = correctBuildingAxes(next.building, correction);
  if (next.building?.meta) {
    const previousPose = flags.building?.meta?.currentEditPose || {};
    const previousScaleX = finite(previousPose.scaleX) ?? 1;
    const previousScaleY = finite(previousPose.scaleY) ?? 1;
    next.building.meta.currentEditPose = {
      ...clone(previousPose),
      scaleX: clean(previousScaleX * scaleX),
      scaleY: clean(previousScaleY * scaleY)
    };
  }
  if (next.buildingComposite) {
    next.buildingComposite = correctBuildingCompositeAxes(next.buildingComposite, correction);
  }
  if (flags.maskedTiling) {
    next.maskedTiling = deriveMaskedTilingResizeCommit({
      maskedTiling: flags.maskedTiling,
      originalTile,
      finalTile
    });
  }
  return next;
}

export function transformSemanticTileFlags({ flags, pivot, transform, targetTile, flattenedTransform = null }) {
  if (!flags) return clone(flags);
  if ([4, 5].includes(Number(flags?.building?.schemaVersion))) {
    if (String(transform?.operation || '') === 'rotate') return clone(flags);
    if (String(transform?.operation || '') === 'scale') return clone(flags);
  }
  if (transform?.operation === 'scale') {
    return transformFaNexusFlags(flags, pivot, transform.factor, targetTile, flattenedTransform);
  }
  if (transform?.operation === 'rotate') {
    const angle = Number(transform.angle);
    const normalizedPivot = { x: Number(pivot?.x), y: Number(pivot?.y) };
    if (!Number.isFinite(angle) || ![normalizedPivot.x, normalizedPivot.y].every(Number.isFinite)) {
      throw new Error('Semantic Tile rotation requires a finite angle and pivot.');
    }
    return rotateFaNexusFlags(flags, normalizedPivot, angle, targetTile, flattenedTransform);
  }
  return clone(flags);
}

export function translateSemanticTileFlags({ flags, delta, targetTile, flattenedTransform = null }) {
  if (!flags) return clone(flags);
  const normalizedDelta = { x: Number(delta?.x), y: Number(delta?.y) };
  if (![normalizedDelta.x, normalizedDelta.y].every(Number.isFinite)) {
    throw new Error('Semantic Tile translation requires a finite delta.');
  }
  return translateFaNexusFlags(flags, normalizedDelta, targetTile, flattenedTransform);
}
