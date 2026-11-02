import { useState } from "react";
import type { AdapterInfo, Project } from "./api";
import { Composer, StartSteps } from "./Composer";
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
  projects,
  projectId,
  onProject,
  onNewProject,
  adapters,
  chosen,
  onToggle,
  run,
  onStart,
  onError,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onNewProject: () => void;
  adapters: AdapterInfo[];
  chosen: string[];
  onToggle: (id: string) => void;
  run: MultiRun | null;
  onStart: (goal: string) => void;
  onError: (m: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const blocker = !project
    ? "Choose a project first"
    : chosen.length < 2
      ? "Pick at least 2 agents"
      : goal.trim() === ""
        ? "Describe the goal"
        : null;
  return (
    <div className="chat">
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
          <>
            <StartSteps
              title="Start a team run"
              steps={[
                {
                  label: "Choose a project",
                  done: project !== undefined,
                  action: { label: "Choose project", run: onNewProject },
                },
                { label: "Tick at least 2 agents", done: chosen.length >= 2 },
                { label: "Describe the goal, then run it", done: false },
              ]}
            />
            <p className="muted small">
              Each agent gets the goal and works on its own in the same project folder. They do not
              talk to each other yet, so changes to the same files can collide.
            </p>
          </>
        )}
      </div>

      <Composer
        projects={projects}
        projectId={projectId}
        onProject={onProject}
        onNewProject={onNewProject}
        agents={
          <fieldset className="picker chips">
            <legend className="muted small">Team</legend>
            {adapters.map((a) => (
              <label key={a.id} className={chosen.includes(a.id) ? "chip active" : "chip"}>
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  onChange={() => onToggle(a.id)}
                />
                <span className={a.available ? "dot ok" : "dot"} aria-hidden="true" />
                {a.id}
                {a.available ? "" : " (not found)"}
              </label>
            ))}
          </fieldset>
        }
        value={goal}
        onChange={setGoal}
        label="Goal"
        placeholder={
          project ? `What should the team achieve in ${project.name}?` : "Choose a project to begin"
        }
        submitLabel="Run team"
        blocker={blocker}
        onSubmit={(text) => {
          onStart(text);
          setGoal("");
        }}
      />
    </div>
  );
}
