import { useEffect, useState } from "react";
import { api, type ResourceReport, type ResourceSettings } from "./api";
import { vramLines } from "./vramText";

const LEVEL_TEXT = {
  normal: "Normal: tasks start up to the ceiling.",
  reduced: "Reduced: the machine is busy, so at most half the ceiling starts at once.",
  paused:
    "Paused: the machine is overloaded, so no new task starts. Running tasks are not stopped.",
} as const;

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));

/** Load limits (P3-4, P3-5): ceiling for tasks running at once and the CPU/memory levels that slow or hold new ones. */
export function ResourceLimitsCard() {
  const [report, setReport] = useState<ResourceReport | null>(null);
  const [draft, setDraft] = useState<ResourceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () =>
    api.getResources().then(
      (r) => {
        setReport(r);
        setDraft((d) => d ?? r.settings);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000); // the level changes with the machine, not with this form
    return () => clearInterval(t);
  }, []);

  if (!draft || !report) {
    return (
      <div className="card">
        <h2>Load limits</h2>
        {error ? (
          <p role="alert" className="error">
            {error}
          </p>
        ) : (
          <p className="muted small">Loading…</p>
        )}
      </div>
    );
  }

  const set = (fn: (d: ResourceSettings) => ResourceSettings) => {
    setSaved(false);
    setDraft(fn(draft));
  };
  const save = (next: ResourceSettings) => {
    setBusy(true);
    setError(null);
    api
      .setResources(next)
      .then(
        (r) => {
          setReport(r);
          setDraft(r.settings);
          setSaved(true);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setBusy(false));
  };
  const { status } = report;
  const m = status.monitor;
  const field = (label: string, value: number, onChange: (n: number) => void, max: number) => (
    <label className="small">
      {label}{" "}
      <input
        type="number"
        min={0}
        max={max}
        value={Number.isNaN(value) ? "" : value}
        onChange={(e) => onChange(num(e.target.value))}
        style={{ width: "5em" }}
      />
    </label>
  );
  const t = draft.thresholds;
  return (
    <div className="card">
      <h2>Load limits</h2>
      <p className="muted small">
        New tasks wait when the computer is busy. Tasks already running are never stopped by these
        limits.
      </p>
      <div role="status" className="small">
        <p>
          {m ? LEVEL_TEXT[m.level] : "Not measured."} Running {status.running}, queued{" "}
          {status.queued}, may start at once now {status.effectiveConcurrency} of{" "}
          {status.concurrency}.
        </p>
        {m && m.reasons.length > 0 && <p className="muted">Reason: {m.reasons.join("; ")}</p>}
        {m && !m.measured && (
          <p className="muted">
            The machine could not be read, so the level is lowered to be safe.
          </p>
        )}
        {vramLines(status).map((line) => (
          <p key={line} className="muted">
            {line}
          </p>
        ))}
        {m && (m.cpuPercent !== undefined || m.memoryPercent !== undefined) && (
          <p className="muted">
            {m.cpuPercent !== undefined && <>CPU {m.cpuPercent.toFixed(0)}% </>}
            {m.memoryPercent !== undefined && <>Memory {m.memoryPercent.toFixed(0)}%</>}
          </p>
        )}
      </div>
      <div className="actions" style={{ flexWrap: "wrap", gap: "0.75em" }}>
        {field(
          "Tasks at once (1-8)",
          draft.concurrency,
          (n) => set((d) => ({ ...d, concurrency: n })),
          8,
        )}
        {field(
          "CPU slow down at %",
          t.cpu.reduceAt,
          (n) =>
            set((d) => ({
              ...d,
              thresholds: { ...d.thresholds, cpu: { ...d.thresholds.cpu, reduceAt: n } },
            })),
          100,
        )}
        {field(
          "CPU pause at %",
          t.cpu.pauseAt,
          (n) =>
            set((d) => ({
              ...d,
              thresholds: { ...d.thresholds, cpu: { ...d.thresholds.cpu, pauseAt: n } },
            })),
          100,
        )}
        {field(
          "Memory slow down at %",
          t.memory.reduceAt,
          (n) =>
            set((d) => ({
              ...d,
              thresholds: { ...d.thresholds, memory: { ...d.thresholds.memory, reduceAt: n } },
            })),
          100,
        )}
        {field(
          "Memory pause at %",
          t.memory.pauseAt,
          (n) =>
            set((d) => ({
              ...d,
              thresholds: { ...d.thresholds, memory: { ...d.thresholds.memory, pauseAt: n } },
            })),
          100,
        )}
        <label className="small">
          <input
            type="checkbox"
            checked={t.vram !== undefined}
            onChange={(e) =>
              set((d) => {
                const { vram: _drop, ...rest } = d.thresholds;
                void _drop;
                return {
                  ...d,
                  thresholds: e.target.checked
                    ? { ...rest, vram: { reduceAt: 85, pauseAt: 95 } }
                    : rest,
                };
              })
            }
          />{" "}
          Limit by GPU memory (whole GPU, needs an NVIDIA driver)
        </label>
        {t.vram &&
          field(
            "GPU memory slow down at %",
            t.vram.reduceAt,
            (n) =>
              set((d) => ({
                ...d,
                thresholds: {
                  ...d.thresholds,
                  vram: { reduceAt: n, pauseAt: d.thresholds.vram?.pauseAt ?? 95 },
                },
              })),
            100,
          )}
        {t.vram &&
          field(
            "GPU memory pause at %",
            t.vram.pauseAt,
            (n) =>
              set((d) => ({
                ...d,
                thresholds: {
                  ...d.thresholds,
                  vram: { reduceAt: d.thresholds.vram?.reduceAt ?? 85, pauseAt: n },
                },
              })),
            100,
          )}
        {field(
          "Release margin %",
          t.releaseMarginPercent,
          (n) => set((d) => ({ ...d, thresholds: { ...d.thresholds, releaseMarginPercent: n } })),
          50,
        )}
      </div>
      <div className="actions">
        <button onClick={() => save(draft)} disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button onClick={() => save(report.defaults)} disabled={busy}>
          Restore defaults
        </button>
        {saved && <span className="muted small">Saved.</span>}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
