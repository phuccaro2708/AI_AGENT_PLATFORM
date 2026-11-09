import { assertLoopbackUrl, type OllamaAdapterOptions } from "@agent-studio/adapter-ollama";
import type { Warn } from "./job-wrap-config.js";

/** Model to chat with. Unset = the `ollama` agent is registered but reports itself unavailable. */
export const OLLAMA_MODEL_ENV = "AGENT_STUDIO_OLLAMA_MODEL";
/** Server URL; loopback only (anything else is ignored with a warning). Default `http://127.0.0.1:11434`. */
export const OLLAMA_URL_ENV = "AGENT_STUDIO_OLLAMA_URL";
/** `read-only` lets the model call `list_dir` / `read_file` inside the task folder. Anything else = off. */
export const OLLAMA_TOOLS_ENV = "AGENT_STUDIO_OLLAMA_TOOLS";

/** Model names look like `name`, `name:tag`, `owner/name:tag`. Anything else is refused, not passed on. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;

/** `OllamaAdapterOptions` for the sidecar from the environment. Never throws: a bad value is dropped with a warning. */
export function resolveOllama(env: NodeJS.ProcessEnv, log: Warn): OllamaAdapterOptions {
  const out: OllamaAdapterOptions = {};
  const model = env[OLLAMA_MODEL_ENV]?.trim();
  if (model) {
    if (MODEL_NAME.test(model)) out.model = model;
    else log.warn({ env: OLLAMA_MODEL_ENV }, "ignored: not a valid Ollama model name");
  }
  const url = env[OLLAMA_URL_ENV]?.trim();
  if (url) {
    try {
      out.baseUrl = assertLoopbackUrl(url);
    } catch {
      log.warn(
        { env: OLLAMA_URL_ENV },
        "ignored: the Ollama URL must be http(s) on a loopback address",
      );
    }
  }
  if (env[OLLAMA_TOOLS_ENV]?.trim().toLowerCase() === "read-only") out.tools = "read-only";
  return out;
}
