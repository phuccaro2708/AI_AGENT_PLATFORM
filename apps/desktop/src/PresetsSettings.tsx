import { useState } from "react";
import {
  MAX_INSTRUCTIONS,
  newPresetId,
  parsePresets,
  serializePresets,
  type Preset,
  type usePresets,
} from "./presets";

/** Local presets: create, edit, delete, and move them between machines as JSON text. */
export function PresetsSettings({
  store,
  adapterIds,
}: {
  store: ReturnType<typeof usePresets>;
  adapterIds: string[];
}) {
  const [editing, setEditing] = useState<Preset | null>(null);
  const [importText, setImportText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const exported = serializePresets(store.presets);

  const doImport = () => {
    const r = parsePresets(importText);
    if (!r.ok) return setNote(r.reason);
    const taken = new Set(store.presets.map((p) => p.id));
    const fresh = r.presets.filter((p) => !taken.has(p.id));
    store.replaceAll([...store.presets, ...fresh]);
    setImportText("");
    setNote(
      `Imported ${fresh.length} preset(s); ${r.presets.length - fresh.length} skipped (same id).`,
    );
  };

  return (
    <div className="card">
      <h2>Presets</h2>
      <p className="muted small">
        Instructions added before your prompt in Agent sessions. They only change the text sent and
        grant no permission. &quot;assistant&quot; is built in.
      </p>
      <ul className="plain">
        {store.presets.map((p) => (
          <li key={p.id} className="field-row">
            <span>
              {p.name}
              {p.agentId ? <span className="muted small"> · {p.agentId}</span> : null}
            </span>
            <button onClick={() => setEditing(p)}>Edit</button>
            <button onClick={() => store.remove(p.id)}>Delete</button>
          </li>
        ))}
        {store.presets.length === 0 && <li className="muted small">No custom presets yet.</li>}
      </ul>
      {editing ? (
        <div className="field">
          <input
            aria-label="Preset name"
            placeholder="Name"
            value={editing.name}
            maxLength={60}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <select
            aria-label="Preferred agent"
            value={editing.agentId ?? ""}
            onChange={(e) => {
              const next: Preset = { ...editing };
              if (e.target.value) next.agentId = e.target.value;
              else delete next.agentId;
              setEditing(next);
            }}
          >
            <option value="">Any agent</option>
            {adapterIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <textarea
            aria-label="Preset instructions"
            rows={4}
            maxLength={MAX_INSTRUCTIONS}
            placeholder="Instructions"
            value={editing.instructions}
            onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
          />
          <div className="actions">
            <button
              className="primary"
              disabled={editing.name.trim() === "" || editing.instructions.trim() === ""}
              onClick={() => {
                store.save(editing);
                setEditing(null);
              }}
            >
              Save preset
            </button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setEditing({ id: newPresetId(), name: "", instructions: "" })}>
          New preset
        </button>
      )}

      <h3>Export</h3>
      <textarea aria-label="Exported presets" readOnly rows={4} value={exported} />
      <button onClick={() => void navigator.clipboard?.writeText(exported).catch(() => undefined)}>
        Copy
      </button>

      <h3>Import</h3>
      <textarea
        aria-label="Presets to import"
        rows={4}
        placeholder="Paste exported JSON here"
        value={importText}
        onChange={(e) => {
          setImportText(e.target.value);
          setNote(null);
        }}
      />
      <div className="actions">
        <button disabled={importText.trim() === ""} onClick={doImport}>
          Import
        </button>
        {note && <span className="muted small">{note}</span>}
      </div>
    </div>
  );
}
