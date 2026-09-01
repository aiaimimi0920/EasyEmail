use crate::easyemail::models::{
    CreateTempMailboxRequest, EasyEmailConnectionSettings, EasyEmailHealth,
    EasyEmailObservedMessage, EasyEmailTempMailbox, FetchTempMessagesRequest,
};
use crate::error::AppError;

pub trait EasyEmailAdapter {
    fn health_check(
        &self,
        settings: &EasyEmailConnectionSettings,
    ) -> Result<EasyEmailHealth, AppError>;

    fn create_temp_mailbox(
        &self,
        settings: &EasyEmailConnectionSettings,
        request: &CreateTempMailboxRequest,
    ) -> Result<EasyEmailTempMailbox, AppError>;

    fn fetch_temp_messages(
        &self,
        settings: &EasyEmailConnectionSettings,
        request: &FetchTempMessagesRequest,
    ) -> Result<Vec<EasyEmailObservedMessage>, AppError>;
}
