use std::{path::Path, sync::Mutex, time::Duration};

use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    types::{Value as SqlValue, ValueRef},
    Connection, DatabaseName,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

use crate::access::AccessState;

pub struct DatabaseState(pub Mutex<Connection>);

#[derive(Deserialize)]
pub struct Statement {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteResult {
    pub rows_affected: usize,
    pub last_insert_id: i64,
}

fn has_table(conn: &Connection, table: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )
}

fn has_column(conn: &Connection, table: &str, column: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
        [table, column],
        |r| r.get(0),
    )
}

fn legacy_version(conn: &Connection) -> rusqlite::Result<i64> {
    if !has_table(conn, "clients")? {
        return Ok(0);
    }
    if has_column(conn, "appointments", "time_confirmed")? {
        return Ok(7);
    }
    if has_column(conn, "appointments", "remote_id")? {
        return Ok(6);
    }
    if has_column(conn, "appointments", "series_id")? {
        return Ok(5);
    }
    if has_table(conn, "appointments")? {
        return Ok(4);
    }
    if has_column(conn, "categories", "default_pence")? {
        return Ok(3);
    }
    Ok(1)
}

pub fn initialize(app: &AppHandle) -> Result<DatabaseState, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    open(&dir.join("ffyon.db"))
}

fn open(path: &Path) -> Result<DatabaseState, String> {
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    let legacy = has_table(&conn, "clients").map_err(|e| e.to_string())?;
    let version: i64 = if has_table(&conn, "_ffyon_migrations").map_err(|e| e.to_string())? {
        conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM _ffyon_migrations",
            [],
            |r| r.get(0),
        )
    } else if has_table(&conn, "_sqlx_migrations").map_err(|e| e.to_string())? {
        conn.query_row(
            "SELECT COALESCE(MAX(version),0) FROM _sqlx_migrations WHERE success=1",
            [],
            |r| r.get(0),
        )
    } else {
        legacy_version(&conn)
    }
    .map_err(|e| e.to_string())?;
    if legacy && version < 7 {
        let stamp = crate::access::now_seconds();
        let upgrade = if version < 6 {
            "cloud"
        } else {
            "booking-features"
        };
        let backup = path.with_file_name(format!(
            "ffyon-pre-{upgrade}-{stamp}-{}.db",
            uuid::Uuid::new_v4()
        ));
        conn.backup(DatabaseName::Main, backup, None)
            .map_err(|e| format!("The pre-upgrade backup could not be created: {e}"))?;
    }
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS _ffyon_migrations(version INTEGER PRIMARY KEY);")
        .map_err(|e| e.to_string())?;
    if version > 0 {
        conn.execute(
            "INSERT OR IGNORE INTO _ffyon_migrations(version) VALUES (?1)",
            [version],
        )
        .map_err(|e| e.to_string())?;
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for migration in crate::migrations() {
        if migration.version as i64 <= version {
            continue;
        }
        tx.execute_batch(migration.sql)
            .map_err(|e| format!("Database upgrade {} failed: {e}", migration.version))?;
        tx.execute(
            "INSERT INTO _ffyon_migrations(version) VALUES (?1)",
            [migration.version],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    conn.authorizer(Some(authorize_sql));
    Ok(DatabaseState(Mutex::new(conn)))
}

fn allowed_table(table: &str) -> bool {
    matches!(
        table,
        "clients"
            | "categories"
            | "transactions"
            | "appointments"
            | "sync_state"
            | "cloud_services"
            | "cloud_blocks"
            | "cloud_settings"
    )
}

fn authorize_sql(ctx: AuthContext<'_>) -> Authorization {
    if ctx.database_name.is_some_and(|name| name != "main") {
        return Authorization::Deny;
    }
    let allowed = match ctx.action {
        AuthAction::Read { table_name, .. }
        | AuthAction::Insert { table_name }
        | AuthAction::Update { table_name, .. }
        | AuthAction::Delete { table_name } => allowed_table(table_name),
        AuthAction::Select
        | AuthAction::Recursive
        | AuthAction::Transaction { .. }
        | AuthAction::Savepoint { .. } => true,
        AuthAction::Function { function_name } => !matches!(
            function_name.to_ascii_lowercase().as_str(),
            "load_extension" | "readfile" | "writefile"
        ),
        _ => false,
    };
    if allowed {
        Authorization::Allow
    } else {
        Authorization::Deny
    }
}

fn sql_params(params: Vec<Value>) -> Result<Vec<SqlValue>, String> {
    params
        .into_iter()
        .map(|v| match v {
            Value::Null => Ok(SqlValue::Null),
            Value::Bool(v) => Ok(SqlValue::Integer(i64::from(v))),
            Value::Number(v) => {
                if let Some(v) = v.as_i64() {
                    Ok(SqlValue::Integer(v))
                } else {
                    v.as_f64()
                        .map(SqlValue::Real)
                        .ok_or_else(|| "Invalid numeric parameter".into())
                }
            }
            Value::String(v) => Ok(SqlValue::Text(v)),
            _ => Err("Database parameters must be scalar values".into()),
        })
        .collect()
}

fn execute(conn: &Connection, statement: Statement) -> Result<ExecuteResult, String> {
    if statement.sql.len() > 100_000 {
        return Err("Database statement is too large".into());
    }
    let values = sql_params(statement.params)?;
    let mut stmt = conn.prepare(&statement.sql).map_err(|e| e.to_string())?;
    if stmt.readonly() {
        return Err("Use db_select for read-only statements".into());
    }
    bind_parameters(&mut stmt, &values)?;
    let rows_affected = stmt.raw_execute().map_err(|e| e.to_string())?;
    Ok(ExecuteResult {
        rows_affected,
        last_insert_id: conn.last_insert_rowid(),
    })
}

fn bind_parameters(stmt: &mut rusqlite::Statement<'_>, values: &[SqlValue]) -> Result<(), String> {
    // SQLite indexes named parameters by appearance; the app uses $N by array position.
    for index in 1..=stmt.parameter_count() {
        let value_index = match stmt.parameter_name(index) {
            Some(name) => name
                .strip_prefix('$')
                .or_else(|| name.strip_prefix('?'))
                .and_then(|name| name.parse::<usize>().ok())
                .and_then(|n| n.checked_sub(1))
                .ok_or("Database parameter names must use $N")?,
            None => index - 1,
        };
        let value = values
            .get(value_index)
            .ok_or("A database parameter is missing")?;
        stmt.raw_bind_parameter(index, value)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn db_select(
    access: State<'_, AccessState>,
    database: State<'_, DatabaseState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<Vec<Value>, String> {
    access.require_authorized()?;
    if sql.len() > 100_000 {
        return Err("Database statement is too large".into());
    }
    let conn = database.0.lock().map_err(|_| "The database is busy")?;
    access.require_authorized()?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    if !stmt.readonly() || stmt.column_count() == 0 {
        return Err("Only read-only queries may use db_select".into());
    }
    let names: Vec<String> = stmt.column_names().iter().map(|n| n.to_string()).collect();
    let values = sql_params(params.unwrap_or_default())?;
    bind_parameters(&mut stmt, &values)?;
    let mut rows = stmt.raw_query();
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if result.len() >= 100_000 {
            return Err("Query returned too many rows".into());
        }
        let mut value = Map::new();
        for (i, name) in names.iter().enumerate() {
            let cell = match row.get_ref(i).map_err(|e| e.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => Value::from(n),
                ValueRef::Real(n) => Value::from(n),
                ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                ValueRef::Blob(_) => {
                    return Err(
                        "Binary values cannot be returned by this database interface".into(),
                    )
                }
            };
            value.insert(name.clone(), cell);
        }
        result.push(Value::Object(value));
    }
    access.require_authorized()?;
    Ok(result)
}

#[tauri::command]
pub fn db_execute(
    access: State<'_, AccessState>,
    database: State<'_, DatabaseState>,
    sql: String,
    params: Option<Vec<Value>>,
) -> Result<ExecuteResult, String> {
    access.require_authorized()?;
    let conn = database.0.lock().map_err(|_| "The database is busy")?;
    access.require_authorized()?;
    execute(
        &conn,
        Statement {
            sql,
            params: params.unwrap_or_default(),
        },
    )
}

#[tauri::command]
pub fn db_batch(
    access: State<'_, AccessState>,
    database: State<'_, DatabaseState>,
    statements: Vec<Statement>,
) -> Result<Vec<ExecuteResult>, String> {
    access.require_authorized()?;
    if statements.len() > 20_000 {
        return Err("The database batch is too large".into());
    }
    let mut conn = database.0.lock().map_err(|_| "The database is busy")?;
    access.require_authorized()?;
    batch(&mut conn, statements)
}

fn batch(conn: &mut Connection, statements: Vec<Statement>) -> Result<Vec<ExecuteResult>, String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut result = Vec::with_capacity(statements.len());
    for stmt in statements {
        result.push(execute(&tx, stmt)?);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorizer_blocks_file_access_schema_and_credentials() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE clients(id INTEGER); CREATE TABLE secrets(token TEXT);")
            .unwrap();
        conn.authorizer(Some(authorize_sql));
        assert!(conn.prepare("SELECT * FROM clients").is_ok());
        assert!(conn.prepare("SELECT * FROM secrets").is_err());
        assert!(conn
            .execute_batch("ATTACH DATABASE 'elsewhere.db' AS other")
            .is_err());
        assert!(conn.execute_batch("PRAGMA writable_schema=ON").is_err());
        assert!(conn.execute_batch("DROP TABLE clients").is_err());
    }

    #[test]
    fn migrations_upgrade_old_diary_and_preserve_payment() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations().into_iter().take(5) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute(
            "INSERT INTO clients(name,notes) VALUES ('Existing customer','Private staff note')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO transactions(type,date,amount_pence,client_id) VALUES ('income','2026-09-30',2500,1)", []).unwrap();
        conn.execute("INSERT INTO appointments(date,start_time,client_id,status,transaction_id) VALUES ('2026-09-30','09:00',1,'paid',1)", []).unwrap();
        conn.execute_batch(crate::migrations()[5].sql).unwrap();
        assert!(conn
            .prepare("SELECT remote_id, transaction_id FROM appointments")
            .is_ok());
        let (status, payment): (String, i64) = conn
            .query_row(
                "SELECT status, transaction_id FROM appointments WHERE id=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "confirmed");
        assert_eq!(payment, 1);
        assert_eq!(
            conn.query_row("SELECT notes FROM clients WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Private staff note"
        );
    }

    #[test]
    fn legacy_without_sqlx_metadata_is_detected() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations().into_iter().take(3) {
            conn.execute_batch(migration.sql).unwrap();
        }
        assert_eq!(legacy_version(&conn).unwrap(), 3);
        assert!(!has_table(&conn, "_sqlx_migrations").unwrap());
    }

    #[test]
    fn v7_upgrade_preserves_existing_quotes_contacts_notes_and_payments() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations().into_iter().take(6) {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.execute_batch("PRAGMA foreign_keys=ON;
            INSERT INTO clients(id,name,email,phone,notes,remote_id,account_id)
            VALUES (1,'Existing customer','customer@example.test','123','Private note','client-1','account-1');
            INSERT INTO transactions(id,type,date,amount_pence,client_id,description)
            VALUES (1,'income','2026-10-01',2500,1,'Recorded payment');
            INSERT INTO appointments(id,date,start_time,client_id,price_pence,notes,status,transaction_id,remote_id)
            VALUES (1,'2026-10-01','09:00',1,2500,'Private booking note','confirmed',1,'booking-1');
            INSERT INTO appointments(id,date,start_time,client_id,price_pence,status)
            VALUES (2,'2026-10-02','10:00',1,NULL,'confirmed');").unwrap();
        conn.execute_batch(crate::migrations()[6].sql).unwrap();
        assert_eq!(legacy_version(&conn).unwrap(), 7);
        let details: (i64, i64, String, String, i64, i64, i64) = conn.query_row(
            "SELECT time_confirmed,is_remote,visit_address,visit_postcode,base_price_pence,discount_percent,transaction_id FROM appointments WHERE id=1",
            [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?)),
        ).unwrap();
        assert_eq!(details, (1, 0, "".into(), "".into(), 2500, 0, 1));
        assert_eq!(
            conn.query_row(
                "SELECT base_price_pence FROM appointments WHERE id=2",
                [],
                |row| row.get::<_, Option<i64>>(0)
            )
            .unwrap(),
            None
        );
        assert_eq!(
            conn.query_row("SELECT notes FROM clients WHERE id=1", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "Private note"
        );
        assert_eq!(
            conn.query_row("SELECT email FROM clients WHERE id=1", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "customer@example.test"
        );
        assert_eq!(
            conn.query_row(
                "SELECT amount_pence FROM transactions WHERE id=1",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2500
        );

        conn.authorizer(Some(authorize_sql));
        conn.execute_batch("UPDATE clients SET saved_address='12 Example Lane',saved_postcode='SW1A 1AA' WHERE id=1;
            INSERT INTO appointments(date,start_time,time_confirmed,is_remote,visit_address,visit_postcode,price_pence,base_price_pence,discount_percent,status)
            VALUES ('2026-10-03','00:00',0,1,'12 Example Lane','SW1A 1AA',2000,2500,20,'confirmed');").unwrap();
        assert!(conn
            .execute_batch("UPDATE appointments SET time_confirmed=2 WHERE id=3")
            .is_err());
        assert!(conn
            .execute_batch("UPDATE appointments SET is_remote=-1 WHERE id=3")
            .is_err());
        assert!(conn
            .execute_batch("UPDATE appointments SET discount_percent=101 WHERE id=3")
            .is_err());
        assert!(conn
            .execute_batch("UPDATE appointments SET proposed_time_confirmed=2 WHERE id=3")
            .is_err());
    }

    #[test]
    fn v6_file_is_backed_up_before_booking_features_and_only_upgraded_once() {
        let dir =
            std::env::temp_dir().join(format!("ffyon-features-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ffyon.db");
        {
            let conn = Connection::open(&path).unwrap();
            for migration in crate::migrations().into_iter().take(6) {
                conn.execute_batch(migration.sql).unwrap();
            }
            conn.execute_batch("INSERT INTO clients(name,notes) VALUES ('Existing customer','Private');
                INSERT INTO transactions(type,date,amount_pence,client_id) VALUES ('income','2026-10-01',2500,1);
                INSERT INTO appointments(date,start_time,price_pence,status,transaction_id) VALUES ('2026-10-01','09:00',2500,'confirmed',1);").unwrap();
        }
        for _ in 0..2 {
            let state = open(&path).unwrap();
            let conn = state.0.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT base_price_pence FROM appointments WHERE id=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                2500
            );
            assert_eq!(
                conn.query_row(
                    "SELECT amount_pence FROM transactions WHERE id=1",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                2500
            );
        }
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("ffyon-pre-booking-features-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        {
            let backup = Connection::open(backups[0].path()).unwrap();
            assert_eq!(legacy_version(&backup).unwrap(), 6);
            assert_eq!(
                backup
                    .query_row(
                        "SELECT price_pence FROM appointments WHERE id=1",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                2500
            );
            assert_eq!(
                backup
                    .query_row(
                        "SELECT transaction_id FROM appointments WHERE id=1",
                        [],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        assert!(dir.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn metadata_less_v7_is_detected_without_repeating_migration_or_backup() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations() {
            conn.execute_batch(migration.sql).unwrap();
        }
        assert_eq!(legacy_version(&conn).unwrap(), 7);
        assert!(conn
            .prepare("SELECT saved_address,saved_postcode FROM clients")
            .is_ok());
        assert!(!has_table(&conn, "_ffyon_migrations").unwrap());
    }

    #[test]
    fn metadata_less_v3_file_is_backed_up_and_upgraded_without_losing_money() {
        let dir = std::env::temp_dir().join(format!("ffyon-upgrade-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ffyon.db");
        {
            let conn = Connection::open(&path).unwrap();
            for migration in crate::migrations().into_iter().take(3) {
                conn.execute_batch(migration.sql).unwrap();
            }
            conn.execute(
                "INSERT INTO clients(name,notes) VALUES ('Legacy customer','Private')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO transactions(type,date,amount_pence,client_id) VALUES ('income','2026-09-30',2500,1)", []).unwrap();
        }
        {
            let state = open(&path).unwrap();
            let conn = state.0.lock().unwrap();
            assert_eq!(
                conn.query_row(
                    "SELECT amount_pence FROM transactions WHERE id=1",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                2500
            );
            assert!(conn.prepare("SELECT remote_id FROM appointments").is_ok());
        }
        let backups: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("ffyon-pre-cloud-")
            })
            .collect();
        assert_eq!(backups.len(), 1);
        {
            let backup = Connection::open(backups[0].path()).unwrap();
            assert_eq!(legacy_version(&backup).unwrap(), 3);
            assert_eq!(
                backup
                    .query_row(
                        "SELECT amount_pence FROM transactions WHERE id=1",
                        [],
                        |r| r.get::<_, i64>(0)
                    )
                    .unwrap(),
                2500
            );
        }
        assert!(dir.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_native_batch_rolls_back_all_statements() {
        let mut conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations() {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.authorizer(Some(authorize_sql));
        let result = batch(&mut conn, vec![
            Statement { sql: "INSERT INTO clients(name) VALUES ($1)".into(), params: vec![Value::from("Rollback client")] },
            Statement { sql: "INSERT INTO transactions(type,date,amount_pence) VALUES ('income','2026-10-01',-1)".into(), params: vec![] },
        ]);
        assert!(result.is_err());
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM clients", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn named_parameter_positions_match_browser_adapter_with_unused_values() {
        let conn = Connection::open_in_memory().unwrap();
        for migration in crate::migrations() {
            conn.execute_batch(migration.sql).unwrap();
        }
        conn.authorizer(Some(authorize_sql));
        execute(
            &conn,
            Statement {
                sql: "INSERT INTO clients(name) VALUES ($1)".into(),
                params: vec![Value::from("Old name")],
            },
        )
        .unwrap();
        execute(
            &conn,
            Statement {
                sql: "UPDATE clients SET notes=$1,name=$3,phone=$4,email=$5 WHERE id=$2".into(),
                params: vec![
                    Value::from("Private"),
                    Value::from(1),
                    Value::from("Jane"),
                    Value::from("123"),
                    Value::from("jane@example.test"),
                ],
            },
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT name FROM clients WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Jane"
        );
        execute(
            &conn,
            Statement {
                sql: "UPDATE clients SET notes=$1 WHERE id=$2".into(),
                params: vec![
                    Value::from("Updated private"),
                    Value::from(1),
                    Value::from("Unused"),
                ],
            },
        )
        .unwrap();
        assert_eq!(
            conn.query_row("SELECT notes FROM clients WHERE id=1", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Updated private"
        );
    }
}
