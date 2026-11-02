import { useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { api } from "./api";
import { describeMessage, isTerminal } from "./taskLog";
import { useTaskLog } from "./useTaskLog";

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TaskRef {
  id: string;
  title: string;
  agentId: string;
  projectId: string;
}

export function Badge({ state }: { state: TaskState | null | undefined }) {
  return <span className={`badge ${state ?? "unknown"}`}>{state ?? "…"}</span>;
}

export function TaskLogView({
  taskId,
  title = "Output",
  onError,
}: {
  taskId: string;
  title?: string;
  onError: (m: string) => void;
}) {
  const { log, error } = useTaskLog(taskId);
  const [cancelling, setCancelling] = useState(false);
  const running = log.state !== null && !isTerminal(log.state);
  const cancel = () => {
    setCancelling(true);
    api
      .cancel(taskId)
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setCancelling(false));
  };
  return (
    <section className="card">
      <div className="head">
        <h2>{title}</h2>
        <Badge state={log.state} />
        <button className="danger" onClick={cancel} disabled={!running || cancelling}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {log.state === "needs_reconciliation" && (
        <p role="status" className="warn">
          The outcome could not be verified (a tool may have been running). Check the project before
          running this again; Agent Studio will not retry it automatically.
        </p>
      )}
      <ol className="log" aria-live="polite">
        {log.messages.map((m) => {
          const line = describeMessage(m);
          return (
            <li key={m.sequence} className={line.kind}>
              {line.text}
            </li>
          );
        })}
        {log.messages.length === 0 && <li className="muted">Waiting for output…</li>}
      </ol>
    </section>
  );
}
