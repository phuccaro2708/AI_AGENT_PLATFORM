export type ShortcutAction = "history" | "settings" | "new";

export const SHORTCUTS: readonly { keys: string; action: ShortcutAction; label: string }[] = [
  { keys: "Ctrl+H", action: "history", label: "Show or hide History" },
  { keys: "Ctrl+,", action: "settings", label: "Show or hide Settings" },
  { keys: "Ctrl+Shift+N", action: "new", label: "New session" },
];

type KeyLike = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing"
>;

/** Maps a key press to an app action, or null. Works while a text box has focus (Ctrl is required). */
export function matchShortcut(e: KeyLike): ShortcutAction | null {
  if (e.defaultPrevented || e.isComposing || e.altKey) return null;
  if (!(e.ctrlKey || e.metaKey)) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) return k === "n" ? "new" : null;
  if (k === "h") return "history";
  if (k === ",") return "settings";
  return null;
}
