import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SidecarEvent } from "@agent-studio/contracts";
import { openDatabase, Repo } from "@agent-studio/storage";

/**
 * Real sidecar processes on one database (ADR-006 §2d). The in-process tests cannot show that the
 * lock is taken before `SidecarService` runs `recoverInterruptedTasks()`, which is the actual hazard.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXIT_LOCKED = 75;

let work: string;
let bundle: string;
const sqliteBinding = join(
  dirname(
    createRequire(join(repoRoot, "packages/storage/package.json")).resolve(
      "better-sqlite3/package.json",
    ),
  ),
  "build/Release/better_sqlite3.node",
);
const migrations = join(repoRoot, "packages/storage/drizzle");

interface Running {
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
  stderr: string[];
  exited: Promise<number | null>;
  ready: Promise<void>;
}
const live: Running[] = [];

function startSidecar(db: string, cwd?: string): Running {
  const child = spawn(
    process.execPath,
    [bundle, "--db", db, "--sqlite-binding", sqliteBinding, "--migrations", migrations],
    { stdio: ["pipe", "pipe", "pipe"], shell: false, ...(cwd ? { cwd } : {}) },
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  let out = "";
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
    const lines = out.split("\n");
    out = lines.pop() ?? "";
    stdout.push(...lines.filter(Boolean));
  });
  child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()));
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  const ready = new Promise<void>((resolve, reject) => {
    const check = () => {
      if (stderr.join("").includes("sidecar ready")) resolve();
    };
    child.stderr.on("data", check);
    void exited.then((code) =>
      reject(new Error(`sidecar exited (${code}) before ready:\n${stderr.join("")}`)),
    );
  });
  ready.catch(() => undefined); // a locked-out sidecar never becomes ready; callers await `exited` instead
  const r = { child, stdout, stderr, exited, ready };
  live.push(r);
  return r;
}

async function kill(r: Running): Promise<void> {
  r.child.kill("SIGKILL");
  await r.exited;
}

function seedRunningTask(db: string): { repo: Repo; taskId: string; close: () => void } {
  const handle = openDatabase(db, { nativeBinding: sqliteBinding });
  const repo = new Repo(handle);
  const project = repo.createProject("demo", "/p");
  const workflow = repo.createWorkflow(project);
  const taskId = repo.createTask(workflow, "stub");
  repo.setTaskState(taskId, "running");
  return { repo, taskId, close: () => handle.$client.close() };
}

function readState(db: string, taskId: string): { state: string; recoveries: number } {
  const handle = openDatabase(db, { nativeBinding: sqliteBinding });
  try {
    const repo = new Repo(handle);
    const recoveries = repo
      .listEvents(taskId)
      .filter((e) => JSON.parse(e.payloadJson ?? "{}").state === "needs_reconciliation").length;
    return { state: repo.getTaskState(taskId) as string, recoveries };
  } finally {
    handle.$client.close();
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "sidecar-lock-proc-"));
  bundle = join(work, "sidecar.mjs");
  const mod = (await import(pathToFileURL(join(repoRoot, "scripts/sidecar-bundle.mjs")).href)) as {
    bundleSidecar: (outfile: string) => Promise<void>;
  };
  await mod.bundleSidecar(bundle);
}, 60_000);

afterEach(async () => {
  for (const r of live.splice(0)) {
    if (r.child.exitCode === null) await kill(r);
  }
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("sidecar single-instance lock (process level)", () => {
  it("refuses a second sidecar on the same database and leaves a running task untouched", async () => {
    const db = join(work, "refuse.db");
    const a = startSidecar(db);
    await a.ready;
    const seeded = seedRunningTask(db);
    seeded.close();

    const b = startSidecar(db);
    expect(await b.exited).toBe(EXIT_LOCKED);

    // B reported why on the protocol channel, in the shape the desktop shell understands...
    const fatal = b.stdout
      .map((l) => JSON.parse(l) as unknown)
      .find((e) => (e as { event?: string }).event === "fatal");
    expect(SidecarEvent.safeParse(fatal).success).toBe(true);
    expect((fatal as { message: string }).message).toMatch(/already owns this database/);
    // ...and never started the service, so A's live task was not recovered away.
    expect(b.stderr.join("")).not.toContain("sidecar ready");
    expect(readState(db, seeded.taskId)).toEqual({ state: "running", recoveries: 0 });
    expect(a.child.exitCode).toBeNull();
  }, 30_000);

  it("lets the next sidecar take over after the owner is killed, and recovery runs exactly once", async () => {
    const db = join(work, "takeover.db");
    const a = startSidecar(db);
    await a.ready;
    const seeded = seedRunningTask(db);
    seeded.close();
    await kill(a);

    const b = startSidecar(db);
    await b.ready;
    expect(readState(db, seeded.taskId)).toEqual({ state: "needs_reconciliation", recoveries: 1 });
    await kill(b);
  }, 30_000);

  it("releases the lock on a graceful shutdown so a restart succeeds", async () => {
    const db = join(work, "restart.db");
    const a = startSidecar(db);
    await a.ready;
    a.child.stdin.write(JSON.stringify({ id: 1, method: "shutdown" }) + "\n");
    expect(await a.exited).toBe(0);

    const b = startSidecar(db);
    await b.ready;
    await kill(b);
  }, 30_000);

  it("waits for a sidecar that is still exiting instead of failing (respawn race)", async () => {
    const db = join(work, "race.db");
    const a = startSidecar(db);
    await a.ready;
    // B starts while A still owns the lock; A goes away well inside B's 3 s wait window.
    const b = startSidecar(db);
    setTimeout(() => a.child.stdin.end(), 500);
    await b.ready;
    expect(await a.exited).toBe(0);
    await kill(b);
  }, 30_000);

  it("treats a relative --db path as the same database as the absolute one", async () => {
    const db = join(work, "relative.db");
    const a = startSidecar(db);
    await a.ready;
    const b = startSidecar(relative(work, db), work);
    expect(await b.exited).toBe(EXIT_LOCKED);
  }, 30_000);
});
