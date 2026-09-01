use crate::error::AppError;
use crate::smtp::models::{
    SmtpConnectionProfile, SmtpConnectionTestResult, SmtpSendMessage, SmtpSendResult,
};

pub trait SmtpAdapter {
    fn test_connection(
        &self,
        profile: &SmtpConnectionProfile,
        secret: &str,
    ) -> Result<SmtpConnectionTestResult, AppError>;

    fn send_message(
        &self,
        profile: &SmtpConnectionProfile,
        secret: &str,
        message: &SmtpSendMessage,
    ) -> Result<SmtpSendResult, AppError>;
}
