import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { msg } from "./components";
import { canBrowse, pickFolder } from "./dialog";
import { folderName } from "./projectName";

/** Choose a folder, the name follows it (editable). Same flow as AionUI's workspace picker. */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (projectId: string) => void;
}) {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const setFolder = (p: string) => {
    setRootPath(p);
    if (!nameEdited) setName(folderName(p));
  };
  const browse = () => {
    pickFolder().then(
      (p) => p && setFolder(p),
      (e: unknown) => setError(msg(e)),
    );
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api.createProject(name.trim(), rootPath.trim()).then(
      ({ projectId }) => onCreated(projectId),
      (err: unknown) => {
        setError(msg(err));
        setBusy(false);
      },
    );
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="np-title"
        onSubmit={submit}
      >
        <h3 id="np-title">New project</h3>
        <p className="muted small">
          Agents work inside this folder. Pick the root of the repository you want them to use.
        </p>
        <label>
          Folder
          <span className="field-row">
            <input
              ref={first}
              aria-label="Project folder"
              placeholder="Folder, e.g. C:\work\my-app"
              value={rootPath}
              onChange={(e) => setFolder(e.target.value)}
            />
            {canBrowse() && (
              <button type="button" onClick={browse}>
                Browse…
              </button>
            )}
          </span>
        </label>
        <label>
          Name
          <input
            aria-label="Project name"
            placeholder="Name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setNameEdited(true);
            }}
          />
        </label>
        {error && (
          <p role="alert" className="error small">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !name.trim() || !rootPath.trim()}>
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
