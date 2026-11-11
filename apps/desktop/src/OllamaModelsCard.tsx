import { useEffect, useState } from "react";
import { api, type OllamaModels } from "./api";

const gb = (b: number) => (b > 0 ? `${(b / 1e9).toFixed(1)} GB` : "");

/** Lists the models installed in the local Ollama so the person can copy the name into `AGENT_STUDIO_OLLAMA_MODEL`. */
export function OllamaModelsCard() {
  const [data, setData] = useState<OllamaModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    setBusy(true);
    setError(null);
    api
      .ollamaModels()
      .then(setData, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  useEffect(refresh, []);
  return (
    <div className="card">
      <h2>Ollama models</h2>
      <p className="muted small">
        Models installed in the local Ollama. Set the one to use with{" "}
        <code>AGENT_STUDIO_OLLAMA_MODEL</code> and restart the app.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {data && !data.reachable && (
        <p role="status" className="small">
          Ollama is not answering. Start it, then refresh.
        </p>
      )}
      {data?.reachable && data.models.length === 0 && (
        <p role="status" className="small">
          Ollama is running but no model is installed yet. Pull one first (<code>ollama pull</code>
          ).
        </p>
      )}
      {data?.reachable && data.models.length > 0 && (
        <ul className="small">
          {data.models.map((m) => (
            <li key={m.name}>
              <code>{m.name}</code>
              {[m.parameterSize, m.quantization, gb(m.sizeBytes)].filter(Boolean).length > 0 &&
                ` · ${[m.parameterSize, m.quantization, gb(m.sizeBytes)].filter(Boolean).join(" · ")}`}
              {data.configured === m.name && " · in use"}
            </li>
          ))}
        </ul>
      )}
      {data?.reachable &&
        data.configured &&
        !data.models.some((m) => m.name === data.configured) && (
          <p role="alert" className="error small">
            The configured model <code>{data.configured}</code> is not installed.
          </p>
        )}
      <div className="actions">
        <button onClick={refresh} disabled={busy}>
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
    </div>
  );
}
