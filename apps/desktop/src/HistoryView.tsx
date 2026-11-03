import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { api, type AdapterInfo, type HistoryRow, type LogHit, type Project } from "./api";
import { Badge, msg, TaskLogView } from "./components";
import { agentsIn, PAGE, searchable, toFilter, whenText } from "./history";

const STATES: TaskState[] = [
  "queued",
  "running",
  "waiting_approval",
  "needs_reconciliation",
  "completed",
  "failed",
  "cancelled",
];

/** Every task ever run, across projects, with filters and a search over stored logs. Read-only. */
export function HistoryView({
  projects,
  adapters,
  onError,
}: {
  projects: Project[];
  adapters: AdapterInfo[];
  onError: (m: string) => void;
}) {
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [state, setState] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<LogHit[] | null>(null);
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    let live = true;
    api.history(toFilter({ projectId, agentId, state, offset })).then(
      (r) => {
        if (live) setRows(r);
      },
      (e: unknown) => onError(msg(e)),
    );
    return () => {
      live = false;
    };
  }, [projectId, agentId, state, offset, onError]);

  const search = useCallback(() => {
    if (!searchable(query)) return setHits(null);
    api
      .searchLogs(query.trim(), projectId || undefined)
      .then(setHits, (e: unknown) => onError(msg(e)));
  }, [query, projectId, onError]);

  const onFilter = (set: (v: string) => void) => (v: string) => {
    set(v);
    setOffset(0);
  };
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const agents = agentsIn(
    rows,
    adapters.map((a) => a.id),
  );

  return (
    <div className="history">
      <h2>History</h2>
      <div className="filters">
        <label className="picker">
          <span className="muted small">Project</span>
          <select
            aria-label="Project"
            value={projectId}
            onChange={(e) => onFilter(setProjectId)(e.target.value)}
          >
            <option value="">All</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="picker">
          <span className="muted small">Agent</span>
          <select
            aria-label="Agent"
            value={agentId}
            onChange={(e) => onFilter(setAgentId)(e.target.value)}
          >
            <option value="">All</option>
            {agents.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label className="picker">
          <span className="muted small">State</span>
          <select
            aria-label="State"
            value={state}
            onChange={(e) => onFilter(setState)(e.target.value)}
          >
            <option value="">All</option>
            {STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      <form
        className="log-search"
        onSubmit={(e) => {
          e.preventDefault();
          search();
        }}
      >
        <input
          type="search"
          aria-label="Search logs"
          placeholder="Search in logs (2+ characters)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={!searchable(query)}>
          Search
        </button>
      </form>

      {hits && (
        <section className="card">
          <div className="head">
            <h2>Log matches</h2>
            <button onClick={() => setHits(null)}>Close</button>
          </div>
          {hits.length === 0 ? (
            <p className="muted small">No log line contains that text.</p>
          ) : (
            <ul className="board">
              {hits.map((h) => (
                <li key={`${h.taskId}-${h.sequence}`}>
                  <button
                    className="link"
                    onClick={() => setOpen({ id: h.taskId, title: `Task ${h.taskId.slice(-6)}` })}
                  >
                    {h.taskId.slice(-6)} #{h.sequence}
                  </button>
                  <code className="snippet">{h.snippet}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        {rows.length === 0 ? (
          <p className="muted small">No tasks match.</p>
        ) : (
          <ul className="board">
            {rows.map((r) => (
              <li key={r.taskId}>
                <span className="muted small">{whenText(r.createdAt)}</span>
                <strong>{projectName(r.projectId)}</strong>
                <span>{r.agentId ?? "?"}</span>
                <Badge state={r.state} />
                {r.attempt > 0 && <span className="tag">attempt {r.attempt + 1}</span>}
                <button
                  onClick={() =>
                    setOpen({
                      id: r.taskId,
                      title: `${r.agentId ?? "?"} · ${projectName(r.projectId)}`,
                    })
                  }
                >
                  Open log
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            Newer
          </button>
          <button disabled={rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}>
            Older
          </button>
        </div>
      </section>

      {open && (
        <TaskLogView
          key={open.id}
          taskId={open.id}
          title={open.title}
          onError={onError}
          cancellable={false}
        />
      )}
    </div>
  );
}
