use crate::error::AppError;
use crate::imap::models::{
    ImapConnectionProfile, ImapConnectionTestResult, ImapFolder, ImapMessageBody, ImapMessageFlag,
    ImapMessageHeader, ImapMessageMoveResult,
};

pub trait ImapAdapter {
    fn test_connection(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<ImapConnectionTestResult, AppError>;

    fn discover_folders(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
    ) -> Result<Vec<ImapFolder>, AppError>;

    fn fetch_recent_headers(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        limit: usize,
    ) -> Result<Vec<ImapMessageHeader>, AppError>;

    fn fetch_incremental(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        cursor: Option<String>,
    ) -> Result<Vec<ImapMessageHeader>, AppError>;

    fn fetch_message_body(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
    ) -> Result<Option<ImapMessageBody>, AppError>;

    fn set_message_flag(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        folder: &ImapFolder,
        provider_message_id: &str,
        flag: ImapMessageFlag,
        enabled: bool,
    ) -> Result<(), AppError>;

    fn move_message(
        &self,
        profile: &ImapConnectionProfile,
        secret: &str,
        source_folder: &ImapFolder,
        provider_message_id: &str,
        target_folder: &ImapFolder,
    ) -> Result<ImapMessageMoveResult, AppError>;
}
