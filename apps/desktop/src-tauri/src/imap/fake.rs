use std::sync::{Arc, Mutex};

use crate::error::{ActionRequired, AppError, ErrorCategory};
use crate::imap::adapter::ImapAdapter;
use crate::imap::models::{
    ImapConnectionProfile, ImapConnectionTestResult, ImapFolder, ImapMessageBody, ImapMessageFlag,
    ImapMessageHeader, ImapMessageMoveResult,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FakeImapAction {
    SetFlag {
        folder_path: String,
        provider_message_id: String,
        flag: String,
        enabled: bool,
    },
    FetchBody {
        folder_path: String,
        provider_message_id: String,
    },
    Move {
        from_folder_path: String,
        target_folder_path: String,
        provider_message_id: String,
    },
}

#[derive(Debug, Clone)]
pub struct FakeImapAdapter {
    auth_failed: bool,
    folders: Vec<ImapFolder>,
    recent_headers: Vec<ImapMessageHeader>,
    recent_headers_by_folder: Vec<(String, Vec<ImapMessageHeader>)>,
    message_body: Option<ImapMessageBody>,
    move_target_provider_message_id: Option<String>,
    actions: Arc<Mutex<Vec<FakeImapAction>>>,
    /// Counted separately from `actions` so that adding this observability does
    /// not change any existing expected-action assertion. Folder discovery also
    /// happens during sync setup, so recording it inline would appear in tests
    /// that are not about discovery at all.
    discover_folders_calls: Arc<Mutex<usize>>,
}

impl FakeImapAdapter {
    pub fn with_connection_success() -> Self {
        Self {
            auth_failed: false,
            folders: vec![ImapFolder {
                provider_folder_id: "INBOX".to_string(),
                display_name: "INBOX".to_string(),
                path: "INBOX".to_string(),
                delimiter: "/".to_string(),
                folder_kind: "inbox".to_string(),
            }],
            recent_headers: Vec::new(),
            recent_headers_by_folder: Vec::new(),
            message_body: None,
            move_target_provider_message_id: None,
            actions: Arc::new(Mutex::new(Vec::new())),
            discover_folders_calls: Arc::new(Mutex::new(0)),
        }
    }

    pub fn with_recent_headers(headers: Vec<ImapMessageHeader>) -> Self {
        Self {
            recent_headers: headers,
            ..Self::with_connection_success()
        }
    }

    pub fn auth_failed() -> Self {
        Self {
            auth_failed: true,
            ..Self::with_connection_success()
        }
    }

    pub fn with_message_body(mut self, body: ImapMessageBody) -> Self {
        self.message_body = Some(body);
        self
    }

    pub fn with_folders(mut self, folders: Vec<ImapFolder>) -> Self {
        self.folders = folders;
        self
    }

    pub fn with_recent_headers_by_folder(
        mut self,
        headers_by_folder: Vec<(&str, Vec<ImapMessageHeader>)>,
    ) -> Self {
        self.recent_headers_by_folder = headers_by_folder
            .into_iter()
            .map(|(path, headers)| (path.to_string(), headers))
            .collect();
        self
    }

    pub fn with_move_target_provider_message_id(mut self, provider_message_id: &str) -> Self {
        self.move_target_provider_message_id = Some(provider_message_id.to_string());
        self
    }

    pub fn recorded_actions(&self) -> Vec<FakeImapAction> {
        self.actions.lock().expect("fake imap actions lock").clone()
    }

    /// How many times folder discovery hit the network. Lets a test assert that
    /// `resolve_target_folder` fell back to discovery rather than answering from
    /// the local folder cache.
    pub fn discover_folders_call_count(&self) -> usize {
        *self
            .discover_folders_calls
            .lock()
            .expect("fake imap discover folders counter lock")
    }
}

impl ImapAdapter for FakeImapAdapter {
    fn test_connection(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
    ) -> Result<ImapConnectionTestResult, AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }

        Ok(ImapConnectionTestResult {
            authenticated: true,
            capability_summary: "fake-imap-ready".to_string(),
        })
    }

    fn discover_folders(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
    ) -> Result<Vec<ImapFolder>, AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }
        *self.discover_folders_calls.lock().map_err(|error| {
            AppError::internal("fake_imap_discover_counter_lock_failed", error.to_string())
        })? += 1;
        Ok(self.folders.clone())
    }

    fn fetch_recent_headers(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
        folder: &ImapFolder,
        limit: usize,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }
        if let Some((_, headers)) = self
            .recent_headers_by_folder
            .iter()
            .find(|(path, _)| path == &folder.path)
        {
            return Ok(headers.iter().take(limit).cloned().collect());
        }
        if folder.folder_kind != "inbox" {
            return Ok(Vec::new());
        }
        Ok(self.recent_headers.iter().take(limit).cloned().collect())
    }

    fn fetch_incremental(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        _cursor: Option<String>,
    ) -> Result<Vec<ImapMessageHeader>, AppError> {
        self.fetch_recent_headers(profile, secret, folder, self.recent_headers.len())
    }

    fn fetch_message_body(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
    ) -> Result<Option<ImapMessageBody>, AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }
        self.actions
            .lock()
            .map_err(|error| {
                AppError::internal("fake_imap_actions_lock_failed", error.to_string())
            })?
            .push(FakeImapAction::FetchBody {
                folder_path: folder.path.clone(),
                provider_message_id: provider_message_id.to_string(),
            });
        Ok(Some(self.message_body.clone().unwrap_or_else(|| {
            ImapMessageBody {
                text: format!("Body for {provider_message_id}"),
                html: None,
            }
        })))
    }

    fn set_message_flag(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
        flag: ImapMessageFlag,
        enabled: bool,
    ) -> Result<(), AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }
        self.actions
            .lock()
            .map_err(|error| {
                AppError::internal("fake_imap_actions_lock_failed", error.to_string())
            })?
            .push(FakeImapAction::SetFlag {
                folder_path: folder.path.clone(),
                provider_message_id: provider_message_id.to_string(),
                flag: flag.as_imap_atom().to_string(),
                enabled,
            });
        Ok(())
    }

    fn move_message(
        &self,
        _profile: &ImapConnectionProfile,
        _secret: &str,
        source_folder: &ImapFolder,
        provider_message_id: &str,
        target_folder: &ImapFolder,
    ) -> Result<ImapMessageMoveResult, AppError> {
        if self.auth_failed {
            return Err(imap_auth_failed());
        }
        self.actions
            .lock()
            .map_err(|error| {
                AppError::internal("fake_imap_actions_lock_failed", error.to_string())
            })?
            .push(FakeImapAction::Move {
                from_folder_path: source_folder.path.clone(),
                target_folder_path: target_folder.path.clone(),
                provider_message_id: provider_message_id.to_string(),
            });
        Ok(ImapMessageMoveResult {
            provider_message_id: self.move_target_provider_message_id.clone(),
        })
    }
}

fn imap_auth_failed() -> AppError {
    AppError {
        code: "imap_auth_failed".to_string(),
        category: ErrorCategory::Auth,
        user_message: "The IMAP server rejected the supplied credentials.".to_string(),
        technical_message: None,
        retryable: false,
        action_required: ActionRequired::EditSettings,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({ "adapter": "fake_imap" })),
    }
}

#[cfg(test)]
mod tests {
    use crate::imap::models::ImapMessageFlag;

    use crate::imap::models::ImapConnectionProfile;

    use super::*;

    #[test]
    fn fake_imap_adapter_tests_connection_success() {
        let adapter = FakeImapAdapter::with_connection_success();
        let profile = ImapConnectionProfile {
            host: "imap.example.test".to_string(),
            port: 993,
            security: "tls".to_string(),
            username: "user@example.test".to_string(),
        };

        let result = adapter
            .test_connection(&profile, "app-password")
            .expect("test connection");

        assert!(result.authenticated);
        assert_eq!(result.capability_summary, "fake-imap-ready");
    }

    #[test]
    fn fake_imap_adapter_records_remote_message_operations() {
        let adapter = FakeImapAdapter::with_connection_success();
        let profile = ImapConnectionProfile {
            host: "imap.example.test".to_string(),
            port: 993,
            security: "tls".to_string(),
            username: "user@example.test".to_string(),
        };
        let source_folder = ImapFolder {
            provider_folder_id: "INBOX".to_string(),
            display_name: "INBOX".to_string(),
            path: "INBOX".to_string(),
            delimiter: "/".to_string(),
            folder_kind: "inbox".to_string(),
        };
        let target_folder = ImapFolder {
            provider_folder_id: "Archive".to_string(),
            display_name: "Archive".to_string(),
            path: "Archive".to_string(),
            delimiter: "/".to_string(),
            folder_kind: "archive".to_string(),
        };

        adapter
            .set_message_flag(
                &profile,
                "app-password",
                &source_folder,
                "uid-1",
                ImapMessageFlag::Seen,
                true,
            )
            .expect("set seen");
        adapter
            .move_message(
                &profile,
                "app-password",
                &source_folder,
                "uid-1",
                &target_folder,
            )
            .expect("move message");

        assert_eq!(
            adapter.recorded_actions(),
            vec![
                FakeImapAction::SetFlag {
                    folder_path: "INBOX".to_string(),
                    provider_message_id: "uid-1".to_string(),
                    flag: "\\Seen".to_string(),
                    enabled: true,
                },
                FakeImapAction::Move {
                    from_folder_path: "INBOX".to_string(),
                    target_folder_path: "Archive".to_string(),
                    provider_message_id: "uid-1".to_string(),
                },
            ]
        );
    }
}
