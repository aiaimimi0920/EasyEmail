use serde::Serialize;

use crate::app_state::AppState;
use crate::error::ErrorDto;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HealthDto {
    pub status: String,
    pub data_dir_ready: bool,
}

fn build_host_health(data_dir_ready: bool) -> HealthDto {
    HealthDto {
        status: if data_dir_ready {
            "ready".to_string()
        } else {
            "degraded".to_string()
        },
        data_dir_ready,
    }
}

#[tauri::command]
pub fn health_check(state: tauri::State<'_, AppState>) -> Result<HealthDto, ErrorDto> {
    Ok(build_host_health(state.data_dir.is_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_health_reports_ready_without_business_sqlite() {
        assert_eq!(
            build_host_health(true),
            HealthDto {
                status: "ready".to_string(),
                data_dir_ready: true,
            }
        );
        assert_eq!(
            build_host_health(false),
            HealthDto {
                status: "degraded".to_string(),
                data_dir_ready: false,
            }
        );
    }
}
