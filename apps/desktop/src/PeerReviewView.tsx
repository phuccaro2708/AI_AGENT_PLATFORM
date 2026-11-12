import { useEffect, useState } from "react";
import { api, type Approval, type WorkflowTask } from "./api";
import { Badge, msg, TaskLogView } from "./components";
import { whenText } from "./history";
import { RecoveryPanel } from "./RecoveryPanel";
import {
  approvalText,
  decisionLog,
  approvalsFor,
  awaitingDecision,
  boardRows,
  diffTask,
  type PeerRun,
  type Row,
} from "./peerReview";
import type { Snapshot } from "./useRuns";

/**
 * An open Peer Review run (started from the composer with a reviewer). One agent implements in its
 * own git worktree, a second one reviews it read-only, and a request for changes loops back. The
 * sidecar chooses cwd, worktree and permissions; a worktree is not a sandbox.
 */
export function PeerReviewView(props: {
  run: PeerRun;
  snapshot: Snapshot | undefined;
  approvals: Approval[];
  onResolved: () => void;
  onError: (m: string) => void;
}) {
  return (
    <div className="chat">
      <div className="chat-body">
        <RunView {...props} />
      </div>
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

      {awaitingDecision(rows).map((r) => (
        <ReconcileCard key={r.task.id} row={r} onResolved={onResolved} onError={onError} />
      ))}

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
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [log, setLog] = useState<Approval[]>([]);
  // Decision log: refreshed whenever the set of pending requests changes (an answer or an expiry).
  const pendingKey = approvals.map((a) => a.id).join(",");
  useEffect(() => {
    let live = true;
    api.approvals().then(
      (all) => {
        if (live) setLog(decisionLog(all));
      },
      (e: unknown) => onError(msg(e)),
    );
    return () => {
      live = false;
    };
  }, [pendingKey, onError]);
  const answer = (id: string, decision: "approved" | "denied") => {
    setBusy(true);
    api
      .resolveApproval(id, decision, notes[id]?.trim())
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
            <li key={a.id} className="approval-card">
              <strong>{approvalText(a)}</strong>
              <span className="muted small">
                Asked {whenText(a.createdAt)}
                {a.expiresAt
                  ? ` · expires ${whenText(a.expiresAt)}; no answer means the task needs reconciliation`
                  : ""}
              </span>
              <input
                aria-label="Note (optional)"
                placeholder="Note (optional)"
                maxLength={2000}
                value={notes[a.id] ?? ""}
                onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
              />
              <div className="actions">
                <button disabled={busy} onClick={() => answer(a.id, "approved")}>
                  Allow once
                </button>
                <button className="danger" disabled={busy} onClick={() => answer(a.id, "denied")}>
                  Deny
                </button>
                <button
                  disabled
                  title="Standing permissions need the Policy Engine (Phase 4)"
                  aria-label="Always allow in this scope (needs the Policy Engine, Phase 4)"
                >
                  Always allow in scope
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        An approval pauses the task until you answer; it does not limit what an agent can already
        do. Nothing is chosen for you, and every answer applies to this one request only.
      </p>
      {log.length > 0 && (
        <>
          <h3>Decision log</h3>
          <ul className="board">
            {log.map((a) => (
              <li key={a.id}>
                <span className="muted small">{whenText(a.resolvedAt ?? a.createdAt)}</span>
                <span>{approvalText(a)}</span>
                <span className="tag">{a.state}</span>
                {a.decisionNote && <span className="muted small">“{a.decisionNote}”</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * A task stopped with unknown side effects (the app closed, the worker died...). Nothing runs it
 * again by itself: the sidecar reports what it found and a person decides (resume / retry / abandon).
 */
function ReconcileCard({
  row,
  onResolved,
  onError,
}: {
  row: Row;
  onResolved: () => void;
  onError: (m: string) => void;
}) {
  return (
    <section className="card reconcile" aria-label="Needs your decision">
      <div className="head">
        <h2>Needs your decision</h2>
        <span className="muted small">
          {row.role} · {row.task.agentId ?? "?"} · round {row.round}
        </span>
        <Badge state={row.task.state} />
      </div>
      {row.role === "implementer" && <DiffViewer task={row.task} onError={onError} />}
      <RecoveryPanel taskId={row.task.id} onResolved={onResolved} onError={onError} />
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
