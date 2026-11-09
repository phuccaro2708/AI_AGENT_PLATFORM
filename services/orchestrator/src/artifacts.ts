import type { Repo } from "@agent-studio/storage";
import { digestInsideWorktree } from "./worktree-hash.js";

export interface ArtifactCheck {
  path: string;
  expectedSha256: string;
  /** Absent when the file is gone or unreadable. */
  actualSha256?: string;
  status: "ok" | "changed" | "missing";
}

export interface ArtifactDiffSource {
  diff(path: string, opts?: { maxBytes?: number }): Promise<{ patch: string; truncated: boolean }>;
}

/**
 * Read side of the artifact registry. Artifacts are registered with their sha256 when a task ends; this
 * re-hashes them in the task's worktree to show whether what was reviewed is still what is on disk, and
 * exposes the worktree diff. Paths are resolved inside the worktree only.
 */
export class ArtifactRegistry {
  constructor(
    private readonly repo: Repo,
    private readonly diffSource: ArtifactDiffSource,
  ) {}

  private worktreePath(taskId: string): string {
    const wt = this.repo.getWorktreeForTask(taskId);
    if (!wt) throw new Error(`Task ${taskId} has no worktree`);
    return wt.path;
  }

  verify(taskId: string): ArtifactCheck[] {
    const root = this.worktreePath(taskId);
    return this.repo.listArtifacts(taskId).map((a) => {
      const base = { path: a.path, expectedSha256: a.sha256 };
      if (isOutside(a.path)) return { ...base, status: "missing" as const };
      // A link that leaves the worktree is reported missing and never read (fail-closed).
      const d = digestInsideWorktree(root, a.path);
      if (d.kind !== "ok") return { ...base, status: "missing" as const };
      return d.sha256 === a.sha256
        ? { ...base, actualSha256: d.sha256, status: "ok" as const }
        : { ...base, actualSha256: d.sha256, status: "changed" as const };
    });
  }

  diff(taskId: string, opts: { maxBytes?: number } = {}) {
    return this.diffSource.diff(this.worktreePath(taskId), opts);
  }
}

/** A stored path must stay inside the worktree; anything else is treated as missing, never read. */
function isOutside(p: string): boolean {
  return /^([a-zA-Z]:|[\\/])/.test(p) || p.split(/[\\/]/).includes("..");
}
