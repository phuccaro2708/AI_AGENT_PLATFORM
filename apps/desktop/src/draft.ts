/**
 * What the composer holds after a start request settled. The draft is cleared only when the backend accepted the task
 * (`accepted !== false`) AND the user has not edited it while the request was running; a refusal keeps it intact.
 */
export function draftAfterStart(
  current: string,
  submitted: string,
  accepted: boolean | void,
): string {
  return accepted !== false && current.trim() === submitted ? "" : current;
}
