//! Node.js sidecar driven over newline-delimited JSON on stdio (ADR-001).
//! The frontend never talks to this directly; it goes through Tauri commands.
//!
//! A reader thread owns stdout: response lines (`id`) wake the waiting request, pushed lines
//! (`event`) go to `on_event`. Requests therefore run concurrently and may finish out of order.

use crate::job::JobObject;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

type Reply = Result<Value, String>;
type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Reply>>>>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Routes one stdout line. Unparseable lines and replies nobody waits for are dropped.
fn dispatch(line: &str, pending: &Pending, on_event: &dyn Fn(Value)) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if v.get("event").is_some() {
        on_event(v);
        return;
    }
    let Some(id) = v["id"].as_i64() else { return };
    let tx = lock(pending).remove(&id);
    if let Some(tx) = tx {
        let reply = match v.get("error") {
            Some(e) => Err(e["message"].as_str().unwrap_or("sidecar error").to_string()),
            None => Ok(v["result"].clone()),
        };
        let _ = tx.send(reply);
    }
}

pub struct Sidecar {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    pending: Pending,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    pid: u32,
    /// Kept alive for the lifetime of the sidecar; dropping it (or dying) kills the process tree.
    _job: JobObject,
}

impl Sidecar {
    /// Spawns `<dir>/node[.exe] <dir>/sidecar.mjs ...` with an argument array (no shell).
    pub fn spawn(
        dir: &Path,
        db: &Path,
        log: &Path,
        secrets: Vec<(String, String)>,
        on_event: impl Fn(Value) + Send + 'static,
    ) -> Result<Self, String> {
        let node = dir.join(if cfg!(windows) { "node.exe" } else { "node" });
        let mut cmd = Command::new(&node);
        cmd.arg(dir.join("sidecar.mjs"))
            .arg("--db")
            .arg(db)
            .arg("--sqlite-binding")
            .arg(dir.join("better_sqlite3.node"))
            .arg("--migrations")
            .arg(dir.join("drizzle"));
        // Secrets travel in the child's environment only; the sidecar removes them from it on start.
        cmd.envs(secrets);
        Self::spawn_command(cmd, log, on_event)
    }

    /// Starts `cmd` with piped stdin/stdout and stderr appended to `log` (no reader thread, so a
    /// full pipe can never stall the sidecar; the file may hold agent output and is not rotated
    /// yet — Phase 4).
    pub fn spawn_command(
        mut cmd: Command,
        log: &Path,
        on_event: impl Fn(Value) + Send + 'static,
    ) -> Result<Self, String> {
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log)
            .map_err(|e| format!("cannot open sidecar log {}: {e}", log.display()))?;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log_file));
        // Created suspended, put in the job, then resumed: nothing the sidecar starts can escape it.
        let job = JobObject::new_kill_on_close().map_err(|e| format!("job object: {e}"))?;
        let mut child = job
            .spawn(&mut cmd, 0x0800_0000) // CREATE_NO_WINDOW
            .map_err(|e| format!("failed to spawn sidecar in job object: {e}"))?;
        let stdin = child.stdin.take().ok_or("no sidecar stdin")?;
        let stdout = child.stdout.take().ok_or("no sidecar stdout")?;
        let pid = child.id();

        let pending: Pending = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        {
            let (pending, alive) = (pending.clone(), alive.clone());
            std::thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    dispatch(&line, &pending, &on_event);
                }
                alive.store(false, Ordering::SeqCst);
                for (_, tx) in lock(&pending).drain() {
                    let _ = tx.send(Err("sidecar exited".into()));
                }
            });
        }
        Ok(Self {
            child: Mutex::new(child),
            stdin: Mutex::new(Some(stdin)),
            pending,
            next_id: AtomicI64::new(0),
            alive,
            pid,
            _job: job,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Sends one request and waits for its reply (or `timeout`).
    pub fn request(&self, method: &str, params: Option<Value>, timeout: Duration) -> Reply {
        if !self.is_alive() {
            return Err("sidecar is not running".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut req = json!({ "id": id, "method": method });
        if let Some(p) = params {
            req["params"] = p;
        }
        let (tx, rx) = mpsc::channel();
        lock(&self.pending).insert(id, tx);
        let forget = || {
            lock(&self.pending).remove(&id);
        };
        // The reader may have drained `pending` just before the insert above.
        if !self.is_alive() {
            forget();
            return Err("sidecar is not running".into());
        }
        let written = {
            let mut guard = lock(&self.stdin);
            match guard.as_mut() {
                Some(stdin) => writeln!(stdin, "{req}")
                    .and_then(|_| stdin.flush())
                    .map_err(|e| format!("write to sidecar failed: {e}")),
                None => Err("sidecar stdin closed".to_string()),
            }
        };
        if let Err(e) = written {
            forget();
            return Err(e);
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                forget();
                Err(format!(
                    "sidecar did not answer {method} within {}s",
                    timeout.as_secs()
                ))
            }
        }
    }

    /// Graceful stop: protocol shutdown, close stdin, wait up to 3s, then kill.
    pub fn shutdown(&self) {
        let _ = self.request("shutdown", None, Duration::from_secs(3));
        *lock(&self.stdin) = None; // closing stdin also makes the sidecar exit
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = lock(&self.child).try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let mut child = lock(&self.child);
        if let Ok(None) = child.try_wait() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tiny stand-in sidecar: `slow` answers after 300ms, `fast` immediately, and every
    /// request also pushes one event first. `quit` exits without answering.
    const FAKE: &str = r#"
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (l) => {
        const r = JSON.parse(l);
        if (r.method === 'quit') process.exit(0);
        process.stdout.write(JSON.stringify({ event: 'task.state', taskId: String(r.id), state: 'running' }) + '\n');
        const reply = () => process.stdout.write(JSON.stringify(
          r.method === 'bad' ? { id: r.id, error: { message: 'nope' } } : { id: r.id, result: { echo: r.method } }) + '\n');
        if (r.method === 'slow') setTimeout(reply, 300); else reply();
      });
    "#;

    fn fake(on_event: impl Fn(Value) + Send + 'static) -> Sidecar {
        let mut cmd = Command::new("node");
        cmd.arg("-e").arg(FAKE);
        let log =
            std::env::temp_dir().join(format!("agent-studio-test-{}.log", std::process::id()));
        Sidecar::spawn_command(cmd, &log, on_event)
            .expect("node must be on PATH to run these tests")
    }

    const T: Duration = Duration::from_secs(30);

    #[test]
    fn replies_match_by_id_even_when_they_finish_out_of_order() {
        let s = Arc::new(fake(|_| {}));
        let slow = {
            let s = s.clone();
            std::thread::spawn(move || s.request("slow", None, T))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(s.request("fast", None, T).unwrap()["echo"], "fast"); // overtakes `slow`
        assert_eq!(slow.join().unwrap().unwrap()["echo"], "slow");
    }

    #[test]
    fn pushed_events_reach_the_callback_and_errors_become_err() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let s = fake(move |v| {
            let _ = lock(&tx).send(v);
        });
        assert_eq!(s.request("bad", None, T).unwrap_err(), "nope");
        let ev = rx.recv_timeout(T).unwrap();
        assert_eq!(ev["event"], "task.state");
    }

    #[test]
    fn a_request_times_out_and_a_dead_sidecar_fails_waiters_and_later_calls() {
        let s = fake(|_| {});
        let timed_out = s
            .request("slow", None, Duration::from_millis(50))
            .unwrap_err();
        assert!(timed_out.contains("did not answer"), "{timed_out}");
        assert!(s.request("quit", None, T).is_err()); // exits without a reply
        let deadline = Instant::now() + T;
        while s.is_alive() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20)); // the reader thread notices EOF
        }
        assert!(!s.is_alive());
        assert_eq!(
            s.request("fast", None, T).unwrap_err(),
            "sidecar is not running"
        );
    }

    #[test]
    fn dispatch_ignores_garbage_and_unclaimed_replies() {
        let pending: Pending = Arc::default();
        dispatch("not json", &pending, &|_| panic!("no event"));
        dispatch(r#"{"id":99,"result":1}"#, &pending, &|_| panic!("no event"));
        dispatch(r#"{"id":null,"error":{"message":"x"}}"#, &pending, &|_| {
            panic!("no event")
        });
    }
}
