export interface Health {
  source: "tauri" | "browser-preview";
  app: string;
  version: string;
}

/** Frontend never talks to CLIs; it only asks the Rust shell via IPC. */
export async function getHealth(): Promise<Health> {
  if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    const h = await invoke<{ app: string; version: string }>("system_health");
    return { source: "tauri", ...h };
  }
  return { source: "browser-preview", app: "agent-studio", version: "n/a" };
}
