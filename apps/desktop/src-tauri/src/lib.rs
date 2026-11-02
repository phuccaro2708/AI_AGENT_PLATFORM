mod job;
mod sidecar;

use serde::Serialize;
use serde_json::{json, Value};
use sidecar::Sidecar;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, RunEvent};

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
struct SidecarState(Mutex<Option<Sidecar>>);

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

fn with_sidecar<T>(
    app: &tauri::AppHandle,
    state: &SidecarState,
    f: impl FnOnce(&mut Sidecar) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "sidecar lock poisoned")?;
    if guard.is_none() {
        let db = db_path(app)?;
        let log = db.with_file_name("sidecar.log");
        *guard = Some(Sidecar::spawn(&sidecar_dir()?, &db, &log)?);
    }
    f(guard.as_mut().expect("just set"))
}

#[tauri::command]
fn sidecar_health(app: tauri::AppHandle, state: tauri::State<SidecarState>) -> Result<Value, String> {
    with_sidecar(&app, &state, |s| s.request("health", None))
}

#[tauri::command]
fn sidecar_run_stub(
    app: tauri::AppHandle,
    state: tauri::State<SidecarState>,
    prompt: String,
) -> Result<Value, String> {
    with_sidecar(&app, &state, |s| {
        let mut r = s.request("runStub", Some(json!({ "prompt": prompt })))?;
        r["sidecarPid"] = json!(s.pid());
        Ok(r)
    })
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
    std::fs::write(&out, serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    app.exit(if report["ok"] == json!(true) { 0 } else { 1 });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            system_health,
            sidecar_health,
            sidecar_run_stub,
            selftest_mode,
            selftest_finish
        ])
        .build(tauri::generate_context!())
        .expect("error while building Agent Studio")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut g) = state.0.lock() {
                        if let Some(mut s) = g.take() {
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
    fn health_reports_app_and_version() {
        let h = health();
        assert_eq!(h.app, "agent-studio");
        assert!(!h.version.is_empty());
    }
}
