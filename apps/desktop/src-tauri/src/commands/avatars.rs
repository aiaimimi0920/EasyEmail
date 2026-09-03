use super::*;

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarSettingsUpdateRequest {
    pub remote_enabled: bool,
    pub bimi_enabled: bool,
    pub favicon_enabled: bool,
    pub auth_enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarResolveRequest {
    pub senders: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarContactRequest {
    pub sender: String,
    pub image_data_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarClearContactRequest {
    pub sender: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AvatarClearCacheRequest {
    pub include_contacts: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AvatarClearCacheDto {
    pub deleted_count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AvatarClearContactDto {
    pub changed: bool,
}

#[tauri::command]
pub fn avatar_get_settings(
    state: tauri::State<'_, AppState>,
) -> Result<AvatarSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    load_avatar_settings(&connection).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_update_settings(
    state: tauri::State<'_, AppState>,
    request: AvatarSettingsUpdateRequest,
) -> Result<AvatarSettingsDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    save_avatar_settings(
        &connection,
        AvatarSettingsDto {
            remote_enabled: request.remote_enabled,
            bimi_enabled: request.bimi_enabled,
            favicon_enabled: request.favicon_enabled,
            auth_enabled: request.auth_enabled,
        },
    )
    .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_resolve_senders(
    state: tauri::State<'_, AppState>,
    request: AvatarResolveRequest,
) -> Result<Vec<SenderAvatarDto>, ErrorDto> {
    // Remote avatar lookups are HTTP and DNS-over-HTTPS calls that can take tens
    // of seconds on a cold cache. The database lock is released between the read
    // and write phases so those fetches do not block every other command.
    let plan = {
        let connection = state.connection.lock().map_err(lock_error)?;
        plan_sender_avatar_resolution(&connection, request.senders)?
    };

    if !plan.has_pending() {
        let connection = state.connection.lock().map_err(lock_error)?;
        return persist_fetched_avatars(&connection, plan, Vec::new()).map_err(ErrorDto::from);
    }

    let fetched = fetch_pending_avatars(&plan);

    let connection = state.connection.lock().map_err(lock_error)?;
    persist_fetched_avatars(&connection, plan, fetched).map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_set_contact(
    state: tauri::State<'_, AppState>,
    request: AvatarContactRequest,
) -> Result<SenderAvatarDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    set_contact_avatar(&connection, &request.sender, &request.image_data_url)
        .map_err(ErrorDto::from)
}

#[tauri::command]
pub fn avatar_clear_contact(
    state: tauri::State<'_, AppState>,
    request: AvatarClearContactRequest,
) -> Result<AvatarClearContactDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let changed = clear_contact_avatar(&connection, &request.sender).map_err(ErrorDto::from)?;
    Ok(AvatarClearContactDto { changed })
}

#[tauri::command]
pub fn avatar_clear_cache(
    state: tauri::State<'_, AppState>,
    request: AvatarClearCacheRequest,
) -> Result<AvatarClearCacheDto, ErrorDto> {
    let connection = state.connection.lock().map_err(lock_error)?;
    let deleted_count =
        clear_avatar_cache(&connection, request.include_contacts).map_err(ErrorDto::from)?;
    Ok(AvatarClearCacheDto { deleted_count })
}
