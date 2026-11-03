/** Secrets live in the OS credential store behind native commands. Write-only: no value comes back. */
import type { Provider } from "./api";

async function invoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const secretNames = (provider: Provider) => invoke<string[]>("secret_names", { provider });
export const setSecret = (provider: Provider, name: string, value: string) =>
  invoke<void>("secret_set", { provider, name, value });
export const deleteSecret = (provider: Provider, name: string) =>
  invoke<void>("secret_delete", { provider, name });
