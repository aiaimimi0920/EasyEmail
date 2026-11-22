use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::app_state::AppState;
use crate::error::{ActionRequired, AppError, ErrorCategory, ErrorDto};
use crate::host_os_security::restrict_path_to_current_user;
use crate::redaction::redact_text;

const DEFAULT_MAX_LOG_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ROTATED_ARCHIVES: usize = 5;
const LOG_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
const MAX_DIAGNOSTIC_LOG_TAIL_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ExportDiagnosticsRequest {
    pub destination_dir: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopDiagnosticBundleDto {
    pub bundle_path: String,
    pub generated_at_epoch_ms: u64,
    pub included_log_files: usize,
    pub redacted_line_count: usize,
}

pub fn core_logs_dir(runtime_root: &Path) -> PathBuf {
    runtime_root.join("logs")
}

pub fn active_core_log_path(runtime_root: &Path) -> PathBuf {
    core_logs_dir(runtime_root).join("core.log")
}

pub fn prepare_core_log_file_with_limit(
    runtime_root: &Path,
    max_bytes: u64,
    now: SystemTime,
) -> Result<PathBuf, String> {
    let logs_dir = core_logs_dir(runtime_root);
    fs::create_dir_all(&logs_dir)
        .map_err(|err| format!("Could not create EasyEmail core log directory: {err}"))?;

    for index in 1..=MAX_ROTATED_ARCHIVES {
        let archive = logs_dir.join(format!("core.{index}.log"));
        if let Ok(meta) = fs::metadata(&archive) {
            if let Ok(modified) = meta.modified() {
                if now.duration_since(modified).unwrap_or_default() > LOG_RETENTION {
                    let _ = fs::remove_file(&archive);
                }
            }
        }
    }

    let active_path = logs_dir.join("core.log");
    if let Ok(meta) = fs::metadata(&active_path) {
        if meta.len() >= max_bytes {
            let oldest = logs_dir.join(format!("core.{MAX_ROTATED_ARCHIVES}.log"));
            let _ = fs::remove_file(&oldest);
            for index in (1..MAX_ROTATED_ARCHIVES).rev() {
                let from = logs_dir.join(format!("core.{index}.log"));
                let to = logs_dir.join(format!("core.{}.log", index + 1));
                if from.is_file() {
                    let _ = fs::rename(&from, &to);
                }
            }
            let first_archive = logs_dir.join("core.1.log");
            let _ = fs::rename(&active_path, &first_archive);
            let _ = restrict_path_to_current_user(&first_archive);
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&active_path)
        .map_err(|err| format!("Could not open EasyEmail core log file: {err}"))?;
    drop(file);
    let _ = restrict_path_to_current_user(&active_path);
    Ok(active_path)
}

pub fn prepare_core_log_file(runtime_root: &Path) -> Result<PathBuf, String> {
    prepare_core_log_file_with_limit(runtime_root, DEFAULT_MAX_LOG_FILE_BYTES, SystemTime::now())
}

pub fn scrub_secondary_tokens(value: &str) -> String {
    let first_pass = redact_text(value);
    let bytes = first_pass.as_bytes();
    let mut output = String::with_capacity(first_pass.len());
    let mut index = 0usize;
    while index < bytes.len() {
        if bytes[index].is_ascii_hexdigit() {
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
                index += 1;
            }
            if index - start >= 32 {
                output.push_str("[REDACTED_TOKEN]");
            } else {
                output.push_str(&first_pass[start..index]);
            }
        } else {
            let ch = first_pass[index..].chars().next().unwrap();
            output.push(ch);
            index += ch.len_utf8();
        }
    }
    output
}

pub fn append_host_lifecycle_log(runtime_root: &Path, event: &str, detail: &str) {
    let Ok(log_path) = prepare_core_log_file(runtime_root) else {
        return;
    };
    let epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let sanitized_detail = scrub_secondary_tokens(detail);
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(
            file,
            "[desktop-host] ts={} event={} detail={}",
            epoch_ms, event, sanitized_detail
        );
    }
}

pub fn export_redacted_diagnostics_bundle(
    data_dir: &Path,
    destination_override: Option<&Path>,
) -> Result<DesktopDiagnosticBundleDto, AppError> {
    let output_dir = match destination_override {
        Some(custom) if custom.is_absolute() => custom.to_path_buf(),
        Some(_) => {
            return Err(AppError {
                code: "diagnostics_destination_invalid".to_string(),
                category: ErrorCategory::Validation,
                user_message: "Diagnostic export destination must be an absolute directory path."
                    .to_string(),
                technical_message: None,
                retryable: false,
                action_required: ActionRequired::EditSettings,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: Box::new(serde_json::json!({})),
            })
        }
        None => data_dir.join("diagnostics"),
    };

    fs::create_dir_all(&output_dir).map_err(|err| AppError {
        code: "diagnostics_dir_create_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Could not create diagnostic export directory.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    })?;

    let runtime_root = data_dir.join("core");
    let logs_dir = core_logs_dir(&runtime_root);
    let mut included_log_files = 0usize;
    let mut redacted_lines = Vec::new();

    for candidate in [logs_dir.join("core.1.log"), logs_dir.join("core.log")] {
        if !candidate.is_file() {
            continue;
        }
        if let Ok(raw) = fs::read_to_string(&candidate) {
            included_log_files += 1;
            let start = raw.len().saturating_sub(MAX_DIAGNOSTIC_LOG_TAIL_BYTES);
            let tail = raw.get(start..).unwrap_or(&raw);
            for line in tail.lines() {
                redacted_lines.push(scrub_secondary_tokens(line));
            }
        }
    }

    let host_id = fs::read_to_string(data_dir.join("desktop-host-id"))
        .ok()
        .map(|s| s.trim().to_string());
    let state_json_bytes = fs::metadata(runtime_root.join("state/easy-email-state.json"))
        .ok()
        .map(|m| m.len());
    let relational_db_bytes =
        fs::metadata(runtime_root.join("state/state/easy-email-relational.sqlite3"))
            .or_else(|_| fs::metadata(runtime_root.join("state/easy-email-relational.sqlite3")))
            .ok()
            .map(|m| m.len());

    let generated_at_epoch_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let bundle_path = output_dir.join(format!(
        "nmail-diagnostics-{generated_at_epoch_ms}-{}.json",
        uuid::Uuid::new_v4().simple()
    ));

    let bundle_json = serde_json::json!({
        "schemaVersion": 1,
        "generatedAtEpochMs": generated_at_epoch_ms,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "hostId": host_id,
        "storageSummary": {
            "stateSnapshotBytes": state_json_bytes,
            "relationalSqliteBytes": relational_db_bytes,
        },
        "includedLogFiles": included_log_files,
        "redactedCoreLogs": redacted_lines,
    });

    let encoded = serde_json::to_vec_pretty(&bundle_json)
        .map_err(|err| AppError::internal("diagnostics_encode_failed", err.to_string()))?;
    fs::write(&bundle_path, encoded).map_err(|err| AppError {
        code: "diagnostics_write_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Could not write diagnostic bundle.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: false,
        action_required: ActionRequired::None,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    })?;
    let _ = restrict_path_to_current_user(&bundle_path);

    Ok(DesktopDiagnosticBundleDto {
        bundle_path: bundle_path.display().to_string(),
        generated_at_epoch_ms,
        included_log_files,
        redacted_line_count: redacted_lines.len(),
    })
}

#[tauri::command]
pub fn desktop_export_diagnostics(
    state: tauri::State<'_, AppState>,
    request: Option<ExportDiagnosticsRequest>,
) -> Result<DesktopDiagnosticBundleDto, ErrorDto> {
    let override_path = request
        .and_then(|req| req.destination_dir)
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(PathBuf::from);
    export_redacted_diagnostics_bundle(&state.data_dir, override_path.as_deref())
        .map_err(ErrorDto::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_oversized_logs_prunes_expired_archives_and_exports_double_redacted_bundle() {
        let root =
            std::env::temp_dir().join(format!("easyemail-logs-test-{}", uuid::Uuid::new_v4()));
        let runtime_root = root.join("core");
        let logs_dir = core_logs_dir(&runtime_root);
        fs::create_dir_all(&logs_dir).unwrap();

        let canary_hex = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
        let canary_bearer = "Bearer secret-loopback-api-token-999";
        fs::write(
            logs_dir.join("core.log"),
            format!("line1 auth={canary_bearer}\nline2 raw={canary_hex}\n"),
        )
        .unwrap();

        // Trigger rotation with a small 20-byte threshold
        let active =
            prepare_core_log_file_with_limit(&runtime_root, 20, SystemTime::now()).unwrap();
        assert!(active.is_file());
        assert!(logs_dir.join("core.1.log").is_file());

        append_host_lifecycle_log(
            &runtime_root,
            "core_graceful_stop",
            &format!("token={canary_hex}"),
        );

        let exported = export_redacted_diagnostics_bundle(&root, None).unwrap();
        assert_eq!(exported.included_log_files, 2);
        let bundle_text = fs::read_to_string(&exported.bundle_path).unwrap();
        assert!(!bundle_text.contains(canary_hex));
        assert!(!bundle_text.contains("secret-loopback-api-token-999"));
        assert!(bundle_text.contains("[REDACTED]"));
        assert!(bundle_text.contains("[REDACTED_TOKEN]"));

        // Prune archive when simulated 'now' is 15 days in the future
        let future = SystemTime::now() + Duration::from_secs(15 * 24 * 60 * 60);
        prepare_core_log_file_with_limit(&runtime_root, 4096, future).unwrap();
        assert!(!logs_dir.join("core.1.log").exists());

        let _ = fs::remove_dir_all(root);
    }
}
