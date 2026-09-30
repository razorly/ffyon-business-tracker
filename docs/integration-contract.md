# Ffyon Integration Contract v1

This file is public. It contains no private credential or signing key.

## Transport and Authorization

- Site: `https://ffyon-customer.razorly.chatgpt.site`.
- Admin routes: `/api/admin/v1/{operation}`. Customer cookies never authorize admin routes.
- Native HTTP sends `Authorization: Bearer <64-hex random device token>` and `X-Ffyon-Device: <device UUID>`.
- Server hashes the token with SHA-256; active `admin_devices` rows authorize normal requests. Bootstrap environment values are never a normal-auth fallback.
- Errors: `{ error: string, code?: string }`; 401/403 invalidate native authorization; 409 indicates stale revision/conflict. Never log credentials or pairing codes.
- Mutations include `operation_id: UUID`; existing receipts replay the committed result. Updates include `revision: integer` and reject stale versions.

## Shared DTOs

```ts
type BookingStatus = 'pending' | 'confirmed' | 'rejected' | 'cancelled' | 'no_show';
type CloudClient = { id: string; account_id: string | null; merged_into: string | null; name: string; email: string; phone: string; disabled: boolean; revision: number; updated_at: string };
type CloudService = { id: string; name: string; description: string; duration_min: number; price_pence: number; active: boolean; revision: number };
type CloudAppointment = { id: string; client_id: string; service_id: string | null; service_name: string; date: string; start_time: string; duration_min: number; price_pence: number; notes: string; status: BookingStatus; revision: number; proposed_date: string | null; proposed_start_time: string | null; series_id: string | null; created_at: string; updated_at: string };
type CloudBlock = { id: string; date: string; start_time: string; duration_min: number; label: string; revision: number };
type BusinessSettings = { booking_enabled: boolean; timezone: 'Europe/London'; slot_minutes: 30; horizon_days: 90; opening_hours: { weekday: number; open: string; close: string }[]; revision: number };
type CloudSnapshot = { clients: CloudClient[]; appointments: CloudAppointment[]; services: CloudService[]; blocks: CloudBlock[]; settings: BusinessSettings; cursor: number };
type CloudChange = { sequence: number; entity: 'client' | 'appointment' | 'service' | 'block' | 'settings'; id: string; record: CloudClient | CloudAppointment | CloudService | CloudBlock | BusinessSettings | null };
type SyncResponse = { snapshot: CloudSnapshot | null; changes: CloudChange[]; cursor: number; has_more: boolean };
type Device = { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null };
type LeaseClaims = { version: 1; site_id: string; device_id: string; token_hash: string; issued_at: number; expires_at: number };
type SignedLease = { payload: string; signature: string }; // base64url original UTF-8 JSON bytes and Ed25519 signature
```

Guest clients have no account. Account profiles remain customer-owned; associated shared contact fields change atomically. Internal notes and all accounting remain desktop-only.

## Endpoint Operations

- `GET session` -> `{ device: Device, lease: SignedLease }`; lease lasts exactly 86400 seconds. Claims use Unix seconds and site ID `appgprj_6abd6e180c8081918b5ec762c98ae90e`. Private PKCS8 base64 signing key is hosted as `FFYON_LEASE_SIGNING_KEY`.
- `POST bootstrap` body `{ device_id, name }` uses its generated bearer; verify hosted `FFYON_BOOTSTRAP_DEVICE_ID` and `FFYON_BOOTSTRAP_TOKEN_HASH`, consume this bootstrap generation once, register device, return session response. Retry for same active device is safe. Changing bootstrap device ID through trusted Sites configuration permits recovery.
- `POST pairing` body `{ operation_id }` -> `{ code, expires_at }`. Code is 12 random Base32 characters, displayed 4-4-4, expires in 600 seconds; persist only its digest. Creating/redeeming is rate-limited. Revoking issuer invalidates outstanding codes.
- `POST redeem` body `{ code, device_id, name }` with new device bearer -> session response. Consume code and register device atomically. Same device/token retry after a lost response succeeds without reusing the code for another device.
- `GET devices` -> `{ devices: Device[] }`; `PATCH devices` `{ operation_id, id, action: 'revoke' }`. Prevent accidental last-device revocation.
- `GET sync` without cursor -> initial snapshot. With `cursor` and `limit` (default 250), return ordered changes, latest applied cursor and `has_more`. Snapshot and its cursor must be consistent. Null records are tombstones.
- `POST clients` `{ operation_id, id, name, email, phone }` creates guest client. `PATCH clients` `{ operation_id, id, revision, name?, email?, phone?, disabled? }` edits shared profile/disabled account state. `POST clients/link` `{ operation_id, id, revision, account_id }` explicitly links a guest to a customer account without deleting booking history. Response `{ client: CloudClient }` and optional aliases for replaced guest IDs. The disabled source record retains `merged_into` in snapshots and the change journal, so a lost response still reconciles local ledger references and private notes exactly once.
- `POST appointments` `{ operation_id, id, client_id, service_id, date, start_time, duration_min, price_pence, notes, series_id? }` creates confirmed admin diary entry; `notes` are customer-visible only. `POST appointments/series` adds `dates: string[]` and atomically creates all occurrences, or reports conflicts without partial confirmation.
- `PATCH appointments` discriminated `action`: `accept`, `reject`, `cancel`, `no_show`, `accept_reschedule`, `reject_reschedule`, `edit`, `restore`. All include `{ operation_id, id, revision }`; edit includes writable booking fields. Restore means explicit online, conflict-checked restore, never raw replay. Response `{ appointment: CloudAppointment }`.
- `POST services` `{ operation_id, id, name, description, duration_min, price_pence, active }`; `PATCH services` adds `revision` to same fields. Response `{ service: CloudService }`.
- `PUT settings` `{ operation_id, ...BusinessSettings }` updates reviewed hours/services booking switch. Response `{ settings }`.
- `POST blocks` `{ operation_id, id, date, start_time, duration_min, label }`; `DELETE blocks` JSON `{ operation_id, id, revision }`. Response `{ block }` or `{ ok: true }`.
- `POST import` `{ operation_id, clients: CloudClientInput[], appointments: CloudAppointmentInput[] }` imports explicit selected legacy records idempotently. Exclude staff notes/ledger. Use same creation shapes, with persisted UUID IDs. Report conflicts before changes; apply selected import atomically.
- Customer `GET /api/availability?service_id=...&date=...` -> `{ times: string[], services: CloudService[], booking_enabled: boolean }`. Existing customer POST/PATCH routes stay origin/cookie protected, add expected revision on changes and revision in all appointment DTOs.

## Native IPC

- `access_status` -> `{ state: 'locked'|'checking'|'online'|'offline', device_id: string|null, device_name: string|null, expires_at: number|null, error: string|null }`.
- `access_prepare` `{ name }` -> `{ device_id, token_hash }`; create/read-back credential in OS vault before returning metadata.
- `access_connect` -> AccessStatus; submits bootstrap using prepared native credential, verifies/stores signed lease.
- `access_pair` `{ code, name }` -> AccessStatus; create credential then redeem.
- `access_check` -> AccessStatus; refresh session/lease; outages preserve still-valid prior lease, 401/403 remove it.
- `access_disconnect` -> AccessStatus; clear local credential/lease, leaving records intact. Server revocation uses devices API.
- `admin_request` `{ operation, method, body?, query? }` -> JSON; operation is a native allowlisted enum matching the routes above, never arbitrary URL. Requires native online authorization; server decides every privilege.
- `db_select` `{ sql, params }` -> row objects; `db_execute` `{ sql, params }` -> `{ rowsAffected, lastInsertId? }`; `db_batch` `{ statements: [{sql, params}] }` -> ordered result list in one native SQLite transaction. All require valid online/offline native authorization.
- Protected filesystem commands mirror existing file read/write/remove/list operations and recheck authorization at execution. Native dialog-selected persisted scopes restrict paths.
- Emit `app-access-changed` on authorization transitions; native timer, focus/resume and each command enforce expiry. No raw credential or signed lease in frontend IPC.

## Desktop Mirror v6

- Clients retain integer IDs/private `notes`; add `remote_id`, `account_id`, `email`, `cloud_revision`, `disabled`.
- Appointments retain integer IDs/private `notes`, links and series; rebuild status CHECK to canonical BookingStatus. Legacy booked/paid -> confirmed, retaining transaction_id. Add `remote_id`, `service_id`, `customer_notes`, `cloud_revision`, `proposed_date`, `proposed_start_time`, `service_name`.
- Unique nullable remote IDs. Cloud upserts preserve integer IDs, private notes and transaction links. Local paid amount comes from linked transaction, not quote.
- Add cloud_services, cloud_blocks and cloud_settings JSON cache and sync_state cursor. Keep service/category mapping in categories `service_id` (nullable, unique for income categories).
- Apply mirror records and cursor in one db_batch. Backup v3 excludes credentials, leases/codes and sync_state; restore old versions safely, then rebuild authoritative cloud mirror without uploading old decisions.

## Accounting and Availability

- Only confirmed/unpaid appointments count as owed. Payment creation/linking is atomic, idempotent, local. Cancel/no-show never delete income. Unpay does not change booking status.
- Updating a ledger amount never edits a shared quote. Customer notes never receive old staff notes.
- Opening hours default to draft 09:00-17:00 daily, booking disabled until reviewed. All service intervals must fit opening hours; capacity one, zero buffer, adjacent bookings allowed.
- Pending requests do not reserve. Confirmed and time-off intervals conflict atomically. Proposed reschedule holds original interval; only approval changes it.
- Local mutation methods for shared records always call server before mirror update. Offline shared edits are disabled. Local-only finance remains available while lease valid.
