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

pub const TRAY_ID: &str = "ffyon-tray";
const MAIN_WINDOW: &str = "main";
const DEFAULT_TOOLTIP: &str = "Ffyon Business Tracker";

// What a click on the menu tells the front end to do.
const EVT_NEW_ENTRY: &str = "tray://new-entry";
const EVT_QUICK_ADD: &str = "tray://quick-add";
const EVT_MARK_PAID: &str = "tray://mark-paid";
const EVT_BACKUP: &str = "tray://backup";
const EVT_ASK_CLOSE: &str = "tray://ask-close";

/// One clickable line the front end has asked for. `id` is whatever it wants
/// handed back — a category or an appointment.
#[derive(Debug, Clone, Deserialize)]
pub struct TrayItem {
    pub id: i64,
    pub label: String,
}

/// The whole menu as the front end sees it. Sent again whenever the data moves.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrayState {
    pub tooltip: String,
    /// Today at a glance, greyed out at the top of the menu.
    pub lines: Vec<String>,
    /// Services with a usual price: one click books the money in.
    pub quick_add: Vec<TrayItem>,
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

    menu.append(&MenuItem::with_id(app, "open", "Open Ffyon", true, None::<&str>)?)?;

    if !state.quick_add.is_empty() {
        let sub = Submenu::with_id(app, "quick-add", "Quick add", true)?;
        for item in &state.quick_add {
            sub.append(&MenuItem::with_id(
                app,
                format!("quick:{}", item.id),
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
    menu.append(&MenuItem::with_id(app, "quit", "Quit Ffyon", true, None::<&str>)?)?;

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
            if let Some(id) = parse_id(other, "quick:") {
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
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
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
pub fn set_tray_state<R: Runtime>(app: AppHandle<R>, state: TrayState) -> Result<(), String> {
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
