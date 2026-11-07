export function createLatestAsyncRequestGate() {
  let generation = 0;
  return Object.freeze({
    begin() {
      generation += 1;
      return generation;
    },
    isCurrent(token) {
      return Number(token) === generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    }
  });
}
