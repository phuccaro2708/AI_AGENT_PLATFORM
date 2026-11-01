import { useEffect, useState } from "react";
import { getHealth, type Health } from "./health";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHealth().then(setHealth, (e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Agent Studio</h1>
      <p>Phase 0 — foundation. No agents are connected yet.</p>
      <h2>System health</h2>
      {error && <p role="alert">Error: {error}</p>}
      {!health && !error && <p>Checking…</p>}
      {health && (
        <ul>
          <li>Runtime: {health.source}</li>
          <li>App: {health.app}</li>
          <li>Version: {health.version}</li>
        </ul>
      )}
    </main>
  );
}
