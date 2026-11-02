import { useState, type FormEvent } from "react";
import type { TaskState } from "@agent-studio/contracts";
import type { AdapterInfo, CliProbe } from "./api";
import { Badge, TaskLogView, type TaskRef } from "./components";

/** Mode 1: pick one agent installed on this machine and talk to it in the selected project. */
export function AgentView({
  adapters,
  cli,
  detecting,
  onDetect,
  agentId,
  onAgent,
  projectName,
  canRun,
  tasks,
  states,
  selected,
  onSelect,
  onStart,
  onError,
}: {
  adapters: AdapterInfo[];
  cli: CliProbe[];
  detecting: boolean;
  onDetect: () => void;
  agentId: string;
  onAgent: (id: string) => void;
  projectName: string | null;
  canRun: boolean;
  tasks: TaskRef[];
  states: Record<string, TaskState>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onStart: (prompt: string) => void;
  onError: (m: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const agent = adapters.find((a) => a.id === agentId);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(prompt.trim());
    setPrompt("");
  };
  const probe = (id: string) => cli.find((c) => c.provider === id);
  return (
    <div className="view">
      <div className="view-body">
        <section>
          <div className="side-title">
            <h2>Agents on this machine</h2>
            <button className="ghost" onClick={onDetect} disabled={detecting}>
              {detecting ? "Detecting…" : "Detect CLIs"}
            </button>
          </div>
          <div className="agent-grid" role="radiogroup" aria-label="Agent">
            {adapters.map((a) => {
              const p = probe(a.id);
              return (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={a.id === agentId}
                  className={a.id === agentId ? "agent-card active" : "agent-card"}
                  onClick={() => onAgent(a.id)}
                >
                  <span className="agent-name">
                    <span className={a.available ? "dot ok" : "dot"} aria-hidden="true" />
                    {a.id}
                  </span>
                  <span className={a.available ? "ok small" : "muted small"}>
                    {a.available ? "available" : "not found"}
                    {p?.version ? ` · ${p.version}` : ""}
                  </span>
                  <span className="muted small">
                    {a.capabilities.join(", ") || "no capabilities"}
                  </span>
                </button>
              );
            })}
            <div className="agent-card disabled" aria-disabled="true">
              <span className="agent-name">+ Connect remote agent</span>
              <span className="muted small">Not supported yet (ACP/MCP, roadmap Phase 8).</span>
            </div>
          </div>
        </section>

        {tasks.length > 0 && (
          <section>
            <h2>Conversations</h2>
            <ul className="list">
              {tasks.map((t) => (
                <li key={t.id}>
                  <button
                    className={t.id === selected ? "row active" : "row"}
                    onClick={() => onSelect(t.id)}
                  >
                    <span>
                      <strong>{t.agentId}</strong> {t.title}
                    </span>
                    <Badge state={states[t.id]} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {selected ? (
          <TaskLogView key={selected} taskId={selected} onError={onError} />
        ) : (
          <div className="empty">
            <p>
              <strong>Pick an agent, then tell it what to do.</strong>
            </p>
            <p className="muted">
              {canRun
                ? `It will work inside ${projectName}.`
                : "Add or choose a project in the sidebar first."}
            </p>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="composer">
        {agent && !agent.available && (
          <p className="warn">This agent was not found on this machine; the task will fail.</p>
        )}
        <textarea
          aria-label="Prompt"
          rows={3}
          maxLength={100000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && prompt.trim() && canRun) {
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            canRun
              ? `Ask ${agentId || "an agent"} to do something… (Ctrl+Enter)`
              : "Choose a project first"
          }
        />
        <div className="composer-bar">
          <span className="muted small">
            {agentId || "no agent"} · {projectName ?? "no project"}
          </span>
          <button type="submit" disabled={!canRun || agentId === "" || prompt.trim() === ""}>
            Start task
          </button>
        </div>
      </form>
    </div>
  );
}
