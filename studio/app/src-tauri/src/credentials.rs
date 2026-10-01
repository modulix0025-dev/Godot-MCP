// SPDX-License-Identifier: Apache-2.0
//
// OS credential store bridge (Execution Patch 1 §39). Long-lived Studio credentials — the ModuleX Agent token
// and the Claude Desktop pairing token — live in Windows Credential Manager (DPAPI-protected, per user), never
// in SQLite, project files, logs or the UI. The shell reads them before starting Core, hands them to Core via
// the environment of the child process only, and stores the ones Core generated on first launch.
//
// Non-Windows builds (Linux CI, developer machines) have no persistent store here: `get` returns None and `set`
// is a no-op, so Core generates fresh per-launch credentials — the safe default.

#[cfg_attr(not(windows), allow(dead_code))]
pub const SERVICE: &str = "ModuleX Game Studio";

/// Credential names (the "account" part of the Credential Manager target). Never the secret itself.
pub const AGENT_TOKEN: &str = "core/agent-token";
pub const CLAUDE_DESKTOP_TOKEN: &str = "core/claude-desktop-token";

#[cfg(windows)]
pub fn get(name: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, name).ok()?.get_password().ok()
}

#[cfg(windows)]
pub fn set(name: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, name)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("credential store: {e}"))
}

#[cfg(windows)]
pub fn delete(name: &str) -> Result<(), String> {
    match keyring::Entry::new(SERVICE, name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("credential store: {e}")),
    }
}

/// Whether a persistent credential store exists on this OS (Windows Credential Manager).
pub fn available() -> bool {
    cfg!(windows)
}

#[cfg(not(windows))]
pub fn delete(_name: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn get(_name: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn set(_name: &str, _value: &str) -> Result<(), String> {
    Ok(())
}

/// Environment for the Core child process: the stored credentials, if any. Values never leave the process tree.
pub fn core_env() -> Vec<(&'static str, String)> {
    [
        ("MODULEX_AGENT_TOKEN", AGENT_TOKEN),
        ("MODULEX_CLAUDE_DESKTOP_TOKEN", CLAUDE_DESKTOP_TOKEN),
    ]
    .into_iter()
    .filter_map(|(var, name)| get(name).map(|v| (var, v)))
    .collect()
}
