import { createInterface } from "node:readline";
import { NodeResourceSource } from "@agent-studio/resource-monitor";
import { createLogger } from "@agent-studio/shared-utils";
import { runPermissionGate } from "./claude-permission-gate.js";
import { createEventWriter } from "./event-writer.js";
import { resolveJobWrap, resolveTreeMemoryLimitMb } from "./job-wrap-config.js";
import { createSecretRedactor, redactingDestination, takeSecretsFromEnv } from "./secrets.js";
import { acquireSidecarLock, SidecarLockError } from "./sidecar-lock.js";
import { SidecarService } from "./sidecar.js";

/** Exit code of a sidecar that lost the single-instance lock (EX_TEMPFAIL). */
const EXIT_LOCKED = 75;

/** stdout is reserved for the protocol; all logs go to stderr. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Started by `claude --permission-prompt-tool` as its MCP server (P4-1 d, opt-in): no database, no lock, no logs on
// stdout. Only ever reached when the sidecar was built with `claudePermissionGate`, which the real process is not.
if (process.argv.includes("--permission-gate")) {
  try {
    await runPermissionGate(process.argv, process.stdin, process.stdout);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`permission gate cannot start: ${String(err)}\n`);
    process.exit(2);
  }
}

const dbPath = arg("db");
if (!dbPath) {
  process.stderr.write(
    "usage: sidecar --db <path> [--sqlite-binding <file>] [--migrations <dir>]\n",
  );
  process.exit(2);
}
const nativeBinding = arg("sqlite-binding");
const migrationsFolder = arg("migrations");
const events = createEventWriter({
  write: (line) => void process.stdout.write(line),
  pending: () => process.stdout.writableLength,
});
const secrets = takeSecretsFromEnv(process.env);
// Last line of defence for the log file: whatever any code path logs, loaded secret values are masked.
const log = createLogger({
  name: "sidecar",
  destination: redactingDestination(createSecretRedactor(secrets), process.stderr),
});
// One sidecar per database: a second one would recover the first one's live tasks away (ADR-006 §2d).
// The lock must be held before SidecarService is constructed, because its constructor runs recovery.
let lock: Awaited<ReturnType<typeof acquireSidecarLock>>;
try {
  lock = await acquireSidecarLock(dbPath);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err: message }, "sidecar cannot start");
  // Tell the desktop shell why before exiting; exit only after the line is flushed.
  const line = JSON.stringify({ event: "fatal", message }) + "\n";
  process.stdout.write(line, () => process.exit(err instanceof SidecarLockError ? EXIT_LOCKED : 1));
  await new Promise<never>(() => undefined); // never construct the service; the callback above exits
}
// P4-4 (b): wrapper ON by default when the installed binary is found, else a warning and no wrap. RAM watchdog stays OFF unless opted in.
const jobWrap = resolveJobWrap(arg("job-wrap"), process.env, log);
const cliTreeMemoryLimitMb = resolveTreeMemoryLimitMb(process.env);
const service = new SidecarService(
  {
    dbPath,
    secrets,
    onEvent: events.emit,
    resourceSource: new NodeResourceSource(),
    ...(nativeBinding ? { nativeBinding } : {}),
    ...(migrationsFolder ? { migrationsFolder } : {}),
    ...(jobWrap ? { jobWrap } : {}),
    ...(cliTreeMemoryLimitMb === undefined ? {} : { cliTreeMemoryLimitMb }),
  },
  log,
);

let closing = false;
function finish(code: number): void {
  if (closing) return;
  closing = true;
  service.close();
  void lock.release().finally(() => process.exit(code));
}

const rl = createInterface({ input: process.stdin });
let chain: Promise<void> = Promise.resolve();
rl.on("line", (line) => {
  // Serialize handling so responses keep request order.
  chain = chain.then(async () => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ id: null, error: { message: "invalid json" } }) + "\n");
      return;
    }
    const { response, shutdown } = await service.handle(raw);
    process.stdout.write(JSON.stringify(response) + "\n", () => {
      if (shutdown) finish(0);
    });
  });
});
// Parent closed our stdin (or died): exit cleanly instead of lingering as an orphan.
rl.on("close", () => chain.then(() => finish(0)));
process.on("SIGTERM", () => finish(0));
process.on("SIGINT", () => finish(0));
log.info({ pid: process.pid }, "sidecar ready");
