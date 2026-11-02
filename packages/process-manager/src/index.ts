export { runProcess, startProcess } from "./process.js";
export type { RunOptions, RunOutcome, RunResult, RunningProcess } from "./process.js";
export {
  ExecutableNotFoundError,
  UnsupportedShimError,
  resolveExecutable,
  unwrapNpmShim,
} from "./resolve.js";
export type { ExecutableKind, ResolveOptions, ResolvedExecutable } from "./resolve.js";
export { killTree } from "./kill-tree.js";
export { createLineSplitter } from "./lines.js";
