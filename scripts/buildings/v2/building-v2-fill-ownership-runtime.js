import {
  FoundryBuildingSceneAdapter
} from '../ownership/building-fill-scene-adapter.js';
import { runFoundryCompositionRegistryTransaction } from '../../composition/composition-registry-transaction.js';
import { isBuildingEditSessionActive } from '../building-edit-delete-guard.js';
import {
  applyBuildingV2FillOwnershipPlan,
  BuildingV2FillOwnershipService
} from './building-v2-fill-ownership.js';

function identity(value) {
  return String(value || '').trim();
}

export function createFoundryBuildingV2FillOwnershipService({
  resolveScene = (sceneId) => {
    const active = globalThis.canvas?.scene;
    if (identity(active?.id) === identity(sceneId)) return active;
    return globalThis.game?.scenes?.get?.(sceneId) || null;
  }
} = {}) {
  const adapter = new FoundryBuildingSceneAdapter({ resolveScene });
  return new BuildingV2FillOwnershipService({
    readAggregate: (reference) => adapter.readAggregate(reference),
    isActiveSession: isBuildingEditSessionActive,
    transactionRunner: async (reference, operation) => {
      const scene = resolveScene(reference.sceneId);
      if (!scene) throw new Error(`Foundry Scene ${identity(reference.sceneId)} is unavailable for Building V2 Fill ownership.`);
      return runFoundryCompositionRegistryTransaction({ scene }, operation);
    },
    applyPlan: (plan) => {
      const scene = resolveScene(plan.sceneId);
      return applyBuildingV2FillOwnershipPlan({ foundry: globalThis.foundry, scene, plan });
    }
  });
}
