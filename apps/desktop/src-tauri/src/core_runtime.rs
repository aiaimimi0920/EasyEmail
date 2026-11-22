use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;

use serde::Serialize;

use crate::credential_broker::DesktopCredentialBroker;
use crate::redaction::redact_text;

#[path = "core_runtime_process.rs"]
mod process;
#[cfg(all(test, windows))]
use process::normalize_child_process_path;
use process::{
    reserve_loopback_port, resolve_core_command_paths, spawn_core, wait_until_ready,
    write_runtime_config, CoreCommandPaths,
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
    child: Mutex<Option<Child>>,
    credential_broker: Mutex<Option<DesktopCredentialBroker>>,
}

enum DesktopCoreStartupStatus {
    Starting,
    Ready(Box<DesktopCoreRuntime>),
    Failed(String),
    Stopped,
}

struct DesktopCoreStartupInner {
    status: Mutex<DesktopCoreStartupStatus>,
    status_changed: Condvar,
    cancelled: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

pub struct DesktopCoreRuntimeState {
    inner: Arc<DesktopCoreStartupInner>,
}

impl DesktopCoreRuntime {
    fn start_with_paths(
        command_paths: CoreCommandPaths,
        application_data_dir: &Path,
        cancelled: &AtomicBool,
    ) -> Result<Self, String> {
        let runtime_root = application_data_dir.join("core");
        let state_dir = runtime_root.join("state");
        fs::create_dir_all(&state_dir)
            .map_err(|error| format!("Could not create EasyEmail core state: {error}"))?;
        let host_id = load_or_create_host_id(application_data_dir)?;

        let api_token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        let mut last_error = "EasyEmail core did not start.".to_string();

        for _ in 0..START_ATTEMPTS {
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

            let mut child = match spawn_core(
                &command_paths,
                &config_path,
                &state_dir,
                &runtime_root.join("core.log"),
                credential_broker.base_url(),
                credential_broker.bearer_token(),
            ) {
                Ok(child) => child,
                Err(error) => {
                    credential_broker.stop();
                    let _ = fs::remove_file(&config_path);
                    last_error = error;
                    continue;
                }
            };

            match wait_until_ready(&mut child, &base_url, &api_token, cancelled) {
                Ok(()) => {
                    let _ = fs::remove_file(&config_path);
                    return Ok(Self {
                        descriptor: DesktopCoreRuntimeDto {
                            status: "ready".to_string(),
                            base_url,
                            api_token,
                            host_id,
                        },
                        child: Mutex::new(Some(child)),
                        credential_broker: Mutex::new(Some(credential_broker)),
                    });
                }
                Err(error) => {
                    last_error = error;
                    let _ = child.kill();
                    let _ = child.wait();
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
            self.stop_credential_broker();
            return Err(format!(
                "EasyEmail core exited unexpectedly with status {status}."
            ));
        }
        Ok(self.descriptor.clone())
    }

    pub fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut process) = child.take() {
                // The Node core does not yet expose a graceful local shutdown endpoint.
                // Kill only the exact child created by this host and always reap it.
                let _ = process.kill();
                let _ = process.wait();
            }
        }
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
            DesktopCoreRuntime::start_with_paths(
                command_paths,
                &application_data_dir,
                cancelled.as_ref(),
            )
        })
    }

    fn start_background_with<F>(starter: F) -> Result<Self, String>
    where
        F: FnOnce(Arc<AtomicBool>) -> Result<DesktopCoreRuntime, String> + Send + 'static,
    {
        let inner = Arc::new(DesktopCoreStartupInner {
            status: Mutex::new(DesktopCoreStartupStatus::Starting),
            status_changed: Condvar::new(),
            cancelled: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        });
        let worker_inner = Arc::clone(&inner);
        let cancelled = Arc::clone(&inner.cancelled);
        let worker = thread::Builder::new()
            .name("easyemail-core-startup".to_string())
            .spawn(move || {
                let result = starter(cancelled);
                let mut runtime_to_stop = None;
                if let Ok(mut status) = worker_inner.status.lock() {
                    if worker_inner.cancelled.load(Ordering::Acquire) {
                        runtime_to_stop = result.ok();
                        *status = DesktopCoreStartupStatus::Stopped;
                    } else {
                        *status = match result {
                            Ok(runtime) => DesktopCoreStartupStatus::Ready(Box::new(runtime)),
                            Err(error) => DesktopCoreStartupStatus::Failed(error),
                        };
                    }
                    worker_inner.status_changed.notify_all();
                } else if let Ok(runtime) = result {
                    runtime_to_stop = Some(runtime);
                }
                if let Some(runtime) = runtime_to_stop {
                    runtime.stop();
                }
            })
            .map_err(|error| format!("Could not start EasyEmail core startup worker: {error}"))?;
        inner
            .worker
            .lock()
            .map_err(|_| "EasyEmail core startup worker lock is unavailable.".to_string())?
            .replace(worker);
        Ok(Self { inner })
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
                DesktopCoreStartupStatus::Ready(runtime) => return runtime.descriptor(),
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

fn load_or_create_host_id(application_data_dir: &Path) -> Result<String, String> {
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

    match fs::rename(&temporary_path, &host_id_path) {
        Ok(()) => Ok(host_id),
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

fn read_host_id(path: &Path) -> Result<String, String> {
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
mod tests {
    use super::*;
    use std::net::TcpListener;
    #[cfg(windows)]
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn background_start_returns_while_core_is_still_starting() {
        let (started_sender, started_receiver) = mpsc::channel();
        let (release_sender, release_receiver) = mpsc::channel();
        let state = DesktopCoreRuntimeState::start_background_with(move |_| {
            started_sender.send(()).unwrap();
            release_receiver.recv().unwrap();
            Err("controlled delayed startup".to_string())
        })
        .unwrap();

        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("the background startup worker should begin without blocking its caller");
        assert!(matches!(
            *state.inner.status.lock().unwrap(),
            DesktopCoreStartupStatus::Starting
        ));

        release_sender.send(()).unwrap();
        assert_eq!(
            DesktopCoreRuntimeState::wait_for_descriptor(state.inner.as_ref()).unwrap_err(),
            "controlled delayed startup"
        );
        state.stop();
    }

    #[test]
    fn renderer_descriptor_never_contains_credential_broker_access() {
        let descriptor = DesktopCoreRuntimeDto {
            status: "ready".to_string(),
            base_url: "http://127.0.0.1:32123".to_string(),
            api_token: "renderer-core-token".to_string(),
            host_id: "easyemail-desktop-00000000000000000000000000000001".to_string(),
        };

        let serialized = serde_json::to_string(&descriptor).unwrap();

        assert!(!serialized.contains("credential_broker"));
        assert!(!serialized.contains("EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER"));
    }

    #[test]
    fn generated_runtime_config_is_loopback_authenticated_and_persistent() {
        let root =
            std::env::temp_dir().join(format!("easyemail-core-config-{}", uuid::Uuid::new_v4()));
        let state = root.join("state");
        fs::create_dir_all(&state).unwrap();
        let config_path = root.join("runtime-config.yaml");
        fs::write(&config_path, "stale-or-partial-config").unwrap();

        write_runtime_config(&config_path, &state, 32123, "test-token").unwrap();
        let config = fs::read_to_string(&config_path).unwrap();

        assert!(config.contains("host: 127.0.0.1"));
        assert!(config.contains("port: 32123"));
        assert!(config.contains("apiKey: \"test-token\""));
        assert!(config.contains(
            "corsOrigins: [http://tauri.localhost, https://tauri.localhost, http://localhost:1420]"
        ));
        assert!(config.contains("driver: file"));
        assert!(config.contains("activeProbeEnabled: false"));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reserved_port_is_loopback_and_nonzero() {
        let port = reserve_loopback_port().unwrap();
        assert_ne!(port, 0);
        let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip().to_string(), "127.0.0.1");
    }

    #[test]
    fn desktop_host_id_is_stable_and_valid() {
        let root = std::env::temp_dir().join(format!("easyemail-host-id-{}", uuid::Uuid::new_v4()));

        let first = load_or_create_host_id(&root).unwrap();
        let second = load_or_create_host_id(&root).unwrap();

        assert_eq!(first, second);
        assert!(first.starts_with("easyemail-desktop-"));
        assert!(!first.contains(' '));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_host_id_rejects_corrupt_state() {
        let root = std::env::temp_dir().join(format!("easyemail-host-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("desktop-host-id"), "not-a-host-id").unwrap();

        let error = load_or_create_host_id(&root).unwrap_err();

        assert!(error.contains("invalid prefix"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn desktop_host_id_ignores_abandoned_staging_file() {
        let root = std::env::temp_dir().join(format!("easyemail-host-id-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("desktop-host-id.abandoned.tmp"), "partial").unwrap();

        let host_id = load_or_create_host_id(&root).unwrap();

        assert!(host_id.starts_with("easyemail-desktop-"));
        assert_eq!(
            read_host_id(&root.join("desktop-host-id")).unwrap(),
            host_id
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn node_child_paths_drop_windows_verbatim_prefixes() {
        assert_eq!(
            normalize_child_process_path(PathBuf::from(r"\\?\C:\Apps\NMail\core")),
            PathBuf::from(r"C:\Apps\NMail\core")
        );
        assert_eq!(
            normalize_child_process_path(PathBuf::from(r"\\?\UNC\server\share\NMail")),
            PathBuf::from(r"\\server\share\NMail")
        );
    }
}
