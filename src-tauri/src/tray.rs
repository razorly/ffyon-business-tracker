//! The tray icon — the app's shortcut to itself.
//!
//! Everything the menu offers is worked out by the front end, which knows the
//! data, and pushed over with `set_tray_state`. Rust only draws the menu and
//! reports clicks back, so there is one set of rules about the money and not two.

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, Window, WindowEvent,
};
use tauri_plugin_notification::NotificationExt;

pub const TRAY_ID: &str = "ffyon-tray";
const MAIN_WINDOW: &str = "main";
const DEFAULT_TOOLTIP: &str = "Tanned by Ffy";

// What a click on the menu tells the front end to do.
const EVT_NEW_ENTRY: &str = "tray://new-entry";
const EVT_QUICK_ADD: &str = "tray://quick-add";
const EVT_MARK_PAID: &str = "tray://mark-paid";
const EVT_BACKUP: &str = "tray://backup";
const EVT_ASK_CLOSE: &str = "tray://ask-close";

/// One clickable line the front end has asked for. `id` is whatever it wants
/// handed back — an appointment.
#[derive(Debug, Clone, Deserialize)]
pub struct TrayItem {
    pub id: i64,
    pub label: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TrayServiceItem {
    pub id: String,
    pub label: String,
}

/// The whole menu as the front end sees it. Sent again whenever the data moves.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayState {
    pub tooltip: String,
    /// Today at a glance, greyed out at the top of the menu.
    pub lines: Vec<String>,
    /// Active shared services: one click records a standalone payment.
    pub quick_add: Vec<TrayServiceItem>,
    /// Appointments that have happened and are still waiting to be marked paid.
    pub mark_paid: Vec<TrayItem>,
    /// Only offered once a backup folder has been chosen.
    pub backup: bool,
}

/// What closing the window does. Asked once, then remembered by the front end
/// and pushed here, so the window still closes properly if the page is busy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    /// Not decided yet — the first close asks.
    #[default]
    Ask,
    /// Stays running in the tray.
    Tray,
    /// Closes the app for real.
    Quit,
}

#[derive(Default)]
pub struct Prefs {
    close: Mutex<CloseAction>,
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, state: &TrayState) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if app.state::<crate::access::AccessState>().require_authorized().is_err() {
        menu.append(&MenuItem::with_id(app, "open", "Connect Tanned by Ffy", true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "quit", "Quit Tanned by Ffy", true, None::<&str>)?)?;
        return Ok(menu);
    }

    for (i, line) in state.lines.iter().enumerate() {
        menu.append(&MenuItem::with_id(
            app,
            format!("info-{i}"),
            line,
            false,
            None::<&str>,
        )?)?;
    }
    if !state.lines.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }

    menu.append(&MenuItem::with_id(app, "open", "Open Tanned by Ffy", true, None::<&str>)?)?;

    if !state.quick_add.is_empty() {
        let sub = Submenu::with_id(app, "quick-add", "Quick add", true)?;
        for item in &state.quick_add {
            if !valid_service_id(&item.id) {
                continue;
            }
            sub.append(&MenuItem::with_id(
                app,
                format!("service:{}", item.id),
                &item.label,
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&sub)?;
    }

    if !state.mark_paid.is_empty() {
        let sub = Submenu::with_id(app, "mark-paid", "Mark paid", true)?;
        for item in &state.mark_paid {
            sub.append(&MenuItem::with_id(
                app,
                format!("paid:{}", item.id),
                &item.label,
                true,
                None::<&str>,
            )?)?;
        }
        menu.append(&sub)?;
    }

    menu.append(&MenuItem::with_id(app, "new-income", "New income…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "new-expense", "New expense…", true, None::<&str>)?)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if state.backup {
        menu.append(&MenuItem::with_id(app, "backup", "Back up now", true, None::<&str>)?)?;
    }
    menu.append(&MenuItem::with_id(app, "quit", "Quit Tanned by Ffy", true, None::<&str>)?)?;

    Ok(menu)
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window(MAIN_WINDOW)
}

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Left-clicking the icon brings the window up, or puts it away if it's already
/// the window you're looking at.
fn toggle_main<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = main_window(app) else { return };
    let in_front = w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
    if in_front {
        let _ = w.hide();
    } else {
        show_main(app);
    }
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if id != "open" && id != "quit" && app.state::<crate::access::AccessState>().require_authorized().is_err() {
        show_main(app);
        return;
    }
    match id {
        "open" => show_main(app),
        "new-income" => {
            show_main(app);
            let _ = app.emit(EVT_NEW_ENTRY, "income");
        }
        "new-expense" => {
            show_main(app);
            let _ = app.emit(EVT_NEW_ENTRY, "expense");
        }
        "backup" => {
            let _ = app.emit(EVT_BACKUP, ());
        }
        "quit" => app.exit(0),
        other => {
            // The window stays where it is: these are the one-click actions.
            if let Some(id) = parse_service_id(other) {
                let _ = app.emit(EVT_QUICK_ADD, id);
            } else if let Some(id) = parse_id(other, "paid:") {
                let _ = app.emit(EVT_MARK_PAID, id);
            }
        }
    }
}

fn parse_id(menu_id: &str, prefix: &str) -> Option<i64> {
    menu_id.strip_prefix(prefix)?.parse().ok()
}

fn valid_service_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn parse_service_id(menu_id: &str) -> Option<&str> {
    let id = menu_id.strip_prefix("service:")?;
    valid_service_id(id).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::{parse_id, parse_service_id};

    #[test]
    fn service_menu_ids_keep_string_identifiers_separate_from_appointments() {
        let id = "00000000-0000-4000-8000-000000000501";
        assert_eq!(parse_service_id(&format!("service:{id}")), Some(id));
        assert_eq!(parse_service_id("paid:42"), None);
        assert_eq!(parse_id("paid:42", "paid:"), Some(42));
        assert_eq!(parse_id(&format!("service:{id}"), "paid:"), None);
    }

    #[test]
    fn malformed_service_menu_ids_are_rejected() {
        for id in ["service:", "service:../42", "service:42:paid", "quick:42", "service:a b"] {
            assert_eq!(parse_service_id(id), None);
        }
        assert_eq!(parse_service_id(&format!("service:{}", "a".repeat(129))), None);
    }
}

fn on_tray_event<R: Runtime>(tray: &TrayIcon<R>, event: TrayIconEvent) {
    // On a Mac the left click belongs to the menu, which is what people expect there.
    if cfg!(target_os = "macos") {
        return;
    }
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_main(tray.app_handle());
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, &TrayState::default())?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(DEFAULT_TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .on_tray_icon_event(on_tray_event);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Closing the window only ends the app if that's what she's asked for.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if matches!(event, WindowEvent::Focused(true)) {
        let _ = window.emit("app-access-changed", window.state::<crate::access::AccessState>().status());
        refresh_locked(window.app_handle());
    }
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.state::<crate::access::AccessState>().require_authorized().is_err() { return; }
    match window.state::<Prefs>().read() {
        CloseAction::Quit => {}
        CloseAction::Tray => {
            api.prevent_close();
            let _ = window.hide();
        }
        CloseAction::Ask => {
            api.prevent_close();
            let _ = window.emit(EVT_ASK_CLOSE, ());
        }
    }
}

impl Prefs {
    fn read(&self) -> CloseAction {
        self.close.lock().map(|g| *g).unwrap_or_default()
    }
}

// ---------- Commands ----------

#[tauri::command]
pub fn notify_payment_confirmation<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    app.state::<crate::access::AccessState>().require_authorized()?;
    if count == 0 { return Ok(()); }
    let body = if count == 1 {
        "1 completed appointment needs payment confirmation in Inbox.".to_string()
    } else {
        format!("{count} completed appointments need payment confirmation in Inbox.")
    };
    app.notification().builder().title("Tanned by Ffy: confirm payments").body(body)
        .show().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_tray_state<R: Runtime>(app: AppHandle<R>, state: TrayState) -> Result<(), String> {
    app.state::<crate::access::AccessState>().require_authorized()?;
    let tray = app.tray_by_id(TRAY_ID).ok_or("there is no tray icon")?;
    let menu = build_menu(&app, &state).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    let tooltip = if state.tooltip.is_empty() {
        DEFAULT_TOOLTIP.to_string()
    } else {
        state.tooltip
    };
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())
}

pub fn refresh_locked<R: Runtime>(app: &AppHandle<R>) {
    if app.state::<crate::access::AccessState>().require_authorized().is_ok() { return; }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Ok(menu) = build_menu(app, &TrayState::default()) { let _ = tray.set_menu(Some(menu)); }
        let _ = tray.set_tooltip(Some(DEFAULT_TOOLTIP));
    }
}

#[tauri::command]
pub fn set_close_action(prefs: State<'_, Prefs>, action: CloseAction) {
    if let Ok(mut guard) = prefs.close.lock() {
        *guard = action;
    }
}

#[tauri::command]
pub fn show_main_window<R: Runtime>(app: AppHandle<R>) {
    show_main(&app);
}

#[tauri::command]
pub fn hide_main_window<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = main_window(&app) {
        let _ = w.hide();
    }
}

/// Whether she can actually see the window — decides between a message in the
/// app and one from the system tray.
#[tauri::command]
pub fn window_is_active<R: Runtime>(app: AppHandle<R>) -> bool {
    main_window(&app)
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

#[tauri::command]
pub fn quit_app<R: Runtime>(app: AppHandle<R>) {
    app.exit(0);
}
