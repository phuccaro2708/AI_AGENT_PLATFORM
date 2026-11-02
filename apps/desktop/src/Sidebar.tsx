import { useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import type { Project } from "./api";
import { ThemeToggle } from "./components";

export type Mode = "agent" | "multi";

export interface Session {
  id: string;
  projectId: string;
  mode: Mode;
  label: string;
  /** Task ids whose state is shown as a dot (one for agent tasks, several for a run). */
  taskIds: string[];
}

const dotClass = (states: (TaskState | undefined)[]) => {
  if (states.some((s) => s === "running")) return "running";
  if (states.some((s) => s === "failed" || s === "needs_reconciliation")) return "failed";
  if (states.length > 0 && states.every((s) => s === "completed")) return "completed";
  return "idle";
};

export function Sidebar({
  mode,
  onMode,
  projects,
  projectId,
  onProject,
  sessions,
  states,
  selected,
  onSession,
  onNewProject,
  version,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  sessions: Session[];
  states: Record<string, TaskState>;
  selected: string | null;
  onSession: (s: Session) => void;
  onNewProject: () => void;
  version: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const nav = [
    ["agent", "Agent", "Work with one agent on your machine"],
    ["multi", "Multi-agent", "A bigger project with several agents"],
  ] as const;
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          A
        </span>
        <strong>Agent Studio</strong>
      </div>
      <nav className="nav" role="tablist" aria-label="Mode">
        {nav.map(([m, label, hint]) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            className={mode === m ? "nav-item active" : "nav-item"}
            title={hint}
            onClick={() => onMode(m)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="side-title">
        <h2>Projects</h2>
        <button
          className="ghost"
          onClick={onNewProject}
          aria-label="New project"
          title="New project"
        >
          + New
        </button>
      </div>
      <div className="tree">
        {projects.length === 0 && (
          <button className="empty-cta" onClick={onNewProject}>
            Choose a folder to start
          </button>
        )}
        {projects.map((p) => {
          const open = !collapsed[p.id];
          const mine = sessions.filter((s) => s.projectId === p.id);
          return (
            <div key={p.id}>
              <button
                className={p.id === projectId ? "group active" : "group"}
                aria-expanded={open}
                title={p.rootPath}
                onClick={() => {
                  onProject(p.id);
                  setCollapsed((c) => ({ ...c, [p.id]: open }));
                }}
              >
                <span className={open ? "chev open" : "chev"} aria-hidden="true">
                  ▸
                </span>
                <span className="group-name">{p.name}</span>
              </button>
              {open &&
                (mine.length === 0 ? (
                  <p className="muted small session-empty">No sessions yet</p>
                ) : (
                  mine.map((s) => (
                    <button
                      key={s.id}
                      className={
                        s.id === selected && s.mode === mode ? "session active" : "session"
                      }
                      onClick={() => onSession(s)}
                    >
                      <span
                        className={`sdot ${dotClass(s.taskIds.map((t) => states[t]))}`}
                        aria-hidden="true"
                      />
                      <span className="session-label">{s.label}</span>
                      {s.mode === "multi" && <span className="tag">team</span>}
                    </button>
                  ))
                ))}
            </div>
          );
        })}
      </div>

      <div className="side-foot">
        <span className="muted small">{version}</span>
        <ThemeToggle />
      </div>
    </aside>
  );
}
