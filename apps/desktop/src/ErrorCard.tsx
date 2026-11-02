import { useState } from "react";

const isSidecar = (m: string) => /sidecar/i.test(m);

/** An error with something to do about it. Only actions that exist are offered. */
export function ErrorCard({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const [details, setDetails] = useState(false);
  const sidecar = isSidecar(message);
  return (
    <div role="alert" className="error-card">
      <div className="error-main">
        <strong>
          {sidecar ? "The background service could not start" : "Something went wrong"}
        </strong>
        {sidecar && (
          <p className="small">
            Start the app with <code>AGENT_STUDIO_SIDECAR_DIR</code> pointing at the sidecar folder,
            or put a <code>sidecar</code> folder next to <code>agent-studio.exe</code>.
          </p>
        )}
        {details && <pre className="small">{message}</pre>}
      </div>
      <div className="error-actions">
        <button onClick={onRetry}>Retry</button>
        <button className="ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          {details ? "Hide details" : "Show details"}
        </button>
        <button className="ghost" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
