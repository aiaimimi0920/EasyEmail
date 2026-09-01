use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::Connection;

use crate::diagnostics::DiagnosticLogger;
use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::events::InMemoryEventBus;
use crate::storage::account_repository::ensure_anonymous_virtual_account;
use crate::storage::db::open_database;
use crate::storage::migrations::run_migrations;
use crate::time::now_rfc3339;

pub struct AppState {
    pub connection: Mutex<Connection>,
    pub event_bus: InMemoryEventBus,
    pub diagnostic_logger: DiagnosticLogger,
    pub data_dir: PathBuf,
}

impl AppState {
    pub fn open_default() -> Result<Self, AppError> {
        let current_dir = std::env::current_dir().map_err(|err| AppError {
            code: "data_dir_unavailable".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The application data directory is unavailable.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        })?;
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let platform_data_dir = dirs::data_local_dir().map(|path| path.join("com.easyemailam.app"));
        let data_dir = resolve_default_data_dir(
            &current_dir,
            exe_dir.as_deref(),
            std::env::var("EASYEMAILAM_DATA_DIR").ok().as_deref(),
            platform_data_dir.as_deref(),
            cfg!(debug_assertions),
        );

        fs::create_dir_all(&data_dir).map_err(|err| AppError {
            code: "data_dir_create_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The application data directory could not be created.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "path": data_dir.display().to_string() })),
        })?;

        let database_path = data_dir.join("easyemailam.sqlite");
        let connection = open_database(&database_path).map_err(|err| AppError {
            code: "sqlite_open_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database could not be opened.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "path": database_path.display().to_string() })),
        })?;

        run_migrations(&connection).map_err(|err| AppError {
            code: "sqlite_migration_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The local database schema could not be prepared.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        })?;

        ensure_anonymous_virtual_account(&connection, now_rfc3339()).map_err(|err| AppError {
            code: "anonymous_account_init_failed".to_string(),
            category: ErrorCategory::Storage,
            user_message: "The anonymous mailbox account could not be initialized.".to_string(),
            technical_message: Some(err.to_string()),
            retryable: false,
            action_required: ActionRequired::None,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({})),
        })?;

        Ok(Self {
            connection: Mutex::new(connection),
            event_bus: InMemoryEventBus::default(),
            diagnostic_logger: DiagnosticLogger::default(),
            data_dir,
        })
    }
}

fn resolve_default_data_dir(
    current_dir: &Path,
    exe_dir: Option<&Path>,
    override_dir: Option<&str>,
    platform_data_dir: Option<&Path>,
    prefer_project_root: bool,
) -> PathBuf {
    if let Some(override_dir) = override_dir {
        let override_dir = override_dir.trim();
        let override_path = PathBuf::from(override_dir);
        if override_path.is_absolute() {
            return override_path;
        }
    }

    if prefer_project_root {
        if let Some(project_root) =
            find_project_root(current_dir).or_else(|| exe_dir.and_then(find_project_root))
        {
            return project_root.join(".easyemailam");
        }
    }

    if let Some(platform_data_dir) = platform_data_dir {
        return platform_data_dir.to_path_buf();
    }

    current_dir.join(".easyemailam")
}

fn find_project_root(start: &Path) -> Option<PathBuf> {
    start.ancestors().find_map(|candidate| {
        if candidate.join("package.json").is_file() && candidate.join("src-tauri").is_dir() {
            Some(candidate.to_path_buf())
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_uses_project_root_when_started_from_debug_exe_directory() {
        let root = std::env::temp_dir().join(format!(
            "easyemailam-app-state-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(
            root.join("src-tauri")
                .join("target-codex-final")
                .join("debug"),
        )
        .expect("create debug dir");
        std::fs::write(root.join("package.json"), "{}").expect("write package marker");
        let exe_dir = root
            .join("src-tauri")
            .join("target-codex-final")
            .join("debug");

        let resolved = resolve_default_data_dir(&exe_dir, Some(&exe_dir), None, None, true);

        assert_eq!(resolved, root.join(".easyemailam"));
        std::fs::remove_dir_all(root).expect("remove test project root");
    }

    #[test]
    fn data_dir_env_override_wins_over_project_root_detection() {
        let root = std::env::temp_dir().join(format!(
            "easyemailam-app-state-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("src-tauri")).expect("create src-tauri marker");
        std::fs::write(root.join("package.json"), "{}").expect("write package marker");
        let override_dir = root.join("custom-data");

        let resolved = resolve_default_data_dir(
            &root,
            None,
            Some(override_dir.to_str().expect("utf8 override path")),
            None,
            true,
        );

        assert_eq!(resolved, override_dir);
        std::fs::remove_dir_all(root).expect("remove test project root");
    }

    #[test]
    fn release_data_dir_uses_platform_app_data_instead_of_project_root() {
        let root = std::env::temp_dir().join(format!(
            "easyemailam-app-state-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("src-tauri")).expect("create src-tauri marker");
        std::fs::write(root.join("package.json"), "{}").expect("write package marker");
        let platform_data_dir = root.join("platform-data");

        let resolved = resolve_default_data_dir(&root, None, None, Some(&platform_data_dir), false);

        assert_eq!(resolved, platform_data_dir);
        std::fs::remove_dir_all(root).expect("remove test project root");
    }

    #[test]
    fn data_dir_ignores_relative_env_override() {
        let root = std::env::temp_dir().join(format!(
            "easyemailam-app-state-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("src-tauri")).expect("create src-tauri marker");
        std::fs::write(root.join("package.json"), "{}").expect("write package marker");

        let resolved = resolve_default_data_dir(&root, None, Some("relative-data"), None, true);

        assert_eq!(resolved, root.join(".easyemailam"));
        std::fs::remove_dir_all(root).expect("remove test project root");
    }
}
