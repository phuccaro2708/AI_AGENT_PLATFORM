import type { SidecarEvent } from "@agent-studio/contracts";

export const MAX_PENDING_BYTES = 1024 * 1024;

/**
 * Writes pushed events as NDJSON with a bounded buffer. When the reader is slow (`pending()` over the
 * limit) `task.message` events are dropped and counted; `task.state` is always written. Dropping is safe
 * because every message is already persisted: the client sees the `sequence` gap and calls
 * `logs.query {afterSequence}`.
 */
export function createEventWriter(opts: {
  write: (line: string) => void;
  pending: () => number;
  maxPending?: number;
}): { emit: (e: SidecarEvent) => void; dropped: () => number } {
  const max = opts.maxPending ?? MAX_PENDING_BYTES;
  let dropped = 0;
  return {
    emit(e) {
      if (e.event === "task.message" && opts.pending() > max) {
        dropped++;
        return;
      }
      opts.write(JSON.stringify(e) + "\n");
    },
    dropped: () => dropped,
  };
}
