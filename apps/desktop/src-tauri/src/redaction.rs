use serde_json::{Map, Value};

const REDACTED: &str = "[REDACTED]";

fn is_secret_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    lowered.contains("password")
        || lowered.contains("token")
        || lowered.contains("secret")
        || lowered.contains("authorization")
        || lowered.contains("api_key")
        || lowered.contains("apikey")
        || lowered.contains("access_key")
        || lowered.contains("accesskey")
        || lowered.contains("private_key")
        || lowered.contains("privatekey")
        || lowered.contains("credential")
        || lowered.contains("cookie")
        || lowered.contains("verification_code")
        || lowered == "otp"
        || lowered == "passcode"
        || lowered == "auth_code"
}

pub fn redact_text(value: &str) -> String {
    let value = if contains_verification_keyword(value) {
        redact_verification_digit_groups(value)
    } else {
        value.to_string()
    };

    let parts = value.split_whitespace().collect::<Vec<_>>();
    let mut redacted_parts = Vec::with_capacity(parts.len());
    let mut redact_next_bearer_value = false;

    for part in parts {
        if redact_next_bearer_value {
            redacted_parts.push(REDACTED.to_string());
            redact_next_bearer_value = false;
            continue;
        }

        let lowered = part.to_ascii_lowercase();
        if matches!(lowered.as_str(), "bearer" | "bearer:") {
            redacted_parts.push(part.to_string());
            redact_next_bearer_value = true;
            continue;
        }

        redacted_parts.push(redact_secret_assignments(part));
    }

    redacted_parts.join(" ")
}

fn redact_secret_assignments(part: &str) -> String {
    let lowered = part.to_ascii_lowercase();
    let secret_markers = [
        "access_token=",
        "refresh_token=",
        "password=",
        "token=",
        "secret=",
        "api_key=",
        "apikey=",
        "access_key=",
        "private_key=",
        "credential=",
        "cookie=",
    ];
    let Some((index, marker)) = secret_markers
        .iter()
        .filter_map(|marker| lowered.find(marker).map(|index| (index, *marker)))
        .min_by_key(|(index, _)| *index)
    else {
        return part.to_string();
    };

    let value_start = index + marker.len();
    let value_end = part[value_start..]
        .find(['&', '#', ',', ';'])
        .map_or(part.len(), |offset| value_start + offset);
    format!("{}{}{}", &part[..value_start], REDACTED, &part[value_end..])
}

pub fn redact_json(value: &Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = Map::new();
            for (key, nested) in object {
                if is_secret_key(key) {
                    redacted.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    redacted.insert(key.clone(), redact_json(nested));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(values) => Value::Array(values.iter().map(redact_json).collect()),
        Value::String(text) => Value::String(redact_text(text)),
        _ => value.clone(),
    }
}

fn contains_verification_keyword(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
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
    .any(|keyword| lowered.contains(keyword))
}

fn redact_verification_digit_groups(value: &str) -> String {
    let mut redacted = String::new();
    let mut digits = String::new();

    for character in value.chars() {
        if character.is_ascii_digit() {
            digits.push(character);
        } else {
            push_redacted_digits(&mut redacted, &mut digits);
            redacted.push(character);
        }
    }
    push_redacted_digits(&mut redacted, &mut digits);

    redacted
}

fn push_redacted_digits(output: &mut String, digits: &mut String) {
    if digits.is_empty() {
        return;
    }

    if (4..=8).contains(&digits.len()) {
        output.push_str("[REDACTED_CODE]");
    } else {
        output.push_str(digits);
    }
    digits.clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_token_like_text() {
        let input = "access_token=abc123 refresh_token=def456 password=secret https://example.test/?token=url-secret&view=safe Authorization: Bearer header-secret";
        let redacted = redact_text(input);

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("def456"));
        assert!(!redacted.contains("secret"));
        assert!(redacted.contains("access_token=[REDACTED]"));
        assert!(redacted.contains("refresh_token=[REDACTED]"));
        assert!(redacted.contains("password=[REDACTED]"));
        assert!(redacted.contains("token=[REDACTED]&view=safe"));
        assert!(redacted.contains("Authorization: Bearer [REDACTED]"));
    }

    #[test]
    fn redacts_secret_like_json_keys() {
        let value = json!({
            "account_id": "acc_1",
            "token": "abc",
            "sessionCookie": "cookie-value",
            "privateKey": "private-key-value",
            "access_key": "access-key-value",
            "providerCredential": "credential-value",
            "nested": {
                "password": "secret",
                "safe": "visible"
            }
        });

        let redacted = redact_json(&value);

        assert_eq!(redacted["account_id"], "acc_1");
        assert_eq!(redacted["token"], "[REDACTED]");
        assert_eq!(redacted["sessionCookie"], "[REDACTED]");
        assert_eq!(redacted["privateKey"], "[REDACTED]");
        assert_eq!(redacted["access_key"], "[REDACTED]");
        assert_eq!(redacted["providerCredential"], "[REDACTED]");
        assert_eq!(redacted["nested"]["password"], "[REDACTED]");
        assert_eq!(redacted["nested"]["safe"], "visible");
    }

    #[test]
    fn redacts_additional_secret_assignments_in_text() {
        let redacted = redact_text(
            "cookie=session-value credential=opaque-value access_key=key-value private_key=pem-value safe=visible",
        );

        for secret in ["session-value", "opaque-value", "key-value", "pem-value"] {
            assert!(!redacted.contains(secret));
        }
        assert!(redacted.contains("cookie=[REDACTED]"));
        assert!(redacted.contains("credential=[REDACTED]"));
        assert!(redacted.contains("access_key=[REDACTED]"));
        assert!(redacted.contains("private_key=[REDACTED]"));
        assert!(redacted.contains("safe=visible"));
    }

    #[test]
    fn verification_code_not_logged_plain_by_default() {
        let text = redact_text("verification code is 123456");
        let metadata = redact_json(&json!({
            "verification_code": "123456",
            "safe": "visible"
        }));

        assert!(!text.contains("123456"));
        assert_eq!(metadata["verification_code"], "[REDACTED]");
        assert_eq!(metadata["safe"], "visible");
    }
}
