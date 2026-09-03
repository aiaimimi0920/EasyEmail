use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct ContactCreateCommandRequest {
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ContactDto {
    pub id: String,
    pub display_name: String,
    pub email_address: String,
    pub note: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[tauri::command]
pub fn contact_list(state: tauri::State<'_, AppState>) -> Result<Vec<ContactDto>, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let rows = list_contacts(&connection).map_err(contact_storage_error)?;
    Ok(rows.into_iter().map(contact_row_to_dto).collect())
}

#[tauri::command]
pub fn contact_create(
    state: tauri::State<'_, AppState>,
    request: ContactCreateCommandRequest,
) -> Result<ContactDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let row = create_contact(
        &connection,
        NewContact {
            display_name: request.display_name,
            email_address: request.email_address,
            note: request.note,
            now: now_rfc3339(),
        },
    )
    .map_err(contact_storage_error)?;
    Ok(contact_row_to_dto(row))
}

pub(super) fn contact_row_to_dto(row: ContactRow) -> ContactDto {
    ContactDto {
        id: row.id,
        display_name: row.display_name,
        email_address: row.email_address,
        note: row.note,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub(super) fn contact_storage_error(err: rusqlite::Error) -> ErrorDto {
    AppError {
        code: "contact_storage_failed".to_string(),
        category: ErrorCategory::Storage,
        user_message: "Contacts could not be loaded or updated.".to_string(),
        technical_message: Some(err.to_string()),
        retryable: true,
        action_required: ActionRequired::Retry,
        correlation_id: uuid::Uuid::new_v4().to_string(),
        metadata: Box::new(serde_json::json!({})),
    }
    .to_dto()
}
