use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::core_logs::append_host_lifecycle_log;
use crate::credential_broker::DesktopCredentialBroker;
use crate::host_lifecycle_guard::{
    load_or_create_host_id, remove_core_child_lease, sweep_stale_runtime_artifacts,
    write_core_child_lease, CrashLoopGuard,
};
use crate::redaction::redact_text;

#[path = "core_runtime_process.rs"]
mod process;
#[cfg(all(test, windows))]
use process::normalize_child_process_path;
use process::{
    configured_shutdown_timeout, reserve_loopback_port, resolve_core_command_paths,
    send_graceful_shutdown_and_wait, spawn_core, wait_until_ready, write_runtime_config,
    CoreCommandPaths,
};

const START_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Serialize)]
pub struct DesktopCoreRuntimeDto {
    pub status: String,
    pub base_url: String,
    pub api_token: String,
    pub host_id: String,
}

pub struct DesktopCoreRuntime {
    descriptor: DesktopCoreRuntimeDto,
    runtime_root: PathBuf,
    child: Mutex<Option<Child>>,
    control_stdin: Mutex<Option<ChildStdin>>,
    control_token: Zeroizing<String>,
    credential_broker: Mutex<Option<DesktopCredentialBroker>>,
}

enum DesktopCoreStartupStatus {
    Starting,
    Ready(Box<DesktopCoreRuntime>),
    Failed(String),
    Stopped,
}

type RuntimeStarterFn = Box<dyn FnMut(&AtomicBool) -> Result<DesktopCoreRuntime, String> + Send>;

struct DesktopCoreStartupInner {
    status: Mutex<DesktopCoreStartupStatus>,
    status_changed: Condvar,
    cancelled: Arc<AtomicBool>,
    starter: Mutex<RuntimeStarterFn>,
    crash_guard: Mutex<CrashLoopGuard>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

pub struct DesktopCoreRuntimeState {
    inner: Arc<DesktopCoreStartupInner>,
}

impl DesktopCoreRuntime {
    fn start_with_paths(
        command_paths: &CoreCommandPaths,
        application_data_dir: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Self, String> {
        let runtime_root = application_data_dir.join("core");
        let state_dir = runtime_root.join("state");
        fs::create_dir_all(&state_dir)
            .map_err(|error| format!("Could not create EasyEmail core state: {error}"))?;
        let sweep_report = sweep_stale_runtime_artifacts(&runtime_root);
        if sweep_report.removed_config_files > 0
            || sweep_report.reaped_stale_child
            || sweep_report.removed_stale_lease
        {
            append_host_lifecycle_log(
                &runtime_root,
                "core_stale_artifacts_swept",
                &format!(
                    "configs={} reaped_child={} removed_lease={}",
                    sweep_report.removed_config_files,
                    sweep_report.reaped_stale_child,
                    sweep_report.removed_stale_lease
                ),
            );
        }

        let host_id = load_or_create_host_id(application_data_dir)?;
        let api_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut last_error = "EasyEmail core did not start.".to_string();

        for attempt in 1..=START_ATTEMPTS {
            if cancelled.load(Ordering::Acquire) {
                return Err("EasyEmail core startup was cancelled.".to_string());
            }
            let port = reserve_loopback_port()?;
            let base_url = format!("http://127.0.0.1:{port}");
            let config_path = runtime_root.join("runtime-config.yaml");
            write_runtime_config(&config_path, &state_dir, port, &api_token)?;
            let credential_broker = match DesktopCredentialBroker::start(&base_url, &api_token) {
                Ok(broker) => broker,
                Err(error) => {
                    let _ = fs::remove_file(&config_path);
                    last_error = error;
                    continue;
                }
            };

            let mut spawned = match spawn_core(
                command_paths,
                &config_path,
                &state_dir,
                &runtime_root,
                credential_broker.base_url(),
                credential_broker.bearer_token(),
            ) {
                Ok(spawned) => spawned,
                Err(error) => {
                    credential_broker.stop();
                    let _ = fs::remove_file(&config_path);
                    last_error = error;
                    continue;
                }
            };

            match wait_until_ready(
                &mut spawned.child,
                port,
                &base_url,
                &api_token,
                &spawned.instance_nonce,
                cancelled,
            ) {
                Ok(()) => {
                    let _ = fs::remove_file(&config_path);
                    let child_pid = spawned.child.id();
                    let _ = write_core_child_lease(&runtime_root, child_pid, port);
                    append_host_lifecycle_log(
                        &runtime_root,
                        "core_ready",
                        &format!("attempt={attempt} pid={child_pid} port={port}"),
                    );
                    return Ok(Self {
                        descriptor: DesktopCoreRuntimeDto {
                            status: "ready".to_string(),
                            base_url,
                            api_token,
                            host_id,
                        },
                        runtime_root,
                        child: Mutex::new(Some(spawned.child)),
                        control_stdin: Mutex::new(spawned.control_stdin),
                        control_token: spawned.control_token,
                        credential_broker: Mutex::new(Some(credential_broker)),
                    });
                }
                Err(error) => {
                    append_host_lifecycle_log(
                        &runtime_root,
                        "core_start_attempt_failed",
                        &format!("attempt={attempt} reason={error}"),
                    );
                    last_error = error;
                    let _ = spawned.child.kill();
                    let _ = spawned.child.wait();
                    credential_broker.stop();
                    let _ = fs::remove_file(&config_path);
                }
            }
        }

        Err(redact_text(&last_error))
    }

    pub fn descriptor(&self) -> Result<DesktopCoreRuntimeDto, String> {
        let mut child = self
            .child
            .lock()
            .map_err(|_| "EasyEmail core process lock is unavailable.".to_string())?;
        let process = child
            .as_mut()
            .ok_or_else(|| "EasyEmail core is not running.".to_string())?;
        if let Some(status) = process
            .try_wait()
            .map_err(|error| format!("Could not inspect EasyEmail core process: {error}"))?
        {
            *child = None;
            drop(child);
            if let Ok(mut stdin) = self.control_stdin.lock() {
                let _ = stdin.take();
            }
            remove_core_child_lease(&self.runtime_root);
            self.stop_credential_broker();
            append_host_lifecycle_log(
                &self.runtime_root,
                "core_unexpected_exit",
                &format!("status={status}"),
            );
            return Err(format!(
                "EasyEmail core exited unexpectedly with status {status}."
            ));
        }
        Ok(self.descriptor.clone())
    }

    pub fn stop(&self) {
        self.stop_with_timeout(configured_shutdown_timeout());
    }

    fn stop_with_timeout(&self, timeout: Duration) {
        let stdin = self
            .control_stdin
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                let pid = process.id();
                if send_graceful_shutdown_and_wait(
                    &mut process,
                    stdin,
                    self.control_token.as_str(),
                    timeout,
                ) {
                    append_host_lifecycle_log(
                        &self.runtime_root,
                        "core_graceful_stop",
                        &format!("pid={pid}"),
                    );
                } else {
                    // Graceful control timed out or was unavailable; terminate and reap
                    // only the exact child spawned by this host instance.
                    let _ = process.kill();
                    let _ = process.wait();
                    append_host_lifecycle_log(
                        &self.runtime_root,
                        "core_forced_kill_fallback",
                        &format!("pid={pid}"),
                    );
                }
            }
        }
        remove_core_child_lease(&self.runtime_root);
        self.stop_credential_broker();
    }

    fn stop_credential_broker(&self) {
        if let Ok(mut broker) = self.credential_broker.lock() {
            if let Some(broker) = broker.take() {
                broker.stop();
            }
        }
    }
}

impl DesktopCoreRuntimeState {
    pub fn start_background(app: &tauri::App, application_data_dir: &Path) -> Result<Self, String> {
        let command_paths = resolve_core_command_paths(app)?;
        let application_data_dir = application_data_dir.to_path_buf();
        Self::start_background_with(move |cancelled| {
            DesktopCoreRuntime::start_with_paths(&command_paths, &application_data_dir, cancelled)
        })
    }

    fn start_background_with<F>(starter: F) -> Result<Self, String>
    where
        F: FnMut(&AtomicBool) -> Result<DesktopCoreRuntime, String> + Send + 'static,
    {
        let inner = Arc::new(DesktopCoreStartupInner {
            status: Mutex::new(DesktopCoreStartupStatus::Starting),
            status_changed: Condvar::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            starter: Mutex::new(Box::new(starter)),
            crash_guard: Mutex::new(CrashLoopGuard::default()),
            worker: Mutex::new(None),
        });
        let worker_inner = Arc::clone(&inner);
        let worker = thread::Builder::new()
            .name("easyemail-core-startup".to_string())
            .spawn(move || {
                let result = worker_inner
                    .starter
                    .lock()
                    .map_err(|_| "EasyEmail core starter lock is unavailable.".to_string())
                    .and_then(|mut run_starter| run_starter(worker_inner.cancelled.as_ref()));
                Self::publish_startup_result(&worker_inner, result);
            })
            .map_err(|error| format!("Could not start EasyEmail core startup worker: {error}"))?;
        inner
            .worker
            .lock()
            .map_err(|_| "EasyEmail core startup worker lock is unavailable.".to_string())?
            .replace(worker);
        Ok(Self { inner })
    }

    fn publish_startup_result(
        inner: &DesktopCoreStartupInner,
        result: Result<DesktopCoreRuntime, String>,
    ) {
        let mut runtime_to_stop = None;
        if let Ok(mut status) = inner.status.lock() {
            if inner.cancelled.load(Ordering::Acquire) {
                runtime_to_stop = result.ok();
                *status = DesktopCoreStartupStatus::Stopped;
            } else {
                *status = match result {
                    Ok(runtime) => DesktopCoreStartupStatus::Ready(Box::new(runtime)),
                    Err(error) => DesktopCoreStartupStatus::Failed(error),
                };
            }
            inner.status_changed.notify_all();
        } else if let Ok(runtime) = result {
            runtime_to_stop = Some(runtime);
        }
        if let Some(runtime) = runtime_to_stop {
            runtime.stop();
        }
    }

    fn wait_for_descriptor(
        inner: &DesktopCoreStartupInner,
    ) -> Result<DesktopCoreRuntimeDto, String> {
        let mut status = inner
            .status
            .lock()
            .map_err(|_| "EasyEmail core startup state is unavailable.".to_string())?;
        loop {
            match &*status {
                DesktopCoreStartupStatus::Starting => {
                    status = inner
                        .status_changed
                        .wait(status)
                        .map_err(|_| "EasyEmail core startup state is unavailable.".to_string())?;
                }
                DesktopCoreStartupStatus::Ready(runtime) => match runtime.descriptor() {
                    Ok(descriptor) => return Ok(descriptor),
                    Err(exit_error) => {
                        if inner.cancelled.load(Ordering::Acquire) {
                            *status = DesktopCoreStartupStatus::Stopped;
                            inner.status_changed.notify_all();
                            return Err("EasyEmail core startup was stopped.".to_string());
                        }
                        let restart_allowed = inner
                            .crash_guard
                            .lock()
                            .map(|mut guard| {
                                guard.record_crash_and_check_restart_allowed(Instant::now())
                            })
                            .unwrap_or(false);
                        if !restart_allowed {
                            let suppressed = format!(
                                "EasyEmail core crash recovery suppressed after repeated exits: {}",
                                redact_text(&exit_error)
                            );
                            append_host_lifecycle_log(
                                &runtime.runtime_root,
                                "core_crash_loop_suppressed",
                                &suppressed,
                            );
                            *status = DesktopCoreStartupStatus::Failed(suppressed.clone());
                            inner.status_changed.notify_all();
                            return Err(suppressed);
                        }
                        append_host_lifecycle_log(
                            &runtime.runtime_root,
                            "core_unexpected_exit_restarting",
                            &exit_error,
                        );
                        *status = DesktopCoreStartupStatus::Starting;
                        inner.status_changed.notify_all();
                        drop(status);

                        let restart_result = inner
                            .starter
                            .lock()
                            .map_err(|_| "EasyEmail core starter lock is unavailable.".to_string())
                            .and_then(|mut run_starter| run_starter(inner.cancelled.as_ref()));
                        Self::publish_startup_result(inner, restart_result);
                        status = inner.status.lock().map_err(|_| {
                            "EasyEmail core startup state is unavailable.".to_string()
                        })?;
                    }
                },
                DesktopCoreStartupStatus::Failed(error) => return Err(error.clone()),
                DesktopCoreStartupStatus::Stopped => {
                    return Err("EasyEmail core startup was stopped.".to_string());
                }
            }
        }
    }

    pub fn stop(&self) {
        self.inner.cancelled.store(true, Ordering::Release);
        let runtime = self.inner.status.lock().ok().and_then(|mut status| {
            let previous = std::mem::replace(&mut *status, DesktopCoreStartupStatus::Stopped);
            self.inner.status_changed.notify_all();
            match previous {
                DesktopCoreStartupStatus::Ready(runtime) => Some(runtime),
                _ => None,
            }
        });
        if let Some(runtime) = runtime {
            runtime.stop();
        }
        if let Some(worker) = self
            .inner
            .worker
            .lock()
            .ok()
            .and_then(|mut worker| worker.take())
        {
            let _ = worker.join();
        }
    }
}

impl Drop for DesktopCoreRuntimeState {
    fn drop(&mut self) {
        self.stop();
    }
}

impl Drop for DesktopCoreRuntime {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub async fn desktop_core_runtime(
    runtime: tauri::State<'_, DesktopCoreRuntimeState>,
) -> Result<DesktopCoreRuntimeDto, String> {
    let inner = Arc::clone(&runtime.inner);
    tauri::async_runtime::spawn_blocking(move || {
        DesktopCoreRuntimeState::wait_for_descriptor(inner.as_ref())
    })
    .await
    .map_err(|_| "EasyEmail core readiness task failed.".to_string())?
}

#[cfg(test)]
#[path = "core_runtime_tests.rs"]
mod tests;
