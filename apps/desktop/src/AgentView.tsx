import { useState, type FormEvent } from "react";
import { TaskLogView, type TaskRef } from "./components";

/** Mode 1: talk to the agent chosen in the right column, inside the selected project. */
export function AgentView({
  agentId,
  agentAvailable,
  projectName,
  canRun,
  task,
  onStart,
  onError,
}: {
  agentId: string;
  agentAvailable: boolean;
  projectName: string | null;
  canRun: boolean;
  task: TaskRef | null;
  onStart: (prompt: string) => void;
  onError: (m: string) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onStart(prompt.trim());
    setPrompt("");
  };
  return (
    <div className="chat">
      <div className="chat-head">
        <h1>{task ? task.title : "New session"}</h1>
        <span className="pill">{task?.agentId ?? (agentId || "no agent")}</span>
      </div>

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
          <div className="empty">
            <p>
              <strong>Tell {agentId || "an agent"} what to do.</strong>
            </p>
            <p className="muted">
              {canRun
                ? `It will work inside ${projectName}. Pick another agent in the right column.`
                : "Add or choose a project in the sidebar first."}
            </p>
          </div>
        )}
      </div>

      <form onSubmit={submit} className="composer">
        {agentId !== "" && !agentAvailable && (
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
            canRun ? `Message ${agentId || "your agent"}… (Ctrl+Enter)` : "Choose a project first"
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
