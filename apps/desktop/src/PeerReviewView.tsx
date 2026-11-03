import { useState } from "react";
import { api, type AdapterInfo, type Approval, type Project, type WorkflowTask } from "./api";
import { Composer, StartSteps } from "./Composer";
import { Badge, msg, TaskLogView } from "./components";
import { approvalText, approvalsFor, boardRows, diffTask, type PeerRun } from "./peerReview";
import type { Snapshot } from "./useRuns";

/**
 * Mode 2: Peer Review. One agent implements in its own git worktree, a second one reviews it
 * read-only, and a request for changes loops back. The sidecar chooses cwd, worktree and
 * permissions; a worktree is not a sandbox, and role permissions are CLI flags plus a post-run check.
 */
export function PeerReviewView({
  projects,
  projectId,
  onProject,
  onNewProject,
  adapters,
  run,
  snapshot,
  approvals,
  onStart,
  onResolved,
  onError,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onNewProject: () => void;
  adapters: AdapterInfo[];
  run: PeerRun | null;
  snapshot: Snapshot | undefined;
  approvals: Approval[];
  onStart: (implementer: string, reviewer: string, goal: string) => void;
  onResolved: () => void;
  onError: (m: string) => void;
}) {
  const [goal, setGoal] = useState("");
  const [implementer, setImplementer] = useState("");
  const [reviewer, setReviewer] = useState("");
  const project = projects.find((p) => p.id === projectId);
  const usable = adapters.filter((a) => a.available);
  const impl = implementer || usable[0]?.id || "";
  const rev = reviewer || usable[1]?.id || usable[0]?.id || "";
  const blocker = !project
    ? "Choose a project first"
    : impl === "" || rev === ""
      ? "No agent is available"
      : goal.trim() === ""
        ? "Describe the goal"
        : null;

  if (run) {
    return (
      <div className="chat">
        <div className="chat-body">
          <RunView
            run={run}
            snapshot={snapshot}
            approvals={approvals}
            onResolved={onResolved}
            onError={onError}
          />
        </div>
      </div>
    );
  }

  const pick = (label: string, value: string, set: (v: string) => void) => (
    <label className="picker">
      <span className="muted small">{label}</span>
      <select aria-label={label} value={value} onChange={(e) => set(e.target.value)}>
        {adapters.map((a) => (
          <option key={a.id} value={a.id} disabled={!a.available}>
            {a.id}
            {a.available ? "" : " (not found)"}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="chat">
      <div className="chat-body">
        <StartSteps
          title="Start a Peer Review"
          steps={[
            {
              label: "Choose a project (it must be a git repository)",
              done: project !== undefined,
              action: { label: "Choose project", run: onNewProject },
            },
            { label: "Pick who implements and who reviews", done: usable.length > 0 },
            { label: "Describe the goal, then run it", done: false },
          ]}
        />
        <p className="muted small">
          The implementer works in its own git worktree, the reviewer inspects the result read-only
          and answers approve or request changes (up to 2 rounds). A worktree keeps your checkout
          clean but is not a security sandbox. Nothing is merged for you.
        </p>
      </div>
      <Composer
        projects={projects}
        projectId={projectId}
        onProject={onProject}
        onNewProject={onNewProject}
        agents={
          <>
            {pick("Implementer", impl, setImplementer)}
            {pick("Reviewer", rev, setReviewer)}
          </>
        }
        value={goal}
        onChange={setGoal}
        label="Goal"
        placeholder={
          project
            ? `What should be built or changed in ${project.name}?`
            : "Choose a project to begin"
        }
        submitLabel="Start review"
        blocker={blocker}
        onSubmit={(text) => {
          onStart(impl, rev, text);
          setGoal("");
        }}
      />
    </div>
  );
}

function RunView({
  run,
  snapshot,
  approvals,
  onResolved,
  onError,
}: {
  run: PeerRun;
  snapshot: Snapshot | undefined;
  approvals: Approval[];
  onResolved: () => void;
  onError: (m: string) => void;
}) {
  const tasks = snapshot?.tasks ?? [];
  const rows = boardRows(tasks);
  const pending = approvalsFor(approvals, tasks);
  const latest = diffTask(rows);
  return (
    <>
      <p className="bubble user">{run.goal}</p>
      <section className="card">
        <div className="head">
          <h2>Task board</h2>
          <span className="muted small">
            {run.implementer} implements · {run.reviewer} reviews
          </span>
          <Badge state={snapshot ? workflowBadge(snapshot.state) : null} />
        </div>
        {rows.length === 0 ? (
          <p className="muted small">Waiting for the first task…</p>
        ) : (
          <ul className="board">
            {rows.map((r) => (
              <li key={r.task.id}>
                <span className="muted small">Round {r.round}</span>
                <strong>{r.role}</strong>
                <span>{r.task.agentId}</span>
                <Badge state={r.task.state} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <ApprovalCenter approvals={pending} onResolved={onResolved} onError={onError} />

      <h2>Timeline</h2>
      <div className="columns">
        {rows.map((r) => (
          <TaskLogView
            key={r.task.id}
            taskId={r.task.id}
            title={`${r.role} · ${r.task.agentId ?? "?"} · round ${r.round}`}
            onError={onError}
            kinds={["text", "info", "error"]}
          />
        ))}
      </div>

      {latest && <DiffViewer key={latest.id} task={latest} onError={onError} />}
    </>
  );
}

/** Badge classes only know task states; map the workflow ones onto them. */
function workflowBadge(s: string) {
  return (s === "pending" ? "queued" : s) as Parameters<typeof Badge>[0]["state"];
}

function ApprovalCenter({
  approvals,
  onResolved,
  onError,
}: {
  approvals: Approval[];
  onResolved: () => void;
  onError: (m: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (id: string, decision: "approved" | "denied") => {
    setBusy(true);
    api
      .resolveApproval(id, decision)
      .then(onResolved, (e: unknown) => onError(msg(e)))
      .finally(() => setBusy(false));
  };
  return (
    <section className="card">
      <div className="head">
        <h2>Approvals</h2>
      </div>
      {approvals.length === 0 ? (
        <p className="muted small">Nothing is waiting for you.</p>
      ) : (
        <ul className="board">
          {approvals.map((a) => (
            <li key={a.id}>
              <span>{approvalText(a)}</span>
              <button disabled={busy} onClick={() => answer(a.id, "approved")}>
                Approve
              </button>
              <button className="danger" disabled={busy} onClick={() => answer(a.id, "denied")}>
                Deny
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        An approval pauses the task until you answer; it does not limit what an agent can already
        do.
      </p>
    </section>
  );
}

function DiffViewer({ task, onError }: { task: WorkflowTask; onError: (m: string) => void }) {
  const [patch, setPatch] = useState<{ text: string; truncated: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const load = () => {
    setLoading(true);
    api
      .diff(task.id)
      .then(
        (d) => setPatch({ text: d.patch, truncated: d.truncated }),
        (e: unknown) => onError(msg(e)),
      )
      .finally(() => setLoading(false));
  };
  return (
    <section className="card">
      <div className="head">
        <h2>Changes in the worktree</h2>
        <button onClick={load} disabled={loading}>
          {patch ? "Reload diff" : "Show diff"}
        </button>
      </div>
      {patch &&
        (patch.text === "" ? (
          <p className="muted small">No changes yet.</p>
        ) : (
          <pre className="diff" aria-label="Diff">
            {patch.text.split("\n").map((line, i) => (
              <span key={i} className={diffClass(line)}>
                {line + "\n"}
              </span>
            ))}
          </pre>
        ))}
      {patch?.truncated && <p className="warn-text">The diff was cut at its size limit.</p>}
    </section>
  );
}

export function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ")) return "dh";
  if (line.startsWith("+")) return "da";
  if (line.startsWith("-")) return "dd";
  if (line.startsWith("@@")) return "dk";
  return "";
}
