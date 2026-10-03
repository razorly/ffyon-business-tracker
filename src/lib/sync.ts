import { invoke } from "@tauri-apps/api/core";
import { requireOnlineAccess } from "./access";
import { getAppointment, getDb, listAppointments, listClients, type AppointmentRow, type AppointmentStatus, type ClientWithStats, type Statement } from "./db";

export interface CloudClient { id: string; account_id: string | null; name: string; email: string; phone: string; saved_address: string; saved_postcode: string; disabled: boolean; revision: number; updated_at: string; merged_into?: string | null }
export interface CloudService { id: string; name: string; description: string; duration_min: number; price_pence: number; discount_percent: number; booking_price_pence: number; active: boolean; revision: number }
export interface CloudAppointment { id: string; client_id: string; service_id: string | null; service_name: string; date: string; start_time: string; time_confirmed: boolean; duration_min: number; price_pence: number; base_price_pence: number; discount_percent: number; is_remote: boolean; visit_address: string; visit_postcode: string; notes: string; status: AppointmentStatus; revision: number; proposed_date: string | null; proposed_start_time: string | null; proposed_time_confirmed: boolean | null; series_id: string | null; created_at: string; updated_at: string }
export interface CloudBlock { id: string; date: string; start_time: string; duration_min: number; label: string; revision: number; period_id?: string | null }
export interface BusinessSettings { home_visit_fee_pence: number; home_visit_radius_miles: number; studio_postcode: string; studio_address: string; contact_email: string; contact_email_enabled: boolean; booking_enabled: boolean; timezone: "Europe/London"; slot_minutes: 30; horizon_days: 90; opening_hours: { weekday: number; open: string; close: string }[]; admin_notifications_enabled: boolean; admin_notification_email: string; revision: number }
export interface Device { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }
export interface CloudSnapshot { clients: CloudClient[]; appointments: CloudAppointment[]; services: CloudService[]; blocks: CloudBlock[]; settings: BusinessSettings; cursor: number }
export interface CloudChange { sequence: number; entity: "client" | "appointment" | "service" | "block" | "settings"; id: string; record: CloudClient | CloudAppointment | CloudService | CloudBlock | BusinessSettings | null }
export interface NotificationStatus { configured: boolean; pending: number; failed: number }
export interface SyncResponse { snapshot: CloudSnapshot | null; changes: CloudChange[]; cursor: number; has_more: boolean; notifications?: NotificationStatus }
export interface SyncState { state: "idle" | "syncing" | "synced" | "error"; last_synced_at: string | null; error: string | null; cursor: number | null; notifications: NotificationStatus | null }
export interface ImportPreview { clients: ClientWithStats[]; appointments: AppointmentRow[]; services: CloudService[] }
export interface ImportSelection { clientIds: number[]; appointmentIds: number[] }

let state: SyncState = { state: "idle", last_synced_at: null, error: null, cursor: null, notifications: null };
let running: Promise<SyncState> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
let mirrorQueue: Promise<void> = Promise.resolve();
const listeners = new Set<(state: SyncState) => void>();
export const getSyncState = () => state;
export function subscribeSync(listener: (state: SyncState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function publish(patch: Partial<SyncState>) { state = { ...state, ...patch }; for (const listener of listeners) listener(state); }

export async function adminRequest<T = unknown>(operation: string, method: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  await requireOnlineAccess();
  try { return await invoke<T>("admin_request", { operation, method, body: body ?? null, query: query ?? null }); }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)); }
}

export function syncNow(): Promise<SyncState> {
  if (running) return running;
  running = (async () => {
    publish({ state: "syncing", error: null });
    try {
      await requireOnlineAccess();
      const db = await getDb();
      const [stored] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key = 'cursor'");
      let cursor = stored ? Number(stored.value) : null;
      if (cursor != null && (!Number.isSafeInteger(cursor) || cursor < 0)) cursor = null;
      for (;;) {
        const response = await adminRequest<SyncResponse>("sync", "GET", undefined, cursor == null ? undefined : { cursor: String(cursor), limit: "250" });
        await applySyncResponse(response);
        publish({ notifications: notificationStatus(response.notifications) });
        if (response.has_more && (cursor != null && response.cursor <= cursor)) throw new Error("The site returned a sync cursor that did not advance.");
        cursor = response.cursor;
        if (!response.has_more) break;
      }
      publish({ state: "synced", cursor, last_synced_at: new Date().toISOString(), error: null });
      return state;
    } catch (error) {
      publish({ state: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally { running = null; }
  })();
  return running;
}

/** A request already in flight may have read the site before this write committed. */
async function syncAfterWrite(): Promise<SyncState> {
  const active = running;
  if (active) await active.catch(() => {});
  return syncNow();
}

function clientUpsert(c: CloudClient, guardDeleted = true): Statement {
  return { sql: `INSERT INTO clients (remote_id, account_id, name, email, phone, cloud_revision, disabled, created_at, saved_address, saved_postcode)
    ${guardDeleted ? "SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10 WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key='deleted-client-' || $1)" : "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)"}
    ON CONFLICT(remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET account_id=excluded.account_id, name=excluded.name,
      email=excluded.email, phone=excluded.phone, cloud_revision=excluded.cloud_revision, disabled=excluded.disabled,
      saved_address=excluded.saved_address, saved_postcode=excluded.saved_postcode
    WHERE excluded.cloud_revision >= clients.cloud_revision`,
    params: [c.id, c.account_id, c.name, c.email, c.phone || null, c.revision, c.disabled ? 1 : 0, c.updated_at, c.saved_address ?? "", c.saved_postcode ?? ""] };
}

function importedRowLink(entity: "client" | "appointment", remoteId: string): Statement {
  const table = entity === "client" ? "clients" : "appointments";
  return { sql: `UPDATE ${table} SET remote_id=$1 WHERE id=(SELECT CAST(value AS INTEGER) FROM sync_state WHERE key=$2) AND remote_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key='deleted-${entity}-' || $1)`,
    params: [remoteId, `import-target-${entity}-${remoteId}`] };
}

function clientMergeStatements(source: string, target: string, guardDeleted = true): Statement[] {
  if (source === target) throw new Error("Invalid client merge response.");
  const guard = guardDeleted ? " AND NOT EXISTS (SELECT 1 FROM sync_state WHERE key IN ('deleted-client-' || $1,'deleted-client-' || $2))" : "";
  return [
    { sql: `INSERT INTO sync_state(key,value) ${guardDeleted ? "SELECT $1,$2 WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key IN ('deleted-client-' || substr($1,14),'deleted-client-' || $2))" : "VALUES ($1,$2)"} ON CONFLICT(key) DO UPDATE SET value=excluded.value`, params: [`client-alias-${source}`, target] },
    { sql: "UPDATE transactions SET client_id=(SELECT id FROM clients WHERE remote_id=$2) WHERE client_id=(SELECT id FROM clients WHERE remote_id=$1) AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)" + guard, params: [source, target] },
    { sql: "UPDATE appointments SET client_id=(SELECT id FROM clients WHERE remote_id=$2) WHERE client_id=(SELECT id FROM clients WHERE remote_id=$1) AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)" + guard, params: [source, target] },
    { sql: `UPDATE clients SET notes=CASE WHEN COALESCE((SELECT notes FROM clients WHERE remote_id=$1),'')='' THEN notes
      ELSE COALESCE(notes || char(10) || char(10),'') || 'Linked notes from ' ||
        (SELECT name FROM clients WHERE remote_id=$1) || ':' || char(10) || (SELECT notes FROM clients WHERE remote_id=$1) END
      WHERE remote_id=$2${guard}`, params: [source, target] },
    { sql: "DELETE FROM clients WHERE remote_id=$1 AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)" + guard, params: [source, target] },
  ];
}

function appointmentUpsert(a: CloudAppointment): Statement {
  return { sql: `INSERT INTO appointments (remote_id, client_id, category_id, service_id, service_name, date, start_time,
    duration_min, price_pence, customer_notes, status, cloud_revision, proposed_date, proposed_start_time, series_id, created_at,
    time_confirmed, proposed_time_confirmed, is_remote, visit_address, visit_postcode, base_price_pence, discount_percent)
    SELECT $1, (SELECT id FROM clients WHERE remote_id=COALESCE((SELECT value FROM sync_state WHERE key='client-alias-' || $2), $2)), NULL,
      $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
    WHERE NOT EXISTS (SELECT 1 FROM sync_state WHERE key IN ('deleted-appointment-' || $1,'deleted-client-' || $2))
    ON CONFLICT(remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET client_id=excluded.client_id,
      service_id=excluded.service_id,
      service_name=CASE WHEN appointments.service_id IS excluded.service_id AND COALESCE(appointments.service_name,'')<>''
        THEN appointments.service_name ELSE excluded.service_name END, date=excluded.date, start_time=excluded.start_time,
      duration_min=excluded.duration_min, price_pence=excluded.price_pence, customer_notes=excluded.customer_notes,
      status=excluded.status, cloud_revision=excluded.cloud_revision, proposed_date=excluded.proposed_date,
      proposed_start_time=excluded.proposed_start_time, series_id=excluded.series_id,
      time_confirmed=excluded.time_confirmed, proposed_time_confirmed=excluded.proposed_time_confirmed,
      is_remote=excluded.is_remote, visit_address=excluded.visit_address, visit_postcode=excluded.visit_postcode,
      base_price_pence=excluded.base_price_pence, discount_percent=excluded.discount_percent
    WHERE excluded.cloud_revision >= appointments.cloud_revision`,
    params: [a.id, a.client_id, a.service_id, a.service_name, a.date, a.time_confirmed === false ? "00:00" : a.start_time, a.duration_min, a.price_pence,
      a.notes, a.status, a.revision, a.proposed_date, a.proposed_start_time, a.series_id, a.created_at,
      a.time_confirmed === false ? 0 : 1, a.proposed_time_confirmed == null ? (a.proposed_date ? 1 : null) : a.proposed_time_confirmed ? 1 : 0,
      a.is_remote ? 1 : 0, a.is_remote ? a.visit_address ?? "" : "", a.is_remote ? a.visit_postcode ?? "" : "",
      a.base_price_pence ?? a.price_pence, a.discount_percent ?? 0] };
}

function cacheStatement(table: "cloud_services" | "cloud_blocks" | "cloud_settings", id: string, data: unknown): Statement {
  return { sql: `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, params: [id, JSON.stringify(data)] };
}

function linkedPaymentServices(): Statement {
  // An imported legacy payment keeps its saved label while gaining the booking's identity.
  return { sql: `UPDATE transactions SET
    service_id=(SELECT service_id FROM appointments WHERE transaction_id=transactions.id),
    service_name=COALESCE(NULLIF(service_name,''),NULLIF(category_name_snapshot,''),
      (SELECT NULLIF(service_name,'') FROM appointments WHERE transaction_id=transactions.id),''),
    income_kind='service'
    WHERE type='income' AND service_id IS NULL AND COALESCE(income_kind,'legacy')='legacy'
      AND EXISTS (SELECT 1 FROM appointments WHERE transaction_id=transactions.id
        AND (service_id IS NOT NULL OR COALESCE(service_name,'')<>''))` };
}

function removeAppointments(where: string, params: unknown[]): Statement[] {
  return [
    { sql: `UPDATE transactions SET client_id=NULL, description=NULL WHERE id IN (SELECT transaction_id FROM appointments WHERE ${where})`, params },
    { sql: `DELETE FROM appointments WHERE ${where}`, params },
  ];
}

function removeClients(where: string, params: unknown[]): Statement[] {
  const clients = `SELECT id FROM clients WHERE ${where}`;
  return [
    { sql: `UPDATE transactions SET client_id=NULL, description=NULL WHERE id IN (SELECT transaction_id FROM appointments WHERE client_id IN (${clients}))`, params },
    { sql: `UPDATE transactions SET client_id=NULL, description=NULL WHERE client_id IN (${clients})`, params },
    { sql: `DELETE FROM appointments WHERE client_id IN (${clients})`, params },
    { sql: `DELETE FROM sync_state WHERE key LIKE 'client-alias-%' AND (value IN (SELECT remote_id FROM clients WHERE ${where}) OR substr(key,14) IN (SELECT remote_id FROM clients WHERE ${where}))`, params },
    { sql: `DELETE FROM clients WHERE ${where}`, params },
  ];
}

function changeStatements(change: CloudChange): Statement[] {
  const record = change.record;
  if (record === null) {
    if (change.entity === "client") return removeClients("remote_id=$1", [change.id]);
    if (change.entity === "appointment") return removeAppointments("remote_id=$1", [change.id]);
    const table = change.entity === "service" ? "cloud_services" : change.entity === "block" ? "cloud_blocks" : "cloud_settings";
    return [{ sql: `DELETE FROM ${table} WHERE id=$1`, params: [change.entity === "settings" ? "business" : change.id] }];
  }
  switch (change.entity) {
    case "client": return [importedRowLink("client", change.id), clientUpsert(record as CloudClient)];
    case "appointment": return [importedRowLink("appointment", change.id), appointmentUpsert(record as CloudAppointment)];
    case "service": return [cacheStatement("cloud_services", change.id, record)];
    case "block": return [cacheStatement("cloud_blocks", change.id, record)];
    case "settings": return [cacheStatement("cloud_settings", "business", record)];
  }
}

// Clear retry payloads together with deletions so old requests cannot restore removed details.
async function deletionState(db: Awaited<ReturnType<typeof getDb>>, response: SyncResponse, restoring: boolean) {
  const [clients, appointments, stored] = await Promise.all([
    db.select<{ id: number; remote_id: string | null }[]>("SELECT id,remote_id FROM clients"),
    db.select<{ id: number; remote_id: string | null; client_id: number | null }[]>("SELECT id,remote_id,client_id FROM appointments"),
    db.select<{ key: string; value: string }[]>("SELECT key,value FROM sync_state WHERE key='mutation-pending' OR key='import-pending' OR key LIKE 'import-target-%' OR key LIKE 'client-alias-%' OR key LIKE 'deleted-%'"),
  ]);
  const liveClients = new Set(response.snapshot?.clients.map((client) => client.id));
  const liveAppointments = new Set(response.snapshot?.appointments.map((appointment) => appointment.id));
  const deletedClients = new Set(response.changes.filter((change) => change.entity === "client" && change.record === null).map((change) => change.id));
  const deletedAppointments = new Set(response.changes.filter((change) => change.entity === "appointment" && change.record === null).map((change) => change.id));
  if (response.snapshot) {
    for (const client of clients) if (client.remote_id && !liveClients.has(client.remote_id)) deletedClients.add(client.remote_id);
    for (const appointment of appointments) if (appointment.remote_id && !liveAppointments.has(appointment.remote_id)) deletedAppointments.add(appointment.remote_id);
  }
  for (const row of stored) {
    if (row.key.startsWith("deleted-client-")) deletedClients.add(row.key.slice(15));
    if (row.key.startsWith("deleted-appointment-")) deletedAppointments.add(row.key.slice(20));
  }
  for (const row of stored) if (row.key.startsWith("client-alias-") && deletedClients.has(row.value)) deletedClients.add(row.key.slice(13));
  const clientLocalIds = new Set(clients.filter((client) => client.remote_id && deletedClients.has(client.remote_id)).map((client) => client.id));
  for (const row of stored) if (row.key.startsWith("import-target-client-") && deletedClients.has(row.key.slice(21))) clientLocalIds.add(Number(row.value));
  const movedAppointments = new Map<string, CloudAppointment>();
  for (const appointment of response.snapshot?.appointments ?? []) movedAppointments.set(appointment.id, appointment);
  for (const change of response.changes) if (change.entity === "appointment" && change.record !== null) movedAppointments.set(change.id, change.record as CloudAppointment);
  const appointmentLocalIds = new Set(appointments.filter((appointment) => {
    if (appointment.remote_id && deletedAppointments.has(appointment.remote_id)) return true;
    if (appointment.client_id == null || !clientLocalIds.has(appointment.client_id)) return false;
    const moved = appointment.remote_id ? movedAppointments.get(appointment.remote_id) : null;
    return !moved || deletedClients.has(moved.client_id);
  }).map((appointment) => appointment.id));
  for (const row of stored) if (row.key.startsWith("import-target-appointment-") && deletedAppointments.has(row.key.slice(26))) appointmentLocalIds.add(Number(row.value));
  for (const appointment of appointments) if (appointmentLocalIds.has(appointment.id) && appointment.remote_id) deletedAppointments.add(appointment.remote_id);
  const identities = new Set([...deletedClients, ...deletedAppointments]);
  const referencesDeleted = (value: unknown): boolean => {
    if (typeof value === "string") return identities.has(value);
    if (Array.isArray(value)) return value.some(referencesDeleted);
    return !!value && typeof value === "object" && Object.values(value).some(referencesDeleted);
  };
  const statements: Statement[] = [];
  if (!restoring) {
    const localClients = [...clientLocalIds];
    const localAppointments = [...appointmentLocalIds];
    if (localAppointments.length) statements.push(...removeAppointments(`remote_id IS NULL AND id IN (${localAppointments.map((_, index) => `$${index + 1}`).join(",")})`, localAppointments));
    if (localClients.length) statements.push(...removeClients(`remote_id IS NULL AND id IN (${localClients.map((_, index) => `$${index + 1}`).join(",")})`, localClients));
  }
  for (const row of stored) {
    let remove = row.key.startsWith("client-alias-") && (deletedClients.has(row.value) || deletedClients.has(row.key.slice(13)));
    if (row.key.startsWith("import-target-client-")) remove = deletedClients.has(row.key.slice(21)) || clientLocalIds.has(Number(row.value));
    if (row.key.startsWith("import-target-appointment-")) remove = deletedAppointments.has(row.key.slice(26)) || appointmentLocalIds.has(Number(row.value));
    if (row.key === "mutation-pending" || row.key === "import-pending") {
      try {
        const pending = JSON.parse(row.value) as { selection?: ImportSelection };
        remove = referencesDeleted(pending) || !!pending.selection?.clientIds.some((id) => clientLocalIds.has(id)) || !!pending.selection?.appointmentIds.some((id) => appointmentLocalIds.has(id));
      } catch { remove = true; }
      if (remove && row.key === "import-pending") statements.push({ sql: "DELETE FROM sync_state WHERE key LIKE 'import-target-%'" });
    }
    if (remove) statements.push({ sql: "DELETE FROM sync_state WHERE key=$1", params: [row.key] });
  }
  for (const id of deletedClients) statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,'1') ON CONFLICT(key) DO NOTHING", params: [`deleted-client-${id}`] });
  for (const id of deletedAppointments) statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,'1') ON CONFLICT(key) DO NOTHING", params: [`deleted-appointment-${id}`] });
  return { deletedClients, deletedAppointments, statements };
}

export function applySyncResponse(response: SyncResponse, prefixStatements: Statement[] = []): Promise<void> {
  const task = mirrorQueue.then(() => applySyncResponseNow(response, prefixStatements));
  mirrorQueue = task.catch(() => {});
  return task;
}

async function applySyncResponseNow(response: SyncResponse, prefixStatements: Statement[]) {
  if (!Number.isSafeInteger(response.cursor) || response.cursor < 0 || !Array.isArray(response.changes)) throw new Error("Invalid site sync response.");
  if (response.snapshot && (!Array.isArray(response.snapshot.clients) || !Array.isArray(response.snapshot.appointments) || !Array.isArray(response.snapshot.services) || !Array.isArray(response.snapshot.blocks) || !response.snapshot.settings)) throw new Error("Invalid site snapshot.");
  const db = await getDb();
  const [stored] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='cursor'");
  const previous = stored ? Number(stored.value) : 0;
  if (response.cursor < previous) throw new Error("The site returned an older sync cursor.");
  if (!response.snapshot && response.changes.length === 0 && response.cursor === previous && prefixStatements.length === 0) {
    await db.batch(syncMetadata(response));
    return;
  }
  const deleted = await deletionState(db, response, prefixStatements.length > 0);
  const statements: Statement[] = [...prefixStatements];
  if (response.snapshot) {
    const s = response.snapshot;
    if (s.cursor !== response.cursor || response.changes.length) throw new Error("Inconsistent site snapshot cursor.");
    for (const table of ["cloud_services", "cloud_blocks", "cloud_settings"]) statements.push({ sql: `DELETE FROM ${table}` });
    const clientIds = s.clients.map((c) => c.id);
    const apptIds = s.appointments.map((a) => a.id);
    const missing = (ids: string[]) => ids.length
      ? `remote_id IS NOT NULL AND remote_id NOT IN (${ids.map((_, i) => `$${i + 1}`).join(",")})`
      : "remote_id IS NOT NULL";
    for (const client of s.clients) if (!deleted.deletedClients.has(client.id)) statements.push(importedRowLink("client", client.id), clientUpsert(client));
    for (const client of s.clients) if (client.merged_into && !deleted.deletedClients.has(client.id) && !deleted.deletedClients.has(client.merged_into)) statements.push(...clientMergeStatements(client.id, client.merged_into));
    for (const appointment of s.appointments) if (!deleted.deletedAppointments.has(appointment.id) && !deleted.deletedClients.has(appointment.client_id)) statements.push(importedRowLink("appointment", appointment.id), appointmentUpsert(appointment));
    statements.push(
      ...s.services.map((service) => cacheStatement("cloud_services", service.id, service)),
      ...s.blocks.map((block) => cacheStatement("cloud_blocks", block.id, block)), cacheStatement("cloud_settings", "business", s.settings));
    statements.push(...removeAppointments(missing(apptIds), apptIds));
    statements.push(...removeClients(missing(clientIds), clientIds));
  } else {
    let sequence = previous;
    for (const change of response.changes) {
      if (!Number.isSafeInteger(change.sequence) || change.sequence <= sequence || change.sequence > response.cursor) throw new Error("Invalid ordering in site changes.");
      sequence = change.sequence;
    }
    const clients = response.changes.filter((change) => change.entity === "client");
    for (const change of clients) if (change.record !== null && !deleted.deletedClients.has(change.id)) statements.push(...changeStatements(change));
    for (const change of clients) {
      const client = change.record as CloudClient | null;
      if (client?.merged_into && !deleted.deletedClients.has(client.id) && !deleted.deletedClients.has(client.merged_into)) statements.push(...clientMergeStatements(client.id, client.merged_into));
    }
    for (const change of response.changes) if (change.entity !== "client" && (change.entity !== "appointment" || change.record === null || (!deleted.deletedAppointments.has(change.id) && !deleted.deletedClients.has((change.record as CloudAppointment).client_id)))) statements.push(...changeStatements(change));
    for (const change of clients) if (change.record === null) statements.push(...changeStatements(change));
  }
  statements.push(...deleted.statements, linkedPaymentServices());
  statements.push(...syncMetadata(response));
  await db.batch(statements);
}

function syncMetadata(response: SyncResponse): Statement[] {
  const notifications = notificationStatus(response.notifications);
  return [notifications
    ? { sql: "INSERT INTO sync_state(key,value) VALUES ('notification-status',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE sync_state.value!=excluded.value", params: [JSON.stringify(notifications)] }
    : { sql: "DELETE FROM sync_state WHERE key='notification-status'" },
    { sql: "INSERT INTO sync_state (key,value) VALUES ('cursor',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(excluded.value AS INTEGER)>CAST(sync_state.value AS INTEGER)", params: [String(response.cursor)] },
  ];
}

async function cached<T>(table: "cloud_services" | "cloud_blocks" | "cloud_settings"): Promise<T[]> {
  const db = await getDb();
  const rows = await db.select<{ data: string }[]>(`SELECT data FROM ${table} ORDER BY id`);
  return rows.map((row) => JSON.parse(row.data) as T);
}
export function serviceDiscountPrice(basePricePence: number, discountPercent: number): number {
  if (!Number.isSafeInteger(basePricePence) || basePricePence < 0 || basePricePence > 1_000_000 || !Number.isSafeInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) throw new Error("Invalid service price or discount.");
  return Math.floor((basePricePence * (100 - discountPercent) + 50) / 100);
}
export async function listServices(): Promise<CloudService[]> {
  return (await cached<CloudService>("cloud_services")).map((service) => ({
    ...service, discount_percent: service.discount_percent ?? 0,
    booking_price_pence: serviceDiscountPrice(service.price_pence, service.discount_percent ?? 0),
  }));
}
export const listBlocks = () => cached<CloudBlock>("cloud_blocks");
export async function listCloudSettings() {
  const settings = (await cached<BusinessSettings>("cloud_settings"))[0];
  return settings ? { ...settings, home_visit_fee_pence: settings.home_visit_fee_pence ?? 0, home_visit_radius_miles: settings.home_visit_radius_miles ?? 15, studio_postcode: settings.studio_postcode ?? "LA3 2AS", studio_address: settings.studio_address ?? "", contact_email: settings.contact_email ?? "hello@tannedbyffy.co.uk", contact_email_enabled: settings.contact_email_enabled ?? false, admin_notifications_enabled: settings.admin_notifications_enabled ?? false, admin_notification_email: settings.admin_notification_email ?? "" } : null;
}

function notificationStatus(value: unknown): NotificationStatus | null {
  const status = value as NotificationStatus | undefined;
  return status && typeof status.configured === "boolean" && Number.isSafeInteger(status.pending) && status.pending >= 0 && Number.isSafeInteger(status.failed) && status.failed >= 0
    ? { configured: status.configured, pending: status.pending, failed: status.failed } : null;
}
export async function listNotificationStatus(): Promise<NotificationStatus | null> {
  const db = await getDb();
  const [row] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='notification-status'");
  try { return row ? notificationStatus(JSON.parse(row.value)) : null; } catch { return null; }
}

async function mutate(operation: string, method: string, body: Record<string, unknown>) {
  await mutateAndSync(operation, method, body);
}

interface PendingMutation { operation: string; method: string; body: Record<string, unknown> }
function requestIdentity(operation: string, method: string, body: Record<string, unknown>) {
  const comparable = { ...body };
  delete comparable.operation_id;
  delete comparable.revision;
  if (method === "POST" && ["clients", "appointments", "appointments/series", "services", "blocks"].includes(operation)) delete comparable.id;
  if (operation === "appointments/series") delete comparable.series_id;
  return JSON.stringify(Object.keys(comparable).sort().map((key) => [key, comparable[key]]));
}

export function mutateAndSync(operation: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const task = mutationQueue.then(async () => {
    await requireOnlineAccess();
    const db = await getDb();
    const [stored] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='mutation-pending'");
    let pending: PendingMutation;
    if (stored) {
      pending = JSON.parse(stored.value) as PendingMutation;
      if (pending.operation !== operation || pending.method !== method || requestIdentity(operation, method, pending.body) !== requestIdentity(operation, method, body)) throw new Error("Retry the previous shared change before starting another. Use Retry Sync in the site connection settings.");
    } else {
      pending = { operation, method, body: { operation_id: crypto.randomUUID(), ...body } };
      await db.execute("INSERT INTO sync_state(key,value) VALUES ('mutation-pending',$1)", [JSON.stringify(pending)]);
    }
    try {
      const response = await adminRequest<{ client?: CloudClient; aliases?: Record<string, string> }>(pending.operation, pending.method, pending.body);
      if (pending.operation === "clients/link" && response.aliases && response.client) await applyClientAliases(response.client, response.aliases);
    } catch (error) {
      if (/^4\d\d:/.test(String(error instanceof Error ? error.message : error))) await db.execute("DELETE FROM sync_state WHERE key='mutation-pending'").catch(() => {});
      throw error;
    }
    await syncAfterWrite();
    await db.execute("DELETE FROM sync_state WHERE key='mutation-pending'");
    return pending.body;
  });
  mutationQueue = task.catch(() => {});
  return task;
}

async function applyClientAliases(client: CloudClient, aliases: Record<string, string>) {
  const db = await getDb();
  const identityKeys = [...new Set([client.id, ...Object.keys(aliases), ...Object.values(aliases)])].map((id) => `deleted-client-${id}`);
  const [deleted] = await db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM sync_state WHERE key IN (${identityKeys.map((_, index) => `$${index + 1}`).join(",")})`, identityKeys);
  if ((deleted?.n ?? 0) > 0) return;
  const statements: Statement[] = [clientUpsert(client, true)];
  for (const [source, target] of Object.entries(aliases)) {
    if (source === target || target !== client.id) throw new Error("Invalid client link response.");
    statements.push(...clientMergeStatements(source, target, true));
  }
  await db.batch(statements);
}

export async function retryPendingMutation() {
  const db = await getDb();
  const [stored] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='mutation-pending'");
  if (stored) {
    const pending = JSON.parse(stored.value) as PendingMutation;
    await mutateAndSync(pending.operation, pending.method, pending.body);
  }
  const [imported] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='import-pending'");
  if (imported) await importLegacyRecords((JSON.parse(imported.value) as { selection: ImportSelection }).selection);
}
export async function saveService(service: Omit<CloudService, "revision" | "booking_price_pence" | "discount_percent"> & { revision?: number; discount_percent?: number; booking_price_pence?: number }) {
  const { booking_price_pence: _derivedPrice, ...input } = service;
  const discount_percent = input.discount_percent ?? 0;
  serviceDiscountPrice(input.price_pence, discount_percent);
  await mutate("services", service.revision == null ? "POST" : "PATCH", { ...input, discount_percent, id: service.id || crypto.randomUUID() });
}
export async function archiveService(id: string, revision: number) {
  const service = (await listServices()).find((s) => s.id === id);
  if (!service) throw new Error("Service not found");
  await saveService({ ...service, active: false, revision });
}
export const updateCloudSettings = (settings: BusinessSettings) => mutate("settings", "PUT", { ...settings });
export const createBlock = (block: Omit<CloudBlock, "id" | "revision">) => mutate("blocks", "POST", { id: crypto.randomUUID(), ...block });
export const createTimeOff = (period: { date: string; start_time: string; end_date: string; end_time: string; label: string }) => mutate("blocks", "POST", { id: crypto.randomUUID(), ...period });
export const deleteTimeOff = (blocks: CloudBlock[]) => blocks.length === 1 && !blocks[0].period_id
  ? deleteBlock(blocks[0])
  : mutate("blocks", "DELETE", { period_id: blocks[0].period_id, blocks: blocks.map(({ id, revision }) => ({ id, revision })) });
export const deleteBlock = (block: Pick<CloudBlock, "id" | "revision">) => mutate("blocks", "DELETE", { ...block });
export const createPairingCode = () => adminRequest<{ code: string; expires_at: number }>("pairing", "POST", { operation_id: crypto.randomUUID() });
export async function listDevices() { return (await adminRequest<{ devices: Device[] }>("devices", "GET")).devices; }
export const revokeDevice = (id: string) => adminRequest("devices", "PATCH", { operation_id: crypto.randomUUID(), id, action: "revoke" });

export async function decideReschedule(id: number, approve: boolean, expectedRevision?: number) {
  const row = await getAppointment(id);
  if (!row?.remote_id) throw new Error("Shared appointment not found");
  await mutate("appointments", "PATCH", { id: row.remote_id, revision: expectedRevision ?? row.cloud_revision, action: approve ? "accept_reschedule" : "reject_reschedule" });
}
export async function listPendingAppointments() { return (await listAppointments()).filter((a) => a.status === "pending" || a.proposed_date != null); }

export async function getImportPreview(): Promise<ImportPreview> {
  const [clients, appointments, services] = await Promise.all([listClients(), listAppointments(), listServices()]);
  return { clients: clients.filter((c) => !c.remote_id), appointments: appointments.filter((a) => !a.remote_id && a.status === "confirmed"), services };
}

export async function importLegacyRecords(selection: ImportSelection) {
  await requireOnlineAccess();
  const db = await getDb();
  const [pending] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='import-pending'");
  if (pending) {
    const saved = JSON.parse(pending.value) as { selection: ImportSelection; body: Record<string, unknown> };
    const same = (a: number[], b: number[]) => [...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");
    if (!same(saved.selection.clientIds, selection.clientIds) || !same(saved.selection.appointmentIds, selection.appointmentIds)) throw new Error("Retry the previous reviewed import before choosing a different selection.");
    try { await adminRequest("import", "POST", saved.body); }
    catch (error) { throw await rejectedImport(error); }
    await syncAfterWrite();
    await clearImportState();
    return;
  }
  const preview = await getImportPreview();
  const selectedClients = preview.clients.filter((c) => selection.clientIds.includes(c.id));
  const selectedAppointments = preview.appointments.filter((a) => selection.appointmentIds.includes(a.id));
  if (selectedClients.length !== new Set(selection.clientIds).size || selectedAppointments.length !== new Set(selection.appointmentIds).size) throw new Error("The import selection changed. Review it again.");
  const allClients = await listClients();
  const remoteClientIds = new Map(allClients.filter((c) => c.remote_id).map((c) => [c.id, c.remote_id!]));
  const statements: Statement[] = [];
  for (const c of selectedClients) {
    const id = crypto.randomUUID(); remoteClientIds.set(c.id, id);
    statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [`import-target-client-${id}`, String(c.id)] });
  }
  const clients = selectedClients.map((c) => ({ id: remoteClientIds.get(c.id)!, name: c.name, email: c.email ?? "", phone: c.phone ?? "", saved_address: c.saved_address ?? "", saved_postcode: c.saved_postcode ?? "" }));
  const appointments = selectedAppointments.map((a) => {
    const clientId = a.client_id == null ? null : remoteClientIds.get(a.client_id);
    const serviceId = a.service_id;
    if (!clientId) throw new Error("Select the legacy client for each appointment, or link it explicitly first.");
    if (!serviceId || !preview.services.some((s) => s.id === serviceId && s.active)) throw new Error("Choose an active service for each legacy appointment before importing. Review legacy income or edit the appointment first.");
    if (a.price_pence == null) throw new Error("Add an agreed price before importing an appointment.");
    const id = crypto.randomUUID();
    statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [`import-target-appointment-${id}`, String(a.id)] });
    return { id, client_id: clientId, service_id: serviceId, date: a.date, start_time: a.time_confirmed === 0 ? "00:00" : a.start_time,
      time_confirmed: a.time_confirmed !== 0, duration_min: a.duration_min, price_pence: a.price_pence,
      base_price_pence: a.base_price_pence ?? a.price_pence, discount_percent: a.discount_percent ?? 0,
      is_remote: Boolean(a.is_remote), visit_address: a.is_remote ? a.visit_address : "", visit_postcode: a.is_remote ? a.visit_postcode : "",
      status: "confirmed", notes: "", series_id: a.series_id };
  });
  const body = { operation_id: crypto.randomUUID(), clients, appointments };
  statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ('import-pending',$1)", params: [JSON.stringify({ selection, body })] });
  await db.batch(statements);
  try { await adminRequest("import", "POST", body); }
  catch (error) { throw await rejectedImport(error); }
  await syncAfterWrite();
  await clearImportState();
}

async function clearImportState() {
  const db = await getDb();
  await db.execute("DELETE FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%'");
}
async function rejectedImport(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  if (/^(400|422):/.test(message)) await clearImportState().catch(() => {});
  if (/^409:/.test(message)) return new Error(`${message} The reviewed import and its original IDs are kept. Resolve the conflict, then use Retry Sync.`);
  return error;
}

export async function linkClientAccount(id: number, accountId: string) {
  const client = (await listClients()).find((c) => c.id === id);
  if (!client?.remote_id) throw new Error("Import this legacy client before linking an account.");
  await mutate("clients/link", "POST", { id: client.remote_id, revision: client.cloud_revision, account_id: accountId });
}
