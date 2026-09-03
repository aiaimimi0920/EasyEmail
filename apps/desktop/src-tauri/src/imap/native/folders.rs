use crate::imap::models::ImapFolder;

pub(super) fn classify_folder_kind(path: &str) -> &'static str {
    let token = normalized_folder_token(path);
    if token == "inbox" || token.ends_with("inbox") || token.ends_with("收件箱") {
        "inbox"
    } else if matches_folder_alias(&token, &["archive", "archives", "归档", "已归档"]) {
        "archive"
    } else if matches_folder_alias(
        &token,
        &["spam", "junk", "junkemail", "垃圾邮件", "广告邮件"],
    ) {
        "spam"
    } else if matches_folder_alias(
        &token,
        &[
            "trash",
            "deleted",
            "deletedmessages",
            "deleteditems",
            "bin",
            "已删除",
            "已删除邮件",
            "废件箱",
            "垃圾箱",
        ],
    ) {
        "trash"
    } else {
        "mail"
    }
}

fn normalized_folder_token(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '_' | '-'))
        .collect()
}

fn matches_folder_alias(token: &str, aliases: &[&str]) -> bool {
    aliases.iter().any(|alias| {
        let alias = normalized_folder_token(alias);
        token == alias || token.ends_with(&alias)
    })
}

pub(super) fn default_inbox_folder() -> ImapFolder {
    ImapFolder {
        provider_folder_id: "INBOX".to_string(),
        display_name: "INBOX".to_string(),
        path: "INBOX".to_string(),
        delimiter: "/".to_string(),
        folder_kind: "inbox".to_string(),
    }
}
