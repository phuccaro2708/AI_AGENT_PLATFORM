/** The native folder picker only exists inside the desktop app; in a plain browser users type the path. */
export const canBrowse = () => "__TAURI_INTERNALS__" in window;

export async function pickFolder(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, multiple: false, title: "Choose project folder" });
  return typeof picked === "string" ? picked : null;
}
