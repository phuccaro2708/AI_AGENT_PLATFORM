import { useCallback, useState } from "react";

const KEY = "agent-studio.nickname";
export const DEFAULT_NICKNAME = "Admin";
const MAX = 32;

/** Trimmed, bounded display name; falls back to the default when empty. */
export function normalizeNickname(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().slice(0, MAX).trim() : "";
  return s === "" ? DEFAULT_NICKNAME : s;
}

/** One or two capital letters for the avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0]!, parts[1]!] : [parts[0] ?? ""];
  const out = letters.map((p) => Array.from(p)[0] ?? "").join("");
  return (out || "?").toLocaleUpperCase();
}

function readStored(): unknown {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage blocked: the name lasts for this session only
  }
}

/** Local display name only. It grants no permissions. */
export function useNickname(): { nickname: string; setNickname: (v: string) => void } {
  const [nickname, set] = useState(() => normalizeNickname(readStored()));
  const setNickname = useCallback((v: string) => {
    const next = normalizeNickname(v);
    set(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* keep the in-memory value */
    }
  }, []);
  return { nickname, setNickname };
}
