#!/usr/bin/env python3
"""Secret scan with detect-secrets: current tree + every commit snapshot in history.

History is scanned per unique (blob, path) pair instead of per commit snapshot. detect-secrets looks
at one file at a time, so a file's findings depend only on its content and path; a file that is
unchanged across N commits is therefore scanned once and its findings are attributed to all N
commits. On this repo the reported (commit, file, type, line) set matched a per-commit snapshot scan
(173 = 173 historical findings). Every blob is scanned as stored, so coverage is at least as broad.

Fails (exit 1) on any finding. Lockfile integrity hashes are excluded (known false positives).
Intentional test fixtures carry an inline `pragma: allowlist secret`.
Requires: pip install detect-secrets==1.5.0
Debugging aid: set SECRET_SCAN_RAW_OUT=<file> to dump every finding before the allow-lists apply.
"""
import json, os, shutil, subprocess, sys, tempfile

# Reviewed by hand, exact (commit, file, type, line). Immutable history snapshots with (a) the FAKE
# fixture value "SUPERSECRET1" in the logger redaction test (before the inline pragma existed) and
# (b) the detect-secrets package name flagged by its own keyword detector.
ACCEPTED_HISTORY = {
    ("2367e003", "packages/shared-utils/src/shared-utils.test.ts", "Secret Keyword", 52),
    ("16506623", "packages/shared-utils/src/shared-utils.test.ts", "Secret Keyword", 52),
    ("6d4977c2", "packages/shared-utils/src/shared-utils.test.ts", "Secret Keyword", 52),
    ("b56f1630", "packages/shared-utils/src/shared-utils.test.ts", "Secret Keyword", 50),
    ("e4c60bd3", "packages/shared-utils/src/shared-utils.test.ts", "Secret Keyword", 50),
    # False positive: the CI step installs the package literally named "detect-secrets==1.5.0".
    ("d4e1b0bc", ".github/workflows/ci.yml", "Secret Keyword", 60),
    ("21c1ae96", ".github/workflows/ci.yml", "Secret Keyword", 60),
    # Phase 7B history: FAKE test values and a schema comment that said "secrets", before the inline
    # pragmas and the rewording landed. Reviewed by hand.
    ("0b696542", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("0b696542", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("0b696542", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 10),
    ("0b696542", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 11),
    ("cb1ed4d6", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("cb1ed4d6", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("cb1ed4d6", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 10),
    ("cb1ed4d6", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 11),
    ("7b8cb236", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("7b8cb236", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("7b8cb236", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 10),
    ("7b8cb236", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 11),
    ("6461cf2d", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("6461cf2d", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("6461cf2d", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 10),
    ("6461cf2d", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 11),
    ("63d07e7e", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("63d07e7e", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("63d07e7e", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 10),
    ("63d07e7e", "services/orchestrator/src/sidecar-secrets.test.ts", "Secret Keyword", 11),
    ("fce54cb1", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("fce54cb1", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    ("998ba7f8", "packages/storage/src/schema.ts", "Secret Keyword", 206),
    ("998ba7f8", "services/orchestrator/src/sidecar-agent-settings.test.ts", "Secret Keyword", 134),
    # Phase 4 history: FAKE values in diagnostics/manifest/sidecar-diagnostics tests before the inline
    # pragmas landed (commits already pushed, immutable). Reviewed by hand: every value is a test literal.
    ("0de30a84", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("0de30a84", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("0de30a84", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("195ce48c", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("195ce48c", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("195ce48c", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("195ce48c", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Base64 High Entropy String", 11),
    ("195ce48c", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 11),
    ("195ce48c", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 12),
    ("22500eef", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("4368ca09", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("4368ca09", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("4368ca09", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("43717b76", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("43717b76", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("43717b76", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("44978cae", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("44978cae", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("5437a040", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("5437a040", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("5437a040", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("54469575", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("54469575", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("54469575", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("5c7e207a", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("5c7e207a", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("5c7e207a", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("603a962d", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("603a962d", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("603a962d", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("60ceb43a", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("71b83da0", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("71b83da0", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("71b83da0", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("7663341d", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("7e58f896", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("7e58f896", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("7e58f896", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("87d5d855", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("87d5d855", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("87d5d855", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("8b0f2694", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("8b0f2694", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("8b0f2694", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("8cca97bd", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("952f7aa2", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("952f7aa2", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("952f7aa2", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("98539d32", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("98539d32", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("98539d32", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("9e01edcf", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("a002dea2", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("a002dea2", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("a002dea2", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("a2b42c69", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("a2b42c69", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("a2b42c69", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("ab229da8", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("ab229da8", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("ab229da8", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("ab229da8", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Base64 High Entropy String", 11),
    ("ab229da8", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 11),
    ("ab229da8", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 12),
    ("c3c5a090", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("c3c5a090", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("c3c5a090", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("c734788d", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("c734788d", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("c734788d", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("c734788d", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Base64 High Entropy String", 11),
    ("c734788d", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 11),
    ("c734788d", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 12),
    ("c7746117", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("ced11465", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("e478ddc7", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("e8843a78", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("e8843a78", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("e8843a78", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("ee6ed721", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("ee6ed721", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("ee6ed721", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("f829e9d5", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("f829e9d5", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("f829e9d5", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("f829e9d5", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Base64 High Entropy String", 11),
    ("f829e9d5", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 11),
    ("f829e9d5", "services/orchestrator/src/sidecar-diagnostics.test.ts", "Secret Keyword", 12),
    # History brought in by merging p4-tests (2026-11-05): FAKE fixture values ("hunter2-not-known",
    # "not-in-the-known-list", "leak") from before the inline pragmas. Reviewed by hand.
    ("86ee0e9f", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("86ee0e9f", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("86ee0e9f", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    ("596bd258", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 53),
    ("596bd258", "packages/diagnostics/src/diagnostics.test.ts", "Secret Keyword", 114),
    ("596bd258", "packages/process-manager/src/manifest.test.ts", "Secret Keyword", 95),
    # Codex security-reviewer role prompt: line 13 began with the focus-area heading "Secrets:", which
    # the keyword detector flags; no value is present. Reworded afterwards; these five snapshots
    # (already committed, immutable) still carry the old wording. Reviewed by hand.
    ("938a7081", ".codex/agents/security-reviewer.toml", "Secret Keyword", 13),
    ("c99c93e7", ".codex/agents/security-reviewer.toml", "Secret Keyword", 13),
    ("426c200f", ".codex/agents/security-reviewer.toml", "Secret Keyword", 13),
    ("9db9c7c7", ".codex/agents/security-reviewer.toml", "Secret Keyword", 13),
    ("56cbc94e", ".codex/agents/security-reviewer.toml", "Secret Keyword", 13),
    # R3 (2026-11-06): FAKE test literal "sk-ant-test-SECRETSECRET…" in sidecar-confirm.test.ts, committed
    # before the inline pragma was added. Reviewed by hand: not a real key.
    ("9394e634", "services/orchestrator/src/sidecar-confirm.test.ts", "Secret Keyword", 14),
    ("2377ce9d", "services/orchestrator/src/sidecar-confirm.test.ts", "Secret Keyword", 14),
    ("c7c6dfc9", "services/orchestrator/src/sidecar-confirm.test.ts", "Secret Keyword", 14),
}

# Reviewed by hand, valid at any commit: exact (file, type, line). Line 28 of the Phase 0 spike
# report holds a generated task id (ULID) inside a JSON string, flagged only by entropy.
ACCEPTED_ANYWHERE = {
    ("docs/reports/phase0-windows/spike-report.json", "Base64 High Entropy String", 28),
    # Line 42 asserts the namespaced branch name for fake ids (agent-studio/abc12345/def67890).
    ("packages/git-worktrees/src/git-worktrees.test.ts", "Base64 High Entropy String", 42),
    # Reviewed by hand (2026-11-07): docs/SECURITY.md line 37 is prose that mentions a secret keyword, no value;
    # sidecar-permission-gates.test.ts line 170 is the FAKE literal "SECRET-HELPER" used by a test. Both predate
    # the Phase 4 close-prep goal (commits 8cf8206, baf26fc) and recur in every later snapshot.
    ("docs/SECURITY.md", "Secret Keyword", 37),
    ("services/orchestrator/src/sidecar-permission-gates.test.ts", "Secret Keyword", 170),
}

EXCLUDE = r"(pnpm-lock\.yaml|Cargo\.lock|\.png|\.ico|\.icns)$"


def scan(root, files=None):
    cmd = ["detect-secrets", "scan", "--exclude-files", EXCLUDE]
    cmd += files if files else ["--all-files", root]
    out = subprocess.run(cmd, cwd=root, capture_output=True, text=True, check=True).stdout
    return json.loads(out)["results"]


def history_pairs(repo, shas):
    """Map (blob sha, path) -> [commit shas that contain that file at that path]."""
    pairs = {}
    for sha in shas:
        out = subprocess.check_output(["git", "ls-tree", "-r", "-z", sha], cwd=repo)
        for entry in out.split(b"\x00"):
            if not entry:
                continue
            meta, path = entry.split(b"\t", 1)
            _mode, kind, blob = meta.decode().split()
            if kind != "blob":  # skips submodule commits
                continue
            pairs.setdefault((blob, path.decode("utf-8", "surrogateescape")), []).append(sha)
    return pairs


def scan_history(repo, shas):
    """Scan each distinct (blob, path) once; report it against every commit that contains it."""
    pairs = history_pairs(repo, shas)
    keys = list(pairs)
    tmp = tempfile.mkdtemp(prefix="secscan-")
    findings = []
    try:
        cat = subprocess.Popen(
            ["git", "cat-file", "--batch"], cwd=repo, stdin=subprocess.PIPE, stdout=subprocess.PIPE
        )
        for i, (blob, path) in enumerate(keys):
            cat.stdin.write(blob.encode() + b"\n")
            cat.stdin.flush()
            head = cat.stdout.readline().split()
            if len(head) != 3:  # "<blob> missing": shallow/partial clone; fail closed, never skip
                cat.kill()
                raise SystemExit(f"cannot read blob {blob} ({path}): need a full clone (fetch-depth: 0)")
            size = head[2]
            data = cat.stdout.read(int(size))
            cat.stdout.read(1)  # newline after the object body
            dest = os.path.join(tmp, str(i), *path.split("/"))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with open(dest, "wb") as fh:
                fh.write(data)
        cat.stdin.close()
        cat.wait()
        for key, items in scan(tmp).items():
            # detect-secrets reports keys relative to cwd ("./<i>/..." or "<i>/..."); tolerate absolute too.
            rel = os.path.relpath(key, tmp) if os.path.isabs(key) else os.path.normpath(key)
            rel = rel.replace(os.sep, "/")
            idx = int(rel.split("/", 1)[0])
            blob, real_path = keys[idx]
            for sha in pairs[(blob, real_path)]:
                findings += [(sha[:8], real_path, i["type"], i["line_number"]) for i in items]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return findings


def main():
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
    findings = []

    tracked = subprocess.check_output(["git", "ls-files"], cwd=repo, text=True).split()
    for f, items in scan(repo, tracked).items():
        findings += [("WORKTREE", f, i["type"], i["line_number"]) for i in items]

    shas = subprocess.check_output(["git", "rev-list", "--all"], cwd=repo, text=True).split()
    findings += scan_history(repo, shas)

    if os.environ.get("SECRET_SCAN_RAW_OUT"):
        with open(os.environ["SECRET_SCAN_RAW_OUT"], "w") as fh:
            json.dump(sorted(map(list, findings)), fh)

    def is_accepted(f):
        norm = (f[0], f[1].replace("\\", "/")) + tuple(f[2:])  # Windows worktree paths use backslashes
        return norm in ACCEPTED_HISTORY or norm[1:] in ACCEPTED_ANYWHERE

    accepted = [f for f in findings if is_accepted(f)]
    findings = [f for f in findings if not is_accepted(f)]
    print(f"scanned worktree + {len(shas)} commits; findings: {len(findings)} (accepted fixture hits: {len(accepted)})")
    for f in findings:
        print("  FINDING", *f)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
