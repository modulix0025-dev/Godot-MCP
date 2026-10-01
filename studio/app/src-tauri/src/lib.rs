// SPDX-License-Identifier: Apache-2.0
//
// ModuleX Game Studio desktop shell (Tauri 2). Responsibilities in Phase 1: single instance, start the
// bundled Studio Core sidecar and keep it alive for the window's lifetime, and a `--selftest <out.json>`
// mode that measures cold start and memory without showing a window (Phase 0 spike 7, run in Windows CI).
mod credentials;
mod sidecar;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::{Manager, State};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);

struct CoreState(Mutex<Option<sidecar::Sidecar>>);

#[derive(Serialize)]
struct CoreInfo {
    port: u16,
    token: String,
    version: String,
}

/// The UI's only privileged command: where Studio Core listens and the session token to talk to it.
#[tauri::command]
fn core_connection(state: State<'_, CoreState>) -> Result<CoreInfo, String> {
    let guard = state.0.lock().map_err(|e| e.to_string())?;
    let sc = guard.as_ref().ok_or("Studio Core is not running")?;
    Ok(CoreInfo {
        port: sc.handshake.port,
        token: sc.handshake.token.clone(),
        version: sc.handshake.version.clone(),
    })
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
    let env = bundled_env(&resources, home);
    match sidecar::spawn(&node, &core_script, HANDSHAKE_TIMEOUT, &env) {
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
            report.shell_rss_bytes = rss_bytes(&mut sys, std::process::id());
            report.sidecar_rss_bytes = rss_bytes(&mut sys, sc.child.id());
            report.ok = report.health_status == 200
                && report.error.is_none()
                && report.health_body.get("ok").and_then(|v| v.as_bool()) == Some(true);
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
        .manage(CoreState(Mutex::new(None)))
        .setup(|app| {
            let script = app
                .path()
                .resource_dir()
                .map(|d| d.join("core").join("modulex-core.mjs"))
                .map_err(|e| e.to_string())?;
            let node = sidecar::node_path(&exe_dir());
            // Stable credentials from Windows Credential Manager; Core generates them on the first launch.
            let mut env = credentials::core_env();
            // %LOCALAPPDATA%\ModuleXGameStudio: audit log, store, config versions, extensions, evolution
            // sandboxes and the install state that drives rollback and Safe Mode.
            if let Ok(dir) = app.path().app_local_data_dir() {
                env.push(("MODULEX_DATA_DIR", dir.to_string_lossy().into_owned()));
            }
            if let Ok(res) = app.path().resource_dir() {
                env.extend(bundled_env(&res, app.path().home_dir().ok()));
            }
            // Safe Mode (Execution Patch 2 §21): if Core does not come up, start it once more with every non-core
            // extension disabled and the last known-good configuration, so the owner can roll back or repair.
            let spawned = sidecar::spawn(&node, &script, HANDSHAKE_TIMEOUT, &env).or_else(|e| {
                eprintln!("[modulex] {e}; retrying in Safe Mode");
                let mut safe = env.clone();
                safe.push(("MODULEX_SAFE_MODE", "1".to_string()));
                sidecar::spawn(&node, &script, HANDSHAKE_TIMEOUT, &safe)
            });
            match spawned {
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
                                eprintln!("[modulex] {e}");
                            }
                        }
                    }
                    *app.state::<CoreState>().0.lock().unwrap() = Some(sc);
                }
                Err(e) => eprintln!("[modulex] {e}"),
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Dropping the Sidecar kills Core (which in turn owns server/editor/game children later).
                if let Ok(mut g) = window.state::<CoreState>().0.lock() {
                    g.take();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![core_connection])
        .run(tauri::generate_context!())
        .expect("error while running ModuleX Game Studio");
}
