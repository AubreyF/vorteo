// Deployed hosts send these admission failures as text. Keep the explicit
// classification here so goal recovery is presented with the goal controls.
const GOAL_ERRORS = new Set([
  "A goal change could not be confirmed. Review and set the task goal before continuing.",
  "The goal state must be confirmed before queue delivery.",
  "The goal pause could not be confirmed. Review the goal before continuing.",
  "The goal resume could not be confirmed. Review the goal before continuing.",
  "The goal stop could not be confirmed. Review the goal before continuing.",
]);

export function isQueueGoalError(error: string | null | undefined): boolean {
  return !!error && GOAL_ERRORS.has(error);
}

export function queueGoalRecoveryMessage(error: string): string {
  return isQueueGoalError(error)
    ? "Message delivery is blocked because the agent's goal state could not be verified. Review and save the goal to continue."
    : error;
}
