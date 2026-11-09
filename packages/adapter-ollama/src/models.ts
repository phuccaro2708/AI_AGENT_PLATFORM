import { assertLoopbackUrl } from "./adapter.js";

/** One model installed in Ollama, as `GET /api/tags` reports it. */
export interface OllamaInstalledModel {
  /** The name to put in `AGENT_STUDIO_OLLAMA_MODEL`, e.g. `qwen3:4b`. */
  name: string;
  sizeBytes: number;
  parameterSize?: string;
  quantization?: string;
}

export interface OllamaTagsOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Models installed in Ollama (`GET /api/tags`, HTTP only, no process is started).
 * `undefined` = the server could not be asked or answered something else (unreachable); `[]` = reachable, nothing
 * pulled yet. These two must stay different: the UI tells the person to start Ollama vs to pull a model.
 */
export async function listOllamaModels(
  opts: OllamaTagsOptions = {},
): Promise<OllamaInstalledModel[] | undefined> {
  try {
    const base = assertLoopbackUrl(opts.baseUrl ?? "http://127.0.0.1:11434");
    const res = await (opts.fetch ?? fetch)(`${base}/api/tags`, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { models?: unknown };
    if (!Array.isArray(body.models)) return undefined;
    const out: OllamaInstalledModel[] = [];
    for (const m of body.models as Record<string, unknown>[]) {
      const name = m["name"] ?? m["model"];
      if (typeof name !== "string" || name.length === 0) continue;
      const size = m["size"];
      const d = (m["details"] ?? {}) as Record<string, unknown>;
      const ps = d["parameter_size"];
      const q = d["quantization_level"];
      out.push({
        name,
        sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : 0,
        ...(typeof ps === "string" ? { parameterSize: ps } : {}),
        ...(typeof q === "string" ? { quantization: q } : {}),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return undefined;
  }
}
