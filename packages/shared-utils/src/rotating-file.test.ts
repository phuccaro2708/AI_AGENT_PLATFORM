import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "./logger.js";
import { createRotatingFileDestination } from "./rotating-file.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rot-"));
  clock = 1_800_000_000_000; // fake clock, never the real one
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const files = () => readdirSync(dir).sort();

describe("createRotatingFileDestination", () => {
  it("rotates by size and loses no line", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 100,
      maxFiles: 50,
      maxAgeMs: 30 * DAY,
      now,
    });
    const lines = Array.from(
      { length: 12 },
      (_, i) => `line-${String(i).padStart(2, "0")}-${"x".repeat(30)}\n`,
    );
    for (const l of lines) {
      dest.write(l);
      clock += 1;
    }
    const all = files();
    expect(all.length).toBeGreaterThan(2);
    expect(all).toContain("agent-studio.log");
    for (const f of all) expect(readFileSync(join(dir, f)).length).toBeLessThanOrEqual(100);
    // Oldest rotated file first (names sort by time), then the live file: original order.
    const joined = [...all.filter((f) => f !== "agent-studio.log"), "agent-studio.log"]
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("");
    expect(joined).toBe(lines.join(""));
  });

  it("writes an oversized single line into an empty file instead of looping", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 10,
      maxFiles: 5,
      maxAgeMs: DAY,
      now,
    });
    dest.write("0123456789ABCDEF\n");
    expect(files()).toEqual(["agent-studio.log"]);
  });

  it("deletes rotated files older than maxAgeMs using the fake clock", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 20,
      maxFiles: 50,
      maxAgeMs: 2 * DAY,
      now,
    });
    dest.write("a".repeat(15));
    clock += 1;
    dest.write("b".repeat(15)); // rotates: file "a" is stamped at T
    expect(files()).toHaveLength(2);
    clock += 3 * DAY;
    dest.prune();
    expect(files()).toEqual(["agent-studio.log"]);
  });

  it("keeps rotated files younger than maxAgeMs", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 20,
      maxFiles: 50,
      maxAgeMs: 2 * DAY,
      now,
    });
    dest.write("a".repeat(15));
    dest.write("b".repeat(15));
    clock += DAY;
    dest.prune();
    expect(files()).toHaveLength(2);
  });

  it("prunes on the hourly write path without an explicit call", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 20,
      maxFiles: 50,
      maxAgeMs: 2 * DAY,
      now,
    });
    dest.write("a".repeat(15));
    dest.write("b".repeat(15));
    clock += 3 * DAY;
    dest.write("c"); // fits the live file, but the hourly sweep is due
    expect(files()).toEqual(["agent-studio.log"]);
  });

  it("keeps at most maxFiles rotated files, newest first", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 10,
      maxFiles: 2,
      maxAgeMs: 30 * DAY,
      now,
    });
    for (const ch of "abcdef") {
      dest.write(ch.repeat(8));
      clock += 1000;
    }
    const rotated = files().filter((f) => f !== "agent-studio.log");
    expect(rotated).toHaveLength(2);
    const text = rotated.map((f) => readFileSync(join(dir, f), "utf8"));
    expect(text).toEqual(["dddddddd", "eeeeeeee"]); // "f" is in the live file
  });

  it("does not collide when two rotations share one millisecond", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 5,
      maxFiles: 50,
      maxAgeMs: DAY,
      now,
    });
    for (const ch of "abc") dest.write(ch.repeat(4)); // clock never advances
    expect(files().filter((f) => f !== "agent-studio.log")).toHaveLength(2);
  });

  it("resumes the size of an existing live file after a restart", () => {
    const first = createRotatingFileDestination({
      dir,
      maxBytes: 20,
      maxFiles: 5,
      maxAgeMs: DAY,
      now,
    });
    first.write("a".repeat(15));
    const second = createRotatingFileDestination({
      dir,
      maxBytes: 20,
      maxFiles: 5,
      maxAgeMs: DAY,
      now,
    });
    second.write("b".repeat(15));
    expect(files()).toHaveLength(2);
  });

  it("ignores unrelated files in the directory", () => {
    writeFileSync(join(dir, "notes.txt"), "keep");
    writeFileSync(join(dir, "other.000000000000001-0.log"), "keep");
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 10,
      maxFiles: 0,
      maxAgeMs: DAY,
      now,
    });
    dest.write("x");
    dest.prune();
    expect(files()).toEqual(["agent-studio.log", "notes.txt", "other.000000000000001-0.log"]);
  });

  it("works as a createLogger destination", () => {
    const dest = createRotatingFileDestination({
      dir,
      maxBytes: 10_000,
      maxFiles: 3,
      maxAgeMs: DAY,
      now,
    });
    createLogger({ name: "t", destination: dest }).info({ n: 1 }, "hello");
    expect(readFileSync(dest.currentPath, "utf8")).toContain('"msg":"hello"');
  });
});
