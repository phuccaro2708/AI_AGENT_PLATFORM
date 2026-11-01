import { and, asc, eq } from "drizzle-orm";
import { AgentMessage, type TaskState } from "@agent-studio/contracts";
import { newId } from "@agent-studio/shared-utils";
import type { StudioDb } from "./db.js";
import { events, messages, projects, tasks, workflows } from "./schema.js";

const now = () => new Date().toISOString();

/** Thin repository layer. State change + event are written in ONE transaction. */
export class Repo {
  constructor(private readonly db: StudioDb) {}

  createProject(name: string, rootPath: string): string {
    const id = newId("prj");
    this.db.insert(projects).values({ id, name, rootPath, createdAt: now() }).run();
    return id;
  }

  createWorkflow(projectId: string): string {
    const id = newId("wf");
    this.db.insert(workflows).values({ id, projectId, state: "pending", createdAt: now() }).run();
    return id;
  }

  createTask(workflowId: string, agentId?: string): string {
    const id = newId("task");
    const ts = now();
    this.db
      .insert(tasks)
      .values({
        id,
        workflowId,
        agentId: agentId ?? null,
        state: "queued",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    return id;
  }

  getTaskState(taskId: string): TaskState | undefined {
    return this.db.select({ s: tasks.state }).from(tasks).where(eq(tasks.id, taskId)).get()?.s as
      TaskState | undefined;
  }

  /** Atomically changes task state and appends an audit event. */
  setTaskState(taskId: string, state: TaskState): void {
    this.db.transaction((tx) => {
      const ts = now();
      const res = tx.update(tasks).set({ state, updatedAt: ts }).where(eq(tasks.id, taskId)).run();
      if (res.changes !== 1) throw new Error(`Unknown task: ${taskId}`);
      tx.insert(events)
        .values({
          id: newId("evt"),
          aggregateId: taskId,
          eventType: "task.state_changed",
          payloadJson: JSON.stringify({ state }),
          createdAt: ts,
        })
        .run();
    });
  }

  /** Validates and appends a message; sequence is assigned per task. */
  appendMessage(input: Omit<AgentMessage, "sequence">, sequence: number): void {
    const msg = AgentMessage.parse({ ...input, sequence });
    this.db
      .insert(messages)
      .values({
        id: msg.id,
        taskId: msg.taskId,
        sequence: msg.sequence,
        messageType: msg.type,
        payloadJson: JSON.stringify(msg),
        createdAt: msg.createdAt,
      })
      .run();
  }

  listMessages(taskId: string): AgentMessage[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, taskId)))
      .orderBy(asc(messages.sequence))
      .all()
      .map((r) => AgentMessage.parse(JSON.parse(r.payloadJson)));
  }

  listEvents(aggregateId: string) {
    return this.db
      .select()
      .from(events)
      .where(eq(events.aggregateId, aggregateId))
      .orderBy(asc(events.createdAt))
      .all();
  }
}
