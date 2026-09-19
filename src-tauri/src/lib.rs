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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
