import { invoke } from "@tauri-apps/api/core";
import { requireOnlineAccess } from "./access";
import { getAppointment, getDb, listAppointments, listClients, type AppointmentRow, type AppointmentStatus, type ClientWithStats, type Statement } from "./db";

export interface CloudClient { id: string; account_id: string | null; name: string; email: string; phone: string; disabled: boolean; revision: number; updated_at: string; merged_into?: string | null }
export interface CloudService { id: string; name: string; description: string; duration_min: number; price_pence: number; active: boolean; revision: number }
export interface CloudAppointment { id: string; client_id: string; service_id: string | null; service_name: string; date: string; start_time: string; duration_min: number; price_pence: number; notes: string; status: AppointmentStatus; revision: number; proposed_date: string | null; proposed_start_time: string | null; series_id: string | null; created_at: string; updated_at: string }
export interface CloudBlock { id: string; date: string; start_time: string; duration_min: number; label: string; revision: number }
export interface BusinessSettings { booking_enabled: boolean; timezone: "Europe/London"; slot_minutes: 30; horizon_days: 90; opening_hours: { weekday: number; open: string; close: string }[]; revision: number }
export interface Device { id: string; name: string; created_at: string; last_seen_at: string | null; revoked_at: string | null }
export interface CloudSnapshot { clients: CloudClient[]; appointments: CloudAppointment[]; services: CloudService[]; blocks: CloudBlock[]; settings: BusinessSettings; cursor: number }
export interface CloudChange { sequence: number; entity: "client" | "appointment" | "service" | "block" | "settings"; id: string; record: CloudClient | CloudAppointment | CloudService | CloudBlock | BusinessSettings | null }
export interface SyncResponse { snapshot: CloudSnapshot | null; changes: CloudChange[]; cursor: number; has_more: boolean }
export interface SyncState { state: "idle" | "syncing" | "synced" | "error"; last_synced_at: string | null; error: string | null; cursor: number | null }
export interface ImportPreview { clients: ClientWithStats[]; appointments: AppointmentRow[]; services: CloudService[] }
export interface ImportSelection { clientIds: number[]; appointmentIds: number[] }

let state: SyncState = { state: "idle", last_synced_at: null, error: null, cursor: null };
let running: Promise<SyncState> | null = null;
let mutationQueue: Promise<unknown> = Promise.resolve();
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

function clientUpsert(c: CloudClient): Statement {
  return { sql: `INSERT INTO clients (remote_id, account_id, name, email, phone, cloud_revision, disabled, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET account_id=excluded.account_id, name=excluded.name,
      email=excluded.email, phone=excluded.phone, cloud_revision=excluded.cloud_revision, disabled=excluded.disabled
    WHERE excluded.cloud_revision >= clients.cloud_revision`,
    params: [c.id, c.account_id, c.name, c.email, c.phone || null, c.revision, c.disabled ? 1 : 0, c.updated_at] };
}

function importedRowLink(entity: "client" | "appointment", remoteId: string): Statement {
  const table = entity === "client" ? "clients" : "appointments";
  return { sql: `UPDATE ${table} SET remote_id=$1 WHERE id=(SELECT CAST(value AS INTEGER) FROM sync_state WHERE key=$2) AND remote_id IS NULL`,
    params: [remoteId, `import-target-${entity}-${remoteId}`] };
}

function clientMergeStatements(source: string, target: string): Statement[] {
  if (source === target) throw new Error("Invalid client merge response.");
  return [
    { sql: "INSERT INTO sync_state(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [`client-alias-${source}`, target] },
    { sql: "UPDATE transactions SET client_id=(SELECT id FROM clients WHERE remote_id=$2) WHERE client_id=(SELECT id FROM clients WHERE remote_id=$1) AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)", params: [source, target] },
    { sql: "UPDATE appointments SET client_id=(SELECT id FROM clients WHERE remote_id=$2) WHERE client_id=(SELECT id FROM clients WHERE remote_id=$1) AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)", params: [source, target] },
    { sql: `UPDATE clients SET notes=CASE WHEN COALESCE((SELECT notes FROM clients WHERE remote_id=$1),'')='' THEN notes
      ELSE COALESCE(notes || char(10) || char(10),'') || 'Linked notes from ' ||
        (SELECT name FROM clients WHERE remote_id=$1) || ':' || char(10) || (SELECT notes FROM clients WHERE remote_id=$1) END
      WHERE remote_id=$2`, params: [source, target] },
    { sql: "DELETE FROM clients WHERE remote_id=$1 AND EXISTS (SELECT 1 FROM clients WHERE remote_id=$2)", params: [source, target] },
  ];
}

function appointmentUpsert(a: CloudAppointment): Statement {
  return { sql: `INSERT INTO appointments (remote_id, client_id, category_id, service_id, service_name, date, start_time,
    duration_min, price_pence, customer_notes, status, cloud_revision, proposed_date, proposed_start_time, series_id, created_at)
    VALUES ($1, (SELECT id FROM clients WHERE remote_id=COALESCE((SELECT value FROM sync_state WHERE key='client-alias-' || $2), $2)), (SELECT id FROM categories WHERE service_id=$3 AND type='income'),
      $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    ON CONFLICT(remote_id) WHERE remote_id IS NOT NULL DO UPDATE SET client_id=excluded.client_id,
      category_id=COALESCE(appointments.category_id, excluded.category_id), service_id=excluded.service_id,
      service_name=excluded.service_name, date=excluded.date, start_time=excluded.start_time,
      duration_min=excluded.duration_min, price_pence=excluded.price_pence, customer_notes=excluded.customer_notes,
      status=excluded.status, cloud_revision=excluded.cloud_revision, proposed_date=excluded.proposed_date,
      proposed_start_time=excluded.proposed_start_time, series_id=excluded.series_id
    WHERE excluded.cloud_revision >= appointments.cloud_revision`,
    params: [a.id, a.client_id, a.service_id, a.service_name, a.date, a.start_time, a.duration_min, a.price_pence,
      a.notes, a.status, a.revision, a.proposed_date, a.proposed_start_time, a.series_id, a.created_at] };
}

function cacheStatement(table: "cloud_services" | "cloud_blocks" | "cloud_settings", id: string, data: unknown): Statement {
  return { sql: `INSERT INTO ${table} (id, data) VALUES ($1, $2) ON CONFLICT(id) DO UPDATE SET data=excluded.data`, params: [id, JSON.stringify(data)] };
}

function changeStatements(change: CloudChange): Statement[] {
  const record = change.record;
  if (record === null) {
    if (change.entity === "client") return [{ sql: "UPDATE clients SET disabled=1 WHERE remote_id=$1", params: [change.id] }];
    if (change.entity === "appointment") return [{ sql: "UPDATE appointments SET status='cancelled' WHERE remote_id=$1", params: [change.id] }];
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

export async function applySyncResponse(response: SyncResponse) {
  if (!Number.isSafeInteger(response.cursor) || response.cursor < 0 || !Array.isArray(response.changes)) throw new Error("Invalid site sync response.");
  const db = await getDb();
  const [stored] = await db.select<{ value: string }[]>("SELECT value FROM sync_state WHERE key='cursor'");
  const previous = stored ? Number(stored.value) : 0;
  if (response.cursor < previous) throw new Error("The site returned an older sync cursor.");
  const statements: Statement[] = [];
  if (response.snapshot) {
    const s = response.snapshot;
    if (s.cursor !== response.cursor || response.changes.length) throw new Error("Inconsistent site snapshot cursor.");
    for (const table of ["cloud_services", "cloud_blocks", "cloud_settings"]) statements.push({ sql: `DELETE FROM ${table}` });
    const clientIds = s.clients.map((c) => c.id);
    const apptIds = s.appointments.map((a) => a.id);
    const inList = (ids: string[]) => ids.map((_, i) => `$${i + 1}`).join(",") || "NULL";
    statements.push({ sql: `UPDATE clients SET disabled=1 WHERE remote_id IS NOT NULL AND remote_id NOT IN (${inList(clientIds)})`, params: clientIds });
    statements.push({ sql: `UPDATE appointments SET status='cancelled' WHERE remote_id IS NOT NULL AND remote_id NOT IN (${inList(apptIds)})`, params: apptIds });
    for (const client of s.clients) statements.push(importedRowLink("client", client.id), clientUpsert(client));
    for (const client of s.clients) if (client.merged_into) statements.push(...clientMergeStatements(client.id, client.merged_into));
    for (const appointment of s.appointments) statements.push(importedRowLink("appointment", appointment.id), appointmentUpsert(appointment));
    statements.push(
      ...s.services.map((service) => cacheStatement("cloud_services", service.id, service)),
      ...s.blocks.map((block) => cacheStatement("cloud_blocks", block.id, block)), cacheStatement("cloud_settings", "business", s.settings));
  } else {
    let sequence = previous;
    for (const change of response.changes) {
      if (!Number.isSafeInteger(change.sequence) || change.sequence <= sequence || change.sequence > response.cursor) throw new Error("Invalid ordering in site changes.");
      sequence = change.sequence;
    }
    const clients = response.changes.filter((change) => change.entity === "client");
    for (const change of clients) statements.push(...changeStatements(change));
    for (const change of clients) {
      const client = change.record as CloudClient | null;
      if (client?.merged_into) statements.push(...clientMergeStatements(client.id, client.merged_into));
    }
    for (const change of response.changes) if (change.entity !== "client") statements.push(...changeStatements(change));
  }
  statements.push({ sql: "INSERT INTO sync_state (key,value) VALUES ('cursor',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [String(response.cursor)] });
  await db.batch(statements);
}

async function cached<T>(table: "cloud_services" | "cloud_blocks" | "cloud_settings"): Promise<T[]> {
  const db = await getDb();
  const rows = await db.select<{ data: string }[]>(`SELECT data FROM ${table} ORDER BY id`);
  return rows.map((row) => JSON.parse(row.data) as T);
}
export const listServices = () => cached<CloudService>("cloud_services");
export const listBlocks = () => cached<CloudBlock>("cloud_blocks");
export async function listCloudSettings() { return (await cached<BusinessSettings>("cloud_settings"))[0] ?? null; }

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
    await syncNow();
    await db.execute("DELETE FROM sync_state WHERE key='mutation-pending'");
    return pending.body;
  });
  mutationQueue = task.catch(() => {});
  return task;
}

async function applyClientAliases(client: CloudClient, aliases: Record<string, string>) {
  const db = await getDb();
  const statements: Statement[] = [clientUpsert(client)];
  for (const [source, target] of Object.entries(aliases)) {
    if (source === target || target !== client.id) throw new Error("Invalid client link response.");
    statements.push(...clientMergeStatements(source, target));
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
export async function saveService(service: Omit<CloudService, "revision"> & { revision?: number }) {
  await mutate("services", service.revision == null ? "POST" : "PATCH", { ...service, id: service.id || crypto.randomUUID() });
}
export async function archiveService(id: string, revision: number) {
  const service = (await listServices()).find((s) => s.id === id);
  if (!service) throw new Error("Service not found");
  await saveService({ ...service, active: false, revision });
}
export const updateCloudSettings = (settings: BusinessSettings) => mutate("settings", "PUT", { ...settings });
export const createBlock = (block: Omit<CloudBlock, "id" | "revision">) => mutate("blocks", "POST", { id: crypto.randomUUID(), ...block });
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

export async function setServiceCategory(serviceId: string, categoryId: number | null) {
  const db = await getDb();
  if (categoryId != null) {
    const [category] = await db.select<{ type: string }[]>("SELECT type FROM categories WHERE id=$1", [categoryId]);
    if (category?.type !== "income") throw new Error("Map a service to an income category.");
  }
  await db.batch([
    { sql: "UPDATE categories SET service_id=NULL WHERE service_id=$1", params: [serviceId] },
    ...(categoryId == null ? [] : [{ sql: "UPDATE categories SET service_id=$1 WHERE id=$2", params: [serviceId, categoryId] }]),
    { sql: "UPDATE appointments SET category_id=$1 WHERE service_id=$2 AND category_id IS NULL", params: [categoryId, serviceId] },
  ]);
}

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
    catch (error) { await clearRejectedImport(error); throw error; }
    await syncNow();
    await clearImportState();
    return;
  }
  const preview = await getImportPreview();
  const selectedClients = preview.clients.filter((c) => selection.clientIds.includes(c.id));
  const selectedAppointments = preview.appointments.filter((a) => selection.appointmentIds.includes(a.id));
  if (selectedClients.length !== new Set(selection.clientIds).size || selectedAppointments.length !== new Set(selection.appointmentIds).size) throw new Error("The import selection changed. Review it again.");
  const allClients = await listClients();
  const mappings = await db.select<{ id: number; service_id: string | null }[]>("SELECT id, service_id FROM categories WHERE type='income'");
  const remoteClientIds = new Map(allClients.filter((c) => c.remote_id).map((c) => [c.id, c.remote_id!]));
  const statements: Statement[] = [];
  for (const c of selectedClients) {
    const id = crypto.randomUUID(); remoteClientIds.set(c.id, id);
    statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [`import-target-client-${id}`, String(c.id)] });
  }
  const clients = selectedClients.map((c) => ({ id: remoteClientIds.get(c.id)!, name: c.name, email: c.email ?? "", phone: c.phone ?? "" }));
  const appointments = selectedAppointments.map((a) => {
    const clientId = a.client_id == null ? null : remoteClientIds.get(a.client_id);
    const serviceId = a.service_id ?? mappings.find((m) => m.id === a.category_id)?.service_id;
    if (!clientId) throw new Error("Select the legacy client for each appointment, or link it explicitly first.");
    if (!serviceId || !preview.services.some((s) => s.id === serviceId && s.active)) throw new Error("Map each legacy appointment to an active website service before importing.");
    if (a.price_pence == null) throw new Error("Add an agreed price before importing an appointment.");
    const id = crypto.randomUUID();
    statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params: [`import-target-appointment-${id}`, String(a.id)] });
    return { id, client_id: clientId, service_id: serviceId, date: a.date, start_time: a.start_time, duration_min: a.duration_min, price_pence: a.price_pence, notes: "", series_id: a.series_id };
  });
  const body = { operation_id: crypto.randomUUID(), clients, appointments };
  statements.push({ sql: "INSERT INTO sync_state(key,value) VALUES ('import-pending',$1)", params: [JSON.stringify({ selection, body })] });
  await db.batch(statements);
  try { await adminRequest("import", "POST", body); }
  catch (error) { await clearRejectedImport(error); throw error; }
  await syncNow();
  await clearImportState();
}

async function clearImportState() {
  const db = await getDb();
  await db.execute("DELETE FROM sync_state WHERE key='import-pending' OR key LIKE 'import-target-%'");
}
async function clearRejectedImport(error: unknown) {
  if (/^4\d\d:/.test(String(error instanceof Error ? error.message : error))) await clearImportState().catch(() => {});
}

export async function linkClientAccount(id: number, accountId: string) {
  const client = (await listClients()).find((c) => c.id === id);
  if (!client?.remote_id) throw new Error("Import this legacy client before linking an account.");
  await mutate("clients/link", "POST", { id: client.remote_id, revision: client.cloud_revision, account_id: accountId });
}
