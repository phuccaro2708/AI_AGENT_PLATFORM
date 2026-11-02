import { useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { api } from "./api";
import { describeMessage, isTerminal } from "./taskLog";
import { useTheme } from "./theme";
import { useTaskLog } from "./useTaskLog";

export const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface TaskRef {
  id: string;
  title: string;
  agentId: string;
  projectId: string;
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const night = theme === "dark";
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      aria-label={night ? "Switch to light mode" : "Switch to night mode"}
      title={night ? "Light mode" : "Night mode"}
    >
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        {night ? (
          <path d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm0-1.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3ZM8 0l1 2H7l1-2Zm0 16-1-2h2l-1 2ZM0 8l2-1v2L0 8Zm16 0-2 1V7l2 1ZM2.3 2.3l2.1.7-1.4 1.4-.7-2.1Zm11.4 11.4-2.1-.7 1.4-1.4.7 2.1ZM13.7 2.3l-.7 2.1-1.4-1.4 2.1-.7ZM2.3 13.7l.7-2.1 1.4 1.4-2.1.7Z" />
        ) : (
          <path d="M6 .3a7.5 7.5 0 1 0 9.7 9.7A6 6 0 0 1 6 .3Z" />
        )}
      </svg>
    </button>
  );
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
