use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VerificationCode {
    pub id: String,
    pub message_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub code: String,
    pub issuer_hint: Option<String>,
    pub target_service_hint: Option<String>,
    pub confidence: f64,
    pub expires_at: Option<String>,
    pub extracted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationExtractionInput {
    pub message_id: String,
    pub account_scope: String,
    pub received_address: String,
    pub subject: String,
    pub from_address: String,
    pub snippet: String,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub target_service_hint: Option<String>,
    pub observed_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Candidate {
    code: String,
    source_rank: u8,
    keyword_present: bool,
    exact_six_digits: bool,
}

pub fn extract_verification_code(
    input: &VerificationExtractionInput,
    now: &str,
) -> Option<VerificationCode> {
    let message_has_keyword = has_verification_keyword(&input.subject)
        || has_verification_keyword(&input.snippet)
        || input
            .body_text
            .as_deref()
            .is_some_and(has_verification_keyword)
        || input
            .body_html
            .as_deref()
            .is_some_and(has_verification_keyword);
    let subject_candidates = collect_candidates(&input.subject, 0, message_has_keyword);
    let snippet_candidates = collect_candidates(&input.snippet, 1, message_has_keyword);
    let body_text_candidates = input
        .body_text
        .as_deref()
        .map(|value| collect_candidates(value, 2, message_has_keyword))
        .unwrap_or_default();
    let body_html_candidates = input
        .body_html
        .as_deref()
        .map(|value| collect_candidates(value, 3, message_has_keyword))
        .unwrap_or_default();

    let mut candidates = Vec::new();
    candidates.extend(subject_candidates);
    candidates.extend(snippet_candidates);
    candidates.extend(body_text_candidates);
    candidates.extend(body_html_candidates);

    let candidate = candidates.into_iter().max_by_key(candidate_score)?;
    let confidence = if candidate.keyword_present && candidate.exact_six_digits {
        0.95
    } else if candidate.keyword_present {
        0.82
    } else {
        0.72
    };

    Some(VerificationCode {
        id: format!("vcode_{}", Uuid::new_v4()),
        message_id: input.message_id.clone(),
        account_scope: input.account_scope.clone(),
        received_address: input.received_address.clone(),
        code: candidate.code,
        issuer_hint: issuer_hint(&input.from_address),
        target_service_hint: input.target_service_hint.clone(),
        confidence,
        expires_at: None,
        extracted_at: now.to_string(),
    })
}

fn collect_candidates(text: &str, source_rank: u8, message_has_keyword: bool) -> Vec<Candidate> {
    let keyword_present = message_has_keyword || has_verification_keyword(text);
    let digit_groups = digit_groups(text);
    let single_six_digit_group = digit_groups.len() == 1 && digit_groups[0].len() == 6;

    digit_groups
        .into_iter()
        .filter(|code| keyword_present || code.len() == 6 || single_six_digit_group)
        .map(|code| Candidate {
            exact_six_digits: code.len() == 6,
            code,
            source_rank,
            keyword_present,
        })
        .collect()
}

fn candidate_score(candidate: &Candidate) -> (u8, u8, u8, std::cmp::Reverse<u8>) {
    (
        u8::from(candidate.keyword_present),
        u8::from(candidate.exact_six_digits),
        code_length_score(&candidate.code),
        std::cmp::Reverse(candidate.source_rank),
    )
}

fn code_length_score(code: &str) -> u8 {
    match code.len() {
        6 => 4,
        5 => 3,
        4 => 2,
        7 | 8 => 1,
        _ => 0,
    }
}

fn digit_groups(text: &str) -> Vec<String> {
    let mut groups = Vec::new();
    let mut current = String::new();

    for character in text.chars() {
        if character.is_ascii_digit() {
            current.push(character);
        } else {
            push_candidate_group(&mut groups, &mut current);
        }
    }
    push_candidate_group(&mut groups, &mut current);

    groups
}

fn push_candidate_group(groups: &mut Vec<String>, current: &mut String) {
    if (4..=8).contains(&current.len()) {
        groups.push(current.clone());
    }
    current.clear();
}

fn has_verification_keyword(text: &str) -> bool {
    let normalized = text.to_ascii_lowercase();
    [
        "verification",
        "verify",
        "code",
        "otp",
        "passcode",
        "one-time",
        "security",
        "login",
        "sign in",
    ]
    .iter()
    .any(|keyword| normalized.contains(keyword))
}

fn issuer_hint(from_address: &str) -> Option<String> {
    let trimmed = from_address.trim();
    if trimmed.is_empty() {
        return None;
    }

    Some(
        trimmed
            .split('@')
            .next_back()
            .filter(|part| !part.trim().is_empty())
            .unwrap_or(trimmed)
            .trim()
            .trim_matches('>')
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_common_6_digit_verification_code() {
        let input = VerificationExtractionInput {
            message_id: "msg_1".to_string(),
            account_scope: "anonymous".to_string(),
            received_address: "code@example.test".to_string(),
            subject: "Your verification code".to_string(),
            from_address: "noreply@example.test".to_string(),
            snippet: String::new(),
            body_text: Some("Use 123456 to continue.".to_string()),
            body_html: None,
            target_service_hint: Some("github".to_string()),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
        };

        let code = extract_verification_code(&input, "2026-06-12T00:11:00Z")
            .expect("verification code should be extracted");

        assert_eq!(code.message_id, "msg_1");
        assert_eq!(code.code, "123456");
        assert_eq!(code.received_address, "code@example.test");
        assert_eq!(code.target_service_hint, Some("github".to_string()));
        assert!(code.confidence >= 0.8);
    }

    #[test]
    fn extracts_code_from_subject_or_body() {
        let subject_input = VerificationExtractionInput {
            message_id: "msg_subject".to_string(),
            account_scope: "anonymous".to_string(),
            received_address: "subject@example.test".to_string(),
            subject: "Login code: 654321".to_string(),
            from_address: "security@example.test".to_string(),
            snippet: String::new(),
            body_text: None,
            body_html: None,
            target_service_hint: None,
            observed_at: "2026-06-12T00:10:00Z".to_string(),
        };
        let body_input = VerificationExtractionInput {
            message_id: "msg_body".to_string(),
            account_scope: "anonymous".to_string(),
            received_address: "body@example.test".to_string(),
            subject: "Confirm your sign in".to_string(),
            from_address: "security@example.test".to_string(),
            snippet: String::new(),
            body_text: Some("Your one-time passcode is 778899.".to_string()),
            body_html: None,
            target_service_hint: None,
            observed_at: "2026-06-12T00:10:00Z".to_string(),
        };

        assert_eq!(
            extract_verification_code(&subject_input, "2026-06-12T00:11:00Z")
                .expect("subject code")
                .code,
            "654321"
        );
        assert_eq!(
            extract_verification_code(&body_input, "2026-06-12T00:11:00Z")
                .expect("body code")
                .code,
            "778899"
        );
    }

    #[test]
    fn extracts_code_from_header_snippet_when_body_is_not_cached() {
        let input = VerificationExtractionInput {
            message_id: "msg_snippet".to_string(),
            account_scope: "normal_account".to_string(),
            received_address: "user@example.test".to_string(),
            subject: "OpenAI sign in".to_string(),
            from_address: "noreply@openai.com".to_string(),
            snippet: "Your verification code is 996703".to_string(),
            body_text: None,
            body_html: None,
            target_service_hint: Some("openai".to_string()),
            observed_at: "2026-06-12T00:10:00Z".to_string(),
        };

        let code = extract_verification_code(&input, "2026-06-12T00:11:00Z")
            .expect("snippet code should be extracted");

        assert_eq!(code.code, "996703");
        assert_eq!(code.account_scope, "normal_account");
    }
}
