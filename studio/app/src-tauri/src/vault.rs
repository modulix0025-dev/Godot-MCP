// SPDX-License-Identifier: Apache-2.0
//
// Credential store bridge for Studio Core (Execution Patch 1 §39, D-052/D-056). Core holds `secret://…` handles
// only; when it must STORE a new secret at runtime (a paired build worker's token) or resolve one, it writes a
// `vault-request` JSON line to its stdout and the shell answers on Core's stdin with a `vault-response`. The pipe
// is private to the parent/child process pair; nothing on it is logged.
//
//   request   {"type":"vault-request","id":1,"op":"set|get|delete","ref":"secret://buildworker/abc/token","value":"…"}
//   response  {"type":"vault-response","id":1,"ok":true,"value":"…"|null,"error":null}
//
// Refs map to Credential Manager entries named `vault/<path>` under the "ModuleX Game Studio" service. Only
// well-formed refs are accepted. On an OS without a credential store here the shell answers ok=false, so Core
// reports the dependent feature as BLOCKED instead of keeping the secret anywhere else.
use serde::{Deserialize, Serialize};

use crate::credentials;

#[derive(Deserialize)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    id: u64,
    op: String,
    #[serde(rename = "ref")]
    reference: String,
    value: Option<String>,
}

#[derive(Serialize)]
struct Response {
    #[serde(rename = "type")]
    kind: &'static str,
    id: u64,
    ok: bool,
    value: Option<String>,
    error: Option<String>,
}

/// `secret://a/b/c` → `vault/a/b/c` when every segment is `[a-z0-9-]+` and there are exactly three.
pub fn entry_name(reference: &str) -> Option<String> {
    let rest = reference.strip_prefix("secret://")?;
    let parts: Vec<&str> = rest.split('/').collect();
    let ok = parts.len() == 3
        && parts.iter().all(|p| {
            !p.is_empty()
                && p.len() <= 64
                && p.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    ok.then(|| format!("vault/{rest}"))
}

/// Answer one stdout line from Core. Returns the response line, or None for anything that is not a vault request
/// (ordinary output is ignored and never echoed or logged).
pub fn handle_line(line: &str) -> Option<String> {
    let req: Request = serde_json::from_str(line).ok()?;
    if req.kind != "vault-request" {
        return None;
    }
    let mut resp = Response {
        kind: "vault-response",
        id: req.id,
        ok: false,
        value: None,
        error: None,
    };
    match entry_name(&req.reference) {
        None => resp.error = Some("invalid secret ref".into()),
        Some(name) => {
            if !credentials::available() {
                resp.error = Some("no credential store on this OS".into());
            } else {
                match req.op.as_str() {
                    "get" => {
                        resp.value = credentials::get(&name);
                        resp.ok = true;
                    }
                    "set" => match req.value.as_deref() {
                        Some(v) if !v.is_empty() => match credentials::set(&name, v) {
                            Ok(()) => resp.ok = true,
                            Err(e) => resp.error = Some(e),
                        },
                        _ => resp.error = Some("empty value".into()),
                    },
                    "delete" => match credentials::delete(&name) {
                        Ok(()) => resp.ok = true,
                        Err(e) => resp.error = Some(e),
                    },
                    _ => resp.error = Some("unknown op".into()),
                }
            }
        }
    }
    serde_json::to_string(&resp).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_only_well_formed_refs() {
        assert_eq!(
            entry_name("secret://buildworker/ab12/token").as_deref(),
            Some("vault/buildworker/ab12/token")
        );
        assert_eq!(entry_name("secret://a/b"), None);
        assert_eq!(entry_name("secret://a/b/c/d"), None);
        assert_eq!(entry_name("secret://A/b/c"), None);
        assert_eq!(entry_name("secret://a/../c"), None);
        assert_eq!(entry_name("file:///etc/passwd"), None);
    }

    #[test]
    fn ignores_ordinary_output_and_rejects_bad_refs() {
        assert_eq!(handle_line("[modulex-core] listening"), None);
        assert_eq!(
            handle_line(r#"{"type":"other","id":1,"op":"get","ref":"secret://a/b/c"}"#),
            None
        );
        let r = handle_line(r#"{"type":"vault-request","id":7,"op":"get","ref":"secret://a/b"}"#)
            .unwrap();
        assert!(
            r.contains(r#""id":7"#)
                && r.contains(r#""ok":false"#)
                && r.contains("invalid secret ref")
        );
    }
}
