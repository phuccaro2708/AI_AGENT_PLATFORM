import type { AdapterInfo } from "./api";

/** Id of the built-in test adapter; it only echoes and must not look like a real agent to users. */
export const STUB_ADAPTER_ID = "stub";

/** Hides the `stub` adapter unless running in dev mode (`import.meta.env.DEV`); other adapters pass through. */
export function visibleAdapters(adapters: AdapterInfo[], dev: boolean): AdapterInfo[] {
  return dev ? adapters : adapters.filter((a) => a.id !== STUB_ADAPTER_ID);
}
