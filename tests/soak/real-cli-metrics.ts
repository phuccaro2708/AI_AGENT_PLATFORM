import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Helpers for the opt-in real-CLI soak: process-tree tracking (to count CLI processes left alive) and the per-workflow
 * report table. Pure functions are unit-tested in real-cli-metrics.test.ts; only `listProcesses` touches the OS.
 */
const execFileAsync = promisify(execFile);

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** Process creation time as a string; (pid, created) identifies a process, so a reused PID is not mistaken for it. */
  created: string;
  name: string;
}

/** Snapshot of all processes. Windows: CIM; elsewhere: `ps`. Arguments are an array, no shell. */
export async function listProcesses(): Promise<ProcInfo[]> {
  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToString('o'), $_.Name }";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return parseProcessLines(stdout);
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,lstart=,comm="], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const out: ProcInfo[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3]!, name: m[4]! });
  }
  return out;
}

/** Parses `pid|ppid|created|name` lines (the Windows format). Malformed lines are skipped. */
export function parseProcessLines(text: string): ProcInfo[] {
  const out: ProcInfo[] = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split("|");
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({ pid, ppid, created: parts[2]!, name: parts.slice(3).join("|") });
  }
  return out;
}

/** Names counted as "CLI processes": the CLIs, their node/bun runtimes and the job wrapper. */
export const CLI_NAME = /^(claude|codex|node|bun|agent-job-wrap)(\.exe)?$/i;

const key = (p: ProcInfo) => `${p.pid}@${p.created}`;

/** All processes that descend from `rootPid` in this snapshot (the root itself is not included). */
export function descendantsOf(rootPid: number, procs: ProcInfo[]): ProcInfo[] {
  const byParent = new Map<number, ProcInfo[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: ProcInfo[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const child of byParent.get(cur) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * Remembers every descendant of the test process seen while sampling. A process whose parent died is no longer a
 * descendant in a later snapshot, so orphans are found by asking "of the processes I saw, which are still alive?".
 * Only processes that were descendants at some sample can be counted; a process that lived and died between two samples
 * is not seen (documented limit).
 */
export class ProcessTracker {
  private readonly seen = new Map<string, ProcInfo & { during: string[] }>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  constructor(private readonly rootPid: number = process.pid) {}

  /** Takes one sample now. `tag` labels who was running (e.g. a workflow id) for the processes first seen in it. */
  async sample(tag: string): Promise<void> {
    const procs = await listProcesses();
    for (const d of descendantsOf(this.rootPid, procs)) {
      const k = key(d);
      const known = this.seen.get(k);
      if (known) {
        if (!known.during.includes(tag)) known.during.push(tag);
      } else this.seen.set(k, { ...d, during: [tag] });
    }
  }

  start(getTag: () => string, intervalMs = 700): void {
    this.timer = setInterval(() => {
      this.inFlight = this.inFlight.then(() => this.sample(getTag()).catch(() => undefined));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Seen processes that are still alive in `alive` (same pid AND same creation time). */
  survivors(alive: ProcInfo[]): (ProcInfo & { during: string[] })[] {
    const live = new Set(alive.map(key));
    return [...this.seen.values()].filter((p) => live.has(key(p)));
  }

  get seenCount(): number {
    return this.seen.size;
  }
}

export interface WorkflowRow {
  /** 1-based position in the run. */
  n: number;
  workflowId: string;
  kind: string;
  agent: string;
  workflowState: string;
  ms: number;
  taskCount: number;
  taskStates: string[];
  /** CLI processes first seen during this workflow that are still alive once it has settled. */
  orphansAfter: number;
}

/** Markdown table of the per-workflow rows. Contains no paths, prompts or log text. */
export function renderTable(rows: WorkflowRow[]): string {
  const head =
    "| # | workflow | kind | agent | final state | ms | tasks | task states | orphan CLI procs |\n" +
    "|---|----------|------|-------|-------------|----|-------|-------------|------------------|";
  const body = rows.map(
    (r) =>
      `| ${r.n} | ${r.workflowId} | ${r.kind} | ${r.agent} | ${r.workflowState} | ${r.ms} | ${r.taskCount} | ${r.taskStates.join(", ")} | ${r.orphansAfter} |`,
  );
  return [head, ...body].join("\n");
}
