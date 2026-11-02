import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { ActivityPanel } from "./ActivityPanel";
import { AgentView } from "./AgentView";
import { Header } from "./Header";
import { api, type AdapterInfo, type CliProbe, type Project } from "./api";
import { msg, TaskLogView, type TaskRef } from "./components";
import { getHealth, type Health } from "./health";
import { MultiAgentView, type MultiRun } from "./MultiAgentView";
import { runSelftestIfRequested } from "./selftest";
import { onSidecarEvent } from "./sidecar";
import { NewProjectDialog } from "./NewProjectDialog";
import { Sidebar, type Mode, type Session } from "./Sidebar";
import { SettingsView } from "./SettingsView";
import { useNickname } from "./profile";
import { useTheme } from "./theme";

export function App() {
  const [mode, setMode] = useState<Mode>("agent");
  const [settings, setSettings] = useState(false);
  const { nickname, setNickname } = useNickname();
  const { theme, set: setTheme } = useTheme();
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
  const [newProject, setNewProject] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [terminal, setTerminal] = useState(false);
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
        setTasks((t) => [{ id, title: text.slice(0, 60), prompt: text, agentId, projectId }, ...t]);
        setSelectedTask(id);
        setError(null);
      },
      (err: unknown) => fail(msg(err)),
    );
  };

  const startRun = (goal: string) => {
    const agentIds = chosen;
    Promise.all(agentIds.map((a) => api.startTask(projectId, a, goal))).then(
      (ids) => {
        const run: MultiRun = {
          id: ids.join("+"),
          projectId,
          goal,
          tasks: ids.map((id, i) => ({
            id,
            title: goal.slice(0, 60),
            prompt: goal,
            agentId: agentIds[i]!,
            projectId,
          })),
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
  const toggleChosen = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  const task = tasks.find((t) => t.id === selectedTask) ?? null;
  const run = runs.find((r) => r.id === selectedRun) ?? null;
  const openTasks = mode === "agent" ? (task ? [task] : []) : (run?.tasks ?? []);
  const title = settings
    ? "Settings"
    : mode === "agent"
      ? (task?.title ?? "New session")
      : (run?.goal.slice(0, 60) ?? "New multi-agent run");

  const sessions: Session[] = [
    ...tasks.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      mode: "agent" as const,
      label: `${t.agentId}: ${t.title}`,
      taskIds: [t.id],
    })),
    ...runs.map((r) => ({
      id: r.id,
      projectId: r.projectId,
      mode: "multi" as const,
      label: r.goal.slice(0, 40),
      taskIds: r.tasks.map((t) => t.id),
    })),
  ];
  const openSession = (s: Session) => {
    setSettings(false);
    setMode(s.mode);
    setProjectId(s.projectId);
    if (s.mode === "agent") setSelectedTask(s.id);
    else setSelectedRun(s.id);
  };
  const newSession = (pid?: string) => {
    setSettings(false);
    if (pid) setProjectId(pid);
    setSelectedTask(null);
    setSelectedRun(null);
  };
  const switchMode = (m: Mode) => {
    setSettings(false);
    setMode(m);
    if (m === "agent") setSelectedTask(null);
    else setSelectedRun(null);
  };

  const agent = adapters.find((a) => a.id === agentId);
  return (
    <div className={settings ? "shell no-activity" : "shell"}>
      <Header
        title={title}
        availableAgents={adapters.filter((a) => a.available).length}
        terminalOpen={terminal}
        onTerminal={() => setTerminal((v) => !v)}
      />
      <Sidebar
        mode={mode}
        onMode={switchMode}
        projects={projects}
        projectId={projectId}
        onProject={setProjectId}
        sessions={sessions}
        states={states}
        selected={mode === "agent" ? selectedTask : selectedRun}
        onSession={openSession}
        onNewProject={() => setNewProject(true)}
        onNewSession={newSession}
        nickname={nickname}
        onSettings={() => setSettings((v) => !v)}
        settingsOpen={settings}
      />
      <main className="main-col">
        <div className="content">
          {error && (
            <p role="alert" className="error banner">
              {error} <button onClick={() => setError(null)}>Dismiss</button>
            </p>
          )}
          {settings ? (
            <SettingsView
              nickname={nickname}
              onNickname={setNickname}
              theme={theme}
              onTheme={setTheme}
              version={health ? `${health.source} · v${health.version}` : "starting…"}
              onClose={() => setSettings(false)}
            />
          ) : mode === "agent" ? (
            <AgentView
              agentId={agentId}
              agentAvailable={agent?.available ?? false}
              projectName={project?.name ?? null}
              canRun={canRun}
              task={task}
              onStart={startAgentTask}
              onError={fail}
            />
          ) : (
            <MultiAgentView
              chosen={chosen}
              projectName={project?.name ?? null}
              canRun={canRun}
              run={run}
              onStart={startRun}
              onError={fail}
            />
          )}
        </div>
        {terminal && !settings && (
          <section className="terminal" aria-label="Tool output">
            <h2>Tool output · read-only, not a shell</h2>
            {openTasks.length === 0 ? (
              <p className="muted small">Open a session to see its tool calls and results.</p>
            ) : (
              openTasks.map((t) => (
                <TaskLogView
                  key={t.id}
                  taskId={t.id}
                  title={t.agentId}
                  onError={fail}
                  kinds={["tool"]}
                  cancellable={false}
                  variant="term"
                />
              ))
            )}
          </section>
        )}
      </main>
      {!settings && (
        <ActivityPanel
          mode={mode}
          adapters={adapters}
          cli={cli}
          detecting={detecting}
          onDetect={detect}
          agentId={agentId}
          onAgent={setAgentId}
          chosen={chosen}
          onToggle={toggleChosen}
          tasks={openTasks}
          states={states}
        />
      )}
      {newProject && (
        <NewProjectDialog
          onClose={() => setNewProject(false)}
          onCreated={(id) => {
            setNewProject(false);
            refreshProjects();
            setProjectId(id);
          }}
        />
      )}
    </div>
  );
}
