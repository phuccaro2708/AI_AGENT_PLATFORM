import { useCallback, useEffect, useState } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { AgentView } from "./AgentView";
import { ErrorCard } from "./ErrorCard";
import { Header } from "./Header";
import { HistoryView } from "./HistoryView";
import { Inspector } from "./Inspector";
import { api, type AdapterInfo, type CliProbe, type Project } from "./api";
import { msg, type TaskRef } from "./components";
import { getHealth, type Health } from "./health";
import { loadRuns, saveRuns, type PeerRun } from "./peerReview";
import { PeerReviewView } from "./PeerReviewView";
import { runSelftestIfRequested } from "./selftest";
import { onSidecarEvent } from "./sidecar";
import { NewProjectDialog } from "./NewProjectDialog";
import { Sidebar, type Mode, type Session } from "./Sidebar";
import { SettingsView } from "./SettingsView";
import { useNickname } from "./profile";
import { useTheme } from "./theme";
import { useRuns } from "./useRuns";

export function App() {
  const [mode, setMode] = useState<Mode>("agent");
  const [settings, setSettings] = useState(false);
  const [history, setHistory] = useState(false);
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
  const [runs, setRuns] = useState<PeerRun[]>(loadRuns);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [inspector, setInspector] = useState(false);
  const [states, setStates] = useState<Record<string, TaskState>>({});

  const fail = useCallback((m: string) => setError(m), []);
  const { snaps, approvals, refresh: refreshRuns } = useRuns(runs, fail);
  useEffect(() => {
    // Polled workflow tasks also feed the sidebar dots (push events only cover the open tasks).
    setStates((s) => {
      const next = { ...s };
      for (const snap of Object.values(snaps)) for (const t of snap.tasks) next[t.id] = t.state;
      return next;
    });
  }, [snaps]);
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

  const startRun = (implementer: string, reviewer: string, goal: string) => {
    api.startPeerReview(projectId, implementer, reviewer, goal).then(
      (workflowId) => {
        const run: PeerRun = { workflowId, projectId, goal, implementer, reviewer };
        setRuns((r) => {
          const next = [run, ...r];
          saveRuns(next);
          return next;
        });
        setSelectedRun(workflowId);
        setError(null);
      },
      (err: unknown) => fail(msg(err)),
    );
  };

  const project = projects.find((p) => p.id === projectId);
  const task = tasks.find((t) => t.id === selectedTask) ?? null;
  const run = runs.find((r) => r.workflowId === selectedRun) ?? null;
  const toRefs = (r: PeerRun): TaskRef[] =>
    (snaps[r.workflowId]?.tasks ?? []).map((t) => ({
      id: t.id,
      title: r.goal.slice(0, 60),
      prompt: r.goal,
      agentId: t.agentId ?? "?",
      projectId: r.projectId,
    }));
  const openTasks = mode === "agent" ? (task ? [task] : []) : run ? toRefs(run) : [];
  const title = settings
    ? "Settings"
    : history
      ? "History"
      : mode === "agent"
        ? (task?.title ?? "New session")
        : (run?.goal.slice(0, 60) ?? "New Peer Review");

  const sessions: Session[] = [
    ...tasks.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      mode: "agent" as const,
      label: `${t.agentId}: ${t.title}`,
      taskIds: [t.id],
    })),
    ...runs.map((r) => ({
      id: r.workflowId,
      projectId: r.projectId,
      mode: "multi" as const,
      label: r.goal.slice(0, 40),
      taskIds: (snaps[r.workflowId]?.tasks ?? []).map((t) => t.id),
    })),
  ];
  const openSession = (s: Session) => {
    setSettings(false);
    setHistory(false);
    setMode(s.mode);
    setProjectId(s.projectId);
    if (s.mode === "agent") setSelectedTask(s.id);
    else setSelectedRun(s.id);
  };
  const newSession = (pid?: string) => {
    setSettings(false);
    setHistory(false);
    if (pid) setProjectId(pid);
    setSelectedTask(null);
    setSelectedRun(null);
  };
  const switchMode = (m: Mode) => {
    setSettings(false);
    setHistory(false);
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
        onSettings={() => {
          setHistory(false);
          setSettings((v) => !v);
        }}
        settingsOpen={settings}
        onHistory={() => {
          setSettings(false);
          setHistory((v) => !v);
        }}
        historyOpen={history}
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
          ) : history ? (
            <HistoryView projects={projects} adapters={adapters} onError={fail} />
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
            <PeerReviewView
              projects={projects}
              projectId={projectId}
              onProject={setProjectId}
              onNewProject={() => setNewProject(true)}
              adapters={adapters}
              run={run}
              snapshot={run ? snaps[run.workflowId] : undefined}
              approvals={approvals}
              onStart={startRun}
              onResolved={() => void refreshRuns()}
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
          chosen={run ? [run.implementer, run.reviewer] : []}
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
