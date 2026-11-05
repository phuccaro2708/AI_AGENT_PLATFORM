import { useState } from "react";
import { api, type DiagnosticsExport } from "./api";

/** One button: writes a redacted support bundle next to the database and shows where it is. */
export function DiagnosticsCard() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiagnosticsExport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setBusy(true);
    setError(null);
    api
      .exportDiagnostics()
      .then(setResult, (e: unknown) => {
        setResult(null);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setBusy(false));
  };
  return (
    <div className="card">
      <h2>Diagnostics</h2>
      <p className="muted small">
        Writes a folder with versions, settings, recent logs and a task summary. Known secrets are
        masked and the folder is checked before it is reported. Look through it before sharing it.
      </p>
      <div className="actions">
        <button onClick={run} disabled={busy}>
          {busy ? "Exporting…" : "Export diagnostics"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {result && (
        <div role="status">
          <p className="small">
            {result.verified ? "Exported and verified:" : "Exported, but verification failed:"}{" "}
            <code>{result.dir}</code>
          </p>
          <ul className="muted small">
            {result.files.map((f) => (
              <li key={f.path}>
                {f.path} · {f.bytes} bytes
              </li>
            ))}
          </ul>
          {result.problems.length > 0 && (
            <p className="error small">{result.problems.join("; ")}</p>
          )}
          <p className="muted small">{result.limits}</p>
        </div>
      )}
    </div>
  );
}
