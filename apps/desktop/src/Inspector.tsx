import { useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import type { AdapterInfo, CliProbe, Project } from "./api";
import { Badge, TaskLogView, type TaskRef } from "./components";

const TABS = ["Context", "Activity", "Tools", "Logs"] as const;
type Tab = (typeof TABS)[number];

/** Right column, shown on demand: details about the open session and this machine. */
export function Inspector({
  project,
  adapters,
  cli,
  detecting,
  onDetect,
  agentId,
  chosen,
  multi,
  tasks,
  states,
  onError,
}: {
  project: Project | undefined;
  adapters: AdapterInfo[];
  cli: CliProbe[];
  detecting: boolean;
  onDetect: () => void;
  agentId: string;
  chosen: string[];
  multi: boolean;
  tasks: TaskRef[];
  states: Record<string, TaskState>;
  onError: (m: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("Context");
  const agents = multi ? chosen : agentId ? [agentId] : [];
  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="tabs" role="tablist" aria-label="Inspector">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? "tab active" : "tab"}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="inspector-body" role="tabpanel">
        {tab === "Context" && (
          <dl className="facts">
            <dt>Project</dt>
            <dd>{project ? project.name : "None selected"}</dd>
            {project && (
              <>
                <dt>Folder</dt>
                <dd className="fact-path">{project.rootPath}</dd>
              </>
            )}
            <dt>{multi ? "Team" : "Agent"}</dt>
            <dd>{agents.length > 0 ? agents.join(", ") : "None selected"}</dd>
          </dl>
        )}
        {tab === "Activity" &&
          (tasks.length === 0 ? (
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
          ))}
        {tab === "Tools" && (
          <>
            <div className="side-title">
              <h2>Agents on this machine</h2>
              <button className="ghost" onClick={onDetect} disabled={detecting}>
                {detecting ? "Detecting…" : "Detect CLIs"}
              </button>
            </div>
            <ul className="activity-list">
              {adapters.map((a) => {
                const version = cli.find((c) => c.provider === a.id)?.version;
                return (
                  <li key={a.id}>
                    <span className={a.available ? "dot ok" : "dot"} aria-hidden="true" />
                    <span className="agent-main">
                      <strong>{a.id}</strong>
                      <span className={a.available ? "ok small" : "muted small"}>
                        {a.available ? "available" : "not found"}
                        {version ? ` · ${version}` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
              <li className="disabled">
                <span className="agent-main">
                  <strong>Remote agent</strong>
                  <span className="muted small">Not supported yet (roadmap Phase 8)</span>
                </span>
              </li>
            </ul>
          </>
        )}
        {tab === "Logs" &&
          (tasks.length === 0 ? (
            <p className="muted small">
              Tool calls and results of the open session appear here (read-only, not a shell).
            </p>
          ) : (
            tasks.map((t) => (
              <TaskLogView
                key={t.id}
                taskId={t.id}
                title={t.agentId}
                onError={onError}
                kinds={["tool"]}
                cancellable={false}
                variant="term"
              />
            ))
          ))}
      </div>
    </aside>
  );
}
