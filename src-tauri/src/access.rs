//! Device credentials and offline authorization never cross the webview boundary.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signature, VerifyingKey};
use keyring_core::Entry;
use rand::{rngs::OsRng, RngCore};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::{Zeroize, Zeroizing};

pub const SITE_ORIGIN: &str = "https://ffyon-customer.razorly.chatgpt.site";
const SITE_ID: &str = "appgprj_6abd6e180c8081918b5ec762c98ae90e";
const LEASE_PUBLIC_KEY: &str = "rGccNwiaYb5Ek0TVhC/aXWrlXrlByX0gar0Wwutr7NY=";
const VAULT_SERVICE: &str = "com.ffyon.tracker.admin";
const VAULT_ACCOUNT: &str = "device-v1";
const LEASE_SECONDS: u64 = 86_400;

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SignedLease {
    payload: String,
    signature: String,
}

#[derive(Deserialize)]
struct LeaseClaims {
    version: u32,
    site_id: String,
    device_id: String,
    token_hash: String,
    issued_at: u64,
    expires_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Vault {
    device_id: String,
    name: String,
    token: String,
    lease: Option<SignedLease>,
    high_water: u64,
    #[serde(default)]
    require_online: bool,
}

impl Drop for Vault {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

#[derive(Clone, Serialize, PartialEq, Eq)]
pub struct AccessStatus {
    state: String,
    device_id: Option<String>,
    device_name: Option<String>,
    expires_at: Option<u64>,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct PreparedDevice {
    device_id: String,
    token_hash: String,
}

struct Inner {
    vault: Option<Vault>,
    online: bool,
    error: Option<String>,
    vault_ready: bool,
    deadline: Option<Instant>,
    require_online: bool,
}

pub struct AccessState {
    inner: Mutex<Inner>,
    client: Client,
    origin: String,
    persistence: Arc<dyn DevicePersistence>,
    verifier: Vec<u8>,
}

trait DevicePersistence: Send + Sync {
    fn read(&self) -> Result<Option<Vault>, String>;
    fn write(&self, vault: &Vault) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
    fn requires_online(&self) -> bool;
    fn mark_recheck(&self) -> Result<(), String>;
    fn clear_recheck(&self) -> Result<(), String>;
}

struct NativePersistence;
impl DevicePersistence for NativePersistence {
    fn read(&self) -> Result<Option<Vault>, String> {
        initialize_store()?;
        match vault_entry(VAULT_ACCOUNT)?.get_password() {
            Ok(raw) => serde_json::from_str::<Vault>(&Zeroizing::new(raw))
                .map(Some)
                .map_err(|_| "Stored credentials are invalid; pair this computer again".into()),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err(
                "Secure credential storage could not be opened. Allow Keychain access or retry."
                    .into(),
            ),
        }
    }
    fn write(&self, vault: &Vault) -> Result<(), String> {
        persist(vault)
    }
    fn delete(&self) -> Result<(), String> {
        match vault_entry(VAULT_ACCOUNT)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err("Unable to remove the credential from secure storage".into()),
        }
    }
    fn requires_online(&self) -> bool {
        recheck_marker().map(|path| path.exists()).unwrap_or(true)
    }
    fn mark_recheck(&self) -> Result<(), String> {
        mark_recheck()
    }
    fn clear_recheck(&self) -> Result<(), String> {
        clear_recheck()
    }
}

fn vault_entry(account: &str) -> Result<Entry, String> {
    #[cfg(target_os = "windows")]
    let entry = Entry::new_with_modifiers(
        VAULT_SERVICE,
        account,
        &HashMap::from([("persistence", "Local")]),
    );
    #[cfg(not(target_os = "windows"))]
    let entry = Entry::new(VAULT_SERVICE, account);
    entry.map_err(|_| "Secure credential storage is unavailable. Allow Keychain access or retry Windows Credential Manager.".into())
}

fn initialize_store() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    keyring_core::set_default_store(
        windows_native_keyring_store::Store::new()
            .map_err(|_| "Windows Credential Manager is unavailable")?,
    );
    #[cfg(target_os = "macos")]
    keyring_core::set_default_store(
        apple_native_keyring_store::keychain::Store::new()
            .map_err(|_| "macOS Keychain is unavailable")?,
    );
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Err("This app requires Windows Credential Manager or macOS Keychain".into());
    #[allow(unreachable_code)]
    Ok(())
}

fn persist(vault: &Vault) -> Result<(), String> {
    let data = Zeroizing::new(
        serde_json::to_string(vault).map_err(|_| "Unable to prepare secure credentials")?,
    );
    let entry = vault_entry(VAULT_ACCOUNT)?;
    entry
        .set_password(&data)
        .map_err(|_| "Unable to save credentials securely. Allow Keychain access and retry.")?;
    let readback = Zeroizing::new(
        entry
            .get_password()
            .map_err(|_| "Secure credential verification failed")?,
    );
    if data.as_str() != readback.as_str() {
        return Err("Secure credential verification failed".into());
    }
    Ok(())
}

fn recheck_marker() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    let root = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or("The application data directory is unavailable")?;
    #[cfg(target_os = "macos")]
    let root = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("The application data directory is unavailable")?
        .join("Library/Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Err("Secure authorization is unavailable on this platform".into());
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    Ok(root
        .join("com.ffyon.tracker")
        .join("access-recheck-required"))
}

fn mark_recheck() -> Result<(), String> {
    let path = recheck_marker()?;
    std::fs::create_dir_all(path.parent().ok_or("Invalid application data directory")?)
        .map_err(|_| "Cannot record the authorization lock")?;
    std::fs::write(
        path,
        b"Online verification is required. This file contains no credentials.",
    )
    .map_err(|_| "Cannot record the authorization lock".into())
}

fn clear_recheck() -> Result<(), String> {
    match std::fs::remove_file(recheck_marker()?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot clear the authorization lock; retry online verification".into()),
    }
}

fn verify_lease(lease: &SignedLease, vault: &Vault, now: u64, key: &[u8]) -> Result<u64, String> {
    verify_with_key(lease, &vault.device_id, &hash_token(&vault.token), now, key)
}

fn verify_with_key(
    lease: &SignedLease,
    device_id: &str,
    token_hash: &str,
    now: u64,
    key: &[u8],
) -> Result<u64, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(&lease.payload)
        .map_err(|_| "Invalid offline authorization")?;
    if bytes.len() > 1500 {
        return Err("Invalid offline authorization".into());
    }
    let signature_bytes = URL_SAFE_NO_PAD
        .decode(&lease.signature)
        .map_err(|_| "Invalid offline authorization")?;
    let signature =
        Signature::from_slice(&signature_bytes).map_err(|_| "Invalid offline authorization")?;
    let key: &[u8; 32] = key
        .try_into()
        .map_err(|_| "Invalid authorization verifier")?;
    VerifyingKey::from_bytes(key)
        .map_err(|_| "Invalid authorization verifier")?
        .verify_strict(&bytes, &signature)
        .map_err(|_| "The offline authorization signature is invalid")?;
    let claims: LeaseClaims =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid offline authorization")?;
    if claims.version != 1
        || claims.site_id != SITE_ID
        || claims.device_id != device_id
        || claims.token_hash != token_hash
        || claims.expires_at.checked_sub(claims.issued_at) != Some(LEASE_SECONDS)
        || claims.issued_at > now.saturating_add(60)
    {
        return Err("This authorization does not belong to this device".into());
    }
    if claims.expires_at <= now {
        return Err("Admin authorization expired. Connect to the site to unlock the app.".into());
    }
    Ok(claims.expires_at)
}

impl AccessState {
    pub fn new() -> Self {
        Self::with_persistence(
            Arc::new(NativePersistence),
            STANDARD
                .decode(LEASE_PUBLIC_KEY)
                .expect("pinned public verifier"),
        )
    }

    fn with_persistence(persistence: Arc<dyn DevicePersistence>, verifier: Vec<u8>) -> Self {
        let result = persistence.read();
        let (vault, error, vault_ready) = match result {
            Ok(vault) => (vault, None, true),
            Err(error) => (None, Some(error), false),
        };
        let require_online = persistence.requires_online()
            || vault.as_ref().is_some_and(|vault| vault.require_online);
        let now = now_seconds();
        let deadline = vault
            .as_ref()
            .and_then(|vault| {
                vault
                    .lease
                    .as_ref()
                    .and_then(|lease| verify_lease(lease, vault, now, &verifier).ok())
            })
            .map(|expiry| Instant::now() + Duration::from_secs(expiry.saturating_sub(now)));
        let origin = fixture_origin().unwrap_or_else(|| SITE_ORIGIN.into());
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .expect("native HTTPS client configuration");
        Self {
            inner: Mutex::new(Inner {
                vault,
                online: false,
                error,
                vault_ready,
                deadline,
                require_online,
            }),
            client,
            origin,
            persistence,
            verifier,
        }
    }

    pub fn status(&self) -> AccessStatus {
        let Ok(mut inner) = self.inner.lock() else {
            return AccessStatus {
                state: "locked".into(),
                device_id: None,
                device_name: None,
                expires_at: None,
                error: Some("Credential storage is busy".into()),
            };
        };
        let now = now_seconds();
        let mut expires_at = None;
        let mut lease_error = None;
        if inner.require_online {
            lease_error = Some("Connect to verify admin access for this computer.".into());
        }
        if inner
            .deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            lease_error =
                Some("Admin authorization expired. Connect to the site to unlock the app.".into());
        }
        if let Some(vault) = &inner.vault {
            if now.saturating_add(60) < vault.high_water {
                lease_error = Some(
                    "The computer clock moved backwards. Connect to verify admin access.".into(),
                );
            } else if lease_error.is_none() && !vault.require_online {
                if let Some(lease) = &vault.lease {
                    match verify_lease(lease, vault, now, &self.verifier) {
                        Ok(expiry) => expires_at = Some(expiry),
                        Err(error) => lease_error = Some(error),
                    }
                }
            }
        }
        if let Some(error) = lease_error {
            inner.error = Some(error);
            inner.online = false;
            expires_at = None;
            if !inner.require_online {
                inner.require_online = true;
                inner.deadline = None;
                let _ = self.persistence.mark_recheck();
                if let Some(vault) = inner.vault.as_mut() {
                    vault.lease = None;
                    vault.require_online = true;
                    if self.persistence.write(vault).is_err() {
                        let _ = self.persistence.delete();
                    }
                }
            }
        }
        if expires_at.is_some() {
            if let Some(vault) = inner.vault.as_mut() {
                if now > vault.high_water.saturating_add(30) {
                    vault.high_water = now;
                    if let Err(error) = self.persistence.write(vault) {
                        vault.lease = None;
                        vault.require_online = true;
                        inner.require_online = true;
                        inner.deadline = None;
                        let _ = self.persistence.mark_recheck();
                        inner.error = Some(error);
                        inner.online = false;
                        expires_at = None;
                    }
                }
            }
        }
        AccessStatus {
            state: if expires_at.is_some() {
                if inner.online {
                    "online"
                } else {
                    "offline"
                }
            } else {
                "locked"
            }
            .into(),
            device_id: inner.vault.as_ref().map(|v| v.device_id.clone()),
            device_name: inner.vault.as_ref().map(|v| v.name.clone()),
            expires_at,
            error: inner.error.clone(),
        }
    }

    pub fn require_authorized(&self) -> Result<(), String> {
        let status = self.status();
        if status.state == "online" || status.state == "offline" {
            Ok(())
        } else {
            Err(status
                .error
                .unwrap_or_else(|| "This computer must be approved before using Ffyon".into()))
        }
    }

    fn prepare(&self, name: String) -> Result<PreparedDevice, String> {
        let name = name.trim();
        if name.is_empty() || name.len() > 100 {
            return Err("Enter a computer name of up to 100 characters".into());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Credential storage is busy")?;
        if !inner.vault_ready {
            inner.vault = self.persistence.read()?;
            inner.vault_ready = true;
        }
        if inner.vault.is_none() {
            let mut bytes = Zeroizing::new([0u8; 32]);
            OsRng.fill_bytes(bytes.as_mut());
            let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let vault = Vault {
                device_id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                token,
                lease: None,
                high_water: now_seconds(),
                require_online: true,
            };
            self.persistence.write(&vault)?;
            inner.vault = Some(vault);
            inner.require_online = true;
            inner.error = None;
        }
        let vault = inner.vault.as_ref().ok_or("No device credential")?;
        Ok(PreparedDevice {
            device_id: vault.device_id.clone(),
            token_hash: hash_token(&vault.token),
        })
    }

    fn credential(&self) -> Result<Vault, String> {
        self.inner
            .lock()
            .map_err(|_| "Credential storage is busy")?
            .vault
            .clone()
            .ok_or_else(|| "Set up or pair this computer first".into())
    }

    async fn send(
        &self,
        vault: &Vault,
        operation: &str,
        method: Method,
        body: Option<Value>,
        query: Option<HashMap<String, String>>,
    ) -> Result<Value, (bool, String)> {
        let url = format!("{}/api/admin/v1/{operation}", self.origin);
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&vault.token)
            .header("X-Ffyon-Device", &vault.device_id);
        if let Some(body) = body {
            request = request.json(&body);
        }
        if let Some(query) = query {
            request = request.query(&query);
        }
        let response = request.send().await.map_err(|_| {
            (
                false,
                "Unable to reach the Ffyon site. Check the internet connection.".into(),
            )
        })?;
        let status = response.status();
        if status.is_redirection() {
            return Err((
                false,
                "The site redirected the connection; admin credentials were not forwarded.".into(),
            ));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err((
                true,
                "This computer is not authorized. Pair it again or ask the owner to approve it."
                    .into(),
            ));
        }
        let payload = response
            .json::<Value>()
            .await
            .map_err(|_| (false, "The site returned an invalid response.".into()))?;
        if !status.is_success() {
            let message = payload
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The site could not complete that action");
            return Err((false, format!("{}: {}", status.as_u16(), message)));
        }
        Ok(payload)
    }

    fn failed(&self, revoked: bool, error: String) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.online = false;
            inner.error = Some(error);
            if revoked {
                inner.require_online = true;
                inner.deadline = None;
                let marker_result = self.persistence.mark_recheck();
                if let Some(vault) = inner.vault.as_mut() {
                    vault.lease = None;
                    vault.require_online = true;
                    if self.persistence.write(vault).is_err() {
                        let removal = self.persistence.delete();
                        if marker_result.is_err() && removal.is_err() {
                            inner.error = Some("Access is locked, but the storage failure prevented recording it. Restore secure storage and verify online before restarting.".into());
                        }
                    }
                }
            }
        }
    }

    fn receive_session(&self, credential: &Vault, response: Value) -> Result<(), String> {
        let lease: SignedLease = serde_json::from_value(
            response
                .get("lease")
                .cloned()
                .ok_or("The site did not return device authorization")?,
        )
        .map_err(|_| "Invalid site authorization")?;
        let now = now_seconds();
        let expiry = verify_lease(&lease, credential, now, &self.verifier)?;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Credential storage is busy")?;
        let vault = inner
            .vault
            .as_mut()
            .ok_or("The device was disconnected during verification")?;
        if vault.device_id != credential.device_id || vault.token != credential.token {
            return Err("The device changed during verification".into());
        }
        vault.lease = Some(lease);
        vault.high_water = now;
        vault.require_online = false;
        if let Err(error) = self.persistence.write(vault) {
            vault.lease = None;
            inner.online = false;
            return Err(error);
        }
        self.persistence.clear_recheck()?;
        inner.require_online = false;
        inner.deadline = Some(Instant::now() + Duration::from_secs(expiry.saturating_sub(now)));
        inner.online = true;
        inner.error = None;
        Ok(())
    }

    async fn verify(&self, bootstrap: bool) -> AccessStatus {
        match self.credential() {
            Ok(vault) => {
                let operation = if bootstrap { "bootstrap" } else { "session" };
                let method = if bootstrap { Method::POST } else { Method::GET };
                let body =
                    bootstrap.then(|| json!({"device_id": vault.device_id, "name": vault.name}));
                match self.send(&vault, operation, method, body, None).await {
                    Ok(response) => {
                        if let Err(error) = self.receive_session(&vault, response) {
                            self.failed(true, error);
                        }
                    }
                    Err((revoked, error)) => self.failed(revoked, error),
                }
            }
            Err(error) => self.failed(false, error),
        }
        self.status()
    }

    pub fn backup_directory(&self) -> Result<Option<String>, String> {
        match vault_entry("backup-directory-v1")?.get_password() {
            Ok(path) => Ok(Some(path)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(_) => Err("Cannot read the approved backup directory from secure storage".into()),
        }
    }

    pub fn set_backup_directory(&self, path: &str) -> Result<(), String> {
        vault_entry("backup-directory-v1")?
            .set_password(path)
            .map_err(|_| "Cannot save the approved backup directory".into())
    }
}

fn fixture_origin() -> Option<String> {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var("FFYON_DEV_API_ORIGIN") {
        if let Ok(url) = reqwest::Url::parse(&value) {
            if url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.username().is_empty()
                && url.password().is_none()
                && url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
            {
                return Some(value.trim_end_matches('/').to_string());
            }
        }
    }
    None
}

pub fn emit(app: &AppHandle, status: AccessStatus) {
    let _ = app.emit("app-access-changed", status);
}

pub fn start_timer(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let mut previous = app.state::<AccessState>().status();
        loop {
            std::thread::sleep(Duration::from_secs(1));
            let current = app.state::<AccessState>().status();
            if current != previous {
                emit(&app, current.clone());
                crate::tray::refresh_locked(&app);
                previous = current;
            }
        }
    });
}

#[tauri::command]
pub fn access_status(state: State<'_, AccessState>) -> AccessStatus {
    state.status()
}

#[tauri::command]
pub fn access_prepare(
    state: State<'_, AccessState>,
    name: String,
) -> Result<PreparedDevice, String> {
    state.prepare(name)
}

#[tauri::command]
pub async fn access_connect(
    app: AppHandle,
    state: State<'_, AccessState>,
) -> Result<AccessStatus, String> {
    let status = state.verify(true).await;
    emit(&app, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn access_check(
    app: AppHandle,
    state: State<'_, AccessState>,
) -> Result<AccessStatus, String> {
    let status = state.verify(false).await;
    emit(&app, status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn access_pair(
    app: AppHandle,
    state: State<'_, AccessState>,
    code: String,
    name: String,
) -> Result<AccessStatus, String> {
    let normalized = code.replace(['-', ' '], "").to_ascii_uppercase();
    if normalized.len() != 12
        || !normalized
            .chars()
            .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c))
    {
        return Err("Enter the 12-character pairing code".into());
    }
    state.prepare(name)?;
    let vault = state.credential()?;
    match state
        .send(
            &vault,
            "redeem",
            Method::POST,
            Some(json!({"code": normalized, "device_id": vault.device_id, "name": vault.name})),
            None,
        )
        .await
    {
        Ok(response) => state.receive_session(&vault, response)?,
        Err((revoked, error)) => {
            state.failed(revoked, error.clone());
            emit(&app, state.status());
            return Err(error);
        }
    }
    let status = state.status();
    emit(&app, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn access_disconnect(
    app: AppHandle,
    state: State<'_, AccessState>,
) -> Result<AccessStatus, String> {
    let mut inner = state
        .inner
        .lock()
        .map_err(|_| "Credential storage is busy")?;
    state.persistence.delete()?;
    inner.vault = None;
    inner.online = false;
    inner.error = None;
    inner.deadline = None;
    inner.require_online = false;
    drop(inner);
    let status = state.status();
    emit(&app, status.clone());
    crate::tray::refresh_locked(&app);
    Ok(status)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdminOperation {
    Sync,
    Devices,
    Pairing,
    Clients,
    #[serde(rename = "clients/link")]
    ClientsLink,
    Appointments,
    #[serde(rename = "appointments/series")]
    AppointmentSeries,
    Services,
    Settings,
    Blocks,
    Import,
}

impl AdminOperation {
    fn route(&self) -> &str {
        match self {
            Self::Sync => "sync",
            Self::Devices => "devices",
            Self::Pairing => "pairing",
            Self::Clients => "clients",
            Self::ClientsLink => "clients/link",
            Self::Appointments => "appointments",
            Self::AppointmentSeries => "appointments/series",
            Self::Services => "services",
            Self::Settings => "settings",
            Self::Blocks => "blocks",
            Self::Import => "import",
        }
    }
    fn permits(&self, method: &Method) -> bool {
        match self {
            Self::Sync => method == Method::GET,
            Self::Devices => method == Method::GET || method == Method::PATCH,
            Self::Pairing | Self::ClientsLink | Self::AppointmentSeries | Self::Import => {
                method == Method::POST
            }
            Self::Clients | Self::Appointments | Self::Services => {
                method == Method::POST || method == Method::PATCH
            }
            Self::Settings => method == Method::PUT,
            Self::Blocks => method == Method::POST || method == Method::DELETE,
        }
    }
}

#[tauri::command]
pub async fn admin_request(
    app: AppHandle,
    state: State<'_, AccessState>,
    operation: AdminOperation,
    method: String,
    body: Option<Value>,
    query: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    state.require_authorized()?;
    if state.status().state != "online" {
        return Err("Connect to the site before changing shared records".into());
    }
    let method =
        Method::from_bytes(method.as_bytes()).map_err(|_| "Invalid admin request method")?;
    if !operation.permits(&method) {
        return Err("That method is not available for this admin operation".into());
    }
    if body
        .as_ref()
        .is_some_and(|body| body.to_string().len() > 2_000_000)
    {
        return Err("The request is too large".into());
    }
    let vault = state.credential()?;
    match state
        .send(&vault, operation.route(), method, body, query)
        .await
    {
        Ok(response) => Ok(response),
        Err((revoked, error)) => {
            if revoked || error.starts_with("Unable to reach") {
                state.failed(revoked, error.clone());
                emit(&app, state.status());
                crate::tray::refresh_locked(&app);
            }
            Err(error)
        }
    }
}

pub fn handle_cli() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--ffyon-prepare") {
        let state = AccessState::new();
        match state.prepare(
            args.get(2)
                .cloned()
                .unwrap_or_else(|| "Ffyon owner computer".into()),
        ) {
            Ok(prepared) => println!("{}", serde_json::to_string(&prepared).unwrap()),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        return true;
    }
    if args
        .get(1)
        .is_some_and(|arg| arg == "--ffyon-check" || arg == "--ffyon-connect")
    {
        let state = AccessState::new();
        let status = tauri::async_runtime::block_on(state.verify(args[1] == "--ffyon-connect"));
        println!("{}", serde_json::to_string(&status).unwrap());
        if status.state == "locked" {
            std::process::exit(1);
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct MemoryPersistence {
        vault: Mutex<Option<Vault>>,
        marker: AtomicBool,
        fail_write: AtomicBool,
        fail_delete: AtomicBool,
    }

    impl DevicePersistence for MemoryPersistence {
        fn read(&self) -> Result<Option<Vault>, String> {
            Ok(self.vault.lock().unwrap().clone())
        }
        fn write(&self, vault: &Vault) -> Result<(), String> {
            if self.fail_write.load(Ordering::SeqCst) {
                return Err("Test secure-store write failure".into());
            }
            *self.vault.lock().unwrap() = Some(vault.clone());
            Ok(())
        }
        fn delete(&self) -> Result<(), String> {
            if self.fail_delete.load(Ordering::SeqCst) {
                return Err("Test secure-store delete failure".into());
            }
            *self.vault.lock().unwrap() = None;
            Ok(())
        }
        fn requires_online(&self) -> bool {
            self.marker.load(Ordering::SeqCst)
        }
        fn mark_recheck(&self) -> Result<(), String> {
            self.marker.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn clear_recheck(&self) -> Result<(), String> {
            self.marker.store(false, Ordering::SeqCst);
            Ok(())
        }
    }

    fn offline_device() -> (AccessState, Arc<MemoryPersistence>, Vec<u8>) {
        let now = now_seconds();
        let token = "ab".repeat(32);
        let (lease, key) = signed(
            json!({"version":1,"site_id":SITE_ID,"device_id":"fixture-device","token_hash":hash_token(&token),"issued_at":now,"expires_at":now+LEASE_SECONDS}),
        );
        let store = Arc::new(MemoryPersistence::default());
        *store.vault.lock().unwrap() = Some(Vault {
            device_id: "fixture-device".into(),
            name: "Fixture computer".into(),
            token,
            lease: Some(lease),
            high_water: now,
            require_online: false,
        });
        (
            AccessState::with_persistence(store.clone(), key.clone()),
            store,
            key,
        )
    }

    fn signed(claims: Value) -> (SignedLease, Vec<u8>) {
        let signing = SigningKey::from_bytes(&[91; 32]);
        let payload = claims.to_string();
        let signature = signing.sign(payload.as_bytes());
        (
            SignedLease {
                payload: URL_SAFE_NO_PAD.encode(payload.as_bytes()),
                signature: URL_SAFE_NO_PAD.encode(signature.to_bytes()),
            },
            signing.verifying_key().to_bytes().to_vec(),
        )
    }

    #[test]
    fn lease_is_signed_device_bound_and_expires() {
        let (lease, key) = signed(
            json!({"version":1,"site_id":SITE_ID,"device_id":"device","token_hash":"hash","issued_at":1000,"expires_at":87400}),
        );
        assert_eq!(
            verify_with_key(&lease, "device", "hash", 1000, &key).unwrap(),
            87400
        );
        assert!(verify_with_key(&lease, "other", "hash", 1000, &key).is_err());
        assert!(verify_with_key(&lease, "device", "other", 1000, &key).is_err());
        assert!(verify_with_key(&lease, "device", "hash", 87400, &key).is_err());
        let forged = SignedLease {
            payload: URL_SAFE_NO_PAD.encode("{}"),
            signature: lease.signature,
        };
        assert!(verify_with_key(&forged, "device", "hash", 1000, &key).is_err());
    }

    #[test]
    fn lease_duration_and_future_issue_are_rejected() {
        let (lease, key) = signed(
            json!({"version":1,"site_id":SITE_ID,"device_id":"device","token_hash":"hash","issued_at":1000,"expires_at":87401}),
        );
        assert!(verify_with_key(&lease, "device", "hash", 1000, &key).is_err());
        let (lease, key) = signed(
            json!({"version":1,"site_id":SITE_ID,"device_id":"device","token_hash":"hash","issued_at":2000,"expires_at":88400}),
        );
        assert!(verify_with_key(&lease, "device", "hash", 1000, &key).is_err());
    }

    #[test]
    fn admin_operations_have_fixed_routes_and_methods() {
        assert!(AdminOperation::Sync.permits(&Method::GET));
        assert!(!AdminOperation::Sync.permits(&Method::POST));
        assert!(serde_json::from_str::<AdminOperation>("\"https://evil.example\"").is_err());
    }

    #[test]
    fn fresh_download_is_locked_and_setup_returns_only_metadata() {
        let store = Arc::new(MemoryPersistence::default());
        let state = AccessState::with_persistence(store.clone(), vec![0; 32]);
        assert!(state.require_authorized().is_err());
        let prepared = state.prepare("Owner computer".into()).unwrap();
        let metadata = serde_json::to_value(&prepared).unwrap();
        assert_eq!(metadata.as_object().unwrap().len(), 2);
        assert!(metadata.get("token").is_none());
        assert_eq!(prepared.token_hash.len(), 64);
        assert!(state.require_authorized().is_err());
        let reopened = AccessState::with_persistence(store, vec![0; 32]);
        let retry = reopened.prepare("Owner computer".into()).unwrap();
        assert_eq!(prepared.device_id, retry.device_id);
        assert_eq!(prepared.token_hash, retry.token_hash);
    }

    #[test]
    fn valid_stored_lease_allows_offline_finance_but_not_admin_api() {
        let (state, _, _) = offline_device();
        assert!(state.require_authorized().is_ok());
        assert_eq!(state.status().state, "offline");
        state.failed(false, "Network unavailable".into());
        assert!(state.require_authorized().is_ok());
    }

    #[test]
    fn revoked_device_stays_locked_after_restart_even_if_secure_writes_fail() {
        let (state, store, key) = offline_device();
        store.fail_write.store(true, Ordering::SeqCst);
        store.fail_delete.store(true, Ordering::SeqCst);
        state.failed(true, "The device was revoked".into());
        assert!(store
            .vault
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .lease
            .is_some());
        assert!(state.require_authorized().is_err());
        let reopened = AccessState::with_persistence(store, key);
        assert!(reopened.require_authorized().is_err());
    }

    #[test]
    fn rollback_remains_locked_after_clock_correction_until_verified_online() {
        let (state, store, key) = offline_device();
        state
            .inner
            .lock()
            .unwrap()
            .vault
            .as_mut()
            .unwrap()
            .high_water = now_seconds() + 300;
        assert!(state.require_authorized().is_err());
        state
            .inner
            .lock()
            .unwrap()
            .vault
            .as_mut()
            .unwrap()
            .high_water = now_seconds();
        assert!(state.require_authorized().is_err());
        let reopened = AccessState::with_persistence(store.clone(), key);
        assert!(reopened.require_authorized().is_err());
        let credential = reopened.credential().unwrap();
        let now = now_seconds();
        let (lease, _) = signed(
            json!({"version":1,"site_id":SITE_ID,"device_id":credential.device_id,"token_hash":hash_token(&credential.token),"issued_at":now,"expires_at":now+LEASE_SECONDS}),
        );
        reopened
            .receive_session(&credential, json!({"lease":lease}))
            .unwrap();
        assert_eq!(reopened.status().state, "online");
        assert!(!store.requires_online());
    }

    #[test]
    fn monotonic_deadline_expires_when_wall_clock_has_not_advanced() {
        let (state, _, _) = offline_device();
        state.inner.lock().unwrap().deadline = Some(Instant::now() - Duration::from_secs(1));
        assert!(state.require_authorized().is_err());
    }

    #[test]
    fn high_water_storage_failure_locks_current_and_restarted_app() {
        let (state, store, key) = offline_device();
        state
            .inner
            .lock()
            .unwrap()
            .vault
            .as_mut()
            .unwrap()
            .high_water = now_seconds() - 31;
        store.fail_write.store(true, Ordering::SeqCst);
        assert!(state.require_authorized().is_err());
        assert!(AccessState::with_persistence(store, key)
            .require_authorized()
            .is_err());
    }
}
