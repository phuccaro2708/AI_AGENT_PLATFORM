import type { ResourceReport } from "./api";

const GIB = 1024 ** 3;
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/**
 * The two VRAM figures, worded so nobody mistakes one for the other: nvidia-smi counts the whole GPU
 * (every program), Ollama counts only its own loaded models. Empty when neither is available.
 */
export function vramLines(status: ResourceReport["status"]): string[] {
  const lines: string[] = [];
  const g = status.gpu;
  if (g && g.totalBytes > 0) {
    const pct = (g.usedBytes / g.totalBytes) * 100;
    lines.push(
      `GPU memory, whole GPU (all programs, from nvidia-smi): ${gib(g.usedBytes)} of ${gib(g.totalBytes)} (${pct.toFixed(0)}%)`,
    );
  }
  for (const m of status.ollama?.models ?? []) {
    const part =
      m.sizeBytes > 0
        ? ` (${Math.round((m.sizeVramBytes / m.sizeBytes) * 100)}% of the model on the GPU)`
        : "";
    lines.push(
      `Ollama model ${m.name}, this model only: ${gib(m.sizeVramBytes)} in GPU memory of ${gib(m.sizeBytes)}${part}`,
    );
  }
  return lines;
}
