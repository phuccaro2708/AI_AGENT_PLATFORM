//! Real-Windows checks for the `agent-job-wrap` binary: killing or timing out the wrapper must take
//! the whole tree down, and `--mem-limit-mb` must change what the CLI can allocate.
//! A Job Object is not a sandbox; these tests only cover lifetime and memory.
#![cfg(windows)]

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const WRAP: &str = env!("CARGO_BIN_EXE_agent-job-wrap");

fn powershell(script: &str) -> String {
    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .expect("powershell");
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn pid_alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

fn wait_for(mut cond: impl FnMut() -> bool, secs: u64) -> bool {
    let end = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < end {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    cond()
}

fn child_of(parent: u32) -> Option<u32> {
    powershell(&format!(
        "(Get-CimInstance Win32_Process -Filter 'ParentProcessId={parent}' | Select-Object -First 1).ProcessId"
    ))
    .parse()
    .ok()
}

/// wrapper -> cmd.exe -> ping.exe; returns (wrapper, cmd pid, ping pid).
fn start_tree(extra: &[&str]) -> (Child, u32, u32) {
    let mut args: Vec<&str> = extra.to_vec();
    args.extend(["--", "cmd.exe", "/C", "ping", "-n", "120", "127.0.0.1"]);
    let wrapper = Command::new(WRAP)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn wrapper");
    let mut cmd_pid = None;
    assert!(wait_for(
        || {
            cmd_pid = child_of(wrapper.id());
            cmd_pid.is_some()
        },
        60
    ));
    let cmd_pid = cmd_pid.unwrap();
    let mut ping_pid = None;
    assert!(wait_for(
        || {
            ping_pid = child_of(cmd_pid);
            ping_pid.is_some()
        },
        60
    ));
    (wrapper, cmd_pid, ping_pid.unwrap())
}

#[test]
fn killing_the_wrapper_kills_the_whole_tree() {
    let (mut wrapper, cmd_pid, ping_pid) = start_tree(&[]);
    assert!(pid_alive(cmd_pid) && pid_alive(ping_pid));
    wrapper.kill().expect("kill wrapper"); // TerminateProcess: no cleanup code runs in the wrapper
    let _ = wrapper.wait();
    assert!(wait_for(|| !pid_alive(cmd_pid), 30), "cmd.exe survived");
    assert!(wait_for(|| !pid_alive(ping_pid), 30), "ping.exe survived");
}

#[test]
fn timeout_kills_the_tree_and_exits_124() {
    // The timeout counts from the wrapper's start, and `start_tree` must find cmd and ping first:
    // each lookup is a PowerShell/CIM query of about one second on an idle machine. With 3 s the
    // tree was sometimes killed before ping was found (seen 2026-11-11 under parallel load), so
    // leave enough room for the lookups and check it was not used up.
    const TIMEOUT_SECS: u64 = 20;
    let started = Instant::now();
    let (mut wrapper, cmd_pid, ping_pid) =
        start_tree(&["--timeout-secs", &TIMEOUT_SECS.to_string()]);
    assert!(
        started.elapsed() < Duration::from_secs(TIMEOUT_SECS),
        "finding the tree took longer than the timeout; the test proves nothing"
    );
    let status = loop {
        if let Some(s) = wrapper.try_wait().unwrap() {
            break s;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(status.code(), Some(124));
    assert!(wait_for(|| !pid_alive(cmd_pid), 30), "cmd.exe survived");
    assert!(wait_for(|| !pid_alive(ping_pid), 30), "ping.exe survived");
}

#[test]
fn exit_code_and_argv_pass_through_without_a_shell() {
    // `&` and `;` must reach the program as plain text; a shell would run them.
    let out = Command::new(WRAP)
        .args(["--", "cmd.exe", "/C", "exit", "7"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(7));
    let script =
        std::env::temp_dir().join(format!("agent-job-wrap-echo-{}.ps1", std::process::id()));
    std::fs::write(&script, "[Console]::Out.Write($args[0])").unwrap();
    let out = Command::new(WRAP)
        .args([
            "--",
            "powershell",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script)
        .arg("a & b; c")
        .output()
        .unwrap();
    let _ = std::fs::remove_file(&script);
    assert_eq!(String::from_utf8_lossy(&out.stdout), "a & b; c");
}

/// 256 would become 0 (success) if cut to 8 bits; 0xC0000005 (access violation) is a real
/// 32-bit Windows exit code, seen by Rust as a negative i32.
#[test]
fn exit_codes_are_not_truncated_to_eight_bits() {
    for (arg, want) in [("256", 256), ("3221225477", 0xC000_0005_u32 as i32)] {
        let out = Command::new(WRAP)
            .args(["--", "cmd.exe", "/C", "exit", arg])
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(want), "cmd exit {arg}");
    }
}

#[test]
fn a_missing_program_is_a_wrapper_error() {
    let out = Command::new(WRAP)
        .args(["--", "definitely-not-a-real-program-xyz"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(125));
}

/// Helper "test": does nothing normally; when AGENT_STUDIO_ALLOC_MB is set (by the real test, in a
/// process started through the wrapper) it commits and touches that much memory.
#[test]
fn alloc_helper() {
    let Some(mb) = std::env::var("AGENT_STUDIO_ALLOC_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return;
    };
    let mut v: Vec<u8> = Vec::new();
    if v.try_reserve_exact(mb * 1024 * 1024).is_err() {
        println!("ALLOC_FAIL");
        return;
    }
    v.resize(mb * 1024 * 1024, 1);
    println!("ALLOC_OK {}", v[v.len() - 1]);
}

fn run_alloc(extra: &[&str], mb: u32) -> String {
    let exe = std::env::current_exe().unwrap();
    let mut args: Vec<&str> = extra.to_vec();
    args.extend([
        "--",
        exe.to_str().unwrap(),
        "--exact",
        "alloc_helper",
        "--nocapture",
    ]);
    let out = Command::new(WRAP)
        .args(&args)
        .env("AGENT_STUDIO_ALLOC_MB", mb.to_string())
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn the_memory_limit_changes_what_the_cli_can_allocate() {
    assert!(
        run_alloc(&[], 600).contains("ALLOC_OK"),
        "control run failed"
    );
    assert!(run_alloc(&["--mem-limit-mb", "1000"], 600).contains("ALLOC_OK"));
    assert!(
        !run_alloc(&["--mem-limit-mb", "300"], 600).contains("ALLOC_OK"),
        "allocation survived the limit"
    );
}

/// Helper "test" for the tree measurement (R4): commits and holds `AGENT_STUDIO_TREE_MB`, then
/// starts a child (the alloc helper) that tries to commit the same amount, and reports its verdict.
#[test]
fn tree_helper() {
    let Some(mb) = std::env::var("AGENT_STUDIO_TREE_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
    else {
        return;
    };
    let mut held: Vec<u8> = Vec::new();
    if held.try_reserve_exact(mb * 1024 * 1024).is_err() {
        println!("PARENT_FAIL");
        return;
    }
    held.resize(mb * 1024 * 1024, 1);
    let out = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "alloc_helper", "--nocapture"])
        .env_remove("AGENT_STUDIO_TREE_MB")
        .env("AGENT_STUDIO_ALLOC_MB", mb.to_string())
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    let verdict = if text.contains("ALLOC_OK") {
        "CHILD_OK"
    } else {
        "CHILD_FAIL"
    };
    println!("PARENT_OK {verdict} {}", held[held.len() - 1]);
}

fn run_tree(extra: &[&str], mb: u32) -> String {
    let exe = std::env::current_exe().unwrap();
    let mut args: Vec<&str> = extra.to_vec();
    args.extend([
        "--",
        exe.to_str().unwrap(),
        "--exact",
        "tree_helper",
        "--nocapture",
    ]);
    let out = Command::new(WRAP)
        .args(&args)
        .env("AGENT_STUDIO_TREE_MB", mb.to_string())
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).to_string()
}

/// R4: parent and child each commit 250 MB (500 MB total). A per-process cap of 300 MB lets both
/// through (it cannot see the tree); a job-wide cap of 300 MB refuses the second one.
#[test]
fn the_job_wide_limit_caps_the_whole_process_tree() {
    let free = run_tree(&[], 250);
    assert!(free.contains("PARENT_OK CHILD_OK"), "control run: {free}");
    let per_process = run_tree(&["--mem-limit-mb", "300"], 250);
    assert!(
        per_process.contains("PARENT_OK CHILD_OK"),
        "per-process cap should not see the tree total: {per_process}"
    );
    let roomy = run_tree(&["--job-mem-limit-mb", "1000"], 250);
    assert!(roomy.contains("PARENT_OK CHILD_OK"), "roomy cap: {roomy}");
    let job_wide = run_tree(&["--job-mem-limit-mb", "300"], 250);
    assert!(
        job_wide.contains("PARENT_OK CHILD_FAIL"),
        "child exceeding the tree total must be refused: {job_wide}"
    );
}
