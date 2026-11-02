import type { TaskState } from "@agent-studio/contracts";
import { Badge } from "./components";

export function Header({
  project,
  session,
  status,
  availableAgents,
  inspectorOpen,
  onInspector,
}: {
  project: string | null;
  session: string;
  status: TaskState | null | undefined;
  availableAgents: number;
  inspectorOpen: boolean;
  onInspector: () => void;
}) {
  return (
    <header className="app-header">
      <span className="logo" aria-hidden="true">
        A
      </span>
      <strong className="app-title">Agent Studio</strong>
      <nav className="crumb" aria-label="Breadcrumb">
        {project && <span className="muted">{project} /</span>}
        <span className="crumb-session">{session}</span>
        {status && <Badge state={status} />}
      </nav>
      <span className="spacer" />
      <span className={availableAgents > 0 ? "pill ok" : "pill"}>
        {availableAgents} {availableAgents === 1 ? "agent" : "agents"} ready
      </span>
      <button
        className={inspectorOpen ? "icon-btn wide active" : "icon-btn wide"}
        aria-pressed={inspectorOpen}
        aria-label="Inspector"
        title="Show or hide the inspector (context, activity, tools, logs)"
        onClick={onInspector}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M2 2.5A1.5 1.5 0 0 1 3.5 1h9A1.5 1.5 0 0 1 14 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 13.5v-11Zm8 0v11h2.5a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5H10Z" />
        </svg>
      </button>
    </header>
  );
}
