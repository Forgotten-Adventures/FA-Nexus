const NATIVE_TILE_GESTURE_ROUTE = Symbol.for('fa-nexus.native-tile-gesture-route');

export function rememberNativeTileGestureRoute(event, route) {
  if (!event?.interactionData || !route) return null;
  event.interactionData[NATIVE_TILE_GESTURE_ROUTE] = route;
  return route;
}

export function readNativeTileGestureRoute(event) {
  return event?.interactionData?.[NATIVE_TILE_GESTURE_ROUTE] || null;
}
