// SPDX-License-Identifier: Apache-2.0
//
// ModuleX Game Studio desktop shell (Tauri 2). Responsibilities in Phase 1: single instance, start the
// bundled Studio Core sidecar and keep it alive for the window's lifetime, and a `--selftest <out.json>`
// mode that measures cold start and memory without showing a window (Phase 0 spike 7, run in Windows CI).
mod credentials;
mod sidecar;
mod vault;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Manager, State};

/// How long Core may take to hand off. Generous: on a first launch Windows Defender scans the bundled Node runtime
/// and Core bundle before they run, which can take tens of seconds on a slow disk.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);

/// The app identifier: Tauri's app_local_data_dir is %LOCALAPPDATA%\<identifier> on Windows.
const APP_IDENTIFIER: &str = "com.modulex.gamestudio";

enum CoreStatus {
    Idle,
    Starting(Instant),
    Ready(sidecar::Sidecar),
    Failed(String),
}

struct CoreState {
    status: Mutex<CoreStatus>,
    /// Core's stderr and the shell's startup errors (shown to the owner when Core does not start).
    log: Mutex<Option<PathBuf>>,
}

/// What the UI gets from `core_connection`. Never the agent or Claude Desktop tokens.
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum CoreInfo {
    Starting {
        elapsed_s: u64,
    },
    Ready {
        port: u16,
        token: String,
        version: String,
    },
    Failed {
        error: String,
        log: Option<String>,
    },
}

/// The UI's only privileged command: whether Studio Core is up, and if so where it listens and the owner session
/// token. While Core is starting the UI polls; if it failed, the UI shows the error and where the log is.
#[tauri::command]
fn core_connection(state: State<'_, CoreState>) -> Result<CoreInfo, String> {
    let log = state
        .log
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|p| p.to_string_lossy().into_owned());
    let guard = state.status.lock().map_err(|e| e.to_string())?;
    Ok(match &*guard {
        CoreStatus::Idle => CoreInfo::Starting { elapsed_s: 0 },
        CoreStatus::Starting(t) => CoreInfo::Starting {
            elapsed_s: t.elapsed().as_secs(),
        },
        CoreStatus::Ready(sc) => CoreInfo::Ready {
            port: sc.handshake.port,
            token: sc.handshake.token.clone(),
            version: sc.handshake.version.clone(),
        },
        CoreStatus::Failed(e) => CoreInfo::Failed {
            error: e.clone(),
            log,
        },
    })
}

/// "Retry" on the startup error screen: start Core again (no-op while it is starting).
#[tauri::command]
fn restart_core(app: tauri::AppHandle) -> Result<(), String> {
    start_core(&app);
    Ok(())
}

/// Copy-to-clipboard source for Settings → Claude Desktop: the stable pairing token the extension needs. It goes
/// from the shell to the UI only on the owner's click, and the UI puts it on the clipboard without displaying it.
#[tauri::command]
fn claude_desktop_pairing_token(state: State<'_, CoreState>) -> Result<String, String> {
    let guard = state.status.lock().map_err(|e| e.to_string())?;
    let CoreStatus::Ready(sc) = &*guard else {
        return Err("Studio Core is not running".into());
    };
    if sc.handshake.claude_desktop_token.is_empty() {
        return Err("Studio Core did not report a Claude Desktop pairing token".into());
    }
    Ok(sc.handshake.claude_desktop_token.clone())
}

/// Settings → Claude Desktop → "Show the extension file": select the bundled `.mcpb` in Explorer, so the owner can
/// open it with Claude Desktop (which shows its own install dialog).
#[tauri::command]
fn reveal_claude_extension(app: tauri::AppHandle) -> Result<String, String> {
    let file = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("claude-desktop")
        .join("modulex-game-studio.mcpb");
    if !file.is_file() {
        return Err("the Claude Desktop extension is not bundled with this build".into());
    }
    #[cfg(windows)]
    std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.display()))
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(file.to_string_lossy().into_owned())
}

/// Bundled components (the full installer ships Godot 4.5.1 .NET and the MCP server under `engine/`; both installers
/// ship the addon sources under `addons/`). Every variable is set only when the file really exists, so the small
/// installer still reports the pipeline as unavailable until the Setup Assistant installs Godot.
fn bundled_env(resources: &std::path::Path, home: Option<PathBuf>) -> Vec<(&'static str, String)> {
    let mut env = Vec::new();
    let engine = resources.join("engine");
    let godot = engine.join("godot");
    if let Ok(entries) = std::fs::read_dir(&godot) {
        let exe = entries.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            name.starts_with("Godot_v") && name.ends_with("_win64.exe")
        });
        if let Some(exe) = exe {
            env.push(("MODULEX_GODOT", exe.to_string_lossy().into_owned()));
        }
    }
    let server = engine.join("server").join("gamedev-mcp-server.exe");
    if server.is_file() {
        env.push(("MODULEX_SERVER", server.to_string_lossy().into_owned()));
    }
    let addons = resources.join("addons");
    if addons.join("godot_mcp").is_dir() && addons.join("modulex_studio").is_dir() {
        env.push((
            "MODULEX_ADDONS_SOURCE",
            addons.to_string_lossy().into_owned(),
        ));
    }
    if let Some(home) = home {
        env.push((
            "MODULEX_PROJECTS_ROOT",
            home.join("ModuleX Games").to_string_lossy().into_owned(),
        ));
    }
    env
}

/// Core's environment, identical for the GUI and `--selftest`: stored credentials, the credential store bridge, the
/// data directory and the bundled components. One function, so the self-test proves what the app really runs.
fn core_environment(
    resources: &std::path::Path,
    home: Option<PathBuf>,
    data_dir: Option<&std::path::Path>,
) -> Vec<(&'static str, String)> {
    // Stable credentials from Windows Credential Manager; Core generates them on the first launch.
    let mut env = credentials::core_env();
    // Core may store/resolve secrets at runtime through the shell (vault.rs), e.g. build worker tokens.
    env.push(("MODULEX_VAULT_BRIDGE", "1".to_string()));
    // %LOCALAPPDATA%\com.modulex.gamestudio: audit log, store, config versions, extensions, evolution sandboxes and
    // the install state that drives rollback and Safe Mode.
    if let Some(dir) = data_dir {
        env.push(("MODULEX_DATA_DIR", dir.to_string_lossy().into_owned()));
    }
    env.extend(bundled_env(resources, home));
    env
}

fn core_log_path(data_dir: &std::path::Path) -> PathBuf {
    data_dir.join("logs").join("core.log")
}

/// Start Core on a background thread so the window stays responsive; the UI polls `core_connection`.
fn start_core(app: &tauri::AppHandle) {
    let state = app.state::<CoreState>();
    {
        let mut g = state.status.lock().unwrap();
        if matches!(*g, CoreStatus::Starting(_)) {
            return; // a start is already in flight
        }
        // Dropping a previous Sidecar (a "Retry" after Ready is not offered, but be safe) kills that Core first.
        *g = CoreStatus::Starting(Instant::now());
    }
    let script = app
        .path()
        .resource_dir()
        .map(|d| d.join("core").join("modulex-core.mjs"));
    let resources = app.path().resource_dir().ok();
    let data_dir = app.path().app_local_data_dir().ok();
    let home = app.path().home_dir().ok();
    let log = data_dir.as_deref().map(core_log_path);
    *state.log.lock().unwrap() = log.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        let result = (|| {
            let script = script.map_err(|e| format!("resource folder unavailable: {e}"))?;
            let resources = resources.ok_or("resource folder unavailable")?;
            let node = sidecar::node_path(&exe_dir());
            let env = core_environment(&resources, home, data_dir.as_deref());
            // Safe Mode (Execution Patch 2 §21): if Core does not come up, start it once more with every non-core
            // extension disabled and the last known-good configuration, so the owner can roll back or repair.
            sidecar::spawn(&node, &script, HANDSHAKE_TIMEOUT, &env, log.as_deref()).or_else(
                |first| {
                    if let Some(l) = &log {
                        sidecar::log_line(l, &format!("{first}; retrying in Safe Mode"));
                    }
                    let mut safe = env.clone();
                    safe.push(("MODULEX_SAFE_MODE", "1".to_string()));
                    sidecar::spawn(&node, &script, HANDSHAKE_TIMEOUT, &safe, log.as_deref())
                        .map_err(|second| format!("{first}. Safe Mode: {second}"))
                },
            )
        })();
        let state = app.state::<CoreState>();
        match result {
            Ok(sc) => {
                for (name, value) in [
                    (credentials::AGENT_TOKEN, &sc.handshake.agent_token),
                    (
                        credentials::CLAUDE_DESKTOP_TOKEN,
                        &sc.handshake.claude_desktop_token,
                    ),
                ] {
                    if !value.is_empty()
                        && credentials::get(name).as_deref() != Some(value.as_str())
                    {
                        if let Err(e) = credentials::set(name, value) {
                            if let Some(l) = &log {
                                sidecar::log_line(l, &e);
                            }
                        }
                    }
                }
                *state.status.lock().unwrap() = CoreStatus::Ready(sc);
            }
            Err(e) => {
                if let Some(l) = &log {
                    sidecar::log_line(l, &format!("Studio Core did not start: {e}"));
                }
                *state.status.lock().unwrap() = CoreStatus::Failed(e);
            }
        }
    });
}

fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn rss_bytes(sys: &mut System, pid: u32) -> u64 {
    let pid = Pid::from_u32(pid);
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
    sys.process(pid).map(|p| p.memory()).unwrap_or(0)
}

#[derive(Serialize)]
struct SelfTestReport {
    ok: bool,
    error: Option<String>,
    shell_to_handshake_ms: u128,
    sidecar_handshake_ms: u128,
    health_status: u16,
    health_body: serde_json::Value,
    shell_rss_bytes: u64,
    sidecar_rss_bytes: u64,
    platform: String,
    /// Credential store bridge round-trip (store → read back → delete a probe secret through Core). Required on
    /// Windows; null where the OS has no credential store here.
    vault_ok: Option<bool>,
    vault_detail: serde_json::Value,
    /// Where Core's stderr went (the same file the GUI uses).
    core_log: Option<String>,
}

/// `--selftest <out.json>`: resolve the bundled Node + Core exactly as the GUI does, handshake, call
/// /health, record timings + RSS, shut Core down, and exit. The token is never written to the report.
fn self_test(core_script: PathBuf, out: PathBuf, started: Instant) -> i32 {
    let mut sys = System::new();
    let node = sidecar::node_path(&exe_dir());
    let mut report = SelfTestReport {
        ok: false,
        error: None,
        shell_to_handshake_ms: 0,
        sidecar_handshake_ms: 0,
        health_status: 0,
        health_body: serde_json::Value::Null,
        shell_rss_bytes: 0,
        sidecar_rss_bytes: 0,
        platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
        vault_ok: None,
        vault_detail: serde_json::Value::Null,
        core_log: None,
    };
    // The same bundled components the GUI passes (engine/, addons/), so the report proves what Core will run with:
    // the full installer must report `pipeline.available` and `pipeline.qaTier` in the health body.
    let resources = core_script
        .parent()
        .and_then(|core| core.parent())
        .map(|d| d.to_path_buf())
        .unwrap_or_else(exe_dir);
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    // Exactly the GUI's environment (core_environment), including the data directory and stored credentials, and
    // the same log file, so a GUI-only startup failure cannot pass the self-test.
    let data_dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_IDENTIFIER);
    let log = core_log_path(&data_dir);
    report.core_log = Some(log.to_string_lossy().into_owned());
    let env = core_environment(&resources, home, Some(&data_dir));
    match sidecar::spawn(&node, &core_script, HANDSHAKE_TIMEOUT, &env, Some(&log)) {
        Ok(sc) => {
            report.shell_to_handshake_ms = started.elapsed().as_millis();
            report.sidecar_handshake_ms = sc.handshake_ms;
            match sidecar::core_get(&sc.handshake, "/health") {
                Ok((status, body)) => {
                    report.health_status = status;
                    report.health_body =
                        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                }
                Err(e) => report.error = Some(format!("health: {e}")),
            }
            match sidecar::core_post(&sc.handshake, "/vault/selftest") {
                Ok((status, body)) => {
                    let v: serde_json::Value =
                        serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                    report.vault_ok = if credentials::available() {
                        Some(status == 200 && v.get("ok").and_then(|x| x.as_bool()) == Some(true))
                    } else {
                        None
                    };
                    report.vault_detail = v;
                }
                Err(e) => {
                    report.vault_detail = serde_json::Value::String(format!("vault selftest: {e}"))
                }
            }
            report.shell_rss_bytes = rss_bytes(&mut sys, std::process::id());
            report.sidecar_rss_bytes = rss_bytes(&mut sys, sc.child.id());
            report.ok = report.health_status == 200
                && report.error.is_none()
                && report.health_body.get("ok").and_then(|v| v.as_bool()) == Some(true)
                && report.vault_ok != Some(false);
            drop(sc);
        }
        Err(e) => report.error = Some(e),
    }
    let json = serde_json::to_string_pretty(&report).unwrap_or_default();
    let _ = std::fs::write(&out, json);
    if report.ok {
        0
    } else {
        1
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started = Instant::now();
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--selftest") {
        let out = args
            .get(i + 1)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("modulex-selftest.json"));
        // Resources sit beside the exe in a Windows install (`resources/` folder layout differs per OS).
        let script = [
            exe_dir().join("core").join("modulex-core.mjs"),
            exe_dir()
                .join("resources")
                .join("core")
                .join("modulex-core.mjs"),
        ]
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| exe_dir().join("core").join("modulex-core.mjs"));
        std::process::exit(self_test(script, out, started));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .manage(CoreState {
            status: Mutex::new(CoreStatus::Idle),
            log: Mutex::new(None),
        })
        .setup(|app| {
            // In the background: the window shows "Starting Studio Core…" and then the app, or the error and the log.
            start_core(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Dropping the Sidecar kills Core (which in turn owns server/editor/game children later).
                if let Ok(mut g) = window.state::<CoreState>().status.lock() {
                    *g = CoreStatus::Idle;
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_connection,
            restart_core,
            claude_desktop_pairing_token,
            reveal_claude_extension
        ])
        .run(tauri::generate_context!())
        .expect("error while running ModuleX Game Studio");
}
