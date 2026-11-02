import type { TaskState } from "@agent-studio/contracts";
import type { AdapterInfo, CliProbe } from "./api";
import { Badge, type TaskRef } from "./components";
import type { Mode } from "./Sidebar";

/** Right column: which agents take part, and what each task of the open session is doing. */
export function ActivityPanel({
  mode,
  adapters,
  cli,
  detecting,
  onDetect,
  agentId,
  onAgent,
  chosen,
  onToggle,
  tasks,
  states,
}: {
  mode: Mode;
  adapters: AdapterInfo[];
  cli: CliProbe[];
  detecting: boolean;
  onDetect: () => void;
  agentId: string;
  onAgent: (id: string) => void;
  chosen: string[];
  onToggle: (id: string) => void;
  tasks: TaskRef[];
  states: Record<string, TaskState>;
}) {
  const multi = mode === "multi";
  return (
    <aside className="activity" aria-label="Agent activity">
      <section>
        <div className="side-title">
          <h2>{multi ? "Team (pick 2 or more)" : "Agent"}</h2>
          <button className="ghost" onClick={onDetect} disabled={detecting}>
            {detecting ? "Detecting…" : "Detect CLIs"}
          </button>
        </div>
        <div className="agent-list" role={multi ? "group" : "radiogroup"} aria-label="Agents">
          {adapters.map((a) => {
            const on = multi ? chosen.includes(a.id) : a.id === agentId;
            const version = cli.find((c) => c.provider === a.id)?.version;
            return (
              <button
                key={a.id}
                role={multi ? "checkbox" : "radio"}
                aria-checked={on}
                className={on ? "agent-row active" : "agent-row"}
                onClick={() => (multi ? onToggle(a.id) : onAgent(a.id))}
              >
                <span className={a.available ? "dot ok" : "dot"} aria-hidden="true" />
                <span className="agent-main">
                  <strong>{a.id}</strong>
                  <span className={a.available ? "ok small" : "muted small"}>
                    {a.available ? "available" : "not found"}
                    {version ? ` · ${version}` : ""}
                  </span>
                </span>
                <span className="mark" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
              </button>
            );
          })}
          <div className="agent-row disabled" aria-disabled="true">
            <span className="dot" aria-hidden="true" />
            <span className="agent-main">
              <strong>Remote agent</strong>
              <span className="muted small">Not supported yet (roadmap Phase 8)</span>
            </span>
          </div>
        </div>
      </section>

      <section>
        <h2>Activity</h2>
        {tasks.length === 0 ? (
          <p className="muted small">Open or start a session to see its tasks here.</p>
        ) : (
          <ul className="activity-list">
            {tasks.map((t) => (
              <li key={t.id}>
                <span className="agent-main">
                  <strong>{t.agentId}</strong>
                  <span className="muted small clip">{t.title}</span>
                </span>
                <Badge state={states[t.id]} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
