import { z } from "zod";

const Subtask = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  title: z.string().min(1).max(120),
  prompt: z.string().min(1).max(4000),
  agent: z.string().min(1).optional(),
  dependsOn: z.array(z.string()).default([]),
});
export type Subtask = z.infer<typeof Subtask>;

const PlanShape = z.object({ subtasks: z.array(Subtask).min(1) });

export type PlanResult =
  { ok: true; subtasks: Subtask[]; layers: Subtask[][] } | { ok: false; error: string };

/** The plan is the last fenced ```json block of the supervisor's answer, or the whole answer if it is bare JSON. */
function extractJson(text: string): string | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].at(-1)?.[1];
  if (fenced) return fenced;
  const bare = text.trim();
  return bare.startsWith("{") ? bare : undefined;
}

/**
 * Validates an agent-written plan. The plan is untrusted input: bounded size, known agents only,
 * unique ids, dependencies that exist, and no cycles. A plan that fails any check is rejected whole
 * (never repaired or guessed at); the caller pauses the workflow for a human.
 */
export function parsePlan(
  text: string,
  o: { maxSubtasks: number; agents: readonly string[] },
): PlanResult {
  const raw = extractJson(text);
  if (raw === undefined)
    return { ok: false, error: "no JSON plan found in the supervisor's answer" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "the plan is not valid JSON" };
  }
  const parsed = PlanShape.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `invalid plan shape: ${parsed.error.issues[0]?.message ?? "?"}` };
  }
  const subtasks = parsed.data.subtasks;
  if (subtasks.length > o.maxSubtasks) {
    return { ok: false, error: `plan has ${subtasks.length} subtasks, limit is ${o.maxSubtasks}` };
  }
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (ids.has(s.id)) return { ok: false, error: `duplicate subtask id: ${s.id}` };
    ids.add(s.id);
    if (s.agent !== undefined && !o.agents.includes(s.agent)) {
      return { ok: false, error: `subtask ${s.id} names an agent that is not allowed: ${s.agent}` };
    }
  }
  for (const s of subtasks) {
    for (const d of s.dependsOn) {
      if (d === s.id) return { ok: false, error: `subtask ${s.id} depends on itself` };
      if (!ids.has(d)) return { ok: false, error: `subtask ${s.id} depends on unknown id: ${d}` };
    }
  }
  // Kahn by layers: layer n holds subtasks whose dependencies all sit in earlier layers.
  const layers: Subtask[][] = [];
  const placed = new Set<string>();
  let rest = subtasks;
  while (rest.length > 0) {
    const layer = rest.filter((s) => s.dependsOn.every((d) => placed.has(d)));
    if (layer.length === 0) return { ok: false, error: "the plan has a dependency cycle" };
    layers.push(layer);
    for (const s of layer) placed.add(s.id);
    rest = rest.filter((s) => !placed.has(s.id));
  }
  return { ok: true, subtasks, layers };
}

export function planInstructions(o: { maxSubtasks: number; agents: readonly string[] }): string {
  return [
    "Break the goal into subtasks for other agents. Do not do the work yourself.",
    "End your answer with ONE fenced ```json block of this shape and nothing after it:",
    '{"subtasks":[{"id":"short-id","title":"...","prompt":"self-contained instructions","agent":"optional","dependsOn":["other-id"]}]}',
    `At most ${o.maxSubtasks} subtasks. Allowed agents: ${o.agents.join(", ")}. Subtasks with no dependsOn may run in parallel; give each its own files where possible.`,
  ].join("\n");
}
