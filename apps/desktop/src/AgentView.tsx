import { useState } from "react";
import type { AdapterInfo, Project } from "./api";
import { AGENT_TASK_REQUIRES, capabilityBlocker } from "./capabilityGap";
import { AUTO_AGENT } from "./autoRoute";
import { Composer, StartSteps } from "./Composer";
import type { Preset } from "./presets";
import { TaskLogView, type TaskRef } from "./components";

/** Mode 1: one agent, one project, one task at a time. */
export function AgentView({
  projects,
  projectId,
  onProject,
  onNewProject,
  adapters,
  agentId,
  onAgent,
  onDetect,
  task,
  onStart,
  presets,
  presetId,
  onPreset,
  onError,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onNewProject: () => void;
  adapters: AdapterInfo[];
  agentId: string;
  onAgent: (id: string) => void;
  onDetect: () => void;
  task: TaskRef | null;
  onStart: (prompt: string) => void;
  presets: Preset[];
  presetId: string;
  onPreset: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const agent = adapters.find((a) => a.id === agentId);
  const blocker = !project
    ? "Choose a project first"
    : agentId === AUTO_AGENT
      ? // The sidecar's router checks availability and capabilities and explains any gap.
        prompt.trim() === ""
        ? "Describe the task"
        : null
      : !agent
        ? "Pick an agent"
        : !agent.available
          ? `${agent.id} was not found on this machine`
          : (capabilityBlocker(agent, AGENT_TASK_REQUIRES) ??
            (prompt.trim() === "" ? "Describe the task" : null));
  return (
    <div className="chat">
      <div className="chat-body">
        {task ? (
          <>
            <p className="bubble user">{task.prompt}</p>
            <TaskLogView
              key={task.id}
              taskId={task.id}
              title={task.agentId}
              onError={onError}
              kinds={["text", "info", "error"]}
            />
          </>
        ) : (
          <StartSteps
            title="Start a task"
            steps={[
              {
                label: "Choose a project",
                done: project !== undefined,
                action: { label: "Choose project", run: onNewProject },
              },
              {
                label: "Select an agent",
                done: agent?.available ?? false,
                action: { label: "Detect CLIs", run: onDetect },
              },
              { label: "Describe your task, then run it", done: false },
            ]}
          />
        )}
      </div>

      <Composer
        projects={projects}
        projectId={projectId}
        onProject={onProject}
        onNewProject={onNewProject}
        agents={
          <>
            <label className="picker">
              <span className="muted small">Agent</span>
              <select aria-label="Agent" value={agentId} onChange={(e) => onAgent(e.target.value)}>
                <option value={AUTO_AGENT}>Auto (router picks)</option>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                    {a.available ? "" : " (not found)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="picker">
              <span className="muted small">Preset</span>
              <select
                aria-label="Preset"
                value={presetId}
                onChange={(e) => {
                  onPreset(e.target.value);
                  const want = presets.find((p) => p.id === e.target.value)?.agentId;
                  if (want && adapters.some((a) => a.id === want && a.available)) onAgent(want);
                }}
              >
                <option value="">None</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        }
        value={prompt}
        onChange={setPrompt}
        label="Prompt"
        placeholder={
          project
            ? `Describe what ${agentId || "the agent"} should do in ${project.name}…`
            : "Choose a project to begin"
        }
        submitLabel="Run task"
        blocker={blocker}
        onSubmit={(text) => {
          onStart(text);
          setPrompt("");
        }}
      />
    </div>
  );
}
