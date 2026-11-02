import { useState, type FormEvent } from "react";
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
  chosen,
  projectName,
  canRun,
  run,
  onStart,
  onError,
}: {
  /** Agents ticked in the right column. */
  chosen: string[];
  projectName: string | null;
  canRun: boolean;
  run: MultiRun | null;
  onStart: (goal: string) => void;
  onError: (m: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(goal.trim());
    setGoal("");
  };
  const ready = canRun && chosen.length >= 2 && goal.trim() !== "";
  return (
    <div className="chat">
      <div className="chat-head">
        <h1>{run ? run.goal.slice(0, 60) : "New multi-agent run"}</h1>
        <span className="pill">team</span>
      </div>

      <div className="chat-body">
        {run ? (
          <>
            <p className="bubble user">{run.goal}</p>
            <div className="columns">
              {run.tasks.map((t) => (
                <TaskLogView
                  key={t.id}
                  taskId={t.id}
                  title={t.agentId}
                  onError={onError}
                  kinds={["text", "info", "error"]}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="empty">
            <p>
              <strong>Tick the agents on the right, write the goal, start the run.</strong>
            </p>
            <p className="muted">
              Each agent gets the goal and works on its own in the same project folder. They do not
              talk to each other yet, so changes to the same files can collide.
            </p>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="composer">
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
        <div className="composer-bar">
          <span className="muted small">
            {chosen.length} agent{chosen.length === 1 ? "" : "s"} · {projectName ?? "no project"}
            {chosen.length < 2 ? " · pick at least 2" : ""}
          </span>
          <button type="submit" disabled={!ready}>
            Start run
          </button>
        </div>
      </form>
    </div>
  );
}
