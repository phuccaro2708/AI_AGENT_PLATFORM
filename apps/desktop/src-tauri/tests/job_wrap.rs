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
    let (mut wrapper, cmd_pid, ping_pid) = start_tree(&["--timeout-secs", "3"]);
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
