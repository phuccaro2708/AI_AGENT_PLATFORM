import { useState } from "react";
import { draftAfterStart } from "./draft";
import type { AdapterInfo, Project } from "./api";
import {
  AUTO_AGENT,
  NO_REVIEWER,
  PEER_REVIEW_REQUIRES,
  capabilityBlocker,
  startBlocker,
} from "./capabilityGap";
import { Composer, StartSteps } from "./Composer";
import type { Preset } from "./presets";
import { TaskLogView, type TaskRef } from "./components";

/**
 * The one place to start work. No reviewer: one agent edits the project folder directly.
 * With a reviewer: Peer Review, the agent implements in its own git worktree and the reviewer
 * checks it read-only. A worktree keeps the checkout clean; it is not a security sandbox.
 */
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
  onStartPeer,
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
  /** Resolves `false` when the backend refused the task: the draft is then kept. */
  onStart: (prompt: string) => void | boolean | Promise<void | boolean>;
  /** Same contract as `onStart`, for a run with a reviewer. */
  onStartPeer: (
    implementer: string,
    reviewer: string,
    goal: string,
  ) => void | boolean | Promise<void | boolean>;
  presets: Preset[];
  presetId: string;
  onPreset: (id: string) => void;
  onError: (m: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [reviewerId, setReviewerId] = useState(NO_REVIEWER);
  const project = projects.find((p) => p.id === projectId);
  const agent = adapters.find((a) => a.id === agentId);
  const peer = reviewerId !== NO_REVIEWER;
  const blocker = startBlocker({
    hasProject: project !== undefined,
    adapters,
    agentId,
    reviewerId,
    prompt,
  });
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
              recover
            />
          </>
        ) : (
          <>
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
            <p className="muted small">
              {peer
                ? `${agentId} works in its own git worktree, ${reviewerId} reviews it read-only and answers approve or request changes (up to 2 rounds). The project needs to be a git repository. A worktree keeps your checkout clean but is not a security sandbox. Nothing is merged for you.`
                : "Without a reviewer the agent edits the project folder directly. Pick a reviewer to have the change built in a separate worktree and checked by a second agent."}
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
          <>
            <label className="picker">
              <span className="muted small">Agent</span>
              <select aria-label="Agent" value={agentId} onChange={(e) => onAgent(e.target.value)}>
                <option value={AUTO_AGENT} disabled={peer}>
                  Auto (router picks)
                </option>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                    {a.available ? "" : " (not found)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="picker">
              <span className="muted small">Review</span>
              <select
                aria-label="Reviewer"
                value={reviewerId}
                onChange={(e) => setReviewerId(e.target.value)}
              >
                <option value={NO_REVIEWER}>None</option>
                {adapters.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.available}>
                    {a.id}
                    {a.available ? "" : " (not found)"}
                    {capabilityBlocker(a, PEER_REVIEW_REQUIRES) ? " (thiếu capability)" : ""}
                  </option>
                ))}
              </select>
            </label>
            {!peer && (
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
            )}
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
        submitLabel={peer ? "Run with review" : "Run task"}
        blocker={blocker}
        onSubmit={(text) => {
          // Clear the draft only when the work was accepted, and only if it was not edited meanwhile.
          const started = peer ? onStartPeer(agentId, reviewerId, text) : onStart(text);
          void Promise.resolve(started).then((ok) => {
            setPrompt((cur) => draftAfterStart(cur, text, ok));
          });
        }}
      />
    </div>
  );
}
