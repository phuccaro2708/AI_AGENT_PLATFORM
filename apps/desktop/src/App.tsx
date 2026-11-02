import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { AgentView } from "./AgentView";
import { ErrorCard } from "./ErrorCard";
import { Header } from "./Header";
import { Inspector } from "./Inspector";
import { api, type AdapterInfo, type CliProbe, type Project } from "./api";
import { msg, type TaskRef } from "./components";
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
  const [inspector, setInspector] = useState(false);
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

  const retry = () => {
    setError(null);
    getHealth().then(setHealth, (e: unknown) => setError(msg(e)));
    refreshProjects();
    refreshAgents();
  };

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

  return (
    <div className={inspector && !settings ? "shell with-inspector" : "shell"}>
      <Header
        project={project?.name ?? null}
        session={title}
        status={openTasks.length === 1 ? states[openTasks[0]!.id] : undefined}
        availableAgents={adapters.filter((a) => a.available).length}
        inspectorOpen={inspector && !settings}
        onInspector={() => {
          setSettings(false);
          setInspector((v) => !v);
        }}
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
          {error && <ErrorCard message={error} onRetry={retry} onDismiss={() => setError(null)} />}
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
              projects={projects}
              projectId={projectId}
              onProject={setProjectId}
              onNewProject={() => setNewProject(true)}
              adapters={adapters}
              agentId={agentId}
              onAgent={setAgentId}
              onDetect={detect}
              task={task}
              onStart={startAgentTask}
              onError={fail}
            />
          ) : (
            <MultiAgentView
              projects={projects}
              projectId={projectId}
              onProject={setProjectId}
              onNewProject={() => setNewProject(true)}
              adapters={adapters}
              chosen={chosen}
              onToggle={toggleChosen}
              run={run}
              onStart={startRun}
              onError={fail}
            />
          )}
        </div>
      </main>
      {inspector && !settings && (
        <Inspector
          project={project}
          adapters={adapters}
          cli={cli}
          detecting={detecting}
          onDetect={detect}
          agentId={agentId}
          chosen={chosen}
          multi={mode === "multi"}
          tasks={openTasks}
          states={states}
          onError={fail}
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
