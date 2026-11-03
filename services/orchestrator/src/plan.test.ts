import { describe, expect, it } from "vitest";
import { parsePlan } from "./plan.js";

const o = { maxSubtasks: 4, agents: ["claude", "codex"] };
const fence = (j: unknown) => `Here is the plan.\n\`\`\`json\n${JSON.stringify(j)}\n\`\`\`\n`;
const st = (id: string, extra: object = {}) => ({
  id,
  title: `t-${id}`,
  prompt: `do ${id}`,
  ...extra,
});

describe("parsePlan", () => {
  it("accepts a fenced plan and layers it by dependencies", () => {
    const r = parsePlan(
      fence({
        subtasks: [
          st("a"),
          st("b", { dependsOn: ["a"] }),
          st("c"),
          st("d", { dependsOn: ["b", "c"] }),
        ],
      }),
      o,
    );
    expect(r.ok && r.layers.map((l) => l.map((s) => s.id))).toEqual([["a", "c"], ["b"], ["d"]]);
  });

  it("takes the last fenced block and also accepts bare JSON", () => {
    const text = fence({ subtasks: [st("old")] }) + fence({ subtasks: [st("new")] });
    expect(parsePlan(text, o)).toMatchObject({ ok: true, subtasks: [{ id: "new" }] });
    expect(parsePlan(JSON.stringify({ subtasks: [st("x")] }), o).ok).toBe(true);
  });

  it.each([
    ["no json", "I will think about it.", /no JSON/],
    ["bad json", "```json\n{oops\n```", /not valid JSON/],
    ["empty", fence({ subtasks: [] }), /invalid plan shape/],
    ["bad id", fence({ subtasks: [st("../x")] }), /invalid plan shape/],
    ["too many", fence({ subtasks: ["a", "b", "c", "d", "e"].map((i) => st(i)) }), /limit is 4/],
    ["duplicate", fence({ subtasks: [st("a"), st("a")] }), /duplicate/],
    ["unknown agent", fence({ subtasks: [st("a", { agent: "gpt" })] }), /not allowed/],
    ["unknown dep", fence({ subtasks: [st("a", { dependsOn: ["z"] })] }), /unknown id/],
    ["self dep", fence({ subtasks: [st("a", { dependsOn: ["a"] })] }), /itself/],
    [
      "cycle",
      fence({ subtasks: [st("a", { dependsOn: ["b"] }), st("b", { dependsOn: ["a"] })] }),
      /cycle/,
    ],
  ])("rejects %s", (_n, text, err) => {
    const r = parsePlan(text, o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(err);
  });
});
