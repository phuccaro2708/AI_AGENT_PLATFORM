import { describe, expect, it } from "vitest";
import {
  createSecretRedactor,
  MIN_SECRET_LENGTH,
  noSecrets,
  redactingDestination,
  SECRET_MASK,
  takeSecretsFromEnv,
} from "./secrets.js";

describe("takeSecretsFromEnv", () => {
  it("moves secrets out of the environment, sorted by provider", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "p",
      AGENT_STUDIO_SECRET__CLAUDE__ANTHROPIC_API_KEY: "a",
      AGENT_STUDIO_SECRET__CODEX__OPENAI_API_KEY: "b",
    };
    const s = takeSecretsFromEnv(env);
    expect(s).toEqual({
      claude: { ANTHROPIC_API_KEY: "a" },
      codex: { OPENAI_API_KEY: "b" },
    });
    expect(env).toEqual({ PATH: "p" });
  });
  it("drops unknown providers and empty values but still scrubs them", () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_STUDIO_SECRET__GEMINI__X_KEY: "z",
      AGENT_STUDIO_SECRET__CLAUDE__EMPTY_KEY: "",
      AGENT_STUDIO_SECRET__broken: "q",
    };
    expect(takeSecretsFromEnv(env)).toEqual({ claude: {}, codex: {} });
    expect(Object.keys(env)).toEqual([]);
  });
});

describe("createSecretRedactor", () => {
  const secrets = {
    claude: { A_KEY: "fake-secret-value-for-test", B_KEY: "fake-secret-value-for-test-longer" }, // pragma: allowlist secret
    codex: { C_KEY: 'other"quoted\\value-123', D_KEY: "abc" }, // pragma: allowlist secret
  };
  const r = createSecretRedactor(secrets);

  it("masks the exact value anywhere in a string, every occurrence", () => {
    expect(r.text("KEY=fake-secret-value-for-test and fake-secret-value-for-test!")).toBe(
      `KEY=${SECRET_MASK} and ${SECRET_MASK}!`,
    );
  });

  it("masks the longer secret as a whole when one contains another", () => {
    expect(r.text("x fake-secret-value-for-test-longer y")).toBe(`x ${SECRET_MASK} y`);
  });

  it("masks other providers' secrets too and the JSON-escaped form", () => {
    expect(r.text('other"quoted\\value-123')).toBe(SECRET_MASK);
    expect(r.text(JSON.stringify({ k: 'other"quoted\\value-123' }))).toBe(`{"k":"${SECRET_MASK}"}`);
  });

  it(`ignores values shorter than ${MIN_SECRET_LENGTH} characters (documented limit)`, () => {
    expect(r.text("the abc is here")).toBe("the abc is here");
  });

  it("masks strings and keys deep inside values without touching the rest", () => {
    const input = {
      a: ["fake-secret-value-for-test", 1, null, true],
      "fake-secret-value-for-test": { n: 2 },
    };
    expect(r.deep(input)).toEqual({ a: [SECRET_MASK, 1, null, true], [SECRET_MASK]: { n: 2 } });
    expect(input.a[0]).toBe("fake-secret-value-for-test"); // input untouched
  });

  it("does not catch a value split across two chunks or transformed (documented limit)", () => {
    expect(r.text("fake-secret-")).toBe("fake-secret-");
    const b64 = Buffer.from("fake-secret-value-for-test").toString("base64");
    expect(r.text(b64)).toBe(b64);
  });

  it("is inactive and returns values as they are when there is nothing to mask", () => {
    const none = createSecretRedactor(noSecrets());
    const v = { a: "x" };
    expect(none.active).toBe(false);
    expect(none.deep(v)).toBe(v);
  });

  it("masks a log line on its way to the destination", () => {
    const lines: string[] = [];
    redactingDestination(r, { write: (c) => lines.push(c) }).write(
      '{"msg":"boom fake-secret-value-for-test"}\n',
    );
    expect(lines).toEqual([`{"msg":"boom ${SECRET_MASK}"}\n`]);
  });
});
