pub fn is_allowed_webview_navigation(url: &tauri::Url, allow_dev_origin: bool) -> bool {
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => match (url.host_str(), url.port()) {
            (Some("tauri.localhost"), None) => true,
            (Some("localhost" | "127.0.0.1"), Some(1420))
                if allow_dev_origin && url.scheme() == "http" =>
            {
                true
            }
            _ => false,
        },
        _ => false,
    }
}

pub fn navigation_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-navigation-guard")
        .on_navigation(|_webview, url| is_allowed_webview_navigation(url, cfg!(debug_assertions)))
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> tauri::Url {
        tauri::Url::parse(raw).expect("valid test URL")
    }

    #[test]
    fn allows_tauri_shell_origins_and_sandboxed_about_frames() {
        for allowed in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "tauri://localhost/index.html",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(
                is_allowed_webview_navigation(&parse(allowed), false),
                "expected allowed origin: {allowed}"
            );
        }
    }

    #[test]
    fn gates_vite_dev_server_strictly_by_debug_mode_and_blocks_untrusted_origins() {
        assert!(is_allowed_webview_navigation(
            &parse("http://localhost:1420/"),
            true
        ));
        assert!(is_allowed_webview_navigation(
            &parse("http://127.0.0.1:1420/"),
            true
        ));
        assert!(!is_allowed_webview_navigation(
            &parse("http://localhost:1420/"),
            false
        ));

        for blocked in [
            "https://evil.example/phish",
            "http://127.0.0.1:32123/mail/catalog",
            "file:///C:/Windows/win.ini",
            "data:text/html,<script>alert(1)</script>",
            "javascript:alert(1)",
        ] {
            assert!(
                !is_allowed_webview_navigation(&parse(blocked), true),
                "expected blocked origin: {blocked}"
            );
        }
    }
}
