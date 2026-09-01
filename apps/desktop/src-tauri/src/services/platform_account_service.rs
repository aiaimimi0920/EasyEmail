use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCategory};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlatformAccountDto {
    pub id: String,
    pub display_name: String,
    pub username: String,
    pub email: String,
    pub avatar_initial: String,
    pub status: String,
    pub plan: String,
    pub home_region: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlatformAccountUsageDto {
    pub account_id: String,
    pub linked_app_count: u32,
    pub workspace_count: u32,
    pub api_quota_used: u32,
    pub api_quota_limit: u32,
    pub last_sync_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlatformAccountEndpointDto {
    pub method: String,
    pub path: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlatformAccountSessionDto {
    pub server_kind: String,
    pub server_url: String,
    pub api_version: String,
    pub auth_mode: String,
    pub account: PlatformAccountDto,
    pub usage: PlatformAccountUsageDto,
    pub endpoints: Vec<PlatformAccountEndpointDto>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PlatformAccountQueryRequest {
    pub resource: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PlatformAccountQueryDto {
    pub resource: String,
    pub status: String,
    pub payload: serde_json::Value,
}

pub fn dev_platform_account_session(now: String) -> PlatformAccountSessionDto {
    let account = PlatformAccountDto {
        id: "dev_platform_acct_001".to_string(),
        display_name: "NMail Dev Account".to_string(),
        username: "nmail-dev".to_string(),
        email: "dev.user@nmail.local".to_string(),
        avatar_initial: "N".to_string(),
        status: "dev_signed_in".to_string(),
        plan: "developer_preview".to_string(),
        home_region: "local-dev".to_string(),
        created_at: "2026-06-15T00:00:00Z".to_string(),
        updated_at: now.clone(),
    };

    PlatformAccountSessionDto {
        server_kind: "fake_platform_account_server".to_string(),
        server_url: "nmail-dev://platform-account.local".to_string(),
        api_version: "2026-06-15.dev".to_string(),
        auth_mode: "unsigned_dev_session".to_string(),
        usage: PlatformAccountUsageDto {
            account_id: account.id.clone(),
            linked_app_count: 1,
            workspace_count: 1,
            api_quota_used: 128,
            api_quota_limit: 10000,
            last_sync_at: now,
        },
        account,
        endpoints: vec![
            endpoint(
                "GET",
                "/v1/account/session",
                "Return current platform session.",
            ),
            endpoint(
                "GET",
                "/v1/account/profile",
                "Return platform account profile.",
            ),
            endpoint(
                "GET",
                "/v1/account/entitlements",
                "Return enabled cross-platform capabilities.",
            ),
            endpoint(
                "GET",
                "/v1/account/usage",
                "Return quota and linked app usage.",
            ),
        ],
    }
}

pub fn query_dev_platform_account(
    request: PlatformAccountQueryRequest,
    now: String,
) -> Result<PlatformAccountQueryDto, AppError> {
    let session = dev_platform_account_session(now);
    let normalized = request.resource.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "session" => Ok(query_result("session", serde_json::json!(session))),
        "profile" => Ok(query_result("profile", serde_json::json!(session.account))),
        "usage" => Ok(query_result("usage", serde_json::json!(session.usage))),
        "entitlements" => Ok(query_result(
            "entitlements",
            serde_json::json!({
                "account_id": session.account.id,
                "features": [
                    "nmail.mail.local_inbox",
                    "nmail.agent_mail.preview",
                    "nmail.avatar.remote_cache",
                    "neuro_platform.shared_identity.dev"
                ],
                "mode": "developer_preview"
            }),
        )),
        _ => Err(AppError {
            code: "platform_account_resource_unknown".to_string(),
            category: ErrorCategory::Validation,
            user_message: "The fake platform account server does not expose that resource."
                .to_string(),
            technical_message: None,
            retryable: false,
            action_required: crate::error::ActionRequired::Retry,
            correlation_id: uuid::Uuid::new_v4().to_string(),
            metadata: Box::new(serde_json::json!({ "resource": request.resource })),
        }),
    }
}

fn endpoint(method: &str, path: &str, description: &str) -> PlatformAccountEndpointDto {
    PlatformAccountEndpointDto {
        method: method.to_string(),
        path: path.to_string(),
        description: description.to_string(),
    }
}

fn query_result(resource: &str, payload: serde_json::Value) -> PlatformAccountQueryDto {
    PlatformAccountQueryDto {
        resource: resource.to_string(),
        status: "ok".to_string(),
        payload,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dev_session_exposes_future_platform_api_contract() {
        let session = dev_platform_account_session("2026-06-15T01:00:00Z".to_string());

        assert_eq!(session.server_kind, "fake_platform_account_server");
        assert_eq!(session.account.username, "nmail-dev");
        assert!(session
            .endpoints
            .iter()
            .any(|endpoint| endpoint.path == "/v1/account/session"));
        assert!(session
            .endpoints
            .iter()
            .any(|endpoint| endpoint.path == "/v1/account/usage"));
    }

    #[test]
    fn dev_query_returns_entitlements_payload() {
        let result = query_dev_platform_account(
            PlatformAccountQueryRequest {
                resource: "entitlements".to_string(),
            },
            "2026-06-15T01:00:00Z".to_string(),
        )
        .expect("entitlements");

        assert_eq!(result.resource, "entitlements");
        assert_eq!(result.status, "ok");
        assert!(result.payload["features"]
            .as_array()
            .expect("features")
            .iter()
            .any(|item| item == "neuro_platform.shared_identity.dev"));
    }
}
