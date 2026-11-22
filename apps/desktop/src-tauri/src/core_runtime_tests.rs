use super::*;
use std::net::TcpListener;
use std::process::{Command, Stdio};
use std::sync::mpsc;

fn build_mock_runtime(mut child: Child, runtime_root: PathBuf, port: u16) -> DesktopCoreRuntime {
    let stdin = child.stdin.take();
    DesktopCoreRuntime {
        descriptor: DesktopCoreRuntimeDto {
            status: "ready".to_string(),
            base_url: format!("http://127.0.0.1:{port}"),
            api_token: "test-token".to_string(),
            host_id: "easyemail-desktop-00000000000000000000000000000001".to_string(),
        },
        runtime_root,
        child: Mutex::new(Some(child)),
        control_stdin: Mutex::new(stdin),
        control_token: Zeroizing::new("control-secret-123".to_string()),
        credential_broker: Mutex::new(None),
    }
}

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
    let root = std::env::temp_dir().join(format!("easyemail-core-config-{}", uuid::Uuid::new_v4()));
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
fn stop_uses_graceful_control_channel_and_escalates_on_timeout() {
    let root = std::env::temp_dir().join(format!("easyemail-core-stop-{}", uuid::Uuid::new_v4()));
    let runtime_root = root.join("core");
    fs::create_dir_all(&runtime_root).unwrap();

    #[cfg(windows)]
    let graceful_child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            "$line = [Console]::In.ReadLine(); if ($line -match '\"command\":\"shutdown\"') { exit 0 } else { exit 2 }",
        ])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    #[cfg(not(windows))]
    let graceful_child = Command::new("sh")
        .args(["-c", "read line; exit 0"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();

    let graceful_runtime = build_mock_runtime(graceful_child, runtime_root.clone(), 41001);
    graceful_runtime.stop_with_timeout(Duration::from_secs(5));
    let log_after_graceful =
        fs::read_to_string(runtime_root.join("logs/core.log")).unwrap_or_default();
    assert!(log_after_graceful.contains("event=core_graceful_stop"));

    #[cfg(windows)]
    let wedged_child = Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    #[cfg(not(windows))]
    let wedged_child = Command::new("sh")
        .args(["-c", "sleep 30"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();

    let wedged_runtime = build_mock_runtime(wedged_child, runtime_root.clone(), 41002);
    wedged_runtime.stop_with_timeout(Duration::from_millis(150));
    let log_after_forced =
        fs::read_to_string(runtime_root.join("logs/core.log")).unwrap_or_default();
    assert!(log_after_forced.contains("event=core_forced_kill_fallback"));
    let _ = fs::remove_dir_all(root);
}

#[test]
fn unexpected_core_exit_restarts_bounded_times_then_suppresses_crash_loop() {
    let root = std::env::temp_dir().join(format!("easyemail-crash-loop-{}", uuid::Uuid::new_v4()));
    let runtime_root = root.join("core");
    fs::create_dir_all(&runtime_root).unwrap();
    let mut generation = 0u16;
    let runtime_root_for_starter = runtime_root.clone();

    let state = DesktopCoreRuntimeState::start_background_with(move |_| {
        generation += 1;
        #[cfg(windows)]
        let short_lived = Command::new("cmd")
            .args(["/C", "exit 1"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let short_lived = Command::new("sh")
            .args(["-c", "exit 1"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        Ok(build_mock_runtime(
            short_lived,
            runtime_root_for_starter.clone(),
            42000 + generation,
        ))
    })
    .unwrap();

    let mut terminal_error = None;
    for _ in 0..5 {
        thread::sleep(Duration::from_millis(100));
        match DesktopCoreRuntimeState::wait_for_descriptor(state.inner.as_ref()) {
            Ok(_) => continue,
            Err(err) => {
                terminal_error = Some(err);
                break;
            }
        }
    }

    let err = terminal_error.expect("crash loop should eventually be suppressed");
    assert!(err.contains("crash recovery suppressed"));
    let log_text = fs::read_to_string(runtime_root.join("logs/core.log")).unwrap_or_default();
    assert!(log_text.contains("event=core_unexpected_exit_restarting"));
    assert!(log_text.contains("event=core_crash_loop_suppressed"));
    state.stop();
    let _ = fs::remove_dir_all(root);
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
