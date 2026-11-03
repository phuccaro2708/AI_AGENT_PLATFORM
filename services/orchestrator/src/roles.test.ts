import { describe, expect, it } from "vitest";
import { assignRole, buildRolePrompt, parseVerdict, type RoleDef } from "./roles.js";

const implementer: RoleDef = {
  name: "implementer",
  instructions: "Make the change.",
  access: "write",
  allowedAgents: ["claude"],
};
const anyReader: RoleDef = {
  name: "reviewer",
  instructions: "Review it.",
  access: "read",
  allowedAgents: "any",
};

describe("assignRole", () => {
  it("accepts an allowed agent and rejects others (assignment is per run, not per agent name)", () => {
    expect(() => assignRole(implementer, "claude")).not.toThrow();
    expect(() => assignRole(implementer, "codex")).toThrow(/not allowed/i);
    expect(() => assignRole(anyReader, "whatever")).not.toThrow();
  });
});

describe("buildRolePrompt", () => {
  it("puts the role instructions and access before the task body", () => {
    const p = buildRolePrompt(implementer, "Add a flag.");
    expect(p.indexOf("Make the change.")).toBeLessThan(p.indexOf("Add a flag."));
    expect(p).toContain("write");
  });
});

describe("parseVerdict", () => {
  it("reads the last VERDICT line", () => {
    expect(parseVerdict("ok\nVERDICT: APPROVE")).toBe("approve");
    expect(parseVerdict("VERDICT: APPROVE\nbut wait\nVERDICT: CHANGES_REQUESTED\n")).toBe(
      "changes_requested",
    );
  });
  it("is unknown when absent, malformed or merely mentioned in prose", () => {
    expect(parseVerdict("looks fine to me")).toBe("unknown");
    expect(parseVerdict("VERDICT: MAYBE")).toBe("unknown");
    expect(parseVerdict("I would write VERDICT: APPROVE if it were fixed")).toBe("unknown");
    expect(parseVerdict("")).toBe("unknown");
  });
});
