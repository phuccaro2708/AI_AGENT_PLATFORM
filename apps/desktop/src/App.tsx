import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { AgentView } from "./AgentView";
import { api, type AdapterInfo, type CliProbe, type Project } from "./api";
import { ProjectPicker, ThemeToggle, msg, type TaskRef } from "./components";
import { getHealth, type Health } from "./health";
import { MultiAgentView, type MultiRun } from "./MultiAgentView";
import { runSelftestIfRequested } from "./selftest";
import { onSidecarEvent } from "./sidecar";

type Mode = "agent" | "multi";

export function App() {
  const [mode, setMode] = useState<Mode>("agent");
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [cli, setCli] = useState<CliProbe[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [tasks, setTasks] = useState<TaskRef[]>([]);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [runs, setRuns] = useState<MultiRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, TaskState>>({});

  const fail = useCallback((m: string) => setError(m), []);
  const refreshProjects = useCallback(
    () => void api.projects().then(setProjects, (e: unknown) => fail(msg(e))),
    [fail],
  );
  const refreshAgents = useCallback(
    () =>
      void api.agents().then(
        ({ adapters: a, cli: c }) => {
          setAdapters(a);
          setCli(c);
          setAgentId((cur) => cur || a.find((x) => x.available)?.id || a[0]?.id || "");
        },
        (e: unknown) => fail(msg(e)),
      ),
    [fail],
  );

  useEffect(() => {
    getHealth().then(setHealth, (e: unknown) => setError(msg(e)));
    void runSelftestIfRequested();
    refreshProjects();
    refreshAgents();
    const unsub = onSidecarEvent((e) => {
      if (e.event === "task.state") setStates((s) => ({ ...s, [e.taskId]: e.state }));
    });
    return () => void unsub.then((f) => f());
  }, [refreshProjects, refreshAgents]);

  useEffect(() => {
    setProjectId((cur) => (projects.some((p) => p.id === cur) ? cur : (projects[0]?.id ?? "")));
  }, [projects]);

  const detect = () => {
    setDetecting(true);
    api
      .detect()
      .then(refreshAgents, (e: unknown) => fail(msg(e)))
      .finally(() => setDetecting(false));
  };

  const startAgentTask = (text: string) => {
    api.startTask(projectId, agentId, text).then(
      (id) => {
        setTasks((t) => [{ id, title: text.slice(0, 60), agentId }, ...t]);
        setSelectedTask(id);
        setError(null);
      },
      (err: unknown) => fail(msg(err)),
    );
  };

  const startRun = (goal: string, agentIds: string[]) => {
    Promise.all(agentIds.map((a) => api.startTask(projectId, a, goal))).then(
      (ids) => {
        const run: MultiRun = {
          id: ids.join("+"),
          goal,
          tasks: ids.map((id, i) => ({ id, title: goal.slice(0, 60), agentId: agentIds[i]! })),
        };
        setRuns((r) => [run, ...r]);
        setSelectedRun(run.id);
        setError(null);
      },
      (err: unknown) => fail(msg(err)),
    );
  };

  const project = projects.find((p) => p.id === projectId);
  const canRun = project !== undefined;

  return (
    <div className="shell">
      <header className="appbar">
        <span className="logo" aria-hidden="true">
          A
        </span>
        <h1>Agent Studio</h1>
        <span className="muted">
          {health ? `${health.source} · v${health.version}` : "starting…"}
        </span>
        <span className="spacer" />
        <ThemeToggle />
      </header>
      <aside className="sidebar">
        <div className="modes" role="tablist" aria-label="Mode">
          {(
            [
              ["agent", "Agent"],
              ["multi", "Multi-agent"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "mode active" : "mode"}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="muted small mode-hint">
          {mode === "agent"
            ? "Work with one agent on your machine."
            : "A bigger project with several agents taking part."}
        </p>
        <ProjectPicker
          projects={projects}
          selected={projectId}
          onSelect={setProjectId}
          onCreated={refreshProjects}
          onError={fail}
        />
      </aside>
      <main className="content">
        {error && (
          <p role="alert" className="error banner">
            {error} <button onClick={() => setError(null)}>Dismiss</button>
          </p>
        )}
        {mode === "agent" ? (
          <AgentView
            adapters={adapters}
            cli={cli}
            detecting={detecting}
            onDetect={detect}
            agentId={agentId}
            onAgent={setAgentId}
            projectName={project?.name ?? null}
            canRun={canRun}
            tasks={tasks}
            states={states}
            selected={selectedTask}
            onSelect={setSelectedTask}
            onStart={startAgentTask}
            onError={fail}
          />
        ) : (
          <MultiAgentView
            adapters={adapters}
            projectName={project?.name ?? null}
            canRun={canRun}
            runs={runs}
            states={states}
            selected={selectedRun}
            onSelect={setSelectedRun}
            onStart={startRun}
            onError={fail}
          />
        )}
      </main>
    </div>
  );
}
