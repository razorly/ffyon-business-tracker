import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Exercise the separately managed Site's real handlers and Worker entry point.
// All D1 data is in-memory and every outbound fetch is intercepted; no real
// customer records, credentials, deployment or email provider is involved.
const site = fileURLToPath(new URL('../customer-site/', import.meta.url));
let available = true;
try { await access(site + 'lib/admin-api.ts'); } catch { available = false; }

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function bounded(promise, description) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(description)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

test('Site sync returns independently of booking email delivery', { skip: !available }, async t => {
  const require = createRequire(site + 'package.json');
  const { build } = require('esbuild');
  const bindings = { RESEND_API_KEY: 're_sync_fixture_only', RESEND_FROM: 'Tanned by Ffy <hello@tannedbyffy.co.uk>' };
  globalThis.__syncFixtureEnv = bindings;
  const bundle = await build({
    stdin: { contents: `export * as admin from './lib/admin-api.ts'; export * as business from './lib/business-store.ts'; export * as notifications from './lib/notifications.ts'; export * as context from './lib/worker-context.ts'; export { default as worker } from './build/sites-worker.ts';`, resolveDir: site },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', tsconfig: site + 'tsconfig.json',
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'sync-fixture-bindings', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare', namespace: 'fixture' }));
      builder.onResolve({ filter: /^vinext\/server\/fetch-handler$/ }, () => ({ path: 'handler', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'cloudflare'
        ? 'export const env = globalThis.__syncFixtureEnv;'
        : 'export default { fetch(request, env, ctx) { return globalThis.__syncFixtureDispatch(request, ctx); } };', loader: 'js' }));
    } }],
  });
  const handlers = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  globalThis.__syncFixtureDispatch = request => handlers.admin.handleAdmin(request, 'sync');
  const migrations = (await readdir(site + 'drizzle/')).filter(name => name.endsWith('.sql')).sort();
  const schemas = await Promise.all(migrations.map(name => readFile(site + 'drizzle/' + name, 'utf8')));
  const realFetch = globalThis.fetch, realWarn = console.warn, realError = console.error;
  const deviceId = crypto.randomUUID(), deviceToken = randomBytes(32).toString('hex');
  const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceToken))).toString('hex');
  let sqlite, db, provider, gate, dbFailure, calls, diagnostics;

  const maintenance = sql => /^UPDATE notification_outbox/i.test(sql);
  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    execute() {
      if (dbFailure?.(this.sql)) { dbFailure = null; throw new Error('Disposable fixture database failure'); }
      const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
      const results = sqlite.prepare(this.sql).all(...this.values).map(row => ({ ...row }));
      return { success: true, results, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS n').get().n - before) } };
    }
    async all() { return executeCall([this], () => this.execute()); }
    async first(column) { const row = (await this.all()).results[0] ?? null; return column && row ? row[column] : row; }
    async run() { return this.all(); }
  }
  async function executeCall(statements, execute) {
    calls.push(statements.map(statement => statement.sql));
    if (gate && statements.some(statement => gate.matches(statement.sql))) {
      gate.started++; gate.entered.resolve(); await gate.release.promise;
    }
    return execute();
  }
  async function reset() {
    sqlite?.close();
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
    for (const schema of schemas) for (const sql of schema.split('--> statement-breakpoint')) if (sql.trim()) sqlite.exec(sql);
    gate = null; dbFailure = null; calls = []; diagnostics = [];
    db = {
      prepare(sql) { return new Statement(sql); },
      async batch(statements) { return executeCall(statements, () => {
        sqlite.exec('BEGIN');
        try { const results = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return results; }
        catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      }); },
    };
    bindings.DB = db;
    sqlite.prepare('INSERT INTO admin_devices(id,name,token_hash,created_at,last_seen_at) VALUES (?,?,?,?,?)').run(deviceId, 'Sync fixture device', tokenHash, new Date().toISOString(), new Date().toISOString());
    provider = { calls: [], sends: [], accepted: new Map(), block: null, mode: 'success' };
    globalThis.fetch = mockFetch;
    console.warn = (...args) => diagnostics.push(args.join(' '));
    console.error = (...args) => diagnostics.push(args.join(' '));
    await handlers.business.ensureBusiness(db);
    calls = [];
  }
  function holdDatabase(matches = maintenance) {
    gate = { matches, entered: deferred(), release: deferred(), started: 0 };
    return gate;
  }
  function context() {
    const entries = [];
    return { props: {}, entries, waitUntil(promise) {
      const entry = { promise, done: false }; entries.push(entry);
      Promise.resolve(promise).then(() => { entry.done = true; }, () => { entry.done = true; });
    } };
  }
  async function drain(ctx) { await bounded(Promise.all(ctx.entries.map(entry => entry.promise)), 'Tracked Worker background work did not finish'); }
  function request(token = deviceToken) {
    return new Request('https://tannedbyffy.co.uk/api/admin/v1/sync?cursor=0&limit=250', { headers: { Authorization: 'Bearer ' + token, 'X-Ffyon-Device': deviceId } });
  }
  async function sync(ctx = context(), options = {}) {
    const req = options.snapshot ? new Request('https://tannedbyffy.co.uk/api/admin/v1/sync', { headers: request(options.token).headers }) : request(options.token);
    const response = await bounded(handlers.worker.fetch(req, bindings, ctx), 'Sync response waited for blocked background email work');
    return { status: response.status, body: await response.json(), ctx };
  }
  function queue(kind = 'request') {
    const client = crypto.randomUUID(), appointment = crypto.randomUUID(), stamp = new Date().toISOString();
    sqlite.prepare('INSERT INTO clients(id,name,email,updated_at) VALUES (?,?,?,?)').run(client, 'Fixture customer', 'customer@example.test', stamp);
    sqlite.prepare("INSERT INTO appointments(id,client_id,service_id,service_name,date,start_time,duration_min,price_pence,status,created_at,updated_at) VALUES (?,?,'spray-tan','Fixture tan','2026-10-10','10:00',30,2500,'pending',?,?)").run(appointment, client, stamp, stamp);
    const settings = JSON.parse(sqlite.prepare('SELECT value FROM business_settings WHERE id=1').get().value);
    sqlite.prepare('UPDATE business_settings SET value=? WHERE id=1').run(JSON.stringify({ ...settings, admin_notifications_enabled: true, admin_notification_email: 'owner@example.test' }));
    const payload = { kind, recipient: 'owner@example.test', name: 'Fixture customer', email: 'customer@example.test', phone: '', appointment: { id: appointment, service_name: 'Fixture tan', date: '2026-10-10', start_time: '10:00', duration_min: 30, price_pence: 2500, time_confirmed: true, is_remote: false, notes: '' } };
    const id = 'booking/' + appointment + '/1/' + kind;
    sqlite.prepare('INSERT INTO notification_outbox(id,appointment_id,client_id,payload) VALUES (?,?,?,?)').run(id, appointment, client, JSON.stringify(payload));
    return id;
  }
  async function mockFetch(input, init = {}) {
    const req = new Request(input, init), url = new URL(req.url);
    assert.equal(url.origin, 'https://api.resend.com', 'All network access must remain fixture-only');
    assert.equal(req.redirect, 'manual', 'Provider credentials must not follow redirects');
    assert.equal(req.headers.get('authorization'), 'Bearer re_sync_fixture_only');
    provider.calls.push(req.method + ' ' + url.pathname);
    if (req.method === 'POST' && url.pathname === '/emails') {
      const key = req.headers.get('idempotency-key'), payload = await req.json();
      assert.ok(key); provider.sends.push({ key, payload });
      if (provider.block) { provider.block.entered.resolve(); await provider.block.release.promise; }
      if (provider.mode === 'timeout') throw new DOMException('Disposable private provider detail', 'TimeoutError');
      let accepted = provider.accepted.get(key);
      if (accepted) assert.deepEqual(payload, accepted.payload, 'Retry payload must be frozen across ambiguous delivery');
      else { accepted = { id: crypto.randomUUID(), payload }; provider.accepted.set(key, accepted); }
      return Response.json({ id: accepted.id });
    }
    const match = /^\/emails\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && match) return Response.json({ id: match[1], message_id: '<fixture-' + match[1] + '@resend.test>' });
    throw new Error('Unexpected fixture provider operation');
  }
  try {
    await t.test('production entry point retains blocked outbox work and coalesces concurrent sync requests', async () => {
      await reset(); const held = holdDatabase(), ctx = context();
      const first = await sync(ctx); assert.equal(first.status, 200);
      await bounded(held.entered.promise, 'Background outbox delivery never started');
      assert.ok(ctx.entries.some(entry => !entry.done), 'The unresolved flush must be registered with Worker waitUntil');
      const more = await Promise.all([sync(), sync(), sync()]);
      assert.ok(more.every(result => result.status === 200));
      assert.equal(held.started, 1, 'Concurrent requests must share one in-flight outbox maintenance run');
      held.release.resolve(); await Promise.all([drain(ctx), ...more.map(result => drain(result.ctx))]);
      assert.equal(provider.calls.length, 0);
    });
    await t.test('blocked provider cannot delay sync; timeout preserves the queued receipt and allows a safe retry', async () => {
      await reset(); const id = queue();
      provider.mode = 'timeout'; provider.block = { entered: deferred(), release: deferred() };
      const first = await sync(); assert.equal(first.status, 200); assert.equal(first.body.notifications.pending, 1);
      await bounded(provider.block.entered.promise, 'Mock provider was not reached');
      const second = await sync(); assert.equal(second.status, 200); assert.equal(provider.sends.length, 1);
      assert.ok(first.ctx.entries.some(entry => !entry.done));
      provider.block.release.resolve(); await Promise.all([drain(first.ctx), drain(second.ctx)]);
      const pending = sqlite.prepare('SELECT * FROM notification_outbox WHERE id=?').get(id);
      assert.equal(pending.sent_at, null); assert.equal(pending.failed_at, null); assert.ok(pending.payload); assert.ok(pending.next_attempt_at > Date.now());
      assert.ok(diagnostics.some(line => line.includes('provider request timed out')));
      assert.ok(diagnostics.every(line => !line.includes('Disposable private')));
      provider.mode = 'success'; provider.block = null;
      sqlite.prepare('UPDATE notification_outbox SET next_attempt_at=0 WHERE id=?').run(id);
      const retried = await sync(); await drain(retried.ctx);
      assert.equal(provider.sends.length, 2); assert.deepEqual(provider.sends[0], provider.sends[1]);
      assert.ok(sqlite.prepare('SELECT sent_at FROM notification_outbox WHERE id=?').get(id).sent_at);
      assert.equal(sqlite.prepare('SELECT payload FROM notification_outbox WHERE id=?').get(id).payload, null);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key=?').get(id).n, 1);
    });
    await t.test('an accepted send followed by a receipt write failure retries the same provider operation without duplicate Mail records', async () => {
      await reset(); const id = queue();
      dbFailure = sql => /^UPDATE notification_outbox SET sent_at/i.test(sql);
      const first = await sync(); await drain(first.ctx);
      assert.equal(provider.accepted.size, 1); assert.equal(sqlite.prepare('SELECT sent_at FROM notification_outbox WHERE id=?').get(id).sent_at, null);
      sqlite.prepare('UPDATE notification_outbox SET next_attempt_at=0 WHERE id=?').run(id);
      const retry = await sync(); await drain(retry.ctx);
      assert.equal(provider.accepted.size, 1); assert.deepEqual(provider.sends[0], provider.sends[1]);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE idempotency_key=?').get(id).n, 1);
      assert.ok(sqlite.prepare('SELECT sent_at FROM notification_outbox WHERE id=?').get(id).sent_at);
    });
    await t.test('production Mail list returns while historical thread repair is stalled and later exposes one complete history', async () => {
      await reset();
      const canonical = crypto.randomUUID(), legacy = crypto.randomUUID(), outgoing = crypto.randomUUID(), incoming = crypto.randomUUID();
      const address = 'hello@tannedbyffy.co.uk', older = new Date(Date.now() - 2000).toISOString(), newer = new Date(Date.now() - 1000).toISOString();
      const messageId = '<historical-' + outgoing + '@resend.test>';
      const insertConversation = sqlite.prepare('INSERT INTO mail_conversations(id,subject,participant_email,created_at,updated_at,last_message_at) VALUES (?,?,?,?,?,?)');
      insertConversation.run(canonical, 'Historical self delivery', address, older, older, older);
      insertConversation.run(legacy, 'Historical self delivery', address, newer, newer, newer);
      const insertMessage = sqlite.prepare('INSERT INTO mail_messages(id,conversation_id,message_id,direction,from_address,to_addresses,subject,text_body,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)');
      insertMessage.run(outgoing, canonical, messageId, 'outbound', address, JSON.stringify([address]), 'Historical self delivery', 'Sent fixture body', older, 'sent');
      insertMessage.run(incoming, legacy, messageId, 'inbound', address, JSON.stringify([address]), 'Historical self delivery', 'Received fixture body', newer, 'received');
      sqlite.prepare('INSERT INTO mail_message_aliases(message_id,mail_message_id) VALUES (?,?)').run(messageId, outgoing);
      const held = holdDatabase(sql => sql.includes("'thread-repair'")), contexts = [];
      globalThis.__syncFixtureDispatch = req => handlers.admin.handleAdmin(req, 'mail/conversations');
      const list = async () => {
        const ctx = context(); contexts.push(ctx);
        const req = new Request('https://tannedbyffy.co.uk/api/admin/v1/mail/conversations?limit=40', { headers: request().headers });
        const response = await bounded(handlers.worker.fetch(req, bindings, ctx), 'Mail list waited for stalled historical repair');
        return { status: response.status, body: await response.json(), ctx };
      };
      try {
        const first = await list(); assert.equal(first.status, 200); assert.equal(first.body.conversations.length, 2);
        await bounded(held.entered.promise, 'Historical repair did not start');
        assert.ok(first.ctx.entries.some(entry => !entry.done), 'Worker waitUntil must retain the stalled repair');
        const parallel = await list(); assert.equal(parallel.status, 200); assert.equal(held.started, 1, 'Parallel Mail requests must share the active repair');
        held.release.resolve(); await Promise.all(contexts.map(drain));
        const repaired = await list(); await drain(repaired.ctx);
        assert.equal(repaired.body.conversations.length, 1); assert.equal(repaired.body.conversations[0].id, canonical);
        assert.equal(repaired.body.conversations[0].message_count, 2); assert.equal(repaired.body.conversations[0].unread_count, 1);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE conversation_id=?').get(canonical).n, 2);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM mail_conversations WHERE id=?').get(legacy).n, 0);
        assert.equal(provider.calls.length, 0, 'Historical grouping never contacts or sends through the provider');
      } finally {
        held.release.resolve(); await Promise.all(contexts.map(drain));
        globalThis.__syncFixtureDispatch = req => handlers.admin.handleAdmin(req, 'sync');
      }
    });
    await t.test('without a Worker context the delivery fallback remains awaited', async () => {
      await reset(); const held = holdDatabase(); let completed = false;
      const delivery = handlers.notifications.tryNotifications().then(() => { completed = true; });
      await bounded(held.entered.promise, 'Fallback delivery never started');
      assert.equal(completed, false); held.release.resolve(); await bounded(delivery, 'Fallback delivery did not finish');
      assert.equal(completed, true);
    });
    await t.test('delta rows and notification counters share one D1 batch; initial snapshot retains its matching cursor', async () => {
      await reset();
      const snapshot = await sync(context(), { snapshot: true }); await drain(snapshot.ctx);
      assert.equal(snapshot.status, 200); assert.equal(snapshot.body.snapshot.cursor, snapshot.body.cursor);
      assert.equal(snapshot.body.cursor, sqlite.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM sync_changes').get().cursor);
      calls = [];
      const result = await sync(); await drain(result.ctx);
      assert.equal(result.status, 200); assert.equal(result.body.snapshot, null);
      const readCall = calls.filter(sqls => sqls.some(sql => /FROM sync_changes WHERE sequence >/.test(sql)));
      assert.equal(readCall.length, 1); assert.ok(readCall[0].some(sql => /FROM notification_outbox/.test(sql) && /^SELECT/.test(sql)), 'Counts and delta rows must share the same remote database call');
      assert.equal(calls.flat().filter(sql => /^UPDATE admin_devices SET last_seen_at/.test(sql)).length, 0, 'A fresh device must not add a heartbeat database round trip');
    });
    await t.test('device heartbeat is throttled from each freshly authorized database row', async () => {
      await reset(); const fresh = await sync(); await drain(fresh.ctx);
      assert.equal(calls.flat().filter(sql => /^UPDATE admin_devices SET last_seen_at/.test(sql)).length, 0);
      sqlite.prepare("UPDATE admin_devices SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(deviceId); calls = [];
      const old = await sync(); await drain(old.ctx);
      assert.equal(calls.flat().filter(sql => /^UPDATE admin_devices SET last_seen_at/.test(sql)).length, 1);
      assert.ok(sqlite.prepare('SELECT last_seen_at FROM admin_devices WHERE id=?').get(deviceId).last_seen_at > '2000-01-01');
      calls = []; const next = await sync(); await drain(next.ctx);
      assert.equal(calls.flat().filter(sql => /^UPDATE admin_devices SET last_seen_at/.test(sql)).length, 0);
    });
    await t.test('invalid credentials and immediate revocation cannot return diary data or schedule email delivery', async () => {
      await reset(); queue();
      const denied = await sync(context(), { token: randomBytes(32).toString('hex') }); await drain(denied.ctx);
      assert.equal(denied.status, 401); assert.equal(denied.body.snapshot, undefined); assert.equal(provider.sends.length, 0);
      assert.equal(calls.flat().filter(sql => /^UPDATE admin_devices SET last_seen_at/.test(sql)).length, 0);
      // The real schema deliberately prevents revoking the final admin device.
      sqlite.prepare('INSERT INTO admin_devices(id,name,token_hash,created_at) VALUES (?,?,?,?)').run(crypto.randomUUID(), 'Other authorized fixture device', randomBytes(32).toString('hex'), new Date().toISOString());
      sqlite.prepare('UPDATE admin_devices SET revoked_at=? WHERE id=?').run(new Date().toISOString(), deviceId);
      const revoked = await sync(); await drain(revoked.ctx);
      assert.equal(revoked.status, 401); assert.equal(revoked.body.changes, undefined); assert.equal(provider.sends.length, 0);
    });
    await t.test('a changed recipient setting suppresses queued delivery before the background claim', async () => {
      await reset(); const id = queue(), held = holdDatabase();
      const result = await sync(); await bounded(held.entered.promise, 'Background delivery never reached the claim');
      const settings = JSON.parse(sqlite.prepare('SELECT value FROM business_settings WHERE id=1').get().value);
      sqlite.prepare('UPDATE business_settings SET value=? WHERE id=1').run(JSON.stringify({ ...settings, admin_notifications_enabled: false }));
      held.release.resolve(); await drain(result.ctx);
      assert.equal(provider.sends.length, 0);
      const cancelled = sqlite.prepare('SELECT failed_at,payload FROM notification_outbox WHERE id=?').get(id);
      assert.ok(cancelled.failed_at); assert.equal(cancelled.payload, null);
    });
    await t.test('background maintenance failure releases the coalescer so a later request can retry', async () => {
      await reset(); const id = queue(); dbFailure = maintenance;
      const failed = await sync(); assert.equal(failed.status, 200); await drain(failed.ctx);
      assert.equal(provider.sends.length, 0); assert.ok(sqlite.prepare('SELECT payload FROM notification_outbox WHERE id=?').get(id).payload);
      const next = await sync(); await drain(next.ctx);
      assert.equal(provider.sends.length, 1); assert.ok(sqlite.prepare('SELECT sent_at FROM notification_outbox WHERE id=?').get(id).sent_at);
    });
    await t.test('active leases and expired provider idempotency windows remain safe in background delivery', async () => {
      await reset(); const leased = queue();
      sqlite.prepare('UPDATE notification_outbox SET lease_until=? WHERE id=?').run(Date.now() + 60000, leased);
      const first = await sync(); await drain(first.ctx); assert.equal(provider.sends.length, 0);
      sqlite.prepare('UPDATE notification_outbox SET lease_until=0,first_attempt_at=? WHERE id=?').run(Date.now() - 24 * 3600000, leased);
      const expired = await sync(); await drain(expired.ctx); assert.equal(provider.sends.length, 0);
      const row = sqlite.prepare('SELECT failed_at,payload FROM notification_outbox WHERE id=?').get(leased);
      assert.ok(row.failed_at); assert.equal(row.payload, null);
    });
    await t.test('request-scoped Worker contexts cannot cross between simultaneous callers', async () => {
      const first = context(), second = context(), overlap = deferred();
      await Promise.all([
        handlers.context.runWithWorkerContext(first, async () => { overlap.resolve(); await new Promise(resolve => setImmediate(resolve)); assert.equal(handlers.context.getWorkerContext(), first); }),
        handlers.context.runWithWorkerContext(second, async () => { await overlap.promise; assert.equal(handlers.context.getWorkerContext(), second); }),
      ]);
      assert.equal(handlers.context.getWorkerContext(), undefined);
    });
  } finally {
    gate?.release.resolve(); provider?.block?.release.resolve();
    globalThis.fetch = realFetch; console.warn = realWarn; console.error = realError;
    delete globalThis.__syncFixtureEnv; delete globalThis.__syncFixtureDispatch;
    sqlite?.close();
  }
});
