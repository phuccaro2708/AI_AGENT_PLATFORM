import type { FormEvent, ReactNode } from "react";
import type { Project } from "./api";

/** One block that holds everything needed to start work: project, agent(s), text, run. */
export function Composer({
  projects,
  projectId,
  onProject,
  onNewProject,
  agents,
  value,
  onChange,
  label,
  placeholder,
  submitLabel,
  blocker,
  onSubmit,
}: {
  projects: Project[];
  projectId: string;
  onProject: (id: string) => void;
  onNewProject: () => void;
  /** The agent picker: a select (one agent) or chips (a team). */
  agents: ReactNode;
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  submitLabel: string;
  /** Why Run is disabled, shown beside it; null when the task can start. */
  blocker: string | null;
  onSubmit: (text: string) => void;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (blocker === null) onSubmit(value.trim());
  };
  return (
    <form onSubmit={submit} className="composer">
      <div className="composer-pickers">
        <label className="picker">
          <span className="muted small">Project</span>
          <select
            aria-label="Project"
            value={projectId}
            onChange={(e) =>
              e.target.value === "__new" ? onNewProject() : onProject(e.target.value)
            }
          >
            {projects.length === 0 && <option value="">No project selected</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="__new">+ Add project…</option>
          </select>
        </label>
        {agents}
      </div>
      <textarea
        aria-label={label}
        rows={3}
        maxLength={100000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && blocker === null) {
            e.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={placeholder}
      />
      <div className="composer-bar">
        <span className={blocker ? "warn-text small" : "muted small"}>
          {blocker ?? "Ctrl+Enter to run"}
        </span>
        <button type="submit" className="primary" disabled={blocker !== null}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

export interface Step {
  label: string;
  done: boolean;
  action?: { label: string; run: () => void };
}

/** Empty state: the next thing to do is the first step that is not done. */
export function StartSteps({ title, steps }: { title: string; steps: Step[] }) {
  const next = steps.findIndex((s) => !s.done);
  return (
    <div className="start">
      <h2>{title}</h2>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.label} className={s.done ? "done" : i === next ? "next" : ""}>
            <span className="step-no" aria-hidden="true">
              {s.done ? "✓" : i + 1}
            </span>
            <span className="step-label">{s.label}</span>
            {i === next && s.action && <button onClick={s.action.run}>{s.action.label}</button>}
          </li>
        ))}
      </ol>
    </div>
  );
}
