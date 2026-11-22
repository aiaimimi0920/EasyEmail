use std::fs::{self, OpenOptions};
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use tauri::Manager;
use zeroize::Zeroizing;

use crate::core_logs::prepare_core_log_file;
use crate::host_os_security::{owning_pid_for_loopback_ipv4_port, restrict_path_to_current_user};

const READINESS_TIMEOUT: Duration = Duration::from_secs(15);
const READINESS_INTERVAL: Duration = Duration::from_millis(150);
const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone)]
pub(super) struct CoreCommandPaths {
    node: PathBuf,
    entry: PathBuf,
    working_directory: PathBuf,
}

pub(super) struct SpawnedCoreProcess {
    pub child: Child,
    pub control_stdin: Option<ChildStdin>,
    pub control_token: Zeroizing<String>,
    pub instance_nonce: String,
}

pub(super) fn resolve_core_command_paths(app: &tauri::App) -> Result<CoreCommandPaths, String> {
    let overridden_node = std::env::var_os("EASY_EMAIL_DESKTOP_NODE_PATH").map(PathBuf::from);
    let overridden_entry = std::env::var_os("EASY_EMAIL_DESKTOP_CORE_ENTRY").map(PathBuf::from);
    if overridden_node.is_some() || overridden_entry.is_some() {
        let node = overridden_node.unwrap_or_else(|| PathBuf::from("node"));
        let entry = overridden_entry.ok_or_else(|| {
            "EASY_EMAIL_DESKTOP_CORE_ENTRY is required when overriding the core command."
                .to_string()
        })?;
        let working_directory = entry
            .ancestors()
            .nth(4)
            .map(Path::to_path_buf)
            .or_else(|| entry.parent().map(Path::to_path_buf))
            .ok_or_else(|| {
                "The overridden EasyEmail core entry has no parent directory.".to_string()
            })?;
        return validate_core_paths(CoreCommandPaths {
            node,
            entry,
            working_directory,
        });
    }

    if cfg!(debug_assertions) {
        let service_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("..")
            .join("service")
            .join("base");
        return validate_core_paths(CoreCommandPaths {
            node: PathBuf::from("node"),
            entry: service_root.join("dist/src/runtime/main.js"),
            working_directory: service_root,
        });
    }

    let resource_root = normalize_child_process_path(
        app.path()
            .resource_dir()
            .map_err(|error| format!("Could not resolve desktop resource directory: {error}"))?,
    )
    .join("core");
    validate_core_paths(CoreCommandPaths {
        node: resource_root.join(if cfg!(windows) { "node.exe" } else { "node" }),
        entry: resource_root.join("dist/src/runtime/main.js"),
        working_directory: resource_root,
    })
}

pub(super) fn normalize_child_process_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        // Tauri returns verbatim Windows resource paths. Node treats a verbatim
        // script argument as `C:` and fails before loading the entry module.
        let display = path.to_string_lossy();
        if let Some(unc_path) = display.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc_path}"));
        }
        if let Some(drive_path) = display.strip_prefix(r"\\?\") {
            return PathBuf::from(drive_path);
        }
    }
    path
}

fn validate_core_paths(paths: CoreCommandPaths) -> Result<CoreCommandPaths, String> {
    if !paths.entry.is_file() {
        return Err(format!(
            "Packaged EasyEmail core entry is missing: {}",
            paths.entry.display()
        ));
    }
    if paths.node.components().count() > 1 && !paths.node.is_file() {
        return Err(format!(
            "Packaged EasyEmail Node runtime is missing: {}",
            paths.node.display()
        ));
    }
    Ok(paths)
}

pub(super) fn reserve_loopback_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("Could not reserve a loopback port: {error}"))?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|error| format!("Could not inspect the loopback port: {error}"))
}

pub(super) fn write_runtime_config(
    config_path: &Path,
    state_dir: &Path,
    port: u16,
    api_token: &str,
) -> Result<(), String> {
    let state_path = state_dir
        .to_str()
        .ok_or_else(|| "EasyEmail core state path is not valid UTF-8.".to_string())?
        .replace('\\', "/")
        .replace('"', "\\\"");
    let config = format!(
        "server:\n  host: 127.0.0.1\n  port: {port}\n  apiKey: \"{api_token}\"\n  corsOrigins: [http://tauri.localhost, https://tauri.localhost, http://localhost:1420]\n\
         maintenance:\n  enabled: true\n  intervalMs: 30000\n  keepRecentCount: 5\n  keepRecentSessionCount: 5000\n  activeProbeEnabled: false\n\
         persistence:\n  enabled: true\n  driver: file\n  intervalMs: 5000\n  filePath: \"{state_path}/easy-email-state.json\"\n"
    );
    let file_name = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "EasyEmail core config path has no valid file name.".to_string())?;
    let staging_path = config_path.with_file_name(format!(
        ".{file_name}.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let staged = (|| -> Result<(), String> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging_path)
            .map_err(|error| format!("Could not stage EasyEmail core config: {error}"))?;
        file.write_all(config.as_bytes())
            .map_err(|error| format!("Could not write EasyEmail core config: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not flush EasyEmail core config: {error}"))
    })();
    if let Err(error) = staged {
        let _ = fs::remove_file(&staging_path);
        return Err(error);
    }
    let _ = restrict_path_to_current_user(&staging_path);

    if let Err(error) = fs::rename(&staging_path, config_path) {
        if !config_path.exists() {
            let _ = fs::remove_file(&staging_path);
            return Err(format!("Could not publish EasyEmail core config: {error}"));
        }
        fs::remove_file(config_path).map_err(|remove_error| {
            let _ = fs::remove_file(&staging_path);
            format!("Could not replace stale EasyEmail core config: {remove_error}")
        })?;
        fs::rename(&staging_path, config_path).map_err(|rename_error| {
            let _ = fs::remove_file(&staging_path);
            format!("Could not publish EasyEmail core config: {rename_error}")
        })?;
    }
    let _ = restrict_path_to_current_user(config_path);
    Ok(())
}

pub(super) fn spawn_core(
    paths: &CoreCommandPaths,
    config_path: &Path,
    state_dir: &Path,
    runtime_root: &Path,
    credential_broker_url: &str,
    credential_broker_token: &str,
) -> Result<SpawnedCoreProcess, String> {
    let log_path = prepare_core_log_file(runtime_root)?;
    let mut stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("Could not open EasyEmail core log: {error}"))?;
    writeln!(
        stdout,
        "[desktop-host] node={} entry={} cwd={}",
        paths.node.display(),
        paths.entry.display(),
        paths.working_directory.display()
    )
    .map_err(|error| format!("Could not write EasyEmail core startup context: {error}"))?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("Could not clone EasyEmail core log handle: {error}"))?;

    let control_token = Zeroizing::new(format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    ));
    let instance_nonce = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.entry)
        .current_dir(&paths.working_directory)
        .env("EASY_EMAIL_CONFIG_PATH", config_path)
        .env("EASY_EMAIL_STATE_DIR", state_dir)
        .env("EASY_EMAIL_RESET_STORE_ON_BOOT", "false")
        .env("EASY_EMAIL_BUNDLED_CHILD_MODE", "1")
        .env("EASY_EMAIL_BUNDLED_CONTROL_TOKEN", control_token.as_str())
        .env("EASY_EMAIL_BUNDLED_INSTANCE_NONCE", &instance_nonce)
        .env(
            "EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_URL",
            credential_broker_url,
        )
        .env(
            "EASY_EMAIL_DESKTOP_CREDENTIAL_BROKER_TOKEN",
            credential_broker_token,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start packaged EasyEmail core: {error}"))?;

    let control_stdin = child.stdin.take();
    Ok(SpawnedCoreProcess {
        child,
        control_stdin,
        control_token,
        instance_nonce,
    })
}

pub(super) fn wait_until_ready(
    child: &mut Child,
    port: u16,
    base_url: &str,
    api_token: &str,
    expected_nonce: &str,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let deadline = Instant::now() + READINESS_TIMEOUT;
    let readiness_url = format!("{base_url}/mail/catalog");
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(2))
        .build();

    while Instant::now() < deadline {
        if cancelled.load(Ordering::Acquire) {
            return Err("EasyEmail core startup was cancelled.".to_string());
        }
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("Could not inspect EasyEmail core startup: {error}"))?
        {
            return Err(format!(
                "EasyEmail core exited during startup with status {status}."
            ));
        }

        match agent
            .get(&readiness_url)
            .set("Authorization", &format!("Bearer {api_token}"))
            .call()
        {
            Ok(response) => {
                if response.header("x-easyemail-bundled-nonce") != Some(expected_nonce) {
                    return Err(
                        "Loopback listener failed bundled instance nonce verification.".to_string(),
                    );
                }
                #[cfg(windows)]
                {
                    match owning_pid_for_loopback_ipv4_port(port) {
                        Some(owner_pid) if owner_pid == child.id() => {}
                        Some(owner_pid) => {
                            return Err(format!(
                                "Loopback listener on port {port} is owned by PID {owner_pid}, expected child PID {}.",
                                child.id()
                            ));
                        }
                        None => {
                            return Err(format!(
                                "Could not verify loopback listener PID ownership on port {port}."
                            ));
                        }
                    }
                }
                return Ok(());
            }
            Err(ureq::Error::Status(_, _)) => {
                if let Some(owner_pid) = owning_pid_for_loopback_ipv4_port(port) {
                    if owner_pid != child.id() {
                        return Err(format!(
                            "Port {port} is occupied by another local listener (PID {owner_pid})."
                        ));
                    }
                }
            }
            Err(_) => {}
        }
        thread::sleep(READINESS_INTERVAL);
    }

    Err("EasyEmail core readiness timed out.".to_string())
}

pub(super) fn configured_shutdown_timeout() -> Duration {
    std::env::var("EASY_EMAIL_DESKTOP_SHUTDOWN_TIMEOUT_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|ms| Duration::from_millis(ms.clamp(100, 15_000)))
        .unwrap_or(DEFAULT_SHUTDOWN_TIMEOUT)
}

pub(super) fn send_graceful_shutdown_and_wait(
    process: &mut Child,
    mut control_stdin: Option<ChildStdin>,
    control_token: &str,
    timeout: Duration,
) -> bool {
    if let Some(stdin) = control_stdin.as_mut() {
        let message = serde_json::json!({
            "protocolVersion": 1,
            "command": "shutdown",
            "controlToken": control_token,
        });
        let _ = writeln!(stdin, "{message}");
        let _ = stdin.flush();
    }

    let deadline = Instant::now() + timeout;
    let exited = loop {
        match process.try_wait() {
            Ok(Some(_)) => break true,
            Ok(None) => {
                if Instant::now() >= deadline {
                    break false;
                }
                thread::sleep(SHUTDOWN_POLL_INTERVAL);
            }
            Err(_) => break false,
        }
    };
    drop(control_stdin);
    exited
}
