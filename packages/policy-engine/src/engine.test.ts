import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";
import { applyGrants, grantTargetFor } from "./grants.js";
import { commandKey } from "./rules.js";
import { canSymlink, makeTree } from "./test-helpers.js";
import type { Decision, Grant, PermissionLevel, Policy, PolicyRequest } from "./types.js";

const trees: Array<() => void> = [];
const tree = () => {
  const t = makeTree();
  trees.push(t.cleanup);
  return t;
};
afterEach(() => trees.splice(0).forEach((c) => c()));
const symlinks = canSymlink();
/** Joins WITHOUT collapsing "..", unlike path.join, so the engine sees what an agent would send. */
const raw = (...parts: string[]) => parts.join(path.sep);

const policyFor = (level: PermissionLevel, ws: string, extra: Partial<Policy> = {}): Policy => ({
  level,
  workspaceRoot: ws,
  ...extra,
});
const effects = async (policy: Policy, reqs: PolicyRequest[]) =>
  Promise.all(reqs.map(async (r) => (await evaluate(policy, r)).effect));

describe("path scope", () => {
  it("allows reads and writes inside the workspace (Workspace Write)", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws);
    expect(
      await effects(p, [
        { kind: "fs.read", path: path.join(ws, "src", "a.txt") },
        { kind: "fs.write", path: path.join(ws, "src", "a.txt") },
        { kind: "fs.write", path: path.join(ws, "src", "brand", "new.txt") },
      ]),
    ).toEqual(["allow", "allow", "allow"]);
  });

  it("denies ../ traversal out of the workspace", async () => {
    const { ws, outside } = tree();
    const p = policyFor("workspace_write", ws);
    const viaDots = raw(ws, "src", "..", "..", "outside", "secret.txt");
    for (const kind of ["fs.read", "fs.write"] as const) {
      const d = await evaluate(p, { kind, path: viaDots });
      expect(d).toMatchObject({ effect: "deny", code: "outside_scope" });
    }
    expect(
      (await evaluate(p, { kind: "fs.read", path: path.join(outside, "secret.txt") })).effect,
    ).toBe("deny");
  });

  it("does not treat a sibling with the same prefix as inside", async () => {
    const { base, ws } = tree();
    fs.mkdirSync(path.join(base, "ws-evil"));
    const d = await evaluate(policyFor("workspace_write", ws), {
      kind: "fs.write",
      path: path.join(base, "ws-evil", "x"),
    });
    expect(d.effect).toBe("deny");
  });

  it.skipIf(!symlinks)("denies a symlink inside the workspace that points outside", async () => {
    const { ws, outside } = tree();
    fs.symlinkSync(outside, path.join(ws, "link"), "dir");
    const p = policyFor("workspace_write", ws);
    expect(
      (await evaluate(p, { kind: "fs.read", path: path.join(ws, "link", "secret.txt") })).effect,
    ).toBe("deny");
    expect(
      (await evaluate(p, { kind: "fs.write", path: path.join(ws, "link", "new.txt") })).effect,
    ).toBe("deny");
  });

  it.skipIf(!symlinks || process.platform === "win32")(
    "POSIX: denies ../ that escapes only because of a symlink",
    async () => {
      const { ws, outside } = tree();
      fs.mkdirSync(path.join(outside, "sub"));
      fs.symlinkSync(path.join(outside, "sub"), path.join(ws, "link"), "dir");
      // lexically ws/link/../src/a.txt looks inside ws; really it is outside/src/a.txt
      const d = await evaluate(policyFor("workspace_write", ws), {
        kind: "fs.write",
        path: raw(ws, "link", "..", "src", "a.txt"),
      });
      expect(d.effect).toBe("deny");
    },
  );

  it.skipIf(process.platform !== "win32")(
    "Windows: denies a verbatim path that would skip .. collapsing",
    async () => {
      const { ws } = tree();
      const d = await evaluate(policyFor("workspace_write", ws), {
        kind: "fs.write",
        path: "\\\\?\\" + raw(ws, "src", "..", "..", "outside", "x.txt"),
      });
      expect(d.effect).toBe("deny");
    },
  );

  it.skipIf(!symlinks)(
    "denies writing through a dangling symlink that points outside",
    async () => {
      const { ws, outside } = tree();
      fs.symlinkSync(path.join(outside, "new.txt"), path.join(ws, "dangling"), "file");
      const d = await evaluate(policyFor("workspace_write", ws), {
        kind: "fs.write",
        path: path.join(ws, "dangling"),
      });
      expect(d.effect).toBe("deny");
    },
  );

  it.skipIf(!symlinks)("allows a symlink that stays inside the workspace", async () => {
    const { ws } = tree();
    fs.symlinkSync(path.join(ws, "src"), path.join(ws, "alias"), "dir");
    const d = await evaluate(policyFor("workspace_write", ws), {
      kind: "fs.read",
      path: path.join(ws, "alias", "a.txt"),
    });
    expect(d.effect).toBe("allow");
  });

  it.skipIf(!symlinks)("denies writes through a symlink into a protected path", async () => {
    const { ws } = tree();
    fs.symlinkSync(path.join(ws, ".git"), path.join(ws, "hooks-alias"), "dir");
    const d = await evaluate(policyFor("workspace_write", ws), {
      kind: "fs.write",
      path: path.join(ws, "hooks-alias", "hooks", "pre-commit"),
    });
    expect(d).toMatchObject({ effect: "deny", code: "protected_path" });
  });

  it("denies writes to .git by default but still allows reading it", async () => {
    const { ws } = tree();
    const p = policyFor("privileged", ws);
    expect(
      await evaluate(p, { kind: "fs.write", path: path.join(ws, ".git", "config") }),
    ).toMatchObject({ effect: "deny", code: "protected_path" });
    expect(
      (await evaluate(p, { kind: "fs.read", path: path.join(ws, ".git", "config") })).effect,
    ).toBe("allow");
  });

  it("honours custom protectedPaths and rejects ones that escape the workspace", async () => {
    const { ws } = tree();
    const custom = policyFor("workspace_write", ws, { protectedPaths: ["src"] });
    expect(
      (await evaluate(custom, { kind: "fs.write", path: path.join(ws, "src", "a.txt") })).code,
    ).toBe("protected_path");
    const bad = policyFor("workspace_write", ws, { protectedPaths: ["../outside"] });
    expect(await evaluate(bad, { kind: "fs.write", path: path.join(ws, "x") })).toMatchObject({
      effect: "deny",
      code: "invalid_policy",
    });
  });

  it("allows extra read roots for reads only", async () => {
    const { ws, outside } = tree();
    const p = policyFor("workspace_write", ws, { extraReadRoots: [outside] });
    expect(
      (await evaluate(p, { kind: "fs.read", path: path.join(outside, "secret.txt") })).code,
    ).toBe("in_read_root");
    expect(
      (await evaluate(p, { kind: "fs.write", path: path.join(outside, "secret.txt") })).effect,
    ).toBe("deny");
  });

  it("denies relative paths and missing workspaces", async () => {
    const { ws, base } = tree();
    expect(
      await evaluate(policyFor("workspace_write", ws), { kind: "fs.read", path: "src/a.txt" }),
    ).toMatchObject({ effect: "deny", code: "path_unresolvable" });
    const gone = policyFor("workspace_write", path.join(base, "nope"));
    expect(
      await evaluate(gone, { kind: "fs.read", path: path.join(base, "nope", "x") }),
    ).toMatchObject({ effect: "deny", code: "workspace_unavailable" });
  });
});

describe("permission levels", () => {
  const cmd: PolicyRequest = { kind: "command", executable: "git", args: ["status"] };
  const net: PolicyRequest = { kind: "network", host: "example.com", port: 443 };
  const rules = {
    commands: { allow: [{ executable: "git", argsPrefix: ["status"] }] },
    network: { allow: [{ host: "example.com", ports: [443] }] },
  };

  it("Read Only: reads in scope only; writes, commands and network denied even with allow rules", async () => {
    const { ws, outside } = tree();
    const p = policyFor("read_only", ws, { ...rules, extraReadRoots: [] });
    expect(
      await effects(p, [
        { kind: "fs.read", path: path.join(ws, "src", "a.txt") },
        { kind: "fs.write", path: path.join(ws, "src", "a.txt") },
        { kind: "fs.read", path: path.join(outside, "secret.txt") },
        cmd,
        net,
      ]),
    ).toEqual(["allow", "deny", "deny", "deny", "deny"]);
  });

  it("Workspace Write: writes in scope, listed commands/hosts allowed, everything else denied (never asks)", async () => {
    const { ws, outside } = tree();
    const p = policyFor("workspace_write", ws, rules);
    expect(
      await effects(p, [
        { kind: "fs.write", path: path.join(ws, "src", "a.txt") },
        cmd,
        net,
        { kind: "command", executable: "git", args: ["push"] },
        { kind: "command", executable: "curl", args: [] },
        { kind: "network", host: "other.com", port: 443 },
        { kind: "network", host: "example.com", port: 80 },
        { kind: "fs.write", path: path.join(outside, "x") },
      ]),
    ).toEqual(["allow", "allow", "allow", "deny", "deny", "deny", "deny", "deny"]);
  });

  it("Restricted Tools: unlisted commands/hosts ask; outside files are still denied", async () => {
    const { ws, outside } = tree();
    const p = policyFor("restricted_tools", ws, rules);
    expect(
      await effects(p, [
        cmd,
        { kind: "command", executable: "git", args: ["push"] },
        { kind: "network", host: "other.com" },
        { kind: "fs.write", path: path.join(outside, "x") },
        { kind: "fs.read", path: path.join(outside, "secret.txt") },
      ]),
    ).toEqual(["allow", "ask", "ask", "deny", "deny"]);
  });

  it("Privileged: outside files also ask, but nothing is auto-allowed without a rule or grant", async () => {
    const { ws, outside } = tree();
    const p = policyFor("privileged", ws);
    const d = await evaluate(p, { kind: "fs.write", path: path.join(outside, "x") });
    expect(d).toMatchObject({
      effect: "ask",
      code: "outside_scope",
      target: path.join(outside, "x"),
    });
    expect(
      await effects(p, [
        { kind: "command", executable: "git", args: [] },
        { kind: "network", host: "example.com" },
        { kind: "fs.read", path: path.join(outside, "secret.txt") },
      ]),
    ).toEqual(["ask", "ask", "ask"]);
  });

  it("deny rules and interpreters hold at every level, including Privileged", async () => {
    const { ws } = tree();
    for (const level of ["workspace_write", "restricted_tools", "privileged"] as const) {
      const p = policyFor(level, ws, {
        commands: {
          allow: [{ executable: "bash" }, { executable: "git" }],
          deny: [{ executable: "git", argsPrefix: ["push"] }],
        },
        network: { allow: [{ host: "*.example.com" }], deny: [{ host: "evil.example.com" }] },
      });
      expect(
        (await evaluate(p, { kind: "command", executable: "bash", args: ["-c", "ls"] })).code,
      ).toBe("interpreter");
      expect(
        (
          await evaluate(p, {
            kind: "command",
            executable: "C:\\Windows\\System32\\cmd.exe",
            args: ["/c", "dir"],
          })
        ).code,
      ).toBe("interpreter");
      expect((await evaluate(p, { kind: "command", executable: "env", args: ["sh"] })).code).toBe(
        "interpreter",
      );
      expect(
        (await evaluate(p, { kind: "command", executable: "git", args: ["push", "origin"] })).code,
      ).toBe("rule_deny");
      expect(
        (await evaluate(p, { kind: "command", executable: "/opt/x/git", args: ["push"] })).code,
      ).toBe("rule_deny");
      expect((await evaluate(p, { kind: "network", host: "evil.example.com" })).code).toBe(
        "rule_deny",
      );
      expect((await evaluate(p, { kind: "network", host: "ok.example.com" })).effect).toBe("allow");
    }
  });
});

describe("command and network matching", () => {
  it("an allow rule for a bare name does not match a path-qualified executable", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws, { commands: { allow: [{ executable: "git" }] } });
    expect(
      (await evaluate(p, { kind: "command", executable: "/tmp/evil/git", args: [] })).effect,
    ).toBe("deny");
  });

  it("argsPrefix must match from the first argument", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws, {
      commands: { allow: [{ executable: "git", argsPrefix: ["status"] }] },
    });
    expect(
      (
        await evaluate(p, {
          kind: "command",
          executable: "git",
          args: ["-c", "core.pager=x", "status"],
        })
      ).effect,
    ).toBe("deny");
    expect(
      (await evaluate(p, { kind: "command", executable: "git", args: ["status", "-s"] })).effect,
    ).toBe("allow");
  });

  it("wildcard host does not match the apex or a look-alike suffix; hosts are normalised", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws, {
      network: { allow: [{ host: "*.example.com" }, { host: "api.test" }] },
    });
    const e = (host: string) => evaluate(p, { kind: "network", host }).then((d) => d.effect);
    expect(await e("example.com")).toBe("deny");
    expect(await e("badexample.com")).toBe("deny");
    expect(await e("a.example.com.evil.io")).toBe("deny");
    expect(await e("A.Example.COM.")).toBe("allow");
    expect(await e("API.test")).toBe("allow");
  });

  it("rejects hosts that are really URLs or carry userinfo, and bad ports", async () => {
    const { ws } = tree();
    const p = policyFor("privileged", ws);
    for (const host of [
      "http://example.com",
      "user@example.com",
      "example.com/x",
      "",
      " ",
      "a b",
    ]) {
      expect((await evaluate(p, { kind: "network", host })).code).toBe("invalid_request");
    }
    for (const port of [0, 70000, 1.5, Number.NaN]) {
      expect((await evaluate(p, { kind: "network", host: "example.com", port })).code).toBe(
        "invalid_request",
      );
    }
  });
});

describe("fail-closed", () => {
  it("denies unknown or malformed requests and policies", async () => {
    const { ws } = tree();
    const p = policyFor("privileged", ws);
    const bad = [
      null,
      undefined,
      {},
      { kind: "fs.delete", path: ws },
      { kind: "fs.read" },
      { kind: "fs.read", path: 5 },
      { kind: "command", executable: "git" },
      { kind: "command", executable: "git", args: [1] },
      { kind: "command", executable: "", args: [] },
    ];
    for (const r of bad) {
      expect((await evaluate(p, r as unknown as PolicyRequest)).effect).toBe("deny");
    }
    const okReq: PolicyRequest = { kind: "fs.read", path: ws };
    for (const pol of [
      null,
      {},
      { level: "root", workspaceRoot: ws },
      { level: "privileged", workspaceRoot: "rel" },
    ]) {
      expect(await evaluate(pol as unknown as Policy, okReq)).toMatchObject({
        effect: "deny",
        code: "invalid_policy",
      });
    }
  });

  it("denies when a rule list is malformed enough to throw", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws, { commands: { allow: [null as never] } });
    expect(await evaluate(p, { kind: "command", executable: "git", args: [] })).toMatchObject({
      effect: "deny",
      code: "internal_error",
    });
  });

  it("default is deny: no rules, no match", async () => {
    const { ws } = tree();
    const p = policyFor("workspace_write", ws);
    expect(
      await effects(p, [
        { kind: "command", executable: "git", args: [] },
        { kind: "network", host: "example.com" },
      ]),
    ).toEqual(["deny", "deny"]);
  });
});

describe("grants (contract for 7C-2)", () => {
  const NOW = new Date("2026-11-05T00:00:00Z");
  const grant = (g: Partial<Grant> & Pick<Grant, "scope" | "target">): Grant => ({
    id: "g1",
    expiresAt: null,
    revokedAt: null,
    ...g,
  });
  const ev = (
    policy: Policy,
    req: PolicyRequest,
    grants: Grant[],
    extra: { taskId?: string; projectId?: string } = {},
  ) => evaluate(policy, req, { grants, now: NOW, ...extra });

  it("a path grant turns an outside-file ask into allow, only below its path", async () => {
    const { ws, outside, base } = tree();
    const p = policyFor("privileged", ws);
    const g = grant({ scope: "path", target: outside });
    expect(await ev(p, { kind: "fs.write", path: path.join(outside, "x") }, [g])).toMatchObject({
      effect: "allow",
      code: "grant",
      grantId: "g1",
    });
    fs.mkdirSync(path.join(base, "other"));
    expect(
      (await ev(p, { kind: "fs.write", path: path.join(base, "other", "x") }, [g])).effect,
    ).toBe("ask");
  });

  it("a path grant cannot be used to escape through ../ or a symlink", async () => {
    const { ws, outside, base } = tree();
    const p = policyFor("privileged", ws);
    fs.mkdirSync(path.join(base, "other"));
    const g = grant({ scope: "path", target: outside });
    expect(
      (await ev(p, { kind: "fs.write", path: raw(outside, "..", "other", "x") }, [g])).effect,
    ).toBe("ask");
    if (symlinks) {
      fs.symlinkSync(path.join(base, "other"), path.join(outside, "l"), "dir");
      expect(
        (await ev(p, { kind: "fs.write", path: path.join(outside, "l", "x") }, [g])).effect,
      ).toBe("ask");
    }
  });

  it("a grant never overrides a deny (protected path, interpreter, deny rule, lower level)", async () => {
    const { ws, outside } = tree();
    const all = [
      grant({ scope: "path", target: ws }),
      grant({ id: "g2", scope: "task", target: "t1" }),
      grant({ id: "g3", scope: "project", target: "p1" }),
    ];
    const priv = policyFor("privileged", ws, {
      commands: { deny: [{ executable: "git", argsPrefix: ["push"] }] },
    });
    const ctx = { taskId: "t1", projectId: "p1" };
    expect(
      (await ev(priv, { kind: "fs.write", path: path.join(ws, ".git", "config") }, all, ctx))
        .effect,
    ).toBe("deny");
    expect(
      (await ev(priv, { kind: "command", executable: "bash", args: [] }, all, ctx)).effect,
    ).toBe("deny");
    expect(
      (await ev(priv, { kind: "command", executable: "git", args: ["push"] }, all, ctx)).effect,
    ).toBe("deny");
    const restricted = policyFor("restricted_tools", ws);
    expect(
      (
        await ev(restricted, { kind: "fs.write", path: path.join(outside, "x") }, [
          grant({ scope: "path", target: outside }),
        ])
      ).effect,
    ).toBe("deny");
  });

  it("command grants match the exact command only", async () => {
    const { ws } = tree();
    const p = policyFor("restricted_tools", ws);
    const g = grant({ scope: "command", target: commandKey("npm", ["test"]) });
    expect((await ev(p, { kind: "command", executable: "npm", args: ["test"] }, [g])).effect).toBe(
      "allow",
    );
    expect(
      (await ev(p, { kind: "command", executable: "npm", args: ["publish"] }, [g])).effect,
    ).toBe("ask");
    expect(
      (await ev(p, { kind: "command", executable: "npm", args: ["test", "x"] }, [g])).effect,
    ).toBe("ask");
  });

  it("task/project grants cover commands and network of that task/project, never outside files", async () => {
    const { ws, outside } = tree();
    const p = policyFor("privileged", ws);
    const t = grant({ scope: "task", target: "t1" });
    const pr = grant({ id: "g2", scope: "project", target: "p1" });
    const cmd: PolicyRequest = { kind: "command", executable: "npm", args: ["test"] };
    const net: PolicyRequest = { kind: "network", host: "example.com" };
    const out: PolicyRequest = { kind: "fs.write", path: path.join(outside, "x") };
    expect((await ev(p, cmd, [t], { taskId: "t1" })).effect).toBe("allow");
    expect((await ev(p, net, [pr], { projectId: "p1" })).effect).toBe("allow");
    expect((await ev(p, cmd, [t], { taskId: "t2" })).effect).toBe("ask");
    expect((await ev(p, cmd, [t], {})).effect).toBe("ask");
    expect((await ev(p, out, [t, pr], { taskId: "t1", projectId: "p1" })).effect).toBe("ask");
  });

  it("expired, revoked, unparsable-expiry and target-less grants do not apply", async () => {
    const { ws } = tree();
    const p = policyFor("restricted_tools", ws);
    const req: PolicyRequest = { kind: "command", executable: "npm", args: [] };
    const target = commandKey("npm", []);
    const cases = [
      grant({ scope: "command", target, expiresAt: "2026-11-04T00:00:00Z" }),
      grant({ scope: "command", target, expiresAt: "not a date" }),
      grant({ scope: "command", target, revokedAt: "2026-11-04T00:00:00Z" }),
      grant({ scope: "command", target: null }),
      grant({ scope: "task", target: "" }),
    ];
    for (const g of cases) expect((await ev(p, req, [g], { taskId: "" })).effect).toBe("ask");
    expect(
      (await ev(p, req, [grant({ scope: "command", target, expiresAt: "2026-11-06T00:00:00Z" })]))
        .effect,
    ).toBe("allow");
  });

  it("grantTargetFor derives targets and refuses unsafe ones (caller must then refuse the scope)", async () => {
    const { ws, outside } = tree();
    const p = policyFor("privileged", ws);
    const fsAsk = (await evaluate(p, {
      kind: "fs.write",
      path: path.join(outside, "x"),
    })) as Extract<Decision, { effect: "ask" }>;
    const cmdAsk = (await evaluate(p, {
      kind: "command",
      executable: "npm",
      args: ["test"],
    })) as Extract<Decision, { effect: "ask" }>;
    const netAsk = (await evaluate(p, {
      kind: "network",
      host: "example.com",
      port: 443,
    })) as Extract<Decision, { effect: "ask" }>;
    expect(grantTargetFor("path", fsAsk, {})).toBe(path.join(outside, "x"));
    expect(grantTargetFor("command", cmdAsk, {})).toBe(commandKey("npm", ["test"]));
    expect(netAsk.target).toBe("example.com:443");
    expect(grantTargetFor("task", cmdAsk, { taskId: "t1" })).toBe("t1");
    expect(grantTargetFor("project", netAsk, { projectId: "p1" })).toBe("p1");
    expect(grantTargetFor("task", cmdAsk, {})).toBeNull();
    expect(grantTargetFor("task", fsAsk, { taskId: "t1" })).toBeNull();
    expect(grantTargetFor("path", cmdAsk, {})).toBeNull();
    expect(grantTargetFor("command", fsAsk, {})).toBeNull();
    const rootAsk = { ...fsAsk, target: path.parse(outside).root };
    expect(grantTargetFor("path", rootAsk, {})).toBeNull();
    expect(applyGrants(cmdAsk, {})).toBe(cmdAsk);
  });
});
