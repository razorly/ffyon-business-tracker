use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::access::AccessState;

#[derive(Default)]
pub struct FileGrants(Mutex<HashSet<PathBuf>>);

#[derive(Deserialize)]
pub struct FileFilter {
    name: String,
    extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    name: String,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
}

fn canonical_target(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("A full file path is required".into());
    }
    if path.exists() {
        return path
            .canonicalize()
            .map_err(|_| "Cannot resolve that file path".into());
    }
    let parent = path
        .parent()
        .ok_or("A file directory is required")?
        .canonicalize()
        .map_err(|_| "The selected directory no longer exists")?;
    Ok(parent.join(path.file_name().ok_or("A file name is required")?))
}

fn grant(grants: &FileGrants, path: &Path) -> Result<PathBuf, String> {
    let canonical = canonical_target(path)?;
    grants
        .0
        .lock()
        .map_err(|_| "File permissions are busy")?
        .insert(canonical.clone());
    Ok(canonical)
}

fn approved(
    access: &AccessState,
    grants: &FileGrants,
    path: &str,
    writing: bool,
) -> Result<PathBuf, String> {
    access.require_authorized()?;
    let target = canonical_target(Path::new(path))?;
    let selected = grants
        .0
        .lock()
        .map_err(|_| "File permissions are busy")?
        .contains(&target);
    let backup_dir = access
        .backup_directory()?
        .map(PathBuf::from)
        .and_then(|dir| dir.canonicalize().ok());
    let auto_backup = backup_dir.as_ref().is_some_and(|dir| {
        target.parent() == Some(dir.as_path())
            && target
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("ffyon-backup-") && name.ends_with(".json"))
    });
    let listing = !writing && backup_dir.as_ref() == Some(&target);
    if !selected && !auto_backup && !listing {
        return Err("Choose this file or backup folder using the native file picker first".into());
    }
    Ok(target)
}

#[tauri::command]
pub async fn protected_pick_file(
    app: AppHandle,
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    filters: Option<Vec<FileFilter>>,
) -> Result<Option<String>, String> {
    access.require_authorized()?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file();
        for filter in filters.unwrap_or_default() {
            picker = picker.add_filter(
                filter.name,
                &filter
                    .extensions
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            );
        }
        picker
            .blocking_pick_file()
            .and_then(|path| path.into_path().ok())
    })
    .await
    .map_err(|_| "The file picker could not open")?;
    access.require_authorized()?;
    path.map(|path| grant(&grants, &path).map(|path| path.to_string_lossy().into_owned()))
        .transpose()
}

#[tauri::command]
pub async fn protected_pick_directory(
    app: AppHandle,
    access: State<'_, AccessState>,
) -> Result<Option<String>, String> {
    access.require_authorized()?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok())
    })
    .await
    .map_err(|_| "The folder picker could not open")?;
    access.require_authorized()?;
    if let Some(path) = path {
        let path = canonical_target(&path)?.to_string_lossy().into_owned();
        access.set_backup_directory(&path)?;
        Ok(Some(path))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn protected_save_file(
    app: AppHandle,
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    default_path: String,
    filters: Option<Vec<FileFilter>>,
) -> Result<Option<String>, String> {
    access.require_authorized()?;
    let path = tauri::async_runtime::spawn_blocking(move || {
        let mut picker = app.dialog().file().set_file_name(default_path);
        for filter in filters.unwrap_or_default() {
            picker = picker.add_filter(
                filter.name,
                &filter
                    .extensions
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
            );
        }
        picker
            .blocking_save_file()
            .and_then(|path| path.into_path().ok())
    })
    .await
    .map_err(|_| "The save picker could not open")?;
    access.require_authorized()?;
    path.map(|path| grant(&grants, &path).map(|path| path.to_string_lossy().into_owned()))
        .transpose()
}

#[tauri::command]
pub fn protected_write_text_file(
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    path: String,
    data: String,
) -> Result<(), String> {
    write(&access, &grants, &path, data.as_bytes())
}

#[tauri::command]
pub fn protected_write_file(
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    write(&access, &grants, &path, &data)
}

fn write(access: &AccessState, grants: &FileGrants, path: &str, data: &[u8]) -> Result<(), String> {
    let path = approved(access, grants, path, true)?;
    if data.len() > 100_000_000 {
        return Err("That export is too large".into());
    }
    std::fs::write(path, data).map_err(|_| "Could not write the selected file".into())
}

#[tauri::command]
pub fn protected_read_text_file(
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    path: String,
) -> Result<String, String> {
    let path = approved(&access, &grants, &path, false)?;
    if std::fs::metadata(&path)
        .map_err(|_| "Cannot read the selected file")?
        .len()
        > 100_000_000
    {
        return Err("That backup is too large".into());
    }
    std::fs::read_to_string(path).map_err(|_| "Could not read the selected file".into())
}

#[tauri::command]
pub fn protected_read_dir(
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    path: String,
) -> Result<Vec<DirectoryEntry>, String> {
    let path = approved(&access, &grants, &path, false)?;
    std::fs::read_dir(path)
        .map_err(|_| "Cannot list the backup folder")?
        .map(|entry| {
            let entry = entry.map_err(|_| "Cannot read a backup folder item")?;
            let ty = entry
                .file_type()
                .map_err(|_| "Cannot read a backup folder item")?;
            Ok(DirectoryEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_file: ty.is_file(),
                is_directory: ty.is_dir(),
                is_symlink: ty.is_symlink(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn protected_remove_file(
    access: State<'_, AccessState>,
    grants: State<'_, FileGrants>,
    path: String,
) -> Result<(), String> {
    let path = approved(&access, &grants, &path, true)?;
    if !path.is_file() {
        return Err("Only backup files can be removed".into());
    }
    std::fs::remove_file(path).map_err(|_| "Could not remove the old backup".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_paths_are_never_accepted() {
        assert!(canonical_target(Path::new("../secret.json")).is_err());
    }
}
