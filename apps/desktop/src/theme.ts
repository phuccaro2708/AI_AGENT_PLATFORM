import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "agent-studio.theme";

export const isTheme = (v: unknown): v is Theme => v === "light" || v === "dark";

/** A saved choice wins; otherwise follow the operating system. */
export function resolveTheme(stored: unknown, systemPrefersDark: boolean): Theme {
  if (isTheme(stored)) return stored;
  return systemPrefersDark ? "dark" : "light";
}

function readStored(): unknown {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage can be blocked; the toggle still works for this session
  }
}

const systemPrefersDark = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: dark)").matches;

export const initialTheme = (): Theme => resolveTheme(readStored(), systemPrefersDark());

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* keep the in-memory choice */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
