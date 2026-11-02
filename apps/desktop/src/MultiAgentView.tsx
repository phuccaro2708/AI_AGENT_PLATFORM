import { useState, type FormEvent } from "react";
import type { AdapterInfo } from "./api";
import { TaskLogView, type TaskRef } from "./components";

export interface MultiRun {
  id: string;
  projectId: string;
  goal: string;
  tasks: TaskRef[];
}

/**
 * Mode 2: a larger piece of work for one project with several agents taking part.
 * For now every chosen agent gets the same goal and runs independently, side by side;
 * there is no coordination between them yet (roadmap Phase 9).
 */
export function MultiAgentView({
  adapters,
  projectName,
  canRun,
  runs,
  selected,
  onStart,
  onError,
}: {
  adapters: AdapterInfo[];
  projectName: string | null;
  canRun: boolean;
  runs: MultiRun[];
  selected: string | null;
  onStart: (goal: string, agentIds: string[]) => void;
  onError: (m: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const run = runs.find((r) => r.id === selected) ?? null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(goal.trim(), chosen);
    setGoal("");
  };
  const ready = canRun && chosen.length >= 2 && goal.trim() !== "";
  return (
    <div className="view">
      <div className="view-body">
        <form onSubmit={submit} className="card stack">
          <h2>New multi-agent run</h2>
          <label>
            Goal
            <textarea
              aria-label="Goal"
              rows={3}
              maxLength={100000}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder={
                canRun
                  ? `What should the team achieve in ${projectName}?`
                  : "Choose a project in the sidebar first"
              }
            />
          </label>
          <fieldset className="participants">
            <legend>Participating agents (pick at least 2)</legend>
            {adapters.map((a) => (
              <label key={a.id} className={chosen.includes(a.id) ? "chip active" : "chip"}>
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span className={a.available ? "dot ok" : "dot"} aria-hidden="true" />
                {a.id}
                {a.available ? "" : " (not found)"}
              </label>
            ))}
          </fieldset>
          <p className="muted small">
            Each agent gets the goal and works on its own in the same project folder. They do not
            talk to each other yet, so changes to the same files can collide.
          </p>
          <div className="composer-bar">
            <span className="muted small">
              {chosen.length} agent{chosen.length === 1 ? "" : "s"} · {projectName ?? "no project"}
            </span>
            <button type="submit" disabled={!ready}>
              Start run
            </button>
          </div>
        </form>

        {run ? (
          <div className="columns">
            {run.tasks.map((t) => (
              <TaskLogView key={t.id} taskId={t.id} title={t.agentId} onError={onError} />
            ))}
          </div>
        ) : (
          <div className="empty">
            <p>
              <strong>Pick the agents, write the goal, start the run.</strong>
            </p>
            <p className="muted">Their output appears side by side here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
