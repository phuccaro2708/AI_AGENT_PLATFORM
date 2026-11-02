import type { SidecarEvent } from "@agent-studio/contracts";

const inTauri = () => "__TAURI_INTERNALS__" in window;

/**
 * Calls an allowlisted sidecar method through the Rust shell (the UI never spawns anything).
 * Params are validated by the sidecar's `SidecarRequest` schema; there is no `cwd` parameter.
 */
export async function callSidecar<T = unknown>(method: string, params?: unknown): Promise<T> {
  if (!inTauri()) throw new Error("sidecar is only available inside the desktop app");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>("sidecar_call", { method, params: params ?? null });
}

/**
 * Subscribes to pushed `task.message` / `task.state` events. Events can be dropped under
 * backpressure: on a `sequence` gap, refetch with `logs.query {taskId, afterSequence}`.
 * Resolves to an unsubscribe function.
 */
export async function onSidecarEvent(handler: (e: SidecarEvent) => void): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<SidecarEvent>("sidecar://event", (ev) => handler(ev.payload));
}
