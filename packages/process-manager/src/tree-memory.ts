import { execFile } from "node:child_process";

/**
 * P4-4 (b), RAM of a WHOLE process tree. The Job Object memory limits do not give this: the per-process cap
 * does not sum over the tree and the job-wide one did not enforce in our tests (docs/ASSUMPTIONS.md, Phase 4).
 * So the host measures instead: it sums the resident memory of a root process and all its descendants and
 * `startProcess` kills the tree when the sum passes `treeMemoryLimitMb`.
 *
 * It is a POLLING watchdog, not a hard cap: a process can allocate faster than the poll interval and overshoot
 * before it is killed. The metric is resident memory (Windows: working set, POSIX: RSS), not committed memory.
 * Not a security boundary (ADR-002).
 */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident bytes. */
  bytes: number;
}

/** Sum of resident bytes of `rootPid` and every descendant in `rows`. Cycles in bad data cannot loop forever. */
export function treeBytes(rows: readonly ProcessRow[], rootPid: number): number {
  const children = new Map<number, ProcessRow[]>();
  const byPid = new Map<number, ProcessRow>();
  for (const r of rows) {
    byPid.set(r.pid, r);
    const list = children.get(r.ppid);
    if (list) list.push(r);
    else children.set(r.ppid, [r]);
  }
  const seen = new Set<number>();
  const stack = [rootPid];
  let total = 0;
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += byPid.get(pid)?.bytes ?? 0;
    for (const c of children.get(pid) ?? []) stack.push(c.pid);
  }
  return total;
}

/**
 * Parses `pid ppid value` lines (one process per line). `unit` converts `value` to bytes
 * (Windows `WorkingSetSize` is bytes; `ps -o rss=` is KiB). Lines that do not fit are ignored.
 */
export function parseProcessRows(text: string, unit: number): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), bytes: Number(m[3]) * unit });
  }
  return rows;
}

const WINDOWS_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)" }';

function listProcesses(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  const [file, args, unit] =
    platform === "win32"
      ? ([
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT],
          1,
        ] as const)
      : (["ps", ["-A", "-o", "pid=,ppid=,rss="], 1024] as const);
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => (err ? reject(err) : resolve(parseProcessRows(stdout, unit))),
    );
  });
}

/** Bytes used by `rootPid` and its descendants right now (`execFile` with an argument array, no shell). */
export async function sampleTreeBytes(rootPid: number): Promise<number> {
  return treeBytes(await listProcesses(process.platform), rootPid);
}

export type TreeMemorySampler = (rootPid: number) => Promise<number>;
