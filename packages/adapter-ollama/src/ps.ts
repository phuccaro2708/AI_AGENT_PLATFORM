import { assertLoopbackUrl } from "./adapter.js";

/** One model Ollama has loaded right now, as `/api/ps` reports it. */
export interface OllamaLoadedModel {
  name: string;
  /** Total bytes of the loaded model (weights + cache). */
  sizeBytes: number;
  /** The part of it held in GPU memory. Less than `sizeBytes` when the model only partly fits. */
  sizeVramBytes: number;
  contextLength?: number;
}

export interface OllamaPsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * What Ollama itself says it has loaded (`GET /api/ps`). This is model memory only; `nvidia-smi` is the whole
 * GPU. Returns `undefined` when the server cannot be asked or answers something else: never a guess, never throws.
 */
export async function readOllamaPs(
  opts: OllamaPsOptions = {},
): Promise<OllamaLoadedModel[] | undefined> {
  try {
    const base = assertLoopbackUrl(opts.baseUrl ?? "http://127.0.0.1:11434");
    const res = await (opts.fetch ?? fetch)(`${base}/api/ps`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return undefined;
    const out: OllamaLoadedModel[] = [];
    for (const m of body.models as Record<string, unknown>[]) {
      const name = m["name"] ?? m["model"];
      const size = m["size"];
      const vram = m["size_vram"];
      if (typeof name !== "string" || typeof size !== "number" || typeof vram !== "number")
        continue;
      const ctx = m["context_length"];
      out.push({
        name,
        sizeBytes: size,
        sizeVramBytes: vram,
        ...(typeof ctx === "number" ? { contextLength: ctx } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
}
