import { describe, expect, it } from "vitest";
import { resolvePermissionGates } from "./permission-gates-config.js";

describe("resolvePermissionGates (Q3: both gates ON by default)", () => {
  it("with no environment nothing is switched off", () => {
    expect(resolvePermissionGates({})).toEqual({});
  });
  it("AGENT_STUDIO_CLAUDE_GATE=0/off/false switches only the Claude gate off", () => {
    for (const v of ["0", "off", "false", " OFF "]) {
      expect(resolvePermissionGates({ AGENT_STUDIO_CLAUDE_GATE: v })).toEqual({
        claudePermissionGate: false,
      });
    }
  });
  it("AGENT_STUDIO_CODEX_GATE=0 switches only the Codex gate off", () => {
    expect(resolvePermissionGates({ AGENT_STUDIO_CODEX_GATE: "0" })).toEqual({
      codexAppServer: false,
    });
  });
  it("an unknown value keeps the gate ON (fail closed)", () => {
    expect(
      resolvePermissionGates({ AGENT_STUDIO_CLAUDE_GATE: "maybe", AGENT_STUDIO_CODEX_GATE: "" }),
    ).toEqual({});
  });
});
