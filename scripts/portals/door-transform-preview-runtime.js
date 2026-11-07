import { NexusLogger as Logger } from '../core/nexus-logger.js';
import { DoorShadowManager } from './door-shadow-manager.js';
import {
  arePortalVisualsAuthoritative,
  DoorTransformPreviewSuppressionController,
  resolveAffectedAnimatedPortalWalls,
  resolvePortalVisualTargets
} from './door-transform-preview-suppression.js';
import { DoorVisualProxyManager } from './door-visual-proxy-manager.js';
import { syncDoorMeshTransformPreview } from './portal-texture-flip-runtime.js';

export class DoorTransformPreviewRuntime {
  constructor({
    canvasProvider = () => globalThis.canvas,
    proxyManagerProvider = () => (
      DoorVisualProxyManager.peek?.() || DoorVisualProxyManager.getInstance?.() || null
    ),
    shadowManagerProvider = () => (
      DoorShadowManager.peek?.() || DoorShadowManager.getInstance?.() || null
    ),
    controllerOptions = {}
  } = {}) {
    this._canvasProvider = canvasProvider;
    this._proxyManagerProvider = proxyManagerProvider;
    this._shadowManagerProvider = shadowManagerProvider;
    this._hooksBound = false;
    this._controller = new DoorTransformPreviewSuppressionController({
      resolveAffectedWalls: resolveAffectedAnimatedPortalWalls,
      resolveTargets: (walls) => resolvePortalVisualTargets(walls, this._environment()),
      isAuthoritativeReady: (walls) => arePortalVisualsAuthoritative(walls, this._environment()),
      holdWallTargetKind: (wall, kind) => this._setManagerSuppression(wall, kind, true),
      releaseWallTargetKind: (wall, kind) => this._setManagerSuppression(wall, kind, false),
      reportBackgroundCheckError: (error, details) => Logger.error(
        'DoorTransformPreview.backgroundHandoffCheckFailed',
        {
          details,
          error: String(error?.message || error)
        }
      ),
      ...controllerOptions
    });
  }

  initialize() {
    if (this._hooksBound) return;
    if (!globalThis.Hooks?.on) {
      throw new Error('Foundry Hooks are unavailable for door transform-preview lifecycle ownership.');
    }
    this._hooksBound = true;
    Hooks.on('canvasReady', () => this.clear('canvas-ready'));
    Hooks.on('canvasTearDown', () => this.clear('canvas-teardown'));
    Logger.info('DoorTransformPreview.runtime.initialized');
  }

  begin({ documents = [], source = 'unknown' } = {}) {
    const session = this._controller.begin({ documents, source });
    if (session.wallIds.length) return session;
    session.cancel('no-affected-portals');
    return null;
  }

  diagnostics() {
    return this._controller.diagnostics();
  }

  sync(document) {
    const documentName = String(document?.documentName || document?.constructor?.documentName || '');
    if (documentName !== 'Wall') return false;
    const wallId = String(document?.id || '').trim();
    const proxyManager = this._proxyManagerProvider?.() || null;
    const shadowManager = this._shadowManagerProvider?.() || null;
    const currentLevelChanged = syncDoorMeshTransformPreview(document);
    const proxyChanged = proxyManager?.syncDoorTransformPreview?.(document) === true;
    const shadowChanged = shadowManager?.syncDoorTransformPreview?.(document) === true;
    if (currentLevelChanged || proxyChanged || shadowChanged) {
      this._controller.revealSynchronizedPreviewTargets(document, {
        proxyReady: proxyChanged && proxyManager?.isDoorVisualReady?.(wallId, document) !== false,
        shadowReady: shadowChanged && shadowManager?.isPortalShadowReady?.(wallId, document) !== false
      });
    }
    return currentLevelChanged || proxyChanged || shadowChanged;
  }

  clear(reason = 'manual') {
    this._controller.cancelAll(reason);
  }

  _environment() {
    return {
      canvasRef: this._canvasProvider?.() || null,
      proxyManager: this._proxyManagerProvider?.() || null,
      shadowManager: this._shadowManagerProvider?.() || null
    };
  }

  _setManagerSuppression(wall, kind, suppressed) {
    const wallId = String(wall?.id || '').trim();
    if (!wallId) return;
    const environment = this._environment();
    if (kind === 'proxy-mesh') {
      environment.proxyManager?.setDoorTransformPreviewSuppressed?.(wallId, suppressed);
    } else if (kind === 'shadow-container') {
      environment.shadowManager?.setPortalTransformPreviewSuppressed?.(wallId, suppressed);
    }
  }
}

export const doorTransformPreviewRuntime = new DoorTransformPreviewRuntime();

if (globalThis.Hooks?.on) {
  try {
    doorTransformPreviewRuntime.initialize();
  } catch (error) {
    Logger.error('DoorTransformPreview.runtime.initializeFailed', {
      error: String(error?.message || error)
    });
  }
}
