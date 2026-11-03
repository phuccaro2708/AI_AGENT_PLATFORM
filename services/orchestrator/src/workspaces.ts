import { join } from "node:path";
import { GitWorktrees } from "@agent-studio/git-worktrees";
import type { Repo } from "@agent-studio/storage";
import type { ArtifactDiffSource } from "./artifacts.js";
import type { Workspaces } from "./workflow-engine.js";

/**
 * Real worktrees for the engine: the repository is the workflow's project root, and every worktree lives
 * under one short `baseDir` (long Windows paths, docs/ASSUMPTIONS.md). Status and diff only need a worktree
 * path, so they build a throwaway `GitWorktrees` rooted there.
 */
export class ProjectWorkspaces implements Workspaces, ArtifactDiffSource {
  constructor(
    private readonly repo: Repo,
    private readonly baseDir: string,
  ) {}

  async create(workflowId: string, taskId: string) {
    const root = this.repo.getWorkflowRoot(workflowId);
    if (!root) throw new Error(`Unknown workflow: ${workflowId}`);
    const git = new GitWorktrees({ repoRoot: root.rootPath, baseDir: this.baseDir });
    const info = await git.create({ workflowId, taskId });
    return { path: info.path, branch: info.branch, baseRef: info.baseRef };
  }

  private at(path: string): GitWorktrees {
    return new GitWorktrees({ repoRoot: path, baseDir: join(path, "..") });
  }

  status(path: string) {
    return this.at(path).status(path);
  }

  diff(path: string, opts: { maxBytes?: number } = {}) {
    return this.at(path).diff(path, opts);
  }
}
