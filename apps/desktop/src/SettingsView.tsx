import { useState } from "react";
import { AgentsSettings } from "./AgentsSettings";
import { DEFAULT_NICKNAME } from "./profile";
import type { Theme } from "./theme";

export function SettingsView({
  nickname,
  onNickname,
  theme,
  onTheme,
  version,
  onClose,
}: {
  nickname: string;
  onNickname: (v: string) => void;
  theme: Theme;
  onTheme: (t: Theme) => void;
  version: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(nickname);
  const themes = [
    ["light", "Light"],
    ["dark", "Night"],
  ] as const;
  return (
    <section className="view settings" aria-labelledby="settings-title">
      <header className="view-head">
        <h1 id="settings-title">Settings</h1>
        <button onClick={onClose}>Back</button>
      </header>

      <div className="card">
        <h2>Profile</h2>
        <label className="field">
          <span>Nickname</span>
          <div className="field-row">
            <input
              aria-label="Nickname"
              value={draft}
              maxLength={32}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onNickname(draft);
              }}
            />
            <button disabled={draft.trim() === nickname} onClick={() => onNickname(draft)}>
              Save
            </button>
          </div>
        </label>
        <p className="muted small">
          Shown next to the gear in the sidebar. Default: {DEFAULT_NICKNAME}. It is a display name
          only and does not change any permission.
        </p>
      </div>

      <div className="card">
        <h2>Appearance</h2>
        <div className="seg" role="radiogroup" aria-label="Theme">
          {themes.map(([t, label]) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              className={theme === t ? "seg-item active" : "seg-item"}
              onClick={() => onTheme(t)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <AgentsSettings />

      <div className="card">
        <h2>About</h2>
        <p className="muted small">Team workspace · {version}</p>
        <p className="muted small">
          Everything is stored on this computer. Agents run through their own CLIs, never from the
          UI.
        </p>
      </div>
    </section>
  );
}
