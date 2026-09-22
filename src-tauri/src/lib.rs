mod tray;

use tauri_plugin_sql::{Migration, MigrationKind};

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_initial_tables",
        sql: r#"
            CREATE TABLE clients (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT,
                notes TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
                colour TEXT NOT NULL
            );

            CREATE TABLE transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
                date TEXT NOT NULL,
                amount_pence INTEGER NOT NULL CHECK (amount_pence >= 0),
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                description TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_transactions_date ON transactions(date);
            CREATE INDEX idx_transactions_client ON transactions(client_id);

            INSERT INTO categories (name, type, colour) VALUES
                ('Spray Tan', 'income', '#2a78d6'),
                ('Express Tan', 'income', '#eb6834'),
                ('Tan Top-up', 'income', '#1baf7a'),
                ('Product Sale', 'income', '#eda100'),
                ('Tanning Solution', 'expense', '#2a78d6'),
                ('Equipment', 'expense', '#eb6834'),
                ('Consumables', 'expense', '#1baf7a'),
                ('Marketing', 'expense', '#eda100'),
                ('Travel', 'expense', '#e87ba4'),
                ('Other', 'expense', '#008300');
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 2,
        description: "brand_palette",
        sql: r#"
            UPDATE categories SET colour = '#9c4a2a' WHERE colour = '#2a78d6';
            UPDATE categories SET colour = '#e8798f' WHERE colour = '#eb6834';
            UPDATE categories SET colour = '#2f7fcf' WHERE colour = '#1baf7a';
            UPDATE categories SET colour = '#dca021' WHERE colour = '#eda100';
            UPDATE categories SET colour = '#7a4aa0' WHERE colour = '#e87ba4';
            UPDATE categories SET colour = '#1c9a78' WHERE colour = '#008300';
            UPDATE categories SET colour = '#e0603a' WHERE colour = '#4a3aa7';
            UPDATE categories SET colour = '#b0305a' WHERE colour = '#e34948';
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 3,
        description: "category_default_amount",
        // Optional usual price per category. Only ever prefills a NEW entry's amount —
        // entries already saved keep the amount they were saved with.
        sql: r#"
            ALTER TABLE categories ADD COLUMN default_pence INTEGER;
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 4,
        description: "appointments",
        // Bookings are kept apart from the money. An appointment only reaches the
        // transactions table when it is marked paid, so nothing unpaid or upcoming
        // can show up in any of the income figures.
        sql: r#"
            CREATE TABLE appointments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                start_time TEXT NOT NULL,
                duration_min INTEGER NOT NULL DEFAULT 30,
                client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                price_pence INTEGER,
                notes TEXT,
                status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'paid')),
                transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX idx_appointments_date ON appointments(date);
            CREATE INDEX idx_appointments_client ON appointments(client_id);
        "#,
        kind: MigrationKind::Up,
    },
    Migration {
        version: 5,
        description: "appointment_status_and_series",
        // Adds 'cancelled' and 'no_show' to the status check (SQLite can't alter a
        // CHECK in place, so the table is rebuilt), plus series_id, which ties the
        // occurrences of a repeating booking together.
        sql: r#"
            CREATE TABLE appointments_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                start_time TEXT NOT NULL,
                duration_min INTEGER NOT NULL DEFAULT 30,
                client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                price_pence INTEGER,
                notes TEXT,
                status TEXT NOT NULL DEFAULT 'booked'
                    CHECK (status IN ('booked', 'paid', 'cancelled', 'no_show')),
                transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                series_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            INSERT INTO appointments_new
                (id, date, start_time, duration_min, client_id, category_id, price_pence,
                 notes, status, transaction_id, created_at)
            SELECT id, date, start_time, duration_min, client_id, category_id, price_pence,
                 notes, status, transaction_id, created_at
            FROM appointments;

            DROP TABLE appointments;
            ALTER TABLE appointments_new RENAME TO appointments;

            CREATE INDEX idx_appointments_date ON appointments(date);
            CREATE INDEX idx_appointments_client ON appointments(client_id);
            CREATE INDEX idx_appointments_series ON appointments(series_id);
        "#,
        kind: MigrationKind::Up,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:ffyon.db", migrations())
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(tray::Prefs::default())
        .setup(|app| {
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            tray::set_tray_state,
            tray::set_close_action,
            tray::show_main_window,
            tray::hide_main_window,
            tray::window_is_active,
            tray::quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
