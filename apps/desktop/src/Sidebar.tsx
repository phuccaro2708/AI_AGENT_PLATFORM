import { useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import type { Project } from "./api";
import { initials } from "./profile";

export interface Session {
  id: string;
  projectId: string;
  /** A single task, or a run with a reviewer (Peer Review). */
  kind: "task" | "review";
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
  projects,
  projectId,
  onProject,
  sessions,
  states,
  selected,
  onSession,
  onNewProject,
  onNewSession,
  nickname,
  onSettings,
  settingsOpen,
  onHistory,
  historyOpen,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  sessions: Session[];
  states: Record<string, TaskState>;
  selected: string | null;
  onSession: (s: Session) => void;
  onNewProject: () => void;
  /** Start an empty session, optionally in a given project. */
  onNewSession: (projectId?: string) => void;
  nickname: string;
  onSettings: () => void;
  settingsOpen: boolean;
  onHistory: () => void;
  historyOpen: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const q = query.trim().toLowerCase();
  return (
    <aside className="sidebar">
      <button className="nav-item new-session" onClick={() => onNewSession()}>
        <span aria-hidden="true">＋</span> New session
      </button>
      <input
        className="search"
        type="search"
        aria-label="Search sessions"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <button
        className={historyOpen ? "nav-item active" : "nav-item"}
        onClick={onHistory}
        title="Every task, with filters and log search"
      >
        History
      </button>

      <div className="side-title">
        <h2>Projects</h2>
        <button
          className="icon-btn"
          onClick={onNewProject}
          aria-label="New project"
          title="New project"
        >
          +
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
          const nameHit = p.name.toLowerCase().includes(q);
          const mine = sessions.filter(
            (s) =>
              s.projectId === p.id &&
              !hidden.has(s.id) &&
              (q === "" || nameHit || s.label.toLowerCase().includes(q)),
          );
          if (q !== "" && !nameHit && mine.length === 0) return null;
          return (
            <div key={p.id}>
              <div className="group-row">
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
                <button
                  className="icon-btn"
                  aria-label={`New session in ${p.name}`}
                  title="New session in this project"
                  onClick={() => onNewSession(p.id)}
                >
                  +
                </button>
              </div>
              {open &&
                (mine.length === 0 ? (
                  <p className="muted small session-empty">No sessions yet</p>
                ) : (
                  mine.map((s) => (
                    <div key={s.id} className="session-row">
                      <button
                        className={s.id === selected ? "session active" : "session"}
                        onClick={() => onSession(s)}
                      >
                        <span
                          className={`sdot ${dotClass(s.taskIds.map((t) => states[t]))}`}
                          aria-hidden="true"
                        />
                        <span className="session-label">{s.label}</span>
                        {s.kind === "review" && <span className="tag">review</span>}
                      </button>
                      <button
                        className="icon-btn more"
                        aria-label="Session options"
                        aria-expanded={menu === s.id}
                        onClick={() => setMenu(menu === s.id ? null : s.id)}
                      >
                        …
                      </button>
                      {menu === s.id && (
                        <div className="popmenu" role="menu">
                          <button
                            role="menuitem"
                            onClick={() => {
                              setHidden((h) => new Set(h).add(s.id));
                              setMenu(null);
                            }}
                          >
                            Hide from list
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                ))}
            </div>
          );
        })}
      </div>

      <div className="side-foot">
        <span className="avatar" aria-hidden="true">
          {initials(nickname)}
        </span>
        <span className="nick" title={nickname}>
          {nickname}
        </span>
        <button
          className={settingsOpen ? "icon-btn gear active" : "icon-btn gear"}
          aria-label="Settings"
          title="Settings"
          onClick={onSettings}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.4.9a1 1 0 0 0-.98-.8H7.6a1 1 0 0 0-.98.8l-.2 1a5.6 5.6 0 0 0-1.1.64l-.97-.33a1 1 0 0 0-1.2.46l-.41.7a1 1 0 0 0 .2 1.25l.77.67a5.7 5.7 0 0 0 0 1.28l-.77.67a1 1 0 0 0-.2 1.25l.4.7a1 1 0 0 0 1.2.46l.98-.33c.34.26.7.47 1.1.64l.2 1a1 1 0 0 0 .98.8h.82a1 1 0 0 0 .98-.8l.2-1c.4-.17.76-.38 1.1-.64l.97.33a1 1 0 0 0 1.2-.46l.41-.7a1 1 0 0 0-.2-1.25l-.77-.67a5.7 5.7 0 0 0 0-1.28l.77-.67a1 1 0 0 0 .2-1.25l-.4-.7a1 1 0 0 0-1.2-.46l-.98.33a5.6 5.6 0 0 0-1.1-.64l-.2-1ZM8 10.2a2.2 2.2 0 1 1 0-4.4 2.2 2.2 0 0 1 0 4.4Z" />
          </svg>
        </button>
      </div>
    </aside>
  );
}
