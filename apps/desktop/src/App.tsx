import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { TaskState } from "@agent-studio/contracts";
import { api, type AdapterInfo, type CliProbe, type Project } from "./api";
import { getHealth, type Health } from "./health";
import { runSelftestIfRequested } from "./selftest";
import { onSidecarEvent } from "./sidecar";
import { describeMessage, isTerminal } from "./taskLog";
import { useTaskLog } from "./useTaskLog";

interface TaskRef {
  id: string;
  title: string;
  agentId: string;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Badge({ state }: { state: TaskState | null | undefined }) {
  return <span className={`badge ${state ?? "unknown"}`}>{state ?? "…"}</span>;
}

function Projects({
  projects,
  selected,
  onSelect,
  onCreated,
  onError,
}: {
  projects: Project[];
  selected: string;
  onSelect: (id: string) => void;
  onCreated: () => void;
  onError: (m: string) => void;
}) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    api.createProject(name.trim(), rootPath.trim()).then(
      ({ projectId }) => {
        setName("");
        setRootPath("");
        onCreated();
        onSelect(projectId);
      },
      (err: unknown) => onError(msg(err)),
    );
  };
  return (
    <section className="card">
      <h2>Projects</h2>
      {projects.length === 0 && <p className="muted">No projects yet.</p>}
      <ul className="list">
        {projects.map((p) => (
          <li key={p.id}>
            <button
              className={p.id === selected ? "row active" : "row"}
              onClick={() => onSelect(p.id)}
            >
              <strong>{p.name}</strong>
              <span className="muted path">{p.rootPath}</span>
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="stack">
        <input
          aria-label="Project name"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="Project folder"
          placeholder="Folder, e.g. C:\work\my-app"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
        />
        <button type="submit" disabled={!name.trim() || !rootPath.trim()}>
          Add project
        </button>
      </form>
    </section>
  );
}

function Agents({
  adapters,
  cli,
  onDetect,
  detecting,
}: {
  adapters: AdapterInfo[];
  cli: CliProbe[];
  onDetect: () => void;
  detecting: boolean;
}) {
  return (
    <section className="card">
      <h2>Agents</h2>
      <ul className="list">
        {adapters.map((a) => (
          <li key={a.id} className="row static">
            <strong>{a.id}</strong>
            <span className={a.available ? "ok" : "muted"}>
              {a.available ? "available" : "not found"}
            </span>
          </li>
        ))}
      </ul>
      {cli.length > 0 && (
        <ul className="list small">
          {cli.map((c) => (
            <li key={c.provider}>
              {c.provider}: {c.status}
              {c.version ? ` · ${c.version}` : ""}
            </li>
          ))}
        </ul>
      )}
      <button onClick={onDetect} disabled={detecting}>
        {detecting ? "Detecting…" : "Detect CLIs"}
      </button>
    </section>
  );
}

function TaskLogView({ taskId, onError }: { taskId: string; onError: (m: string) => void }) {
  const { log, error } = useTaskLog(taskId);
  const [cancelling, setCancelling] = useState(false);
  const running = log.state !== null && !isTerminal(log.state);
  const cancel = () => {
    setCancelling(true);
    api
      .cancel(taskId)
      .catch((e: unknown) => onError(msg(e)))
      .finally(() => setCancelling(false));
  };
  return (
    <section className="card">
      <div className="head">
        <h2>Output</h2>
        <Badge state={log.state} />
        <button className="danger" onClick={cancel} disabled={!running || cancelling}>
          Cancel
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {log.state === "needs_reconciliation" && (
        <p role="status" className="warn">
          The outcome could not be verified (a tool may have been running). Check the project before
          running this again; Agent Studio will not retry it automatically.
        </p>
      )}
      <ol className="log" aria-live="polite">
        {log.messages.map((m) => {
          const line = describeMessage(m);
          return (
            <li key={m.sequence} className={line.kind}>
              {line.text}
            </li>
          );
        })}
        {log.messages.length === 0 && <li className="muted">Waiting for output…</li>}
      </ol>
    </section>
  );
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [adapters, setAdapters] = useState<AdapterInfo[]>([]);
  const [cli, setCli] = useState<CliProbe[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [tasks, setTasks] = useState<TaskRef[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
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

  const start = (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    api.startTask(projectId, agentId, text).then(
      (id) => {
        setTasks((t) => [{ id, title: text.slice(0, 60), agentId }, ...t]);
        setSelected(id);
        setPrompt("");
        setError(null);
      },
      (err: unknown) => fail(msg(err)),
    );
  };

  const canStart = projectId !== "" && agentId !== "" && prompt.trim() !== "";
  const agent = adapters.find((a) => a.id === agentId);

  return (
    <main>
      <header>
        <h1>Agent Studio</h1>
        <span className="muted">
          {health ? `${health.source} · v${health.version}` : "starting…"}
        </span>
      </header>
      {error && (
        <p role="alert" className="error banner">
          {error} <button onClick={() => setError(null)}>Dismiss</button>
        </p>
      )}
      <div className="grid">
        <aside>
          <Projects
            projects={projects}
            selected={projectId}
            onSelect={setProjectId}
            onCreated={refreshProjects}
            onError={fail}
          />
          <Agents adapters={adapters} cli={cli} onDetect={detect} detecting={detecting} />
        </aside>
        <div className="main">
          <section className="card">
            <h2>New task</h2>
            <form onSubmit={start} className="stack">
              <label>
                Agent
                <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  {adapters.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.id}
                      {a.available ? "" : " (not found)"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Prompt
                <textarea
                  rows={4}
                  maxLength={100000}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="What should the agent do in this project?"
                />
              </label>
              {agent && !agent.available && (
                <p className="warn">
                  This agent was not found on this machine; the task will fail.
                </p>
              )}
              {projects.length === 0 && <p className="muted">Add a project first.</p>}
              <button type="submit" disabled={!canStart}>
                Start task
              </button>
            </form>
          </section>
          {tasks.length > 0 && (
            <section className="card">
              <h2>Tasks this session</h2>
              <ul className="list">
                {tasks.map((t) => (
                  <li key={t.id}>
                    <button
                      className={t.id === selected ? "row active" : "row"}
                      onClick={() => setSelected(t.id)}
                    >
                      <span>
                        <strong>{t.agentId}</strong> {t.title}
                      </span>
                      <Badge state={states[t.id]} />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {selected && <TaskLogView key={selected} taskId={selected} onError={fail} />}
        </div>
      </div>
    </main>
  );
}
