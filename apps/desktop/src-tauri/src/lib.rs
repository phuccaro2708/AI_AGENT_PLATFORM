pub mod job;
mod secrets;
mod sidecar;

use serde::Serialize;
use serde_json::{json, Value};
use sidecar::Sidecar;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, RunEvent};

#[derive(Serialize, Debug, PartialEq)]
pub struct Health {
    pub app: &'static str,
    pub version: &'static str,
}

pub fn health() -> Health {
    Health {
        app: "agent-studio",
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[derive(Default)]
struct SidecarState(Mutex<Option<Arc<Sidecar>>>);

/// IPC command: the frontend's entry point into the native layer.
#[tauri::command]
fn system_health() -> Health {
    health()
}

fn sidecar_dir() -> Result<PathBuf, String> {
    if let Ok(d) = std::env::var("AGENT_STUDIO_SIDECAR_DIR") {
        return Ok(PathBuf::from(d));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(exe.parent().ok_or("exe has no parent")?.join("sidecar"))
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("AGENT_STUDIO_DB") {
        return Ok(PathBuf::from(p));
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("agent-studio.db"))
}

/// Methods the frontend may call. Everything else (`shutdown`, `runStub`, unknown names) is
/// refused here, before it reaches the sidecar; the sidecar schema validates the params and has
/// no `cwd` parameter, so the UI cannot choose where an agent runs.
const ALLOWED_METHODS: &[&str] = &[
    "health",
    "queryTask",
    "agents.list",
    "agents.detect",
    "agents.scan",
    "agents.capabilities",
    "agents.getSettings",
    "agents.setSettings",
    "agents.probe",
    "projects.create",
    "projects.list",
    "workflows.create",
    "workflows.start",
    "tasks.cancel",
    "logs.query",
    "tasks.list",
    "workflows.startPeerReview",
    "roles.list",
    "context.list",
    "approvals.list",
    "approvals.resolve",
    "artifacts.list",
    "artifacts.diff",
    "worktrees.list",
    "tasks.history",
    "logs.search",
    "tasks.resolveReconciliation",
];

fn is_allowed(method: &str) -> bool {
    ALLOWED_METHODS.contains(&method)
}

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STUB_TIMEOUT: Duration = Duration::from_secs(60);
/// Tauri event carrying every server-pushed sidecar event (`task.message`, `task.state`).
const SIDECAR_EVENT: &str = "sidecar://event";

/// Returns the running sidecar, starting (or restarting a dead) one. Does not hold the lock
/// while a request is in flight, so a slow request never blocks the others.
fn ensure_sidecar(app: &tauri::AppHandle, state: &SidecarState) -> Result<Arc<Sidecar>, String> {
    let mut guard = state.0.lock().map_err(|_| "sidecar lock poisoned")?;
    if let Some(s) = guard.as_ref().filter(|s| s.is_alive()) {
        return Ok(s.clone());
    }
    let db = db_path(app)?;
    let log = db.with_file_name("sidecar.log");
    let handle = app.clone();
    let s = Arc::new(Sidecar::spawn(
        &sidecar_dir()?,
        &db,
        &log,
        secrets::env_for_sidecar(),
        move |ev| {
            let _ = handle.emit(SIDECAR_EVENT, ev);
        },
    )?);
    *guard = Some(s.clone());
    Ok(s)
}

/// Runs the blocking request off the UI thread.
async fn call(
    app: &tauri::AppHandle,
    state: &SidecarState,
    method: &str,
    params: Option<Value>,
    timeout: Duration,
) -> Result<Value, String> {
    let sidecar = ensure_sidecar(app, state)?;
    let method = method.to_string();
    tauri::async_runtime::spawn_blocking(move || sidecar.request(&method, params, timeout))
        .await
        .map_err(|e| e.to_string())?
}

/// Generic, allowlisted entry point used by the UI for everything except the Phase 0 spike calls.
#[tauri::command]
async fn sidecar_call(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if !is_allowed(&method) {
        return Err(format!("method not allowed: {method}"));
    }
    call(&app, &state, &method, params, REQUEST_TIMEOUT).await
}

#[tauri::command]
async fn sidecar_health(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
) -> Result<Value, String> {
    call(&app, &state, "health", None, REQUEST_TIMEOUT).await
}

#[tauri::command]
async fn sidecar_run_stub(
    app: tauri::AppHandle,
    state: tauri::State<'_, SidecarState>,
    prompt: String,
) -> Result<Value, String> {
    let mut r = call(
        &app,
        &state,
        "runStub",
        Some(json!({ "prompt": prompt })),
        STUB_TIMEOUT,
    )
    .await?;
    r["sidecarPid"] = json!(ensure_sidecar(&app, &state)?.pid());
    Ok(r)
}

fn path_text(p: PathBuf) -> Result<String, String> {
    p.into_os_string()
        .into_string()
        .map_err(|_| "the chosen folder has a name that is not valid text".to_string())
}

/// Where the folder dialog opens: the D: drive when this machine has one, otherwise the system's
/// default. It is only a starting point; any folder can still be picked and the project policy
/// decides what is acceptable.
fn start_directory() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let d = PathBuf::from(r"D:\");
        if d.is_dir() {
            return Some(d);
        }
    }
    None
}

/// Native folder picker, opened from the native side so the webview needs no dialog permission.
/// Returns `None` when the person cancels. The path is only a suggestion: the sidecar's project
/// policy decides whether it can be a project folder.
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_title("Choose project folder");
        if let Some(start) = start_directory() {
            dialog = dialog.set_directory(start);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;
    match picked {
        None => Ok(None),
        Some(p) => p
            .into_path()
            .map_err(|e| e.to_string())
            .and_then(path_text)
            .map(Some),
    }
}

/// Refuses while work is in flight: a restart would kill running tasks (they would end up in
/// `needs_reconciliation`), so the person waits or cancels first. Nothing running -> nothing to ask.
async fn ensure_idle(state: &SidecarState) -> Result<(), String> {
    let running = state.0.lock().map_err(|_| "sidecar lock poisoned")?.clone();
    let Some(sidecar) = running.filter(|s| s.is_alive()) else {
        return Ok(());
    };
    let reply = tauri::async_runtime::spawn_blocking(move || {
        sidecar.request("system.activeTasks", None, REQUEST_TIMEOUT)
    })
    .await
    .map_err(|e| e.to_string())??;
    match reply["count"].as_u64() {
        Some(0) => Ok(()),
        _ => Err(
            "Tasks are still running or queued. Cancel them or wait, then change secrets.".into(),
        ),
    }
}

/// Stops the sidecar so the next call starts one with the new secrets in its environment.
async fn restart_sidecar(state: &SidecarState) -> Result<(), String> {
    let old = state.0.lock().map_err(|_| "sidecar lock poisoned")?.take();
    if let Some(s) = old {
        tauri::async_runtime::spawn_blocking(move || s.shutdown())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Write-only: stores a secret in the credential store. There is no command that reads a value.
#[tauri::command]
async fn secret_set(
    state: tauri::State<'_, SidecarState>,
    provider: String,
    name: String,
    value: String,
) -> Result<(), String> {
    ensure_idle(&state).await?;
    tauri::async_runtime::spawn_blocking(move || secrets::set(&provider, &name, &value))
        .await
        .map_err(|e| e.to_string())??;
    restart_sidecar(&state).await
}

#[tauri::command]
async fn secret_delete(
    state: tauri::State<'_, SidecarState>,
    provider: String,
    name: String,
) -> Result<(), String> {
    ensure_idle(&state).await?;
    tauri::async_runtime::spawn_blocking(move || secrets::delete(&provider, &name))
        .await
        .map_err(|e| e.to_string())??;
    restart_sidecar(&state).await
}

/// Names only, never values.
#[tauri::command]
async fn secret_names(provider: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || secrets::names(&provider))
        .await
        .map_err(|e| e.to_string())?
}

/// True only when CI/automation asks the app to verify itself and exit.
#[tauri::command]
fn selftest_mode() -> bool {
    std::env::var("AGENT_STUDIO_SELFTEST_OUT").is_ok()
}

/// Writes the frontend-collected report and exits. Only active in selftest mode.
#[tauri::command]
fn selftest_finish(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    let out = std::env::var("AGENT_STUDIO_SELFTEST_OUT").map_err(|_| "not in selftest mode")?;
    std::fs::write(
        &out,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    app.exit(if report["ok"] == json!(true) { 0 } else { 1 });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            system_health,
            sidecar_call,
            sidecar_health,
            sidecar_run_stub,
            pick_folder,
            secret_set,
            secret_delete,
            secret_names,
            selftest_mode,
            selftest_finish
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Workspace")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut g) = state.0.lock() {
                        if let Some(s) = g.take() {
                            s.shutdown();
                        }
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_ui_methods_are_allowed() {
        assert!(is_allowed("workflows.start") && is_allowed("logs.query"));
        for m in [
            "tasks.list",
            "workflows.startPeerReview",
            "roles.list",
            "context.list",
            "approvals.list",
            "approvals.resolve",
            "artifacts.list",
            "artifacts.diff",
            "worktrees.list",
            "tasks.history",
            "logs.search",
            "tasks.resolveReconciliation",
            "agents.getSettings",
            "agents.setSettings",
            "agents.probe",
            "agents.scan",
        ] {
            assert!(is_allowed(m), "{m:?}");
        }
        for m in [
            "shutdown",
            "runStub",
            "",
            "workflows.start ",
            "Health",
            "agents",
            "system.activeTasks",
        ] {
            assert!(!is_allowed(m), "{m:?}");
        }
    }

    #[test]
    fn a_chosen_folder_becomes_text() {
        assert_eq!(
            path_text(PathBuf::from("some").join("folder")).unwrap(),
            PathBuf::from("some").join("folder").to_string_lossy()
        );
    }

    #[test]
    fn health_reports_app_and_version() {
        let h = health();
        assert_eq!(h.app, "agent-studio");
        assert!(!h.version.is_empty());
    }
}
