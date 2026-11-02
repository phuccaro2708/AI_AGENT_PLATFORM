import { and, asc, eq } from "drizzle-orm";
import {
  AgentMessage,
  IllegalTransitionError,
  canTransition,
  type TaskState,
} from "@agent-studio/contracts";
import { newId } from "@agent-studio/shared-utils";
import type { StudioDb } from "./db.js";
import { events, executionRuns, messages, projects, tasks, workflows } from "./schema.js";

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

  /**
   * Atomically changes task state (guarded by the state machine) and appends an audit event.
   * Compare-and-set: the UPDATE only applies if the state is still the one the guard checked,
   * so a concurrent writer cannot make an illegal transition slip through.
   */
  setTaskState(taskId: string, state: TaskState): void {
    this.db.transaction((tx) => {
      const ts = now();
      const row = tx.select({ s: tasks.state }).from(tasks).where(eq(tasks.id, taskId)).get();
      if (!row) throw new Error(`Unknown task: ${taskId}`);
      const from = row.s as TaskState;
      if (!canTransition(from, state)) throw new IllegalTransitionError(taskId, from, state);
      const res = tx
        .update(tasks)
        .set({ state, updatedAt: ts })
        .where(and(eq(tasks.id, taskId), eq(tasks.state, from)))
        .run();
      if (res.changes !== 1) throw new Error(`Concurrent state change for task: ${taskId}`);
      tx.insert(events)
        .values({
          id: newId("evt"),
          aggregateId: taskId,
          eventType: "task.state_changed",
          payloadJson: JSON.stringify({ from, state }),
          createdAt: ts,
        })
        .run();
    });
  }

  /** Records the launch of a process for a task attempt; returns the run id. */
  startRun(taskId: string, opts: { pid?: number; attempt?: number; sessionId?: string }): string {
    const id = newId("run");
    this.db
      .insert(executionRuns)
      .values({
        id,
        taskId,
        sessionId: opts.sessionId ?? null,
        attempt: opts.attempt ?? 0,
        pid: opts.pid ?? null,
        startedAt: now(),
      })
      .run();
    return id;
  }

  finishRun(runId: string, result: { exitCode: number | null; signal: string | null }): void {
    const res = this.db
      .update(executionRuns)
      .set({ exitCode: result.exitCode, signal: result.signal, endedAt: now() })
      .where(eq(executionRuns.id, runId))
      .run();
    if (res.changes !== 1) throw new Error(`Unknown run: ${runId}`);
  }

  getRun(runId: string) {
    return this.db.select().from(executionRuns).where(eq(executionRuns.id, runId)).get();
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
