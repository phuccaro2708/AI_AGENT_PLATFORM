import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { onSidecarEvent } from "./sidecar";
import {
  applyEvent,
  emptyLog,
  hasGap,
  isTerminal,
  mergeMessages,
  resyncCursor,
  type TaskLog,
} from "./taskLog";

const PAGE = 500;

/**
 * Follows one task: pushed events for latency, `logs.query` as the source of truth.
 * Pushes can be dropped under backpressure, so a hole in `sequence` — or the final state —
 * triggers a catch-up query. Returns the log and the last error, if any.
 */
export function useTaskLog(taskId: string | null): { log: TaskLog; error: string | null } {
  const [log, setLog] = useState<TaskLog>(emptyLog);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<TaskLog>(emptyLog);

  useEffect(() => {
    const set = (l: TaskLog) => {
      ref.current = l;
      setLog(l);
    };
    set(emptyLog);
    setError(null);
    if (!taskId) return;

    let live = true;
    let syncing = false;
    let again = false;
    const sync = async () => {
      if (syncing) {
        again = true;
        return;
      }
      syncing = true;
      try {
        do {
          again = false;
          for (;;) {
            const page = await api.logs(taskId, resyncCursor(ref.current), PAGE);
            if (!live) return;
            set(mergeMessages(ref.current, page.messages));
            if (page.messages.length < PAGE) break;
          }
        } while (again);
        const { state } = await api.task(taskId);
        if (live && state) set({ ...ref.current, state });
      } catch (e) {
        if (live) setError(String(e));
      } finally {
        syncing = false;
      }
    };

    // Subscribe before the first query so nothing falls between the two.
    const unsub = onSidecarEvent((e) => {
      if (e.event !== "task.message" && e.event !== "task.state") return;
      if (e.taskId !== taskId) return;
      const next = applyEvent(ref.current, e);
      set(next);
      if (hasGap(next) || (e.event === "task.state" && isTerminal(e.state))) void sync();
    });
    void sync();
    return () => {
      live = false;
      void unsub.then((f) => f());
    };
  }, [taskId]);

  return { log, error };
}
