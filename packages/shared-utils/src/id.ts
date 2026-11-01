import { ulid } from "ulid";

/** Sortable unique id, optionally prefixed (e.g. "task_01H..."). */
export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${ulid()}` : ulid();
}
