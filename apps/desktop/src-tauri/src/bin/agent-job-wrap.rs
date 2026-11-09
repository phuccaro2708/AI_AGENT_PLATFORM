//! `agent-job-wrap`: runs ONE agent CLI inside its own Windows Job Object (P4-4 (b)).
//!
//! ```text
//! agent-job-wrap [--mem-limit-mb N] [--job-mem-limit-mb N] [--timeout-secs N] -- <program> [args...]
//! ```
//!
//! * The program and its arguments are an argv array passed to `CreateProcess`; no shell is
//!   involved, so nothing in the arguments is interpreted.
//! * The job has `KILL_ON_JOB_CLOSE`: when the wrapper exits, is killed, or hits the timeout, the
//!   whole tree the CLI started dies with it.
//! * `--mem-limit-mb` caps the memory EACH process in the job may commit (not the tree total); past it that process's allocations fail.
//! * `--job-mem-limit-mb` caps the SUM of committed memory of the whole tree (`JOB_OBJECT_LIMIT_JOB_MEMORY`): past it the allocation that would exceed the total fails (Windows does not kill the process).
//! * stdin/stdout/stderr are inherited, so the caller talks to the CLI directly.
//!
//! **This is NOT a security sandbox.** It manages lifetime and memory only; the CLI keeps all of
//! the user's file, network and registry access (ADR-002).
//!
//! Exit codes: the CLI's own code, unchanged (full 32 bits on Windows); 124 on timeout (tree killed); 125 for a wrapper error
//! (bad arguments, job or spawn failure).

use agent_studio_lib::job::JobObject;
use std::process::Command;
use std::time::{Duration, Instant};

struct Opts {
    mem_limit_mb: Option<u64>,
    job_mem_limit_mb: Option<u64>,
    timeout: Option<Duration>,
    program: String,
    args: Vec<String>,
}

fn parse(argv: &[String]) -> Result<Opts, String> {
    let mut mem_limit_mb = None;
    let mut job_mem_limit_mb = None;
    let mut timeout = None;
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            flag @ ("--mem-limit-mb" | "--job-mem-limit-mb" | "--timeout-secs") => {
                let n = argv
                    .get(i + 1)
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|n| *n > 0)
                    .ok_or_else(|| format!("{flag} needs a positive integer"))?;
                if flag == "--mem-limit-mb" {
                    mem_limit_mb = Some(n);
                } else if flag == "--job-mem-limit-mb" {
                    job_mem_limit_mb = Some(n);
                } else {
                    timeout = Some(Duration::from_secs(n));
                }
                i += 2;
            }
            other => return Err(format!("unknown option before `--`: {other}")),
        }
    }
    let program = argv.get(i).ok_or("missing program after `--`")?.clone();
    Ok(Opts {
        mem_limit_mb,
        job_mem_limit_mb,
        timeout,
        program,
        args: argv[i + 1..].to_vec(),
    })
}

fn run(opts: Opts) -> Result<i32, String> {
    let limit = opts.mem_limit_mb.map(|mb| mb.saturating_mul(1024 * 1024));
    let job_limit = opts
        .job_mem_limit_mb
        .map(|mb| mb.saturating_mul(1024 * 1024));
    let job = JobObject::with_limits(limit, job_limit).map_err(|e| format!("job object: {e}"))?;
    let mut cmd = Command::new(&opts.program);
    cmd.args(&opts.args);
    let mut child = job
        .spawn(&mut cmd, 0)
        .map_err(|e| format!("cannot start {}: {e}", opts.program))?;
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            // Normal end: dropping `job` below still reaps any stragglers the CLI left behind.
            // `ExitCode::from` only takes a u8 (256 would become 0 = success); `process::exit(i32)` hands
            // Windows the full 32-bit code (e.g. 0xC0000005 for a crash).
            return Ok(status.code().unwrap_or(1));
        }
        if opts.timeout.is_some_and(|t| started.elapsed() >= t) {
            eprintln!("agent-job-wrap: timeout, killing the process tree");
            drop(job); // closes the last handle: Windows kills the whole tree
            let _ = child.wait();
            return Ok(124);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // Everything with a destructor (the job handle) lives inside `run`, so it is already dropped
    // when `exit` skips the rest of `main`'s cleanup.
    let code = match parse(&argv).and_then(run) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("agent-job-wrap: {e}");
            125
        }
    };
    #[cfg(not(windows))]
    let code = if code & 0xff == 0 && code != 0 {
        1
    } else {
        code
    }; // the OS keeps 8 bits: never let a failure look like success
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_options_and_keeps_argv_verbatim() {
        let o = parse(&v(&[
            "--mem-limit-mb",
            "64",
            "--job-mem-limit-mb",
            "128",
            "--timeout-secs",
            "5",
            "--",
            "tool",
            "--timeout-secs",
            "a b; rm -rf",
        ]))
        .unwrap();
        assert_eq!(o.mem_limit_mb, Some(64));
        assert_eq!(o.job_mem_limit_mb, Some(128));
        assert_eq!(o.timeout, Some(Duration::from_secs(5)));
        assert_eq!(o.program, "tool");
        assert_eq!(o.args, v(&["--timeout-secs", "a b; rm -rf"]));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(parse(&v(&[])).is_err());
        assert!(parse(&v(&["--"])).is_err());
        assert!(parse(&v(&["tool"])).is_err());
        assert!(parse(&v(&["--mem-limit-mb", "0", "--", "x"])).is_err());
        assert!(parse(&v(&["--mem-limit-mb", "--", "x"])).is_err());
    }
}
