import { useEffect, useState } from "react";
import { api, type RecoveryAction, type RecoveryReport } from "./api";
import { RECOVERY_CHOICES, evidenceSummary, recoveryBlocker } from "./recovery";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * A task stopped with unknown side effects. The sidecar reports what it found (read-only) and a person
 * picks resume / retry / abandon; nothing runs by itself. The note goes to the audit trail.
 */
export function RecoveryPanel({
  taskId,
  onResolved,
  onError,
}: {
  taskId: string;
  onResolved?: () => void;
  onError: (m: string) => void;
}) {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  const [action, setAction] = useState<RecoveryAction | null>(null);
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.inspectRecovery(taskId).then(
      (r) => {
        if (live) setReport(r);
      },
      (e: unknown) => onError(msg(e)),
    );
    return () => {
      live = false;
    };
  }, [taskId, onError]);

  const blocker = recoveryBlocker(report, action, note, confirmed);
  const send = () => {
    if (action === null || blocker !== null) return;
    setBusy(true);
    api
      .recover(taskId, action, note.trim(), confirmed)
      .then(
        (r) => {
          setDone(r.state);
          onResolved?.();
        },
        (e: unknown) => onError(msg(e)),
      )
      .finally(() => setBusy(false));
  };

  if (done !== null) {
    return (
      <p role="status" className="small">
        Decision recorded. The task is now {done}.
      </p>
    );
  }
  return (
    <section className="reconcile" aria-label="Recovery">
      <p className="small">
        This task stopped before it reported a result, so what it changed is not known. Nothing
        continues until you decide.
      </p>
      {report && (
        <p className="muted small" role="status">
          {report.classification === "no_evidence_of_side_effects"
            ? "No evidence of side effects"
            : "Side effects could not be verified"}
          {" — "}
          {evidenceSummary(report)}
        </p>
      )}
      <fieldset className="choices">
        <legend className="muted small">What do you want to do?</legend>
        {RECOVERY_CHOICES.map(([value, label, hint]) => {
          const a = report?.actions[value];
          const off = a !== undefined && !a.allowed;
          return (
            <label key={value} className={action === value ? "chip active" : "chip"}>
              <span className="chip-title">
                <input
                  type="radio"
                  name={`recovery-${taskId}`}
                  checked={action === value}
                  disabled={off}
                  onChange={() => {
                    setAction(value);
                    setConfirmed(false);
                  }}
                />
                {label}
              </span>
              <span className="muted small">{off ? (a.why ?? hint) : hint}</span>
            </label>
          );
        })}
      </fieldset>
      {action !== null && report?.actions[action].confirmation === true && (
        <label className="choice">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          <span>I checked the worktree and this choice is safe</span>
        </label>
      )}
      <textarea
        aria-label="What did you check?"
        placeholder="What did you check? (kept in the audit trail)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
      />
      <div className="actions">
        <button disabled={busy || blocker !== null} onClick={send}>
          Confirm decision
        </button>
        {blocker && <span className="muted small">{blocker}</span>}
      </div>
    </section>
  );
}
