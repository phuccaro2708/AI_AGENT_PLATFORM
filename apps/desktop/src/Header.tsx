export function Header({
  title,
  availableAgents,
  terminalOpen,
  onTerminal,
}: {
  title: string;
  availableAgents: number;
  terminalOpen: boolean;
  onTerminal: () => void;
}) {
  return (
    <header className="app-header">
      <span className="logo" aria-hidden="true">
        A
      </span>
      <strong className="app-title">Agent Studio</strong>
      <span className="muted header-ctx">{title}</span>
      <span className="spacer" />
      <span className={availableAgents > 0 ? "pill ok" : "pill"}>
        {availableAgents} {availableAgents === 1 ? "agent" : "agents"} ready
      </span>
      <button
        className={terminalOpen ? "toggle active" : "toggle"}
        aria-pressed={terminalOpen}
        title="Show the tool calls and results of the selected session (read-only, not a shell)"
        onClick={onTerminal}
      >
        Tool output
      </button>
    </header>
  );
}
