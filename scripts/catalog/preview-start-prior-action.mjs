/**
 * Pure decision for an owned, alive preview marker before workspace refresh / spawn.
 * @param {{ alreadyRunning: boolean }} input
 * @returns {'noop' | 'controlled-stop'}
 */
export function priorPreviewAction({ alreadyRunning }) {
  if (alreadyRunning) {
    return 'noop';
  }
  return 'controlled-stop';
}
