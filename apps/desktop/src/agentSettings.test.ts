import { describe, expect, it } from "vitest";
import {
  argsText,
  envText,
  looksLikeSecretName,
  parseArgs,
  parseEnv,
  toSettings,
} from "./agentSettings";

describe("agent settings text", () => {
  it("keeps one argument per line and skips blanks", () => {
    expect(parseArgs("--model\n  sonnet \r\n\n--verbose")).toEqual([
      "--model",
      "sonnet",
      "--verbose",
    ]);
    expect(argsText(["a", "b"])).toBe("a\nb");
  });
  it("parses NAME=value lines and keeps '=' inside values", () => {
    expect(parseEnv("TZ=UTC\nHTTPS_PROXY=http://h:1/?a=b")).toEqual({
      ok: true,
      env: { TZ: "UTC", HTTPS_PROXY: "http://h:1/?a=b" },
    });
    expect(envText({ TZ: "UTC" })).toBe("TZ=UTC");
  });
  it("reports the first bad env line", () => {
    expect(parseEnv("TZ=UTC\noops")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Line 2"),
    });
    expect(parseEnv("=x")).toMatchObject({ ok: false });
    expect(parseEnv("A=1\nA=2")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("twice"),
    });
  });
  it("needs a command", () => {
    expect(toSettings("  ", "", "")).toMatchObject({ ok: false });
    expect(toSettings(" claude ", "--x", "TZ=UTC")).toEqual({
      ok: true,
      settings: { command: "claude", args: ["--x"], env: { TZ: "UTC" } },
    });
  });
  it("recognises credential-shaped secret names", () => {
    expect(looksLikeSecretName("ANTHROPIC_API_KEY")).toBe(true);
    for (const n of ["PATH", "api_key", "1_KEY", "", "MY KEY"])
      expect(looksLikeSecretName(n)).toBe(false);
  });
});
