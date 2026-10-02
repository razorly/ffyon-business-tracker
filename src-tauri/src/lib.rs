mod tray;
mod access;
mod database;
mod protected_files;
mod location;

use tauri::Manager;

struct Migration { version: i32, sql: &'static str }

fn migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
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
    },
    Migration {
        version: 2,
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
    },
    Migration {
        version: 3,
        // Optional usual price per category. Only ever prefills a NEW entry's amount —
        // entries already saved keep the amount they were saved with.
        sql: r#"
            ALTER TABLE categories ADD COLUMN default_pence INTEGER;
        "#,
    },
    Migration {
        version: 4,
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
    },
    Migration {
        version: 5,
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
    },
    Migration {
        version: 6,
        sql: r#"
            ALTER TABLE clients ADD COLUMN remote_id TEXT;
            ALTER TABLE clients ADD COLUMN account_id TEXT;
            ALTER TABLE clients ADD COLUMN email TEXT;
            ALTER TABLE clients ADD COLUMN cloud_revision INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE clients ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
            CREATE UNIQUE INDEX idx_clients_remote ON clients(remote_id) WHERE remote_id IS NOT NULL;
            ALTER TABLE categories ADD COLUMN service_id TEXT;
            CREATE UNIQUE INDEX idx_categories_service ON categories(service_id) WHERE service_id IS NOT NULL AND type='income';
            CREATE TABLE appointments_cloud (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL,
                start_time TEXT NOT NULL,
                duration_min INTEGER NOT NULL DEFAULT 30,
                client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
                category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
                price_pence INTEGER,
                notes TEXT,
                status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('pending','confirmed','rejected','cancelled','no_show')),
                transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
                series_id TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                remote_id TEXT,
                service_id TEXT,
                customer_notes TEXT,
                cloud_revision INTEGER NOT NULL DEFAULT 0,
                proposed_date TEXT,
                proposed_start_time TEXT,
                service_name TEXT
            );
            INSERT INTO appointments_cloud(id,date,start_time,duration_min,client_id,category_id,price_pence,notes,status,transaction_id,series_id,created_at)
            SELECT id,date,start_time,duration_min,client_id,category_id,price_pence,notes,
                CASE WHEN status IN ('booked','paid') THEN 'confirmed' ELSE status END,
                transaction_id,series_id,created_at FROM appointments;
            DROP TABLE appointments;
            ALTER TABLE appointments_cloud RENAME TO appointments;
            CREATE INDEX idx_appointments_date ON appointments(date);
            CREATE INDEX idx_appointments_client ON appointments(client_id);
            CREATE INDEX idx_appointments_series ON appointments(series_id);
            CREATE UNIQUE INDEX idx_appointments_remote ON appointments(remote_id) WHERE remote_id IS NOT NULL;
            CREATE TABLE cloud_services(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE cloud_blocks(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE cloud_settings(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        "#,
    },
    Migration {
        version: 7,
        sql: r#"
            ALTER TABLE clients ADD COLUMN saved_address TEXT NOT NULL DEFAULT '';
            ALTER TABLE clients ADD COLUMN saved_postcode TEXT NOT NULL DEFAULT '';
            ALTER TABLE appointments ADD COLUMN time_confirmed INTEGER NOT NULL DEFAULT 1 CHECK(time_confirmed IN (0,1));
            ALTER TABLE appointments ADD COLUMN proposed_time_confirmed INTEGER CHECK(proposed_time_confirmed IN (0,1));
            ALTER TABLE appointments ADD COLUMN is_remote INTEGER NOT NULL DEFAULT 0 CHECK(is_remote IN (0,1));
            ALTER TABLE appointments ADD COLUMN visit_address TEXT NOT NULL DEFAULT '';
            ALTER TABLE appointments ADD COLUMN visit_postcode TEXT NOT NULL DEFAULT '';
            ALTER TABLE appointments ADD COLUMN base_price_pence INTEGER;
            ALTER TABLE appointments ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100);
            UPDATE appointments SET base_price_pence=price_pence;
        "#,
    },
    Migration {
        version: 8,
        sql: r#"
            ALTER TABLE categories ADD COLUMN income_kind TEXT NOT NULL DEFAULT 'legacy' CHECK(income_kind IN ('legacy','service','other'));
            ALTER TABLE transactions ADD COLUMN service_id TEXT;
            ALTER TABLE transactions ADD COLUMN service_name TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN category_name_snapshot TEXT NOT NULL DEFAULT '';
            ALTER TABLE transactions ADD COLUMN income_kind TEXT CHECK(income_kind IS NULL OR income_kind IN ('legacy','service','other'));
            DROP INDEX IF EXISTS idx_categories_service;
            CREATE INDEX idx_categories_service ON categories(service_id) WHERE service_id IS NOT NULL AND type='income';
            UPDATE categories SET income_kind='service' WHERE type='income' AND service_id IS NOT NULL;
            UPDATE transactions SET category_name_snapshot=COALESCE((SELECT name FROM categories WHERE id=transactions.category_id),'');
            UPDATE transactions SET
                service_id=CASE WHEN EXISTS(SELECT 1 FROM appointments WHERE transaction_id=transactions.id AND (service_id IS NOT NULL OR COALESCE(service_name,'')!=''))
                    THEN (SELECT service_id FROM appointments WHERE transaction_id=transactions.id AND (service_id IS NOT NULL OR COALESCE(service_name,'')!='') ORDER BY id LIMIT 1)
                    ELSE (SELECT service_id FROM categories WHERE id=transactions.category_id AND type='income') END,
                service_name=COALESCE((SELECT NULLIF(service_name,'') FROM appointments WHERE transaction_id=transactions.id AND (service_id IS NOT NULL OR COALESCE(service_name,'')!='') ORDER BY id LIMIT 1),
                    NULLIF(category_name_snapshot,''),'')
                WHERE type='income' AND (EXISTS(SELECT 1 FROM appointments WHERE transaction_id=transactions.id AND (service_id IS NOT NULL OR COALESCE(service_name,'')!=''))
                    OR EXISTS(SELECT 1 FROM categories WHERE id=transactions.category_id AND type='income' AND service_id IS NOT NULL));
            UPDATE appointments SET
                service_id=(SELECT service_id FROM categories WHERE id=appointments.category_id AND type='income'),
                service_name=COALESCE(NULLIF(service_name,''),(SELECT name FROM categories WHERE id=appointments.category_id),'')
                WHERE remote_id IS NULL AND service_id IS NULL AND COALESCE(service_name,'')='' AND EXISTS(SELECT 1 FROM categories WHERE id=appointments.category_id AND type='income' AND service_id IS NOT NULL);
            UPDATE transactions SET income_kind=CASE WHEN service_id IS NOT NULL OR service_name!='' THEN 'service'
                ELSE (SELECT income_kind FROM categories WHERE id=transactions.category_id AND type='income') END WHERE type='income';
            CREATE INDEX idx_transactions_service ON transactions(service_id) WHERE service_id IS NOT NULL AND type='income';
        "#,
    }]
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if access::handle_cli() { return; }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(tray::Prefs::default())
        .manage(access::AccessState::new())
        .manage(protected_files::FileGrants::default())
        .setup(|app| {
            app.manage(database::initialize(app.handle()).map_err(std::io::Error::other)?);
            tray::setup(app.handle())?;
            access::start_timer(app.handle());
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            tray::notify_payment_confirmation,
            tray::set_tray_state,
            tray::set_close_action,
            tray::show_main_window,
            tray::hide_main_window,
            tray::window_is_active,
            tray::quit_app,
            access::access_status,
            access::access_prepare,
            access::access_connect,
            access::access_pair,
            access::access_check,
            access::access_disconnect,
            access::admin_request,
            location::lookup_postcode,
            location::open_appointment_directions,
            database::db_select,
            database::db_read_batch,
            database::db_execute,
            database::db_batch,
            protected_files::protected_pick_file,
            protected_files::protected_pick_directory,
            protected_files::protected_save_file,
            protected_files::protected_write_file,
            protected_files::protected_write_text_file,
            protected_files::protected_read_text_file,
            protected_files::protected_read_dir,
            protected_files::protected_remove_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
