use serde::Serialize;

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

/// IPC command: the frontend's only Phase 0 entry point into the native layer.
#[tauri::command]
fn system_health() -> Health {
    health()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![system_health])
        .run(tauri::generate_context!())
        .expect("error while running Agent Studio");
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
