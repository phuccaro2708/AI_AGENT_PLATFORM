import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Fresh temp tree: <base>/ws (workspace), <base>/outside (sibling folder). Paths are realpath'd. */
export function makeTree(): { base: string; ws: string; outside: string; cleanup: () => void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-engine-")));
  const ws = path.join(base, "ws");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, "src", "a.txt"), "a");
  fs.writeFileSync(path.join(outside, "secret.txt"), "s");
  return { base, ws, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

/** Whether this machine can create symlinks (Windows needs a privilege). Tests that need them are skipped otherwise. */
export function canSymlink(): boolean {
  const t = makeTree();
  try {
    fs.symlinkSync(t.outside, path.join(t.ws, "probe-link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    t.cleanup();
  }
}
