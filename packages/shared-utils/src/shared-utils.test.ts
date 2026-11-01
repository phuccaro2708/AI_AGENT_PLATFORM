import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger, newId, redact, REDACTED } from "./index.js";

function capture() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  return { destination, output: () => chunks.join("") };
}

describe("newId", () => {
  it("is unique, prefixed and lexicographically sortable", () => {
    const a = newId("task");
    const b = newId("task");
    expect(a.startsWith("task_")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("redact", () => {
  it("masks sensitive keys deeply and credential-like strings", () => {
    const out = redact({
      user: "a",
      nested: { apiKey: "k", Authorization: "Bearer abcdefghijkl" },
      text: "token is ghp_abcdefghijklmnopqrstuvwxyz0123 ok",
      list: [{ password: "p" }],
    });
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.Authorization).toBe(REDACTED);
    expect(out.text).not.toContain("ghp_");
    expect(out.list[0]?.password).toBe(REDACTED);
    expect(out.user).toBe("a");
  });
  it("handles circular references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe("createLogger", () => {
  it("never writes secrets to the output", () => {
    const { destination, output } = capture();
    const log = createLogger({ name: "test", destination });
    log.info({ apiKey: "SUPERSECRET1", headers: { authorization: "Bearer topsecrettoken123" }, env: { X: "envsecret" } }, "login with sk-abcdefghijklmnopqrstuv");
    log.warn({ nested: { token: "TOK123SECRET" } });
    const o = output();
    for (const s of ["SUPERSECRET1", "topsecrettoken123", "envsecret", "sk-abcdefghijklmnopqrstuv", "TOK123SECRET"]) {
      expect(o).not.toContain(s);
    }
    expect(o).toContain(REDACTED);
  });
});
