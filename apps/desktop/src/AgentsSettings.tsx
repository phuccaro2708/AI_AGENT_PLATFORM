import { useCallback, useEffect, useState } from "react";
import { api, type Provider, type SettingsOutcome } from "./api";
import { argsText, envText, looksLikeSecretName, toSettings } from "./agentSettings";
import { canBrowse } from "./dialog";
import { deleteSecret, secretNames, setSecret } from "./secrets";

const PROVIDERS: { id: Provider; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Outcome({ o }: { o: SettingsOutcome }) {
  if (!o.ok) {
    return (
      <p className="error small" role="alert">
        {o.reason ?? "Not usable"}
      </p>
    );
  }
  const caps = Object.entries(o.probe?.capabilities ?? {})
    .filter(([, v]) => v)
    .map(([k]) => k);
  return (
    <p className="ok small" role="status">
      Works. {o.resolvedPath ? `Runs ${o.resolvedPath}` : ""}
      {o.probe?.version ? ` · ${o.probe.version}` : ""}
      {caps.length > 0 ? ` · ${caps.join(", ")}` : ""}
    </p>
  );
}

function Secrets({ provider }: { provider: Provider }) {
  const [names, setNames] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    secretNames(provider).then(setNames, (e) => setError(message(e)));
  }, [provider]);
  useEffect(refresh, [refresh]);

  const run = async (job: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await job();
      refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="secrets">
      <h3>Secrets</h3>
      <p className="muted small">
        Kept in the system credential store, never in the database. They can be replaced or deleted
        here but never shown again. Changing one restarts the background service, so it waits until
        no task is running.
      </p>
      {names.length === 0 ? (
        <p className="muted small">None stored.</p>
      ) : (
        <ul className="list small">
          {names.map((n) => (
            <li key={n} className="field-row">
              <code>{n}</code>
              <span className="muted">stored</span>
              <button disabled={busy} onClick={() => void run(() => deleteSecret(provider, n))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <input
          aria-label={`${provider} secret name`}
          placeholder="ANTHROPIC_API_KEY"
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
        />
        <input
          aria-label={`${provider} secret value`}
          type="password"
          autoComplete="off"
          placeholder="value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button
          disabled={busy || !looksLikeSecretName(name) || value === ""}
          onClick={() =>
            void run(async () => {
              await setSecret(provider, name, value);
              setName("");
              setValue("");
            })
          }
        >
          Save
        </button>
      </div>
      {name !== "" && !looksLikeSecretName(name) && (
        <p className="muted small">The name must end in KEY, TOKEN, SECRET or PASSWORD.</p>
      )}
      {error && (
        <p className="error small" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function ProviderCard({ provider, label }: { provider: Provider; label: string }) {
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<SettingsOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.agentSettings(provider).then(
      (s) => {
        setCommand(s?.command ?? "");
        setArgs(argsText(s?.args ?? []));
        setEnv(envText(s?.env ?? {}));
        setSaved(s?.verifiedAt ?? null);
      },
      (e) => setOutcome({ ok: false, reason: message(e) }),
    );
  }, [provider]);

  const act = async (job: () => Promise<SettingsOutcome>) => {
    setBusy(true);
    try {
      setOutcome(await job());
    } catch (e) {
      setOutcome({ ok: false, reason: message(e) });
    } finally {
      setBusy(false);
    }
  };
  const draft = toSettings(command, args, env);
  const problem = draft.ok ? null : draft.reason;

  return (
    <div className="card agent-settings">
      <h2>{label}</h2>
      <label className="field">
        <span>Command or full path</span>
        <input
          aria-label={`${label} command`}
          placeholder={provider}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Extra arguments (one per line)</span>
        <textarea
          aria-label={`${label} arguments`}
          rows={3}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Environment (NAME=value per line)</span>
        <textarea
          aria-label={`${label} environment`}
          rows={2}
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
      </label>
      <p className="muted small">
        Permissions, tools and the working folder are set per task and cannot be changed here. Only
        proxy, language, time zone and certificate variables are accepted; API keys go under
        Secrets. Settings apply only after a successful check.
      </p>
      {problem && command !== "" && <p className="error small">{problem}</p>}
      <div className="actions">
        <button
          disabled={busy || !draft.ok}
          onClick={() => draft.ok && void act(() => api.probeAgent(provider, draft.settings))}
        >
          Check
        </button>
        <button
          className="primary"
          disabled={busy || !draft.ok}
          onClick={() =>
            draft.ok &&
            void act(async () => {
              const r = await api.saveAgentSettings(provider, draft.settings);
              if (r.ok) setSaved(r.settings?.verifiedAt ?? null);
              return r;
            })
          }
        >
          Save
        </button>
        <button
          disabled={busy || saved === null}
          onClick={() =>
            void act(async () => {
              const r = await api.saveAgentSettings(provider, null);
              if (r.ok) {
                setCommand("");
                setArgs("");
                setEnv("");
                setSaved(null);
              }
              return r;
            })
          }
        >
          Use defaults
        </button>
      </div>
      {outcome && <Outcome o={outcome} />}
      <p className="muted small">
        {saved ? `Saved settings verified ${new Date(saved).toLocaleString()}.` : "Using defaults."}
      </p>
      {canBrowse() ? (
        <Secrets provider={provider} />
      ) : (
        <p className="muted small">Secrets can be stored in the desktop app.</p>
      )}
    </div>
  );
}

export function AgentsSettings() {
  return (
    <>
      {PROVIDERS.map((p) => (
        <ProviderCard key={p.id} provider={p.id} label={p.label} />
      ))}
    </>
  );
}
