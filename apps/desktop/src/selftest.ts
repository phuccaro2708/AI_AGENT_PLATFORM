/**
 * Automation hook: when the native side was started with AGENT_STUDIO_SELFTEST_OUT,
 * exercise the real IPC path (webview -> Rust -> Node sidecar -> SQLite), then ask Rust
 * to write the report and exit. Does nothing in normal use or in a plain browser.
 */
export async function runSelftestIfRequested(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { invoke } = await import("@tauri-apps/api/core");
  if (!(await invoke<boolean>("selftest_mode"))) return;

  const report: Record<string, unknown> = { ok: false, userAgent: navigator.userAgent };
  try {
    report.health = await invoke("system_health");
    report.sidecarHealth = await invoke("sidecar_health");
    const stub = await invoke<{ finalState: string }>("sidecar_run_stub", { prompt: "selftest" });
    report.stub = stub;
    report.ok = stub.finalState === "completed";
  } catch (e) {
    report.error = String(e);
  }
  await invoke("selftest_finish", { report });
}
