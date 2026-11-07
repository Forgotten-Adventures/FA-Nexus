function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

// Foundry v14 applies a document patch through DataFieldOperator values rather than the legacy
// `-=key` / `==key` string keys. The wire form of an operator is a plain object carrying this
// identifier, which Foundry reconstructs while it cleans the incoming change set, so a planner with
// no Foundry access can still express an exact operation as pure data.
export const FOUNDRY_OPERATOR_IDENTIFIER = '__$OPERATOR$__';

export function forcedReplacement(value) {
  return { [FOUNDRY_OPERATOR_IDENTIFIER]: 'ForcedReplacement', value: clone(value) };
}

export function forcedDeletion() {
  return { [FOUNDRY_OPERATOR_IDENTIFIER]: 'ForcedDeletion' };
}
