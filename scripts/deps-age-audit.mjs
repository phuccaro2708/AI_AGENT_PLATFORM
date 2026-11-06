// Release-age audit for every locked package (npm: pnpm-lock.yaml, Rust: Cargo.lock), direct + transitive.
// Read-only: only GETs public registry metadata (registry.npmjs.org, crates.io API). Sends no project data
// (only public package names/versions in the URL), installs nothing, runs no package scripts.
// Usage: node scripts/deps-age-audit.mjs [--npm] [--cargo] [--days 14] [--now ISO] [--json out.json]
//   --npm / --cargo   limit to one ecosystem (default: both)
//   --days N          minimum age threshold (default 14)
//   --now ISO         reference time (default: current time)
//   --json FILE       also write the full result as JSON
// Exit code: 0 = every package resolved and >= threshold; 1 = some package younger than threshold;
//            2 = some package could not be looked up (and none younger).
// Rate limit: npm 4 in flight; crates.io 1 request/second (their crawler policy) with a User-Agent.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : d;
};
const DAYS = Number(opt("days", "14"));
const NOW = opt("now") ? Date.parse(opt("now")) : Date.now();
const wantNpm = flag("npm") || !flag("cargo");
const wantCargo = flag("cargo") || !flag("npm");
const UA = "agent-workspace-deps-audit (read-only release-age check)";
const DAY = 86_400_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url, headers = {}) {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await globalThis.fetch(url, { headers: { "user-agent": UA, ...headers } });
      if (res.status === 404) return { missing: true };
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { json: await res.json() };
    } catch (e) {
      lastErr = String(e?.message ?? e);
      await sleep(2000 * (attempt + 1));
    }
  }
  return { error: lastErr };
}

// ---------- pnpm-lock.yaml (line-based parse; no YAML dependency) ----------
function parsePnpmLock(text) {
  const lines = text.split(/\r?\n/);
  const unq = (s) => s.replace(/^'|'$/g, "");
  const packages = new Set(); // "name@version"
  const edges = new Map(); // snapshotKey -> [childKey]
  const direct = []; // [childKey] from importers
  let section = "";
  let curKey = null;
  let impDep = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      curKey = null;
      continue;
    }
    if (section === "packages") {
      const m = /^ {2}(\S.*):$/.exec(line);
      if (m) packages.add(unq(m[1]));
    } else if (section === "snapshots") {
      const m = /^ {2}(\S.*):$/.exec(line);
      if (m) {
        curKey = unq(m[1]);
        edges.set(curKey, []);
        continue;
      }
      const d = /^ {6}(\S.*?): (\S.*)$/.exec(line);
      if (d && curKey) edges.get(curKey).push(`${unq(d[1])}@${unq(d[2])}`);
    } else if (section === "importers") {
      const n = /^ {6}(\S.*):$/.exec(line);
      if (n) impDep = unq(n[1]);
      const v = /^ {8}version: (\S.*)$/.exec(line);
      if (v && impDep) direct.push(`${impDep}@${unq(v[1])}`);
    }
  }
  return { packages: [...packages], edges, direct };
}
const stripPeer = (k) => k.replace(/\(.*$/, "");
function splitNpm(key) {
  const i = key.lastIndexOf("@");
  return { name: key.slice(0, i), version: key.slice(i + 1) };
}

// Shortest dependency path from any importer's direct dep to a "name@version".
function npmPathTo(lock, target) {
  const parent = new Map();
  const queue = [];
  for (const d of lock.direct) {
    if (!parent.has(d)) {
      parent.set(d, null);
      queue.push(d);
    }
  }
  while (queue.length) {
    const cur = queue.shift();
    if (stripPeer(cur) === target) {
      const path = [];
      for (let k = cur; k; k = parent.get(k)) path.unshift(stripPeer(k));
      return path;
    }
    for (const c of lock.edges.get(cur) ?? []) {
      if (!parent.has(c)) {
        parent.set(c, cur);
        queue.push(c);
      }
    }
  }
  return null;
}

async function auditNpm() {
  const lock = parsePnpmLock(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const directSet = new Set(lock.direct.map(stripPeer));
  const byName = new Map();
  for (const key of lock.packages) {
    const { name, version } = splitNpm(key);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(version);
  }
  const names = [...byName.keys()].sort();
  const times = new Map();
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const name = names[next++];
      const url = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
      const r = await getJson(url);
      times.set(
        name,
        r.json?.time ?? { __err: r.missing ? "not found" : (r.error ?? "no time field") },
      );
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  const rows = [];
  for (const key of lock.packages) {
    const { name, version } = splitNpm(key);
    const t = times.get(name);
    const iso = t?.[version];
    rows.push({
      eco: "npm",
      id: key,
      direct: directSet.has(key),
      published: iso ?? null,
      ageDays: iso ? (NOW - Date.parse(iso)) / DAY : null,
      error: iso ? null : (t?.__err ?? "version not in registry time map"),
      path: null,
    });
  }
  for (const r of rows) if (r.ageDays !== null && r.ageDays < DAYS) r.path = npmPathTo(lock, r.id);
  return rows;
}

// ---------- Cargo.lock ----------
function parseCargoLock(text) {
  const pkgs = [];
  let cur = null;
  let inDeps = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "[[package]]") {
      cur = { name: "", version: "", source: "", deps: [] };
      pkgs.push(cur);
      inDeps = false;
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = /^name = "(.*)"$/.exec(line))) cur.name = m[1];
    else if ((m = /^version = "(.*)"$/.exec(line))) cur.version = m[1];
    else if ((m = /^source = "(.*)"$/.exec(line))) cur.source = m[1];
    else if (line === "dependencies = [") inDeps = true;
    else if (inDeps && line === "]") inDeps = false;
    else if (inDeps && (m = /^ "(.*)",?$/.exec(line))) cur.deps.push(m[1]); // "name" or "name version"
  }
  return pkgs;
}

async function auditCargo() {
  const lockPath = resolve(root, "apps/desktop/src-tauri/Cargo.lock");
  const pkgs = parseCargoLock(readFileSync(lockPath, "utf8"));
  const registry = pkgs.filter((p) => p.source.startsWith("registry+"));
  const byName = new Map();
  for (const p of pkgs) {
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const resolveDep = (d) => {
    const [n, v] = d.split(" ");
    const c = byName.get(n) ?? [];
    return v ? c.find((p) => p.version === v) : c[0];
  };
  const workspace = pkgs.filter((p) => !p.source);
  const directSet = new Set();
  for (const w of workspace) for (const d of w.deps) directSet.add(resolveDep(d));
  const idOf = (p) => `${p.name}@${p.version}`;
  const rows = [];
  for (const p of registry) {
    const r = await getJson(
      `https://crates.io/api/v1/crates/${encodeURIComponent(p.name)}/${encodeURIComponent(p.version)}`,
    );
    const iso = r.json?.version?.created_at ?? null;
    rows.push({
      eco: "cargo",
      id: idOf(p),
      direct: directSet.has(p),
      published: iso,
      ageDays: iso ? (NOW - Date.parse(iso)) / DAY : null,
      error: iso ? null : r.missing ? "not found on crates.io" : (r.error ?? "no created_at"),
      path: null,
      _pkg: p,
    });
    await sleep(1000);
  }
  // dependency path for young crates: BFS from workspace crates
  for (const row of rows) {
    if (row.ageDays === null || row.ageDays >= DAYS) continue;
    const parent = new Map();
    const q = [];
    for (const w of workspace) {
      parent.set(w, null);
      q.push(w);
    }
    let found = null;
    while (q.length && !found) {
      const cur = q.shift();
      for (const d of cur.deps) {
        const c = resolveDep(d);
        if (!c || parent.has(c)) continue;
        parent.set(c, cur);
        if (c === row._pkg) {
          found = c;
          break;
        }
        q.push(c);
      }
    }
    if (found) {
      const path = [];
      for (let k = found; k; k = parent.get(k)) path.unshift(idOf(k));
      row.path = path;
    }
  }
  for (const r of rows) delete r._pkg;
  return rows;
}

// ---------- report ----------
const rows = [];
if (wantNpm) rows.push(...(await auditNpm()));
if (wantCargo) rows.push(...(await auditCargo()));

const summarize = (eco) => {
  const rs = rows.filter((r) => r.eco === eco);
  const ok = rs.filter((r) => r.ageDays !== null);
  const young = ok.filter((r) => r.ageDays < DAYS);
  const unresolved = rs.filter((r) => r.ageDays === null);
  const youngest = [...ok].sort((a, b) => a.ageDays - b.ageDays)[0];
  return {
    eco,
    total: rs.length,
    direct: rs.filter((r) => r.direct).length,
    resolved: ok.length,
    young,
    unresolved,
    youngest,
  };
};
console.log(`Reference time: ${new Date(NOW).toISOString()}  threshold: ${DAYS} days`);
let exit = 0;
for (const eco of ["npm", "cargo"]) {
  if (!rows.some((r) => r.eco === eco)) continue;
  const s = summarize(eco);
  console.log(`\n== ${eco} ==`);
  console.log(
    `packages: ${s.total} (direct/workspace-edge: ${s.direct}); resolved: ${s.resolved}; unresolved: ${s.unresolved.length}; younger than ${DAYS}d: ${s.young.length}`,
  );
  if (s.youngest)
    console.log(
      `youngest: ${s.youngest.id} published ${s.youngest.published} (${s.youngest.ageDays.toFixed(1)} days)`,
    );
  for (const r of s.young)
    console.log(
      `  YOUNG ${r.id} ${r.published} (${r.ageDays.toFixed(1)}d) via ${r.path ? r.path.join(" > ") : "path not found"}`,
    );
  for (const r of s.unresolved) console.log(`  UNRESOLVED ${r.id}: ${r.error}`);
  if (s.young.length) exit = 1;
  else if (s.unresolved.length && exit === 0) exit = 2;
}
if (opt("json"))
  writeFileSync(
    resolve(opt("json")),
    JSON.stringify({ now: new Date(NOW).toISOString(), days: DAYS, rows }, null, 2),
  );
process.exitCode = exit;
