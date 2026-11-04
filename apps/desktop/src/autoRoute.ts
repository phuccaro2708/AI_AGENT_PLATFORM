import { useCallback, useState } from "react";

/** Picker value meaning "let the capability router choose" (no agent id is ever called this). */
export const AUTO_AGENT = "auto";

const KEY = "agent-studio.autoRoute.allowAgy";

/** Default on: `agy` takes part in automatic choice until the user switches it off. */
export function parseAllowAgy(raw: unknown): boolean {
  return raw !== "false";
}

/** Ids the router must skip when the user has not allowed `agy`. */
export function autoExcludes(allowAgy: boolean): string[] {
  return allowAgy ? [] : ["agy"];
}

export function readAllowAgy(): boolean {
  try {
    return parseAllowAgy(localStorage.getItem(KEY));
  } catch {
    return true; // storage blocked: keep the default
  }
}

export function useAllowAgy(): { allowAgy: boolean; setAllowAgy: (v: boolean) => void } {
  const [allowAgy, set] = useState(readAllowAgy);
  const setAllowAgy = useCallback((v: boolean) => {
    set(v);
    try {
      localStorage.setItem(KEY, String(v));
    } catch {
      /* lasts for this session only */
    }
  }, []);
  return { allowAgy, setAllowAgy };
}
