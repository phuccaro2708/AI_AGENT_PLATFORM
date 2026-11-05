import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createScrubber, MIN_SECRET_LENGTH } from "./scrub.js";

export interface DiagnosticsInput {
  /** Parent directory; the bundle is created inside it as `diagnostics-<UTC time>`. */
  outDir: string;
  /** Directory written by the rotating log destination. */
  logDir: string;
  /** Log file stem, as given to the rotating destination. Default `agent-studio`. */
  logBaseName?: string;
  /** Component versions (app, sidecar, node, CLI versions...). */
  versions: Record<string, string>;
  /** Configuration state to include. Keys that look sensitive are masked; send no raw secrets. */
  config: unknown;
  /** Extra text attachments, e.g. a DB dump. `name` is reduced to its base name. */
  attachments?: { name: string; content: string }[];
  /** Exact secret values known to the caller; none of them may survive in the bundle. */
  secrets: readonly string[];
  /** Most recent log bytes to include in total. Default 2 MiB. */
  maxLogBytes?: number;
  now?: () => number;
}

export interface ManifestEntry {
  path: string;
  bytes: number;
  sha256: string;
}

export interface DiagnosticsManifest {
  schema: 1;
  generatedAt: string;
  versions: Record<string, string>;
  files: ManifestEntry[];
  redaction: { exactSecretNeedles: number; minSecretLength: number; limits: string };
}

export interface DiagnosticsResult {
  dir: string;
  manifestPath: string;
  manifest: DiagnosticsManifest;
}

/** Thrown (after the bundle was deleted) if a known secret is still present in the output. */
export class DiagnosticsLeakError extends Error {
  constructor(readonly files: string[]) {
    super(`diagnostics export aborted: a known secret survived masking in ${files.join(", ")}`);
    this.name = "DiagnosticsLeakError";
  }
}

const LIMITS =
  "Only exact secret values of at least 6 characters are masked; transformed values (base64, " +
  "URL-encoded, split across lines) are not detected. Credential shapes and sensitive keys are masked too.";
const DEFAULT_LOG_BYTES = 2 * 1024 * 1024;

/** Newest first: the live file, then rotated files by the timestamp in their name. */
function listLogs(dir: string, base: string): string[] {
  const live = `${base}.log`;
  const rotated = readdirSync(dir)
    .filter((f) =>
      new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d{15}-\\d+\\.log$`).test(f),
    )
    .sort()
    .reverse();
  return [...(existsSync(join(dir, live)) ? [live] : []), ...rotated];
}

/** The last `bytes` bytes of a file, starting at a line boundary when it had to be cut. */
function readTail(path: string, bytes: number): string {
  const size = statSync(path).size;
  if (size <= bytes) return readFileSync(path, "utf8");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes);
    const text = buf.toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    closeSync(fd);
  }
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

/**
 * Writes a folder with `manifest.json`, `versions.json`, `config.json`, recent `logs/` and any
 * attachments. Everything goes through the secret scrubber again at export time, then the written
 * files are read back and checked; on a surviving secret the folder is deleted and the export fails.
 */
export function exportDiagnostics(input: DiagnosticsInput): DiagnosticsResult {
  const now = (input.now ?? Date.now)();
  const scrub = createScrubber(input.secrets);
  const out = new Map<string, string>();

  out.set("versions.json", JSON.stringify(scrub.value(input.versions), null, 2));
  out.set("config.json", JSON.stringify(scrub.value(input.config ?? null), null, 2));

  let budget = input.maxLogBytes ?? DEFAULT_LOG_BYTES;
  const base = input.logBaseName ?? "agent-studio";
  if (existsSync(input.logDir)) {
    for (const f of listLogs(input.logDir, base)) {
      if (budget <= 0) break;
      const raw = readTail(join(input.logDir, f), budget);
      budget -= Buffer.byteLength(raw);
      out.set(`logs/${f}`, scrub.text(raw));
    }
  }
  for (const a of input.attachments ?? []) {
    const name = basename(a.name.replace(/\\/g, "/")) || "attachment.txt";
    out.set(`attachments/${scrub.text(name)}`, scrub.text(a.content));
  }

  mkdirSync(input.outDir, { recursive: true });
  const stamp = new Date(now)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  let dir = join(input.outDir, `diagnostics-${stamp}`);
  for (let i = 1; existsSync(dir); i++) dir = join(input.outDir, `diagnostics-${stamp}-${i}`);
  mkdirSync(dir);

  try {
    const files: ManifestEntry[] = [];
    for (const [path, content] of out) {
      const full = join(dir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
      files.push({ path, bytes: Buffer.byteLength(content), sha256: sha256(content) });
    }
    const manifest: DiagnosticsManifest = {
      schema: 1,
      generatedAt: new Date(now).toISOString(),
      versions: scrub.value(input.versions),
      files,
      redaction: {
        exactSecretNeedles: scrub.needleCount,
        minSecretLength: MIN_SECRET_LENGTH,
        limits: LIMITS,
      },
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(manifestPath, manifestText);

    // Read back what is really on disk, not what we meant to write.
    const leaked = [...files.map((f) => f.path), "manifest.json"].filter(
      (p) => scrub.leaks(readFileSync(join(dir, p), "utf8")).length > 0,
    );
    if (leaked.length > 0) throw new DiagnosticsLeakError(leaked);
    return { dir, manifestPath, manifest };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Reads a bundle back and checks every file against the manifest (size and sha256). */
export function verifyDiagnostics(dir: string): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  let manifest: DiagnosticsManifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DiagnosticsManifest;
  } catch {
    return { ok: false, problems: ["manifest.json missing or not valid JSON"] };
  }
  for (const f of manifest.files) {
    try {
      const content = readFileSync(join(dir, f.path), "utf8");
      if (sha256(content) !== f.sha256) problems.push(`${f.path}: sha256 mismatch`);
    } catch {
      problems.push(`${f.path}: missing`);
    }
  }
  return { ok: problems.length === 0, problems };
}
