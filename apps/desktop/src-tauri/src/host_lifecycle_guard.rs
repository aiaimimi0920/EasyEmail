use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::host_os_security::{
    lock_file_exclusive_nonblocking, process_creation_timestamp, restrict_path_to_current_user,
    terminate_process_matching_creation_time,
};

const INSTANCE_LOCK_FILENAME: &str = "desktop-instance.lock";
const CHILD_LEASE_FILENAME: &str = "core-child-lease.json";
const MAX_CRASH_RESTARTS_IN_WINDOW: usize = 2;
const CRASH_LOOP_WINDOW: Duration = Duration::from_secs(60);

pub struct HostInstanceLock {
    _file: File,
    lock_path: PathBuf,
}

impl HostInstanceLock {
    pub fn acquire(data_dir: &Path) -> Result<Self, AppError> {
        fs::create_dir_all(data_dir).map_err(|err| AppError {
            code: "data_dir_create_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The application data directory could not be created.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        })?;

        let lock_path = data_dir.join(INSTANCE_LOCK_FILENAME);
        let mut file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|err| AppError {
                code: "desktop_instance_lock_open_failed".to_string(),
                category: ErrorCategory::Storage,
                user_message: "Could not open the desktop single-instance lock file.".to_string(),
                technical_message: Some(err.to_string()),
                retryable: false,
                action_required: ActionRequired::None,
                correlation_id: uuid::Uuid::new_v4().to_string(),
                metadata: Box::new(serde_json::json!({})),
            })?;

        lock_file_exclusive_nonblocking(&file).map_err(|reason| AppError {
            code: "desktop_instance_already_running".to_string(),
            category: ErrorCategory::Validation,
            user_message: reason,
            technical_message: None,
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        })?;

        let _ = file.set_len(0);
        let started_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let _ = writeln!(
            file,
            "{{\"pid\":{},\"startedAtEpochMs\":{}}}",
            std::process::id(),
            started_epoch_ms
        );
        let _ = file.sync_all();

        Ok(Self {
            _file: file,
            lock_path,
        })
    }

    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledCoreChildLease {
    pub pid: u32,
    pub port: u16,
    pub creation_timestamp: Option<u64>,
    pub recorded_at_epoch_ms: u64,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StaleRuntimeCleanupReport {
    pub removed_config_files: usize,
    pub reaped_stale_child: bool,
    pub removed_stale_lease: bool,
}

pub fn sweep_stale_runtime_artifacts(runtime_root: &Path) -> StaleRuntimeCleanupReport {
    let mut report = StaleRuntimeCleanupReport::default();
    if !runtime_root.is_dir() {
        return report;
    }

    if let Ok(entries) = fs::read_dir(runtime_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name_str) = name.to_str() else {
                continue;
            };
            let is_temp_runtime_config = name_str == "runtime-config.yaml"
                || (name_str.starts_with(".runtime-config.yaml.") && name_str.ends_with(".tmp"));
            if is_temp_runtime_config && fs::remove_file(entry.path()).is_ok() {
                report.removed_config_files += 1;
            }
        }
    }

    let lease_path = runtime_root.join(CHILD_LEASE_FILENAME);
    if lease_path.is_file() {
        if let Ok(raw) = fs::read_to_string(&lease_path) {
            if let Ok(lease) = serde_json::from_str::<BundledCoreChildLease>(&raw) {
                if let Some(expected_creation) = lease.creation_timestamp {
                    if lease.pid != std::process::id()
                        && terminate_process_matching_creation_time(lease.pid, expected_creation)
                    {
                        report.reaped_stale_child = true;
                    }
                }
            }
        }
        if fs::remove_file(&lease_path).is_ok() {
            report.removed_stale_lease = true;
        }
    }

    report
}

pub fn write_core_child_lease(runtime_root: &Path, pid: u32, port: u16) -> Result<(), String> {
    fs::create_dir_all(runtime_root)
        .map_err(|err| format!("Could not prepare core runtime root: {err}"))?;
    let lease = BundledCoreChildLease {
        pid,
        port,
        creation_timestamp: process_creation_timestamp(pid),
        recorded_at_epoch_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };
    let payload = serde_json::to_vec_pretty(&lease)
        .map_err(|err| format!("Could not encode core child lease: {err}"))?;
    let lease_path = runtime_root.join(CHILD_LEASE_FILENAME);
    fs::write(&lease_path, payload)
        .map_err(|err| format!("Could not write core child lease: {err}"))?;
    let _ = restrict_path_to_current_user(&lease_path);
    Ok(())
}

pub fn remove_core_child_lease(runtime_root: &Path) {
    let _ = fs::remove_file(runtime_root.join(CHILD_LEASE_FILENAME));
}

#[derive(Debug, Default)]
pub struct CrashLoopGuard {
    restart_timestamps: Vec<Instant>,
}

impl CrashLoopGuard {
    pub fn record_crash_and_check_restart_allowed(&mut self, now: Instant) -> bool {
        self.restart_timestamps
            .retain(|ts| now.saturating_duration_since(*ts) <= CRASH_LOOP_WINDOW);
        if self.restart_timestamps.len() >= MAX_CRASH_RESTARTS_IN_WINDOW {
            return false;
        }
        self.restart_timestamps.push(now);
        true
    }

    pub fn restart_count(&self) -> usize {
        self.restart_timestamps.len()
    }
}

pub fn load_or_create_host_id(application_data_dir: &Path) -> Result<String, String> {
    fs::create_dir_all(application_data_dir)
        .map_err(|error| format!("Could not create EasyEmail application state: {error}"))?;
    let host_id_path = application_data_dir.join("desktop-host-id");
    if host_id_path.is_file() {
        return read_host_id(&host_id_path);
    }

    let host_id = format!("easyemail-desktop-{}", uuid::Uuid::new_v4().simple());
    let temporary_path = application_data_dir.join(format!(
        "desktop-host-id.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary_path)
        .map_err(|error| format!("Could not stage EasyEmail desktop host ID: {error}"))?;
    if let Err(error) = file
        .write_all(host_id.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary_path);
        return Err(format!(
            "Could not persist EasyEmail desktop host ID: {error}"
        ));
    }
    drop(file);
    let _ = restrict_path_to_current_user(&temporary_path);

    match fs::rename(&temporary_path, &host_id_path) {
        Ok(()) => {
            let _ = restrict_path_to_current_user(&host_id_path);
            Ok(host_id)
        }
        Err(_) if host_id_path.is_file() => {
            let _ = fs::remove_file(&temporary_path);
            read_host_id(&host_id_path)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary_path);
            Err(format!(
                "Could not install EasyEmail desktop host ID: {error}"
            ))
        }
    }
}

pub fn read_host_id(path: &Path) -> Result<String, String> {
    let host_id = fs::read_to_string(path)
        .map_err(|error| format!("Could not read EasyEmail desktop host ID: {error}"))?;
    let host_id = host_id.trim();
    let uuid_part = host_id
        .strip_prefix("easyemail-desktop-")
        .ok_or_else(|| "EasyEmail desktop host ID has an invalid prefix.".to_string())?;
    uuid::Uuid::parse_str(uuid_part)
        .map_err(|_| "EasyEmail desktop host ID is invalid.".to_string())?;
    Ok(host_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_lock_blocks_second_concurrent_holder_and_releases_on_drop() {
        let root = std::env::temp_dir().join(format!(
            "easyemail-instance-lock-test-{}",
            uuid::Uuid::new_v4()
        ));
        let first = HostInstanceLock::acquire(&root).expect("acquire first lock");
        assert!(first.lock_path().is_file());

        #[cfg(windows)]
        {
            let second_err = HostInstanceLock::acquire(&root)
                .err()
                .expect("second concurrent lock must fail");
            assert_eq!(second_err.code, "desktop_instance_already_running");
        }

        drop(first);
        let reacquired = HostInstanceLock::acquire(&root).expect("reacquire after drop");
        drop(reacquired);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn sweeps_stale_runtime_configs_and_mismatched_child_leases_safely() {
        let root = std::env::temp_dir().join(format!(
            "easyemail-stale-sweep-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("runtime-config.yaml"), "apiKey: secret").unwrap();
        fs::write(root.join(".runtime-config.yaml.123.tmp"), "apiKey: partial").unwrap();
        // Record current process PID with a bogus creation timestamp: must NOT terminate self!
        let bogus_lease = BundledCoreChildLease {
            pid: std::process::id(),
            port: 45123,
            creation_timestamp: Some(1),
            recorded_at_epoch_ms: 100,
        };
        fs::write(
            root.join(CHILD_LEASE_FILENAME),
            serde_json::to_vec(&bogus_lease).unwrap(),
        )
        .unwrap();

        let report = sweep_stale_runtime_artifacts(&root);
        assert_eq!(report.removed_config_files, 2);
        assert!(!report.reaped_stale_child);
        assert!(report.removed_stale_lease);
        assert!(!root.join("runtime-config.yaml").exists());
        assert!(!root.join(CHILD_LEASE_FILENAME).exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_loop_guard_allows_bounded_restarts_then_suppresses_within_window() {
        let mut guard = CrashLoopGuard::default();
        let t0 = Instant::now();
        assert!(guard.record_crash_and_check_restart_allowed(t0));
        assert!(guard.record_crash_and_check_restart_allowed(t0 + Duration::from_secs(10)));
        assert!(!guard.record_crash_and_check_restart_allowed(t0 + Duration::from_secs(20)));
        // After the 60s window passes, recovery is allowed again
        assert!(guard.record_crash_and_check_restart_allowed(t0 + Duration::from_secs(75)));
    }

    #[test]
    fn desktop_host_id_is_stable_valid_and_rejects_corrupt_state() {
        let root = std::env::temp_dir().join(format!("easyemail-host-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("desktop-host-id.abandoned.tmp"), "partial").unwrap();

        let first = load_or_create_host_id(&root).unwrap();
        let second = load_or_create_host_id(&root).unwrap();
        assert_eq!(first, second);
        assert!(first.starts_with("easyemail-desktop-"));
        assert_eq!(read_host_id(&root.join("desktop-host-id")).unwrap(), first);

        fs::write(root.join("desktop-host-id"), "not-a-host-id").unwrap();
        assert!(load_or_create_host_id(&root)
            .unwrap_err()
            .contains("invalid prefix"));
        let _ = fs::remove_dir_all(root);
    }
}
