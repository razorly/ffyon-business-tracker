use std::{
    collections::HashSet,
    io::Write,
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
                .is_some_and(automatic_backup_name)
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
    atomic_write(&path, data).map_err(|_| "Could not write the selected file".into())
}

fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let temporary = path.with_file_name(format!(".ffyon-export-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

fn automatic_backup_name(name: &str) -> bool {
    let Some(date) = name.strip_prefix("ffyon-backup-").and_then(|name| name.strip_suffix(".json")) else { return false; };
    let bytes = date.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || !bytes.iter().enumerate().all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit()) {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or_default();
    let month: u32 = date[5..7].parse().unwrap_or_default();
    let day: u32 = date[8..].parse().unwrap_or_default();
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30, 2 if leap => 29, 2 => 28, _ => 0 };
    year > 0 && day > 0 && day <= days
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

    #[test]
    fn automatic_backups_use_only_calendar_valid_dated_names() {
        assert!(automatic_backup_name("ffyon-backup-2026-10-02.json"));
        assert!(automatic_backup_name("ffyon-backup-2028-02-29.json"));
        for name in ["ffyon-backup-wedding-import.json", "ffyon-backup-2026-02-30.json",
            "ffyon-backup-2026-10-02-copy.json", "ffyon-backup-0000-01-01.json",
            "ffyon-backup-2026-10-02.json.exe"] { assert!(!automatic_backup_name(name)); }
    }

    #[test]
    fn atomic_export_replaces_the_complete_file_and_cleans_failed_temporary_files() {
        let dir = std::env::temp_dir().join(format!("ffyon-file-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("backup.json");
        std::fs::write(&path, b"old complete backup").unwrap();
        atomic_write(&path, b"new complete backup").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new complete backup");
        let blocked = dir.join("directory.json");
        std::fs::create_dir(&blocked).unwrap();
        assert!(atomic_write(&blocked, b"cannot replace a directory").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2, "No temporary export remains");
        assert!(dir.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
