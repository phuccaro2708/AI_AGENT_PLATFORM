import { useCallback, useState } from "react";

/**
 * A local preset: reusable instructions (and an optional preferred agent) for single-agent
 * sessions. It only changes the text sent as the prompt; it grants no permission and no tool.
 */
export interface Preset {
  id: string;
  name: string;
  agentId?: string;
  instructions: string;
}

const KEY = "agent-studio.presets";
export const MAX_PRESETS = 50;
export const MAX_NAME = 60;
export const MAX_INSTRUCTIONS = 4000;
const MAX_IMPORT_CHARS = 400_000;

export const BUILTIN_ASSISTANT: Preset = {
  id: "assistant",
  name: "assistant",
  instructions:
    "You are a careful general-purpose assistant working inside this project. " +
    "Answer concisely, say what you are unsure about, and ask before making changes " +
    "that are large or hard to undo.",
};

export const BUILTIN_PRESETS: readonly Preset[] = [BUILTIN_ASSISTANT];

/** Returns a clean preset or null when the value is unusable. Never throws. */
export function normalizePreset(raw: unknown): Preset | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string" || typeof r.instructions !== "string")
    return null;
  const id = r.id.trim().slice(0, 64);
  const name = r.name.trim().slice(0, MAX_NAME);
  const instructions = r.instructions.trim().slice(0, MAX_INSTRUCTIONS);
  if (id === "" || name === "" || instructions === "") return null;
  const agent = typeof r.agentId === "string" ? r.agentId.trim().slice(0, 64) : "";
  return agent === "" ? { id, name, instructions } : { id, name, agentId: agent, instructions };
}

export type ParseResult = { ok: true; presets: Preset[] } | { ok: false; reason: string };

/** Parses an exported list. Strict about shape, size and duplicate or reserved ids. */
export function parsePresets(text: string): ParseResult {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, reason: "That text is too large" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That is not valid JSON" };
  }
  if (!Array.isArray(data)) return { ok: false, reason: "Expected a list of presets" };
  if (data.length > MAX_PRESETS)
    return { ok: false, reason: `At most ${MAX_PRESETS} presets can be imported` };
  const seen = new Set<string>(BUILTIN_PRESETS.map((p) => p.id));
  const presets: Preset[] = [];
  for (const [i, item] of data.entries()) {
    const p = normalizePreset(item);
    if (!p) return { ok: false, reason: `Preset ${i + 1} needs an id, a name and instructions` };
    if (seen.has(p.id)) return { ok: false, reason: `Preset ${i + 1}: id "${p.id}" is taken` };
    seen.add(p.id);
    presets.push(p);
  }
  return { ok: true, presets };
}

export const serializePresets = (presets: readonly Preset[]): string =>
  JSON.stringify(presets, null, 2);

/** The prompt actually sent: the preset's instructions first, then what the user wrote. */
export const composePrompt = (preset: Preset | undefined, text: string): string =>
  preset ? `${preset.instructions}\n\n${text}` : text;

export const newPresetId = (): string =>
  `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function readStored(): Preset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [];
    const r = parsePresets(raw);
    return r.ok ? r.presets : [];
  } catch {
    return []; // storage blocked or damaged: start empty
  }
}

export function usePresets(): {
  presets: Preset[];
  all: Preset[];
  save: (p: Preset) => void;
  remove: (id: string) => void;
  replaceAll: (list: Preset[]) => void;
} {
  const [presets, set] = useState<Preset[]>(readStored);
  const commit = useCallback((next: Preset[]) => {
    set(next);
    try {
      localStorage.setItem(KEY, serializePresets(next));
    } catch {
      /* keep the in-memory list */
    }
  }, []);
  const save = useCallback(
    (p: Preset) => {
      const clean = normalizePreset(p);
      if (!clean || BUILTIN_PRESETS.some((b) => b.id === clean.id)) return;
      const next = presets.some((x) => x.id === clean.id)
        ? presets.map((x) => (x.id === clean.id ? clean : x))
        : [...presets, clean].slice(0, MAX_PRESETS);
      commit(next);
    },
    [presets, commit],
  );
  const remove = useCallback(
    (id: string) => commit(presets.filter((p) => p.id !== id)),
    [presets, commit],
  );
  return { presets, all: [...BUILTIN_PRESETS, ...presets], save, remove, replaceAll: commit };
}
