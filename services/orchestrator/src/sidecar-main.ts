import { createInterface } from "node:readline";
import { createLogger } from "@agent-studio/shared-utils";
import { createEventWriter } from "./event-writer.js";
import { takeSecretsFromEnv } from "./secrets.js";
import { SidecarService } from "./sidecar.js";

/** stdout is reserved for the protocol; all logs go to stderr. */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const dbPath = arg("db");
if (!dbPath) {
  process.stderr.write(
    "usage: sidecar --db <path> [--sqlite-binding <file>] [--migrations <dir>]\n",
  );
  process.exit(2);
}
const log = createLogger({ name: "sidecar", destination: process.stderr });
const nativeBinding = arg("sqlite-binding");
const migrationsFolder = arg("migrations");
const events = createEventWriter({
  write: (line) => void process.stdout.write(line),
  pending: () => process.stdout.writableLength,
});
const secrets = takeSecretsFromEnv(process.env);
const service = new SidecarService(
  {
    dbPath,
    secrets,
    onEvent: events.emit,
    ...(nativeBinding ? { nativeBinding } : {}),
    ...(migrationsFolder ? { migrationsFolder } : {}),
  },
  log,
);

let closing = false;
function finish(code: number): void {
  if (closing) return;
  closing = true;
  service.close();
  process.exit(code);
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
