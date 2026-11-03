/** The native folder picker only exists inside the desktop app; in a plain browser users type the path. */
export const canBrowse = () => "__TAURI_INTERNALS__" in window;

/**
 * Asks the native side to open the folder dialog (`pick_folder`). Resolves to `null` when the
 * person cancels. The path is not trusted: the sidecar checks it when the project is created.
 */
export async function pickFolder(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("pick_folder");
}
