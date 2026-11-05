import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, createRotatingFileDestination } from "@agent-studio/shared-utils";
import { createScrubber, exportDiagnostics, verifyDiagnostics } from "./index.js";

const SECRET_A = "fake-claude-secret-value-for-test"; // pragma: allowlist secret
const SECRET_B = 'fake"codex\\secret-with-escapes-for-test'; // pragma: allowlist secret
const SECRETS = [SECRET_A, SECRET_B];

let root: string;
let logDir: string;
let outDir: string;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "diag-"));
  logDir = join(root, "logs");
  outDir = join(root, "out");
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Every file under `dir`, recursively, as relative path -> text. */
function readAll(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, readAll(dir, p));
    else out[p] = readFileSync(join(dir, p), "utf8");
  }
  return out;
}

function baseInput() {
  return {
    outDir,
    logDir,
    versions: { app: "0.0.0", node: "v22.0.0" },
    config: { agents: { claude: { enabled: true } }, workspace: "demo" },
    secrets: SECRETS,
    now: () => clock,
  };
}

describe("createScrubber", () => {
  it("masks raw and JSON-escaped forms, keys, and credential shapes", () => {
    const s = createScrubber(SECRETS);
    const text = [
      `a ${SECRET_A} b`,
      JSON.stringify({ note: SECRET_B }),
      JSON.stringify({ password: "hunter2-not-known", ok: 1 }), // pragma: allowlist secret
      "Authorization: Bearer abcdefghijklmnop12345",
    ].join("\n");
    const out = s.text(text);
    expect(s.leaks(out)).toEqual([]);
    expect(out).not.toContain("hunter2-not-known");
    expect(out).not.toContain("abcdefghijklmnop12345");
    expect(out).toContain('"ok":1');
  });

  it("does not mask values shorter than the minimum", () => {
    expect(createScrubber(["abc"]).text("abc def")).toBe("abc def");
  });
});

describe("exportDiagnostics", () => {
  it("opens, matches its manifest, and holds recent logs plus versions and config", () => {
    const dest = createRotatingFileDestination({
      dir: logDir,
      maxBytes: 300,
      maxFiles: 10,
      maxAgeMs: 86_400_000,
      now: () => clock,
    });
    const log = createLogger({ name: "t", destination: dest });
    for (let i = 0; i < 10; i++) {
      log.info({ i }, `event number ${i}`);
      clock += 1000;
    }
    const res = exportDiagnostics(baseInput());
    expect(verifyDiagnostics(res.dir)).toEqual({ ok: true, problems: [] });
    expect(res.manifest.generatedAt).toBe(new Date(clock).toISOString());
    const files = readAll(res.dir);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(["manifest.json", "versions.json", "config.json"]),
    );
    expect(Object.keys(files).filter((f) => f.startsWith("logs/")).length).toBeGreaterThan(1);
    expect(JSON.parse(files["versions.json"]!)).toEqual({ app: "0.0.0", node: "v22.0.0" });
    expect(Object.values(files).join("")).toContain("event number 9");
  });

  it("leaves no known secret in logs, DB dump, config or manifest", () => {
    // Logs written WITHOUT the masking destination, as an older build or another tool might.
    const dest = createRotatingFileDestination({
      dir: logDir,
      maxBytes: 10_000,
      maxFiles: 5,
      maxAgeMs: 86_400_000,
      now: () => clock,
    });
    const log = createLogger({ name: "t", destination: dest });
    log.info(`request failed with key ${SECRET_A}`);
    log.info({ detail: SECRET_B, nested: { note: `x${SECRET_A}y` } }, "payload");
    dest.write(`raw line ${SECRET_B}\n`);
    dest.write(`${JSON.stringify({ msg: "j", data: SECRET_A })}\n`);

    const dbDump =
      `INSERT INTO events VALUES (1,'${SECRET_A}');\n` +
      `INSERT INTO runs VALUES (2,'${JSON.stringify(SECRET_B)}');\n`;
    const res = exportDiagnostics({
      ...baseInput(),
      config: { api: { apiKey: "not-in-the-known-list" }, note: `uses ${SECRET_A}` }, // pragma: allowlist secret
      versions: { app: `0.0.0 (${SECRET_B})` },
      attachments: [{ name: "..\\..\\evil/db-dump.sql", content: dbDump }],
    });

    const files = readAll(res.dir);
    expect(Object.keys(files)).toContain("attachments/db-dump.sql");
    expect(Object.keys(files).some((f) => f.includes(".."))).toBe(false);
    const everything = Object.values(files).join("\n");
    for (const s of SECRETS) {
      expect(everything).not.toContain(s);
      expect(everything).not.toContain(JSON.stringify(s).slice(1, -1));
    }
    expect(everything).not.toContain("not-in-the-known-list");
    expect(everything).toContain("[REDACTED]");
    expect(verifyDiagnostics(res.dir).ok).toBe(true);
  });

  it("caps the log volume and keeps the newest lines", () => {
    const dest = createRotatingFileDestination({
      dir: logDir,
      maxBytes: 10_000,
      maxFiles: 5,
      maxAgeMs: 86_400_000,
      now: () => clock,
    });
    for (let i = 0; i < 50; i++) dest.write(`line-${String(i).padStart(3, "0")}\n`);
    const res = exportDiagnostics({ ...baseInput(), maxLogBytes: 40 });
    const log = Object.entries(readAll(res.dir)).find(([f]) => f.startsWith("logs/"))![1];
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(40);
    expect(log).toContain("line-049");
    expect(log).not.toContain("line-000");
  });

  it("detects tampering with verifyDiagnostics", () => {
    const res = exportDiagnostics(baseInput());
    writeFileSync(join(res.dir, "config.json"), "{}");
    const v = verifyDiagnostics(res.dir);
    expect(v.ok).toBe(false);
    expect(v.problems[0]).toContain("config.json");
  });

  it("works with no log directory and never overwrites an earlier bundle", () => {
    const a = exportDiagnostics(baseInput());
    const b = exportDiagnostics(baseInput());
    expect(a.dir).not.toBe(b.dir);
    expect(readdirSync(outDir)).toHaveLength(2);
  });
});
