import type { AgentMessage, TaskState } from "@agent-studio/contracts";
import { callSidecar as call } from "./sidecar";

export interface Project {
  id: string;
  name: string;
  rootPath: string;
}
export interface AdapterInfo {
  id: string;
  available: boolean;
  capabilities: string[];
}
export interface CliProbe {
  provider: string;
  status: string;
  version?: string;
  path?: string;
}

/** Typed wrappers over the allowlisted sidecar methods (docs/PROTOCOL.md). */
export const api = {
  projects: () => call<{ projects: Project[] }>("projects.list").then((r) => r.projects),
  createProject: (name: string, rootPath: string) =>
    call<{ projectId: string }>("projects.create", { name, rootPath }),
  agents: () => call<{ adapters: AdapterInfo[]; cli: CliProbe[] }>("agents.list"),
  detect: () => call<{ results: CliProbe[] }>("agents.detect", {}),
  /** One workflow per task for now; the sidecar runs it in the project's root. */
  async startTask(projectId: string, agentId: string, prompt: string): Promise<string> {
    const { workflowId } = await call<{ workflowId: string }>("workflows.create", { projectId });
    const { taskId } = await call<{ taskId: string }>("workflows.start", {
      workflowId,
      agentId,
      prompt,
    });
    return taskId;
  },
  cancel: (taskId: string) =>
    call<{ requested: boolean; state: TaskState }>("tasks.cancel", { taskId }),
  task: (taskId: string) => call<{ state: TaskState | null }>("queryTask", { taskId }),
  logs: (taskId: string, afterSequence: number, limit = 500) =>
    call<{ messages: AgentMessage[]; nextAfterSequence: number }>("logs.query", {
      taskId,
      afterSequence,
      limit,
    }),
};
