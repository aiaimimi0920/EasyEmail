use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::redaction::redact_json;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppEvent {
    pub kind: String,
    pub payload: Value,
    pub emitted_at: String,
}

impl AppEvent {
    pub fn new(kind: impl Into<String>, payload: Value, emitted_at: String) -> Self {
        Self {
            kind: kind.into(),
            payload: redact_json(&payload),
            emitted_at,
        }
    }
}

pub trait EventBus {
    fn emit(&self, event: AppEvent);
}

#[derive(Debug, Default)]
pub struct InMemoryEventBus {
    events: Mutex<Vec<AppEvent>>,
}

impl InMemoryEventBus {
    pub fn snapshot(&self) -> Vec<AppEvent> {
        self.events
            .lock()
            .expect("event bus lock is not poisoned")
            .clone()
    }
}

impl EventBus for InMemoryEventBus {
    fn emit(&self, event: AppEvent) {
        self.events
            .lock()
            .expect("event bus lock is not poisoned")
            .push(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_bus_records_redacted_backend_events() {
        let bus = InMemoryEventBus::default();

        bus.emit(AppEvent::new(
            "agent_thread_updated",
            serde_json::json!({
                "thread_id": "agthread_1",
                "password": "secret-password",
            }),
            "2026-06-12T04:00:00Z".to_string(),
        ));

        let events = bus.snapshot();
        let serialized = serde_json::to_string(&events).expect("serialize events");

        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "agent_thread_updated");
        assert_eq!(events[0].payload["thread_id"], "agthread_1");
        assert!(!serialized.contains("secret-password"));
        assert_eq!(events[0].payload["password"], "[REDACTED]");
    }
}
