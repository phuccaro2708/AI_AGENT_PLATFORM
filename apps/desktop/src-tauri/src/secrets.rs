//! Secrets for the CLI agents (Phase 7B), kept in the OS credential store (Windows Credential
//! Manager), never in the database, the logs or the webview. The UI can only write or delete a
//! secret and list the NAMES that exist; there is no command that returns a value.
//!
//! The sidecar receives the values as environment variables at spawn time
//! (`AGENT_STUDIO_SECRET__<PROVIDER>__<NAME>`), takes them out of its own environment at start-up
//! and hands each agent only its own provider's secrets.

use keyring_core::{Entry, Error};

const SERVICE: &str = "agent-studio";
/// Prefix of the variables that carry secrets from this process to the sidecar.
pub const ENV_PREFIX: &str = "AGENT_STUDIO_SECRET__";
pub const PROVIDERS: [&str; 2] = ["claude", "codex"];

const MAX_VALUE: usize = 8192;

/// Secret names must look like credentials. That keeps this from being a way to set arbitrary
/// environment variables (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`...) for an agent.
pub fn valid_name(name: &str) -> bool {
    let ok_chars = !name.is_empty()
        && name.len() <= 64
        && name.starts_with(|c: char| c.is_ascii_uppercase())
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    ok_chars
        && ["KEY", "TOKEN", "SECRET", "PASSWORD"]
            .iter()
            .any(|s| name.ends_with(s))
}

fn check(provider: &str, name: &str) -> Result<(), String> {
    if !PROVIDERS.contains(&provider) {
        return Err(format!("unknown provider: {provider}"));
    }
    if !valid_name(name) {
        return Err(
            "A secret name uses A-Z, 0-9 and _, and ends in KEY, TOKEN, SECRET or PASSWORD".into(),
        );
    }
    Ok(())
}

#[cfg(windows)]
fn install_store() -> Result<(), String> {
    let store = windows_native_keyring_store::Store::new_with_configuration(
        &std::collections::HashMap::from([("service_no_divider", "true")]),
    )
    .map_err(|e| e.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(not(windows))]
fn install_store() -> Result<(), String> {
    Err("secrets are only supported on Windows for now".into())
}

/// Installs the credential store once. Tests install their own before calling anything here.
fn ready() -> Result<(), String> {
    static INIT: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    INIT.get_or_init(|| {
        if keyring_core::get_default_store().is_some() {
            Ok(())
        } else {
            install_store()
        }
    })
    .clone()
}

fn entry(user: &str) -> Result<Entry, String> {
    ready()?;
    // `Local`: stays on this machine instead of roaming with a domain profile. The in-memory mock
    // store used by the tests does not take modifiers.
    #[cfg(not(test))]
    let made = {
        let mods = std::collections::HashMap::from([("persistence", "Local")]);
        Entry::new_with_modifiers(SERVICE, user, &mods)
    };
    #[cfg(test)]
    let made = Entry::new(SERVICE, user);
    made.map_err(|e| e.to_string())
}

fn secret_user(provider: &str, name: &str) -> String {
    format!("{provider}/{name}")
}

fn index_user(provider: &str) -> String {
    format!("index/{provider}")
}

/// Names (not values) stored for a provider. The index itself holds no secret.
pub fn names(provider: &str) -> Result<Vec<String>, String> {
    check(provider, "X_KEY")?;
    match entry(&index_user(provider))?.get_password() {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(Error::NoEntry) => Ok(vec![]),
        Err(e) => Err(e.to_string()),
    }
}

fn save_names(provider: &str, names: &[String]) -> Result<(), String> {
    let json = serde_json::to_string(names).map_err(|e| e.to_string())?;
    entry(&index_user(provider))?
        .set_password(&json)
        .map_err(|e| e.to_string())
}

pub fn set(provider: &str, name: &str, value: &str) -> Result<(), String> {
    check(provider, name)?;
    if value.is_empty() || value.len() > MAX_VALUE || value.contains('\0') {
        return Err(format!(
            "A secret value must be 1-{MAX_VALUE} characters, no NUL"
        ));
    }
    entry(&secret_user(provider, name))?
        .set_password(value)
        .map_err(|e| e.to_string())?;
    let mut all = names(provider)?;
    if !all.iter().any(|n| n == name) {
        all.push(name.to_string());
        all.sort();
        save_names(provider, &all)?;
    }
    Ok(())
}

pub fn delete(provider: &str, name: &str) -> Result<(), String> {
    check(provider, name)?;
    match entry(&secret_user(provider, name))?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => {}
        Err(e) => return Err(e.to_string()),
    }
    let all: Vec<String> = names(provider)?.into_iter().filter(|n| n != name).collect();
    save_names(provider, &all)
}

/// Every stored secret as `(ENV_NAME, value)` for the sidecar's environment. A secret that
/// cannot be read is skipped (and reported by name only), never fatal for the app.
pub fn env_for_sidecar() -> Vec<(String, String)> {
    let mut out = vec![];
    for provider in PROVIDERS {
        let Ok(all) = names(provider) else { continue };
        for name in all {
            match entry(&secret_user(provider, &name))
                .and_then(|e| e.get_password().map_err(|e| e.to_string()))
            {
                Ok(v) => out.push((
                    format!("{ENV_PREFIX}{}__{name}", provider.to_ascii_uppercase()),
                    v,
                )),
                Err(e) => eprintln!("secret {provider}/{name} could not be read: {e}"),
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// The mock store is process-global: run these tests one at a time on a fresh store.
    static LOCK: Mutex<()> = Mutex::new(());

    fn fresh() -> std::sync::MutexGuard<'static, ()> {
        let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
        g
    }

    #[test]
    fn names_must_look_like_credentials() {
        for ok in ["ANTHROPIC_API_KEY", "GH_TOKEN", "DB_PASSWORD", "X_SECRET"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in [
            "PATH",
            "NODE_OPTIONS",
            "LD_PRELOAD",
            "anthropic_api_key",
            "A KEY",
            "",
            "1_KEY",
            "API_KEY_X",
        ] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[test]
    fn a_secret_is_listed_by_name_only_and_reaches_the_sidecar_environment() {
        let _g = fresh();
        set("claude", "ANTHROPIC_API_KEY", "sk-test-123").unwrap();
        set("codex", "OPENAI_API_KEY", "sk-other").unwrap();
        assert_eq!(names("claude").unwrap(), vec!["ANTHROPIC_API_KEY"]);
        assert_eq!(names("codex").unwrap(), vec!["OPENAI_API_KEY"]);
        let env = env_for_sidecar();
        assert!(env.contains(&(
            "AGENT_STUDIO_SECRET__CLAUDE__ANTHROPIC_API_KEY".to_string(),
            "sk-test-123".to_string()
        )));
        // the index lists names and holds no value
        let index = entry("index/claude").unwrap().get_password().unwrap();
        assert!(!index.contains("sk-test-123"));
    }

    #[test]
    fn deleting_removes_the_value_and_the_name() {
        let _g = fresh();
        set("claude", "ANTHROPIC_API_KEY", "v").unwrap();
        delete("claude", "ANTHROPIC_API_KEY").unwrap();
        assert!(names("claude").unwrap().is_empty());
        assert!(env_for_sidecar().is_empty());
        delete("claude", "ANTHROPIC_API_KEY").unwrap(); // already gone: not an error
    }

    #[test]
    fn bad_input_is_refused_before_touching_the_store() {
        let _g = fresh();
        assert!(set("gemini", "A_KEY", "v").is_err());
        assert!(set("claude", "PATH", "v").is_err());
        assert!(set("claude", "A_KEY", "").is_err());
        assert!(set("claude", "A_KEY", "a\0b").is_err());
        assert!(names("claude").unwrap().is_empty());
    }

    /// Touches the real Windows Credential Manager, so it is opt-in: `cargo test -- --ignored`.
    /// Not run in CI (no interactive profile); it removes what it creates.
    #[test]
    #[ignore]
    #[cfg(windows)]
    fn real_credential_manager_roundtrip() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        install_store().unwrap();
        let name = "AGENT_STUDIO_SELFTEST_KEY";
        set("claude", name, "selftest-value").unwrap();
        assert!(names("claude").unwrap().iter().any(|n| n == name));
        assert!(env_for_sidecar()
            .iter()
            .any(|(k, v)| k.ends_with(name) && v == "selftest-value"));
        delete("claude", name).unwrap();
        assert!(!names("claude").unwrap().iter().any(|n| n == name));
    }
}
