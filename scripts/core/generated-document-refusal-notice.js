// One native action can refuse many generated documents: Clear Walls, a box selection or a
// multi-document update asks Foundry about each document in turn. Every refusal is logged
// where it happens; the user is told once for the whole action instead of once per document.
const FLUSH_DELAY_MS = 50;

let pending = null;

function flush() {
  const burst = pending;
  pending = null;
  if (!burst) return;
  const [first] = burst.explanations;
  globalThis.ui?.notifications?.warn?.(burst.explanations.size === 1
    ? first
    : `${burst.total} generated documents were left unchanged: they belong to ${burst.explanations.size} Buildings or Paths.`
      + ' Edit the owning Building or Path instead.');
}

/** Queue the ownership explanation for a refused direct write to a generated document. */
export function notifyGeneratedDocumentRefusal(explanation) {
  const message = String(explanation || '').trim();
  if (!message) return;
  if (!pending) {
    pending = { total: 0, explanations: new Set() };
    setTimeout(flush, FLUSH_DELAY_MS);
  }
  pending.total += 1;
  pending.explanations.add(message);
}
