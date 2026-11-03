import { describe, expect, it } from "vitest";
import { takeSecretsFromEnv } from "./secrets.js";

describe("takeSecretsFromEnv", () => {
  it("moves secrets out of the environment, sorted by provider", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "p",
      AGENT_STUDIO_SECRET__CLAUDE__ANTHROPIC_API_KEY: "a",
      AGENT_STUDIO_SECRET__CODEX__OPENAI_API_KEY: "b",
    };
    const s = takeSecretsFromEnv(env);
    expect(s).toEqual({
      claude: { ANTHROPIC_API_KEY: "a" },
      codex: { OPENAI_API_KEY: "b" },
    });
    expect(env).toEqual({ PATH: "p" });
  });
  it("drops unknown providers and empty values but still scrubs them", () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_STUDIO_SECRET__GEMINI__X_KEY: "z",
      AGENT_STUDIO_SECRET__CLAUDE__EMPTY_KEY: "",
      AGENT_STUDIO_SECRET__broken: "q",
    };
    expect(takeSecretsFromEnv(env)).toEqual({ claude: {}, codex: {} });
    expect(Object.keys(env)).toEqual([]);
  });
});
