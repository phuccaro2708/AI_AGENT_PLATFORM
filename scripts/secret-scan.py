#!/usr/bin/env python3
"""Secret scan with detect-secrets: current tree + every commit snapshot in history.

Fails (exit 1) on any finding. Lockfile integrity hashes are excluded (known false positives).
Intentional test fixtures carry an inline `pragma: allowlist secret`.
Requires: pip install detect-secrets==1.5.0
"""
import json, subprocess, sys, tempfile, shutil, os

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
}

EXCLUDE = r"(pnpm-lock\.yaml|Cargo\.lock|\.png|\.ico|\.icns)$"


def scan(root, files=None):
    cmd = ["detect-secrets", "scan", "--exclude-files", EXCLUDE]
    cmd += files if files else ["--all-files", root]
    out = subprocess.run(cmd, cwd=root, capture_output=True, text=True, check=True).stdout
    return json.loads(out)["results"]


def main():
    repo = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()
    findings = []

    tracked = subprocess.check_output(["git", "ls-files"], cwd=repo, text=True).split()
    for f, items in scan(repo, tracked).items():
        findings += [("WORKTREE", f, i["type"], i["line_number"]) for i in items]

    shas = subprocess.check_output(["git", "rev-list", "--all"], cwd=repo, text=True).split()
    for sha in shas:
        tmp = tempfile.mkdtemp(prefix="secscan-")
        try:
            tar = subprocess.Popen(["git", "archive", sha], cwd=repo, stdout=subprocess.PIPE)
            subprocess.run(["tar", "-x", "-C", tmp], stdin=tar.stdout, check=True)
            tar.wait()
            for f, items in scan(tmp).items():
                findings += [(sha[:8], f, i["type"], i["line_number"]) for i in items]
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    accepted = [f for f in findings if f in ACCEPTED_HISTORY]
    findings = [f for f in findings if f not in ACCEPTED_HISTORY]
    print(f"scanned worktree + {len(shas)} commits; findings: {len(findings)} (accepted fixture hits: {len(accepted)})")
    for f in findings:
        print("  FINDING", *f)
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main())
