import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Approval, type WorkflowState, type WorkflowTask } from "./api";
import { msg } from "./components";
import { workflowDone, type PeerRun } from "./peerReview";
import { isTerminal } from "./taskLog";

export interface Snapshot {
  state: WorkflowState;
  tasks: WorkflowTask[];
}

const settled = (s: Snapshot) => workflowDone(s.state) && s.tasks.every((t) => isTerminal(t.state));

/**
 * Workflows have no push events (docs/ASSUMPTIONS.md), so the UI polls `tasks.list`.
 * A run that has settled is read once more only when it is first seen, e.g. after a restart.
 */
export function useRuns(runs: PeerRun[], onError: (m: string) => void, intervalMs = 1500) {
  const [snaps, setSnaps] = useState<Record<string, Snapshot>>({});
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const seen = useRef<Record<string, Snapshot>>({});
  const reported = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = { ...seen.current };
      for (const r of runs) {
        const known = next[r.workflowId];
        if (known && settled(known)) continue;
        const { workflowState, tasks } = await api.workflowTasks(r.workflowId);
        next[r.workflowId] = { state: workflowState, tasks };
      }
      seen.current = next;
      setSnaps(next);
      setApprovals(await api.approvals("pending"));
      reported.current = false;
    } catch (e) {
      if (!reported.current) onError(msg(e));
      reported.current = true;
    }
  }, [runs, onError]);

  useEffect(() => {
    if (runs.length === 0) return;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [runs, refresh, intervalMs]);

  return { snaps, approvals, refresh };
}
