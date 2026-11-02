//! ADR-001 spike: a Node.js sidecar driven over newline-delimited JSON on stdio.
//! The frontend never talks to this directly; it goes through Tauri commands.

use serde_json::{json, Value};
use crate::job::JobObject;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Sidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: i64,
    /// Kept alive for the lifetime of the sidecar; dropping it (or dying) kills the process tree.
    _job: JobObject,
}

impl Sidecar {
    /// Spawns `<dir>/node[.exe] <dir>/sidecar.mjs ...` with an argument array (no shell).
    pub fn spawn(dir: &Path, db: &Path, log: &Path) -> Result<Self, String> {
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        // stderr goes straight to an append-only file: no reader thread, so a full pipe can never
        // stall the sidecar. The file may contain agent output; it is not rotated yet (Phase 4).
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("cannot open sidecar log {}: {e}", log.display()))?;
        let mut cmd = Command::new(&node);
        cmd.arg(dir.join("sidecar.mjs"))
            .arg("--db")
            .arg(db)
            .arg("--sqlite-binding")
            .arg(dir.join("better_sqlite3.node"))
            .arg("--migrations")
            .arg(dir.join("drizzle"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log_file));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn sidecar {}: {e}", node.display()))?;
        // Assign immediately, before any request, so nothing the sidecar starts can escape the job.
        let job = JobObject::new_kill_on_close().map_err(|e| format!("job object: {e}"))?;
        if let Err(e) = job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("failed to assign sidecar to job object: {e}"));
        }
        let stdin = child.stdin.take().ok_or("no sidecar stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no sidecar stdout")?);
        Ok(Self { child, stdin: Some(stdin), stdout, next_id: 0, _job: job })
    }

    pub fn pid(&self) -> u32 {
        self.child.id()
    }

    /// Sends one request and waits for the matching response line.
    pub fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let mut req = json!({ "id": id, "method": method });
        if let Some(p) = params {
            req["params"] = p;
        }
        let stdin = self.stdin.as_mut().ok_or("sidecar stdin closed")?;
        writeln!(stdin, "{req}").map_err(|e| format!("write to sidecar failed: {e}"))?;
        stdin.flush().map_err(|e| format!("flush failed: {e}"))?;
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("read from sidecar failed: {e}"))?;
        if n == 0 {
            return Err("sidecar closed stdout".into());
        }
        let resp: Value = serde_json::from_str(line.trim()).map_err(|e| format!("bad response: {e}"))?;
        if resp["id"] != json!(id) {
            return Err(format!("response id mismatch: {}", resp["id"]));
        }
        if let Some(err) = resp.get("error") {
            return Err(err["message"].as_str().unwrap_or("sidecar error").to_string());
        }
        Ok(resp["result"].clone())
    }

    /// Graceful stop: protocol shutdown, close stdin, wait up to 3s, then kill.
    pub fn shutdown(&mut self) {
        let _ = self.request("shutdown", None);
        self.stdin = None; // closing stdin also makes the sidecar exit
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        if let Ok(None) = self.child.try_wait() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}
