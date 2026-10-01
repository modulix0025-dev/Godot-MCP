// SPDX-License-Identifier: Apache-2.0
//
// Studio Core sidecar lifecycle: spawn the bundled Node runtime on the bundled `modulex-core.mjs`, read the
// one-line JSON handshake {port, token} from its stdout, and kill it when the shell exits. Core also exits by
// itself when its stdin closes, so a crashed shell never leaves an orphan behind.
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handshake {
    #[serde(rename = "type")]
    pub kind: String,
    pub version: String,
    pub port: u16,
    pub token: String,
    #[serde(rename = "agentToken", default)]
    pub agent_token: String,
    #[serde(rename = "claudeDesktopToken", default)]
    pub claude_desktop_token: String,
    pub pid: u32,
}

pub struct Sidecar {
    pub child: Child,
    pub handshake: Handshake,
    pub handshake_ms: u128,
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Locate the bundled Node binary: Tauri places `externalBin` next to the main executable,
/// with the target-triple suffix stripped.
pub fn node_path(exe_dir: &Path) -> PathBuf {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    exe_dir.join(name)
}

pub fn spawn(node: &Path, core_script: &Path, timeout: Duration, env: &[(&str, String)]) -> Result<Sidecar, String> {
    let started = Instant::now();
    let mut cmd = Command::new(node);
    cmd.envs(env.iter().map(|(k, v)| (*k, v.as_str())));
    cmd.arg(core_script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start Studio Core ({}): {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let mut stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;

    // One reader for Core's whole lifetime: the handshake line first, then credential store requests (vault.rs).
    // Reading continuously also keeps Core's stdout pipe from filling up. The thread owns Core's stdin; when Core
    // exits (or is killed by Drop) stdout closes, the thread ends and stdin is closed.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line.clone());
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            if let Some(resp) = crate::vault::handle_line(line.trim()) {
                if writeln!(stdin, "{resp}").and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
        }
    });
    let line = match rx.recv_timeout(timeout) {
        Ok(l) => l,
        Err(_) => {
            let _ = child.kill();
            return Err(format!("Studio Core did not hand off within {timeout:?}"));
        }
    };
    let handshake: Handshake = serde_json::from_str(line.trim()).map_err(|e| {
        let _ = child.kill();
        format!("invalid Studio Core handshake: {e}")
    })?;
    if handshake.kind != "modulex-core-handshake" {
        let _ = child.kill();
        return Err("unexpected Studio Core handshake type".into());
    }
    Ok(Sidecar { child, handshake, handshake_ms: started.elapsed().as_millis() })
}

/// Minimal authenticated GET against Core (std only; Core is loopback-only HTTP/1.1).
pub fn core_get(hs: &Handshake, path: &str) -> Result<(u16, String), String> {
    core_request(hs, "GET", path)
}

/// Minimal authenticated POST with an empty JSON body.
pub fn core_post(hs: &Handshake, path: &str) -> Result<(u16, String), String> {
    core_request(hs, "POST", path)
}

fn core_request(hs: &Handshake, method: &str, path: &str) -> Result<(u16, String), String> {
    let mut s = TcpStream::connect(("127.0.0.1", hs.port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok();
    let body = if method == "POST" { "{}" } else { "" };
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        hs.token,
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).map_err(|e| e.to_string())?;
    let status = buf
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = buf.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();
    Ok((status, body))
}
