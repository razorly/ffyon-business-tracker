import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// The Site is a separately managed checkout. This suite only runs against its
// real server handlers when that checkout is available; every provider call is
// replaced by the fixture below. It never sends email or reads production data.
const site = fileURLToPath(new URL('../customer-site/', import.meta.url));
let available = true;
try { await access(site + 'lib/mail.ts'); } catch { available = false; }

test('Mail backend security and delivery regressions', { skip: !available }, async t => {
  const require = createRequire(site + 'package.json');
  const { build } = require('esbuild');
  const bindings = { RESEND_API_KEY: 're_fixture_only', RESEND_FROM: 'Tanned by Ffy <hello@tannedbyffy.co.uk>', MAIL_RECEIVING_ADDRESSES: 'hello@tannedbyffy.co.uk', RESEND_WEBHOOK_SECRET: 'whsec_' + randomBytes(32).toString('base64') };
  globalThis.__mailFixtureEnv = bindings;
  const bundled = await build({
    stdin: { contents: `export * as mail from './lib/mail.ts'; export * as admin from './lib/admin-api.ts';`, resolveDir: site },
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node24', tsconfig: site + 'tsconfig.json',
    plugins: [{ name: 'mail-fixture-bindings', setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare', namespace: 'fixture' }));
      builder.onResolve({ filter: /^next\/headers$/ }, () => ({ path: 'headers', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'cloudflare' ? 'export const env = globalThis.__mailFixtureEnv;' : 'export async function cookies() { return { get() { return undefined; } }; }', loader: 'js' }));
    } }],
  });
  const handlers = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const migrations = (await readdir(site + 'drizzle/')).filter(name => name.endsWith('.sql')).sort();
  const schemas = await Promise.all(migrations.map(name => readFile(site + 'drizzle/' + name, 'utf8')));
  const realFetch = globalThis.fetch;
  const deviceId = crypto.randomUUID(), deviceToken = randomBytes(32).toString('hex');
  const tokenHash = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deviceToken))).toString('hex');
  let sqlite, provider, db;

  class Statement {
    constructor(sql, values = []) { this.sql = sql; this.values = values; }
    bind(...values) { return new Statement(this.sql, values); }
    execute() {
      if (db.fail?.(this.sql)) { db.fail = null; throw new Error('Fixture database unavailable'); }
      const before = sqlite.prepare('SELECT total_changes() AS n').get().n;
      const rows = sqlite.prepare(this.sql).all(...this.values).map(row => ({ ...row }));
      return { success: true, results: rows, meta: { changes: Number(sqlite.prepare('SELECT total_changes() AS n').get().n - before) } };
    }
    async all() { return this.execute(); }
    async first(column) { const row = this.execute().results[0] ?? null; return column && row ? row[column] : row; }
    async run() { return this.execute(); }
  }

  function reset() {
    sqlite?.close();
    sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys = ON');
    for (const schema of schemas) for (const sql of schema.split('--> statement-breakpoint')) if (sql.trim()) sqlite.exec(sql);
    db = {
      fail: null,
      prepare(sql) { return new Statement(sql); },
      async batch(statements) { sqlite.exec('BEGIN'); try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
    };
    bindings.DB = db;
    sqlite.prepare('INSERT INTO admin_devices(id, name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(deviceId, 'Mail fixture device', tokenHash, new Date().toISOString());
    provider = { received: new Map(), sent: new Map(), sends: [], calls: [], cache: new Map(), failGet: null, failSentGet: null, sendError: null, holdSend: null, attachment: null, download: null, onReceivedGet: null };
    globalThis.fetch = mockFetch;
  }

  async function mockFetch(input, init = {}) {
    const request = new Request(input, init), url = new URL(request.url);
    provider.calls.push({ method: request.method, url: request.url, redirect: request.redirect, authorization: request.headers.get('authorization') });
    if (url.host === 'inbound-cdn.resend.com') {
      assert.equal(request.headers.has('authorization'), false, 'Private API key must not reach attachment CDN');
      assert.equal(request.redirect, 'manual');
      return typeof provider.download === 'function' ? provider.download(request) : provider.download ?? new Response('Fixture file');
    }
    assert.equal(url.origin, 'https://api.resend.com', 'No unmocked or arbitrary network request is permitted');
    assert.equal(request.redirect, 'manual', 'Provider redirect must never forward API credentials');
    assert.equal(request.headers.get('authorization'), 'Bearer re_fixture_only');
    if (request.method === 'POST' && url.pathname === '/emails') {
      const payload = await request.json(), key = request.headers.get('idempotency-key');
      assert.ok(key, 'Every send requires provider idempotency');
      provider.sends.push({ key, payload });
      const prior = provider.cache.get(key);
      if (prior) {
        assert.deepEqual(payload, prior.payload, 'Retries must use the original complete payload');
        return Response.json({ id: prior.id });
      }
      if (typeof provider.sendError === 'function') return provider.sendError({ key, payload });
      if (provider.sendError) return provider.sendError.clone();
      const id = crypto.randomUUID(), canonical = '<provider-' + id + '@resend.test>';
      provider.cache.set(key, { id, payload });
      provider.sent.set(id, { id, ...payload, message_id: canonical, created_at: new Date().toISOString(), last_event: 'sent' });
      if (provider.holdSend) await provider.holdSend;
      return Response.json({ id });
    }
    if (url.pathname === '/emails/receiving') {
      const all = [...provider.received.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const after = url.searchParams.get('after'), index = after ? all.findIndex(row => row.id === after) + 1 : 0;
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 20));
      return Response.json({ object: 'list', data: all.slice(index, index + limit), has_more: index + limit < all.length });
    }
    const attachment = /^\/emails\/receiving\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (attachment) return provider.attachment ?? Response.json({ id: attachment[2], filename: 'invoice.pdf', size: 12, content_type: 'application/pdf', download_url: 'https://inbound-cdn.resend.com/' + attachment[1] + '/attachments/' + attachment[2] + '?signature=fixture', expires_at: new Date(Date.now() + 3600000).toISOString() });
    const received = /^\/emails\/receiving\/([^/]+)$/.exec(url.pathname);
    if (received) {
      await provider.onReceivedGet?.(received[1]);
      if (provider.failGet) return provider.failGet.clone();
      const email = provider.received.get(received[1]);
      return email ? Response.json(email) : Response.json({ name: 'not_found' }, { status: 404 });
    }
    const sent = /^\/emails\/([^/]+)$/.exec(url.pathname);
    if (sent) return provider.failSentGet?.clone() ?? (provider.sent.has(sent[1]) ? Response.json(provider.sent.get(sent[1])) : Response.json({ name: 'not_found' }, { status: 404 }));
    throw new Error('Unexpected mocked provider path: ' + url.pathname);
  }

  function incoming(overrides = {}) {
    const id = crypto.randomUUID();
    const email = { id, from: 'Sarah Smith <sarah@example.test>', to: ['hello@tannedbyffy.co.uk'], cc: [], bcc: [], reply_to: [], received_for: [], subject: 'Appointment change', text: 'Could I move my appointment to 6pm?', html: '<p>Could I move my appointment?</p>', created_at: new Date().toISOString(), message_id: '<incoming-' + id + '@example.test>', headers: {}, attachments: [], ...overrides };
    provider.received.set(email.id, email); return email;
  }

  function signed(email, options = {}) {
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000)), id = 'msg_' + crypto.randomUUID();
    const payload = options.raw ?? JSON.stringify({ type: 'email.received', created_at: new Date().toISOString(), data: { email_id: email.id, from: email.from, to: email.to, subject: email.subject, message_id: email.message_id } }, null, 2);
    const digest = createHmac('sha256', Buffer.from(bindings.RESEND_WEBHOOK_SECRET.slice(6), 'base64')).update(id + '.' + timestamp + '.' + payload).digest('base64');
    return new Request('https://tannedbyffy.co.uk/api/webhooks/resend', { method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': options.signature ?? 'v1,' + digest }, body: options.body ?? payload });
  }
  const count = table => Number(sqlite.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n);
  const rows = sql => sqlite.prepare(sql).all().map(row => ({ ...row }));
  async function webhook(email, options) { const response = await handlers.mail.handleResendWebhook(signed(email, options)); return { status: response.status, body: await response.json() }; }
  async function admin(endpoint, method = 'GET', data, options = {}) {
    const request = new Request('https://tannedbyffy.co.uk/api/admin/v1/' + endpoint, { method, headers: { ...(options.unauthorized ? {} : { Authorization: 'Bearer ' + (options.token ?? deviceToken), 'x-ffyon-device': deviceId }), 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const response = await handlers.admin.handleAdmin(request, endpoint.split('?')[0]);
    return { status: response.status, body: await response.json() };
  }
  async function importOne(email) { const result = await webhook(email); assert.equal(result.status, 200, JSON.stringify(result.body)); return rows('SELECT * FROM mail_messages WHERE resend_email_id = ' + "'" + email.id + "'")[0]; }
  const send = (overrides = {}) => ({ idempotency_key: crypto.randomUUID(), to: 'sarah@example.test', subject: 'Appointment change', text: 'Yep, 6pm is fine.', ...overrides });

  try {
    await t.test('business contact migration activates the verified address without overwriting settings, prices or custom contacts', () => {
      const index = migrations.indexOf('0012_activate_business_email.sql'); assert.ok(index >= 0, 'Exercise the actual contact activation migration');
      const base = { home_visit_fee_pence: 750, home_visit_radius_miles: 12, studio_postcode: 'LA3 2AS', studio_address: 'Fixture studio address', booking_enabled: true,
        timezone: 'Europe/London', slot_minutes: 30, horizon_days: 90, opening_hours: [{ weekday: 2, open: '10:30', close: '18:30' }, { weekday: 5, open: '09:00', close: '20:00' }],
        admin_notifications_enabled: true, admin_notification_email: 'owner-notifications@example.test', revision: 7, future_setting: { preserve: ['unknown', 'fields'] } };
      for (const [contact, enabled, activates] of [['hello@tannedbyffy.co.uk', false, true], ['', false, true], ['HELLO@TANNEDBYFFY.CO.UK', false, true], ['custom@example.test', false, false], ['custom@example.test', true, false], ['hello@tannedbyffy.co.uk', true, false]]) {
        const fixture = new DatabaseSync(':memory:');
        try {
          fixture.exec('PRAGMA foreign_keys = ON');
          for (const schema of schemas.slice(0, index)) for (const sql of schema.split('--> statement-breakpoint')) if (sql.trim()) fixture.exec(sql);
          const initial = { ...base, contact_email: contact, contact_email_enabled: enabled };
          fixture.prepare('INSERT INTO business_settings(id,value,last_operation) VALUES(1,?,?)').run(JSON.stringify(initial), 'prior-settings-operation');
          fixture.prepare('INSERT INTO booking_services(id,name,duration_min,price_pence,discount_percent,revision) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), 'Fixture spray tan', 30, 3500, 10, 4);
          const services = fixture.prepare('SELECT * FROM booking_services').all().map(row => ({ ...row }));
          const changes = () => fixture.prepare("SELECT * FROM sync_changes WHERE entity='settings' ORDER BY sequence").all().map(row => ({ ...row }));
          const before = changes().length;
          fixture.exec(schemas[index]);
          const row = fixture.prepare('SELECT * FROM business_settings WHERE id=1').get(), actual = JSON.parse(row.value);
          const expected = activates ? { ...initial, contact_email: 'hello@tannedbyffy.co.uk', contact_email_enabled: true, revision: initial.revision + 1 } : initial;
          assert.deepEqual(actual, expected, 'All populated and unknown settings must survive contact activation');
          assert.equal(row.last_operation, activates ? null : 'prior-settings-operation');
          assert.deepEqual(fixture.prepare('SELECT * FROM booking_services').all().map(value => ({ ...value })), services, 'Service prices and discounts must remain intact');
          assert.equal(changes().length, before + Number(activates), 'Settings sync must receive exactly one change when activation occurs');
          if (activates) { assert.equal(String(changes().at(-1).id), '1'); assert.deepEqual(JSON.parse(changes().at(-1).record), expected); }
          const after = changes().length;
          fixture.exec(schemas[index]);
          assert.equal(fixture.prepare('SELECT value FROM business_settings WHERE id=1').get().value, row.value, 'Applying the migration again is a no-op');
          assert.equal(changes().length, after, 'Migration replay must not advance revision or add journal entries');
        } finally { fixture.close(); }
      }
    });

    await t.test('signed raw webhook stores content, links a known customer and starts unread', async () => {
      reset();
      const clientId = crypto.randomUUID();
      sqlite.prepare('INSERT INTO clients(id,name,email,updated_at) VALUES(?,?,?,?)').run(clientId, 'Sarah Smith', 'sarah@example.test', new Date().toISOString());
      const email = incoming(), stored = await importOne(email);
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1);
      assert.equal(stored.direction, 'inbound'); assert.equal(stored.text_body, email.text); assert.equal(stored.message_id, email.message_id); assert.equal(stored.read_at, null);
      const list = await admin('mail/conversations'); assert.equal(list.status, 200);
      assert.equal(list.body.conversations[0].participant_name, 'Sarah Smith'); assert.equal(list.body.conversations[0].client_id, clientId);
      assert.equal(list.body.conversations[0].unread_count, 1);
      const unread = await admin('mail/unread'); assert.equal(unread.body.unread_count, 1);
      const retrieval = provider.calls.find(call => call.url.includes('/emails/receiving/' + email.id));
      assert.equal(new URL(retrieval.url).searchParams.get('html_format'), 'cid', 'Avoid huge embedded inline-image payloads');
    });

    await t.test('invalid, missing, tampered, stale and future signatures reject before provider or database access', async () => {
      reset(); const email = incoming();
      for (const options of [{ signature: 'v1,invalid' }, { signature: '' }, { timestamp: Math.floor(Date.now() / 1000) - 301 }, { timestamp: Math.floor(Date.now() / 1000) + 301 }, { body: '{"tampered":true}' }]) {
        const result = await webhook(email, options); assert.ok([400, 401].includes(result.status));
      }
      const malformed = await webhook(email, { raw: '{ invalid json' }); assert.ok([400, 401].includes(malformed.status));
      assert.equal(count('mail_messages'), 0); assert.equal(provider.calls.length, 0);
    });

    await t.test('same received ID is safe under duplicate and concurrent delivery', async () => {
      reset(); const email = incoming();
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => webhook(email)));
      for (const outcome of outcomes) assert.equal(outcome.status, 200, JSON.stringify(outcome.body));
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1);
      assert.equal((await webhook(email)).status, 200);
      assert.equal(count('mail_messages'), 1);
    });

    await t.test('content retrieval and database failures remain retryable rather than acknowledged', async () => {
      reset(); const email = incoming();
      provider.failGet = Response.json({ name: 'service_unavailable' }, { status: 503 });
      assert.equal((await webhook(email)).status, 503); assert.equal(count('mail_messages'), 0);
      provider.failGet = null;
      db.fail = sql => /INSERT.*mail_messages/i.test(sql);
      assert.equal((await webhook(email)).status, 503); assert.equal(count('mail_messages'), 0); assert.equal(count('mail_conversations'), 0);
      await importOne(email); assert.equal(count('mail_messages'), 1);
    });

    await t.test('foreign mailbox is ignored while display-name, case and forwarded recipients work', async () => {
      reset();
      assert.equal((await webhook(incoming({ to: ['other@tannedbyffy.co.uk'] }))).status, 200);
      assert.equal((await webhook(incoming({ to: ['hello@tannedbyffy.co.uk.attacker.test'] }))).status, 200);
      assert.equal(count('mail_messages'), 0);
      await importOne(incoming({ to: ['Ffy <HELLO@TANNEDBYFFY.CO.UK>'] }));
      await importOne(incoming({ to: ['forward-target@example.test'], received_for: ['hello@tannedbyffy.co.uk'] }));
      assert.equal(count('mail_messages'), 2);
    });

    await t.test('thread references associate a reply while participant spoofing and unrelated same-subject mail stay separate', async () => {
      reset(); const original = incoming(), first = await importOne(original);
      const reply = incoming({ subject: 'Re: Appointment change', headers: { 'In-Reply-To': original.message_id, References: original.message_id } });
      assert.equal((await importOne(reply)).conversation_id, first.conversation_id);
      const spoofed = incoming({ from: 'Unrelated sender <unrelated@example.test>', headers: { 'in-reply-to': original.message_id, references: original.message_id } });
      assert.notEqual((await importOne(spoofed)).conversation_id, first.conversation_id);
      const unrelated = incoming({ text: 'A completely separate request.' });
      assert.notEqual((await importOne(unrelated)).conversation_id, first.conversation_id);
      assert.equal(count('mail_conversations'), 3);
    });

    await t.test('conflicting References cannot merge separate conversations, even for the same participant', async () => {
      reset(); const firstEmail = incoming(), secondEmail = incoming();
      const first = await importOne(firstEmail), second = await importOne(secondEmail);
      const conflict = await importOne(incoming({ headers: { 'in-reply-to': firstEmail.message_id, references: firstEmail.message_id + ' ' + secondEmail.message_id } }));
      assert.notEqual(conflict.conversation_id, first.conversation_id); assert.notEqual(conflict.conversation_id, second.conversation_id);
      assert.equal(count('mail_conversations'), 3);
    });

    await t.test('reading displayed IDs clears notifications without swallowing later arrivals', async () => {
      reset(); const firstEmail = incoming(), first = await importOne(firstEmail);
      const detail = await admin('mail/conversations/' + first.conversation_id); assert.equal(detail.status, 200);
      assert.equal(detail.body.messages[0].id, first.id);
      const later = await importOne(incoming({ created_at: firstEmail.created_at, headers: { 'in-reply-to': firstEmail.message_id } }));
      assert.equal(later.conversation_id, first.conversation_id);
      const read = await admin('mail/conversations/' + first.conversation_id + '/read', 'POST', { message_ids: [first.id] }); assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(rows('SELECT * FROM mail_messages WHERE id = ' + "'" + later.id + "'")[0].read_at, null);
      let unread = await admin('mail/unread'); assert.equal(unread.body.unread_count, 1); assert.equal(unread.body.conversations[0].unread_count, 1);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/read', 'POST', { message_ids: [later.id] })).status, 200);
      unread = await admin('mail/unread'); assert.equal(unread.body.unread_count, 0); assert.equal(unread.body.conversations.length, 0);
    });

    await t.test('a read request cannot mark messages belonging to another conversation', async () => {
      reset(); const first = await importOne(incoming()), second = await importOne(incoming({ from: 'jane@example.test' }));
      await admin('mail/conversations/' + first.conversation_id + '/read', 'POST', { message_ids: [second.id] });
      assert.equal(rows('SELECT * FROM mail_messages WHERE id = ' + "'" + second.id + "'")[0].read_at, null);
    });

    await t.test('trash removes conversations from active filters and badges, while restore preserves unread history', async () => {
      reset(); const email = incoming(), original = await importOne(email);
      assert.equal((await admin('mail/send', 'POST', send({ conversation_id: original.conversation_id, reply_to_message_id: original.id }))).status, 200);
      for (const filter of ['all', 'unread', 'sent']) assert.equal((await admin('mail/conversations?filter=' + filter)).body.conversations.length, 1);
      assert.equal((await admin('mail/conversations?filter=trash')).body.conversations.length, 0);
      assert.equal((await admin('mail/unread')).body.unread_count, 1);
      const before = rows('SELECT * FROM mail_messages');
      const trashed = await admin('mail/conversations/' + original.conversation_id + '/trash', 'POST', {}); assert.equal(trashed.status, 200); assert.equal(trashed.body.ok, true);
      const trash = await admin('mail/conversations?filter=trash'); assert.equal(trash.status, 200); assert.equal(trash.body.conversations.length, 1);
      assert.ok(Number.isFinite(Date.parse(trash.body.conversations[0].trashed_at)));
      for (const filter of ['all', 'unread', 'sent']) assert.equal((await admin('mail/conversations?filter=' + filter)).body.conversations.length, 0);
      const unread = await admin('mail/unread'); assert.equal(unread.body.unread_count, 0); assert.equal(unread.body.conversations.length, 0);
      assert.deepEqual(rows('SELECT * FROM mail_messages'), before, 'Moving to Trash must preserve bodies and read state');
      assert.equal((await admin('mail/conversations/' + original.conversation_id + '/trash', 'POST', {})).status, 200, 'Trash replay should be safe');
      const restored = await admin('mail/conversations/' + original.conversation_id + '/restore', 'POST', {}); assert.equal(restored.status, 200); assert.equal(restored.body.ok, true);
      assert.equal((await admin('mail/conversations?filter=trash')).body.conversations.length, 0);
      const active = await admin('mail/conversations'); assert.equal(active.body.conversations.length, 1); assert.equal(active.body.conversations[0].trashed_at, null);
      assert.equal((await admin('mail/unread')).body.unread_count, 1);
      assert.deepEqual(rows('SELECT * FROM mail_messages'), before);
      assert.equal((await admin('mail/conversations/' + original.conversation_id + '/restore', 'POST', {})).status, 200, 'Restore replay should be safe');
    });

    await t.test('reading exact displayed IDs still works in Trash and restoration retains the remaining unread message', async () => {
      reset(); const email = incoming(), first = await importOne(email), second = await importOne(incoming({ headers: { 'in-reply-to': email.message_id } }));
      assert.equal(second.conversation_id, first.conversation_id);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/trash', 'POST', {})).status, 200);
      const detail = await admin('mail/conversations/' + first.conversation_id); assert.equal(detail.status, 200); assert.ok(detail.body.conversation.trashed_at);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/read', 'POST', { message_ids: [first.id] })).status, 200);
      const readAt = sqlite.prepare('SELECT read_at FROM mail_messages WHERE id=?').get(first.id).read_at; assert.ok(readAt);
      assert.equal(sqlite.prepare('SELECT read_at FROM mail_messages WHERE id=?').get(second.id).read_at, null);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/restore', 'POST', {})).status, 200);
      const unread = await admin('mail/unread'); assert.equal(unread.body.unread_count, 1); assert.equal(unread.body.conversations[0].unread_count, 1);
      assert.equal(sqlite.prepare('SELECT read_at FROM mail_messages WHERE id=?').get(first.id).read_at, readAt);
    });

    await t.test('old webhook replays leave Trash intact but a new customer reply restores the conversation', async () => {
      reset(); const email = incoming(), first = await importOne(email);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/trash', 'POST', {})).status, 200);
      const readTrash = () => sqlite.prepare('SELECT trashed_at FROM mail_conversations WHERE id=?').get(first.conversation_id).trashed_at;
      const stamp = readTrash(); assert.ok(stamp);
      assert.equal((await webhook(email)).status, 200); assert.equal(readTrash(), stamp); assert.equal((await admin('mail/unread')).body.unread_count, 0);
      const replyEmail = incoming({ headers: { 'in-reply-to': email.message_id }, text: 'A new question from the customer.' }), reply = await importOne(replyEmail);
      assert.equal(reply.conversation_id, first.conversation_id); assert.equal(readTrash(), null); assert.equal(count('mail_conversations'), 1);
      assert.equal((await admin('mail/unread')).body.conversations[0].unread_count, 2);
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/trash', 'POST', {})).status, 200);
      const again = readTrash(); assert.equal((await webhook(replyEmail)).status, 200); assert.equal(readTrash(), again);
    });

    await t.test('an in-flight duplicate webhook cannot undo the owner trashing an already delivered reply', async () => {
      reset(); const email = incoming(), first = await importOne(email), replyEmail = incoming({ headers: { 'in-reply-to': email.message_id } });
      assert.equal((await admin('mail/conversations/' + first.conversation_id + '/trash', 'POST', {})).status, 200);
      let announce, release, arrivals = 0;
      const entered = new Promise(resolve => { announce = resolve; }), held = new Promise(resolve => { release = resolve; });
      provider.onReceivedGet = async id => { if (id === replyEmail.id && ++arrivals === 1) { announce(); await held; } };
      const delayed = webhook(replyEmail); await entered;
      let completed;
      try {
        const fast = await webhook(replyEmail); assert.equal(fast.status, 200);
        assert.equal(sqlite.prepare('SELECT trashed_at FROM mail_conversations WHERE id=?').get(first.conversation_id).trashed_at, null);
        assert.equal((await admin('mail/conversations/' + first.conversation_id + '/trash', 'POST', {})).status, 200);
      } finally { release(); completed = await delayed; }
      assert.equal(completed.status, 200); assert.equal(count('mail_messages'), 2);
      assert.ok(sqlite.prepare('SELECT trashed_at FROM mail_conversations WHERE id=?').get(first.conversation_id).trashed_at, 'Ignored duplicate must not resurrect Trash');
      assert.equal((await admin('mail/unread')).body.unread_count, 0);
    });

    await t.test('trash and restore mutations require authorization and reject unknown conversation IDs', async () => {
      reset(); const original = await importOne(incoming()), before = provider.calls.length;
      for (const action of ['trash', 'restore']) {
        assert.equal((await admin('mail/conversations/' + original.conversation_id + '/' + action, 'POST', {}, { unauthorized: true })).status, 401);
        assert.equal((await admin('mail/conversations/' + crypto.randomUUID() + '/' + action, 'POST', {})).status, 404);
        assert.equal((await admin('mail/conversations/invalid/' + action, 'POST', {})).status, 400);
      }
      assert.equal(sqlite.prepare('SELECT trashed_at FROM mail_conversations WHERE id=?').get(original.conversation_id).trashed_at, null);
      assert.equal(count('mail_messages'), 1); assert.equal(provider.calls.length, before);
    });

    await t.test('90-day cleanup removes expired active and trashed mail, aliases and empty conversations while preserving recent replies', async () => {
      reset(); const now = Date.now(), cutoff = now - 90 * 86400000, expired = new Date(cutoff - 1).toISOString();
      const old = incoming({ subject: 'Expired private subject', text: 'Expired private body' }), first = await importOne(old);
      const recent = await importOne(incoming({ subject: 'Current retained subject', text: 'Current retained reply', headers: { 'in-reply-to': old.message_id } }));
      const oldReply = await admin('mail/send', 'POST', send({ conversation_id: first.conversation_id, reply_to_message_id: recent.id, text: 'Expired outbound reply' })); assert.equal(oldReply.status, 200);
      const isolated = await importOne(incoming({ from: 'expired-customer@example.test', text: 'Expired isolated body' }));
      const oldCompose = await admin('mail/send', 'POST', send({ to: 'expired-recipient@example.test', text: 'Expired composed body' })); assert.equal(oldCompose.status, 200);
      const trashed = await importOne(incoming({ from: 'expired-trash@example.test', text: 'Expired trashed body' }));
      assert.equal((await admin('mail/conversations/' + trashed.conversation_id + '/trash', 'POST', {})).status, 200);
      sqlite.prepare('UPDATE mail_messages SET created_at=? WHERE id<>?').run(expired, recent.id);
      sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run();
      const before = provider.calls.length; await handlers.mail.cleanupExpiredMail(now);
      assert.equal(provider.calls.length, before, 'Local retention requires no provider quota');
      assert.deepEqual(rows('SELECT id FROM mail_messages'), [{ id: recent.id }]); assert.equal(count('mail_conversations'), 1);
      assert.equal(rows('SELECT id FROM mail_conversations')[0].id, first.conversation_id);
      assert.equal(rows('SELECT subject FROM mail_conversations')[0].subject, 'Current retained subject', 'Do not retain the expired first email subject as conversation content');
      assert.equal(count('mail_retired_operations'), 2);
      assert.equal(rows('SELECT * FROM mail_message_aliases').some(alias => alias.mail_message_id !== recent.id), false, 'Deleted messages must lose their aliases');
      const retained = JSON.stringify({ messages: rows('SELECT * FROM mail_messages'), conversations: rows('SELECT * FROM mail_conversations'), receipts: rows('SELECT * FROM mail_retired_operations') });
      for (const secret of ['Expired private subject', 'Expired private body', 'Expired outbound reply', 'Expired isolated body', 'Expired composed body', 'Expired trashed body', 'expired-customer@example.test', 'expired-recipient@example.test', 'expired-trash@example.test']) assert.equal(retained.includes(secret), false, secret);
      const detail = await admin('mail/conversations/' + first.conversation_id); assert.equal(detail.status, 200); assert.equal(detail.body.messages.length, 1);
      assert.ok(Number.isFinite(Date.parse(detail.body.retention_cutoff))); assert.equal((await admin('mail/conversations/' + isolated.conversation_id)).status, 404);
      assert.equal((await admin('mail/conversations?filter=trash')).body.conversations.length, 0);
      assert.equal((await admin('mail/unread')).body.unread_count, 1);
    });

    await t.test('retention keeps the exact UTC 90-day boundary and newer messages but removes older messages', async () => {
      reset(); const now = Date.now(), cutoff = now - 90 * 86400000;
      const expired = await importOne(incoming()), boundary = await importOne(incoming()), recent = await importOne(incoming());
      for (const [row, date] of [[expired, cutoff - 1], [boundary, cutoff], [recent, cutoff + 1]]) sqlite.prepare('UPDATE mail_messages SET created_at=? WHERE id=?').run(new Date(date).toISOString(), row.id);
      sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run();
      await handlers.mail.cleanupExpiredMail(now);
      assert.deepEqual(new Set(rows('SELECT id FROM mail_messages').map(row => row.id)), new Set([boundary.id, recent.id]));
      assert.equal(count('mail_conversations'), 2); assert.equal(count('mail_message_aliases'), 2);
    });

    await t.test('expired received replays are not stored again and cannot restore a retained conversation from Trash', async () => {
      reset(); const now = Date.now(), expired = new Date(now - 90 * 86400000 - 1).toISOString();
      const email = incoming(), original = await importOne(email);
      const recent = await importOne(incoming({ headers: { 'in-reply-to': email.message_id } }));
      assert.equal((await admin('mail/conversations/' + original.conversation_id + '/trash', 'POST', {})).status, 200);
      sqlite.prepare('UPDATE mail_messages SET created_at=? WHERE id=?').run(expired, original.id); email.created_at = expired;
      sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run(); await handlers.mail.cleanupExpiredMail(now);
      const trashStamp = rows('SELECT trashed_at FROM mail_conversations')[0].trashed_at;
      assert.equal((await webhook(email)).status, 200); assert.equal(count('mail_messages'), 1);
      assert.equal(rows('SELECT id FROM mail_messages')[0].id, recent.id); assert.equal(rows('SELECT trashed_at FROM mail_conversations')[0].trashed_at, trashStamp);
      assert.equal((await admin('mail/unread')).body.unread_count, 0);
      assert.equal(await handlers.mail.importReceivedEmail(email.id), false); assert.equal(count('mail_messages'), 1);
      assert.equal((await webhook(incoming({ created_at: expired, from: 'expired-unseen@example.test' }))).status, 200);
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1);
    });

    await t.test('retired accepted and uncertain send operations cannot dispatch again and retain only minimal receipts', async () => {
      reset(); const now = Date.now(), expired = new Date(now - 90 * 86400000 - 1).toISOString();
      const accepted = send({ text: 'Expired accepted content' }); assert.equal((await admin('mail/send', 'POST', accepted)).status, 200);
      provider.sendError = () => { throw new TypeError('Fixture uncertain delivery'); };
      const uncertain = send({ to: 'uncertain-recipient@example.test', text: 'Expired uncertain content' }); assert.equal((await admin('mail/send', 'POST', uncertain)).status, 503);
      sqlite.prepare('UPDATE mail_messages SET created_at=?').run(expired); sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run();
      await handlers.mail.cleanupExpiredMail(now); assert.equal(count('mail_messages'), 0); assert.equal(count('mail_conversations'), 0); assert.equal(count('mail_message_aliases'), 0);
      const receipts = rows('SELECT * FROM mail_retired_operations'); assert.equal(receipts.length, 2);
      for (const receipt of receipts) assert.deepEqual(Object.keys(receipt).sort(), ['idempotency_key', 'retired_at']);
      provider.sendError = null; const before = provider.sends.length;
      for (const input of [accepted, uncertain, { ...accepted, text: 'Mutated old payload' }]) {
        const replay = await admin('mail/send', 'POST', input); assert.equal(replay.status, 409, JSON.stringify(replay.body)); assert.equal(replay.body.code, 'mail_send_expired');
      }
      assert.equal(provider.sends.length, before); assert.equal(count('mail_messages'), 0); assert.equal(count('mail_conversations'), 0);
      assert.equal(JSON.stringify(receipts).includes('example.test'), false); assert.equal(JSON.stringify(receipts).includes('Expired'), false);
    });

    await t.test('recording an expired booking operation again cannot recreate purged email history', async () => {
      reset(); const now = Date.now(), id = crypto.randomUUID(), input = { id: 'booking/' + crypto.randomUUID() + '/1/confirmed', email_id: id, from: bindings.RESEND_FROM, to: ['old-booking@example.test'], subject: 'Expired booking subject', text: 'Expired booking body' };
      provider.sent.set(id, { id, message_id: '<old-booking-' + id + '@resend.test>' }); await handlers.mail.recordBookingEmail(input);
      sqlite.prepare('UPDATE mail_messages SET created_at=?').run(new Date(now - 90 * 86400000 - 1).toISOString()); sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run();
      await handlers.mail.cleanupExpiredMail(now); assert.equal(count('mail_retired_operations'), 1); assert.equal(count('mail_messages'), 0);
      const before = provider.calls.length; await handlers.mail.recordBookingEmail(input);
      assert.equal(count('mail_messages'), 0); assert.equal(count('mail_conversations'), 0); assert.equal(provider.calls.length, before);
      const receipt = rows('SELECT * FROM mail_retired_operations')[0]; assert.equal(receipt.idempotency_key, input.id); assert.equal(JSON.stringify(receipt).includes('old-booking@example.test'), false);
    });

    await t.test('cleanup rollback is atomic, releases a failed lease and concurrent checks use one hourly cleanup', async () => {
      reset(); const now = Date.now(), expired = new Date(now - 90 * 86400000 - 1).toISOString();
      await importOne(incoming()); assert.equal((await admin('mail/send', 'POST', send())).status, 200);
      sqlite.prepare('UPDATE mail_messages SET created_at=?').run(expired); sqlite.prepare("UPDATE mail_locks SET lease_until=0 WHERE id='cleanup'").run();
      let batches = 0; const originalBatch = db.batch; db.batch = async statements => { batches++; return originalBatch(statements); };
      db.fail = sql => /^DELETE FROM mail_messages/.test(sql);
      await assert.rejects(handlers.mail.cleanupExpiredMail(now), /Fixture database unavailable/);
      assert.equal(count('mail_messages'), 2); assert.equal(count('mail_conversations'), 2); assert.equal(count('mail_message_aliases'), 3); assert.equal(count('mail_retired_operations'), 0, 'Receipt insertion must roll back with deletion');
      assert.equal(rows("SELECT lease_until FROM mail_locks WHERE id='cleanup'")[0].lease_until, 0);
      await Promise.all(Array.from({ length: 5 }, () => handlers.mail.cleanupExpiredMail(now)));
      assert.equal(batches, 2, 'Exactly one successful cleanup should follow the failed attempt'); assert.equal(count('mail_messages'), 0); assert.equal(count('mail_conversations'), 0);
      assert.equal(rows("SELECT lease_until FROM mail_locks WHERE id='cleanup'")[0].lease_until, now + 3600000);
      await handlers.mail.cleanupExpiredMail(now + 3599999); assert.equal(batches, 2, 'Shared one-hour lease throttles repeated requests');
      await handlers.mail.cleanupExpiredMail(now + 3600000); assert.equal(batches, 3, 'Cleanup resumes at the hourly lease boundary');
    });

    await t.test('mail endpoints reject unauthorised and revoked devices without provider calls', async () => {
      reset();
      for (const [endpoint, method, data] of [['mail/status', 'GET'], ['mail/conversations', 'GET'], ['mail/unread', 'GET'], ['mail/send', 'POST', send()], ['mail/reconcile', 'POST', {}], ['mail/conversations/' + crypto.randomUUID(), 'GET'], ['mail/attachments/' + crypto.randomUUID() + '/' + crypto.randomUUID(), 'GET']]) {
        assert.equal((await admin(endpoint, method, data, { unauthorized: true })).status, 401);
      }
      sqlite.prepare('INSERT INTO admin_devices(id,name,token_hash,created_at) VALUES(?,?,?,?)').run(crypto.randomUUID(), 'Second fixture device', randomBytes(32).toString('hex'), new Date().toISOString());
      sqlite.prepare('UPDATE admin_devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId);
      assert.equal((await admin('mail/send', 'POST', send())).status, 401);
      assert.equal(count('mail_messages'), 0); assert.equal(provider.calls.length, 0);
    });

    await t.test('new email persists canonical provider ID, operation replay avoids sending again and mismatched operations fail', async () => {
      reset(); const input = send(), sent = await admin('mail/send', 'POST', input);
      assert.equal(sent.status, 200, JSON.stringify(sent.body)); assert.ok(sent.body.conversation_id); assert.ok(sent.body.message_id);
      assert.equal(count('mail_messages'), 1); assert.equal(provider.cache.size, 1);
      const stored = rows('SELECT * FROM mail_messages')[0];
      assert.equal(stored.direction, 'outbound'); assert.equal(stored.status, 'sent'); assert.ok(stored.resend_email_id);
      assert.equal(stored.message_id, provider.sent.get(stored.resend_email_id).message_id);
      assert.equal((await admin('mail/send', 'POST', input)).status, 200); assert.equal(provider.sends.length, 1);
      assert.equal((await admin('mail/send', 'POST', { ...input, text: 'Changed payload' })).status, 409); assert.equal(provider.sends.length, 1);
    });

    await t.test('canonical and custom sent Message-ID aliases both thread replies without allowing alias takeover', async () => {
      reset(); const input = send(), result = await admin('mail/send', 'POST', input); assert.equal(result.status, 200);
      const outbound = rows('SELECT * FROM mail_messages')[0], custom = provider.sends[0].payload.headers['Message-ID'];
      assert.notEqual(custom, outbound.message_id, 'Fixture intentionally simulates provider rewriting Message-ID');
      const attacker = await importOne(incoming({ from: 'jane@example.test', message_id: outbound.message_id }));
      assert.notEqual(attacker.conversation_id, result.body.conversation_id);
      for (const id of [custom, outbound.message_id]) {
        const reply = await importOne(incoming({ headers: { 'in-reply-to': id } }));
        assert.equal(reply.conversation_id, result.body.conversation_id);
      }
      assert.equal(count('mail_conversations'), 2);
    });

    await t.test('an unavailable canonical Message-ID prevents replying with a provider-overwritten placeholder', async () => {
      reset(); provider.failSentGet = Response.json({ name: 'service_unavailable' }, { status: 503 });
      const first = await admin('mail/send', 'POST', send()); assert.equal(first.status, 200);
      const previous = rows('SELECT * FROM mail_messages')[0], reply = send({ conversation_id: previous.conversation_id, reply_to_message_id: previous.id });
      const unknownHeader = await admin('mail/send', 'POST', reply); assert.equal(unknownHeader.status, 409, JSON.stringify(unknownHeader.body)); assert.equal(unknownHeader.body.code, 'mail_header_pending');
      assert.equal(provider.sends.length, 1, 'Do not send an invalid external threading reference');
      provider.failSentGet = null;
      const recovered = await admin('mail/send', 'POST', reply); assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
      assert.equal(provider.sends[1].payload.headers['In-Reply-To'], provider.sent.get(previous.resend_email_id).message_id);
    });

    await t.test('an incoming reply recovers a missed canonical sent header before creating a separate conversation', async () => {
      reset(); provider.failSentGet = Response.json({ name: 'service_unavailable' }, { status: 503 });
      const first = await admin('mail/send', 'POST', send()); assert.equal(first.status, 200);
      const previous = rows('SELECT * FROM mail_messages')[0], canonical = provider.sent.get(previous.resend_email_id).message_id;
      assert.notEqual(previous.message_id, canonical);
      const arriving = incoming({ headers: { 'in-reply-to': canonical, references: canonical } });
      const unavailable = await webhook(arriving); assert.equal(unavailable.status, 503, 'Let Resend retry before acknowledging a reply with unresolved threading');
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1);
      provider.failSentGet = null;
      const reply = await importOne(arriving);
      assert.equal(reply.conversation_id, first.body.conversation_id, 'A transient sent-header GET failure must not permanently split real replies');
      assert.equal(count('mail_conversations'), 1);
    });

    await t.test('concurrent sends use one stored operation and one provider dispatch', async () => {
      reset(); const input = send(); let release;
      provider.holdSend = new Promise(resolve => { release = resolve; });
      const first = admin('mail/send', 'POST', input);
      while (!provider.sends.length) await new Promise(resolve => setTimeout(resolve, 1));
      let duplicate;
      try { duplicate = await admin('mail/send', 'POST', input); } finally { release(); }
      assert.ok([200, 202, 409].includes(duplicate.status), JSON.stringify(duplicate));
      if (duplicate.status === 409) assert.equal(duplicate.body.code, 'mail_send_pending');
      const result = await first; assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1); assert.equal(provider.sends.length, 1);
    });

    await t.test('reply uses participant, real Message-ID and References; wrong target cannot leak another history', async () => {
      reset(); const email = incoming(), original = await importOne(email);
      const reply = await admin('mail/send', 'POST', send({ conversation_id: original.conversation_id, reply_to_message_id: original.id }));
      assert.equal(reply.status, 200, JSON.stringify(reply.body)); assert.equal(reply.body.conversation_id, original.conversation_id);
      const payload = provider.sends[0].payload;
      assert.deepEqual(payload.to, ['sarah@example.test']); assert.match(payload.subject, /^Re:/i);
      assert.equal(payload.headers['In-Reply-To'], email.message_id); assert.ok(payload.headers.References.includes(email.message_id)); assert.match(payload.headers['Message-ID'], /^<[^<>\s]+@tannedbyffy\.co\.uk>$/);
      const other = await importOne(incoming({ from: 'jane@example.test' }));
      const invalid = await admin('mail/send', 'POST', send({ conversation_id: original.conversation_id, reply_to_message_id: other.id }));
      assert.ok([400, 404, 409].includes(invalid.status)); assert.equal(provider.sends.length, 1);
    });

    await t.test('provider failures retain retryable state and expired uncertain sends never dispatch again', async () => {
      reset(); const input = send();
      provider.sendError = () => { throw new TypeError('Fixture network unavailable'); };
      const failed = await admin('mail/send', 'POST', input); assert.equal(failed.status, 503);
      assert.equal(count('mail_messages'), 1);
      sqlite.prepare('UPDATE mail_messages SET first_attempt_at = ?, lease_until = 0').run(Date.now() - 25 * 3600000);
      provider.sendError = null; const before = provider.sends.length;
      const expired = await admin('mail/send', 'POST', input); assert.ok([409, 503].includes(expired.status), JSON.stringify(expired.body));
      assert.equal(provider.sends.length, before, 'Never retry beyond provider idempotency cache');
    });

    await t.test('accepted send with database receipt failure retries the frozen payload', async () => {
      reset(); const email = incoming(), original = await importOne(email), input = send({ conversation_id: original.conversation_id, reply_to_message_id: original.id });
      db.fail = sql => /UPDATE mail_messages SET.*resend_email_id/i.test(sql);
      const first = await admin('mail/send', 'POST', input); assert.equal(first.status, 503); assert.equal(provider.cache.size, 1);
      await importOne(incoming({ headers: { 'in-reply-to': email.message_id }, text: 'Another email arrived during retry.' }));
      sqlite.prepare('UPDATE mail_messages SET lease_until = 0 WHERE direction = ?').run('outbound');
      const retry = await admin('mail/send', 'POST', input); assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(provider.cache.size, 1); assert.equal(rows("SELECT * FROM mail_messages WHERE direction='outbound'").length, 1);
    });

    await t.test('unknown conversations and invalid compose data cannot dispatch provider mail', async () => {
      reset();
      assert.equal((await admin('mail/conversations/' + crypto.randomUUID())).status, 404);
      for (const input of [send({ to: 'invalid' }), send({ to: 'sarah@example.test\r\nBcc: other@example.test' }), send({ subject: 'Subject\r\nInjected: yes' }), send({ text: '' }), send({ idempotency_key: 'invalid' }), send({ conversation_id: crypto.randomUUID() })]) {
        const result = await admin('mail/send', 'POST', input); assert.ok([400, 404, 409].includes(result.status), JSON.stringify(result.body));
      }
      assert.equal(provider.sends.length, 0);
    });

    await t.test('reconciliation imports missing mailbox mail once and skips unrelated team mail', async () => {
      reset();
      incoming(); incoming({ from: 'jane@example.test' }); incoming({ from: 'unrelated@example.test', to: ['another-mailbox@tannedbyffy.co.uk'] });
      const sync = await admin('mail/reconcile', 'POST', {}); assert.equal(sync.status, 200, JSON.stringify(sync.body));
      assert.equal(count('mail_messages'), 2);
      const importedIds = rows('SELECT resend_email_id FROM mail_messages').map(row => row.resend_email_id);
      const importedGets = () => provider.calls.filter(call => importedIds.some(id => new URL(call.url).pathname === '/emails/receiving/' + id)).length;
      const gets = importedGets(); sqlite.prepare('UPDATE mail_locks SET lease_until=0').run();
      const replay = await admin('mail/reconcile', 'POST', {}); assert.equal(replay.status, 200, JSON.stringify(replay.body)); assert.equal(count('mail_messages'), 2);
      assert.equal(importedGets(), gets, 'Known email IDs need no repeated content retrieval');
    });

    await t.test('reconciliation checkpoints beyond an already imported page and then returns to newer missed mail', async () => {
      reset(); const emails = [];
      for (let index = 0; index < 12; index++) emails.push(incoming({ created_at: new Date(Date.now() - index * 1000).toISOString() }));
      for (const email of emails.slice(0, 10)) await importOne(email);
      const first = await admin('mail/reconcile', 'POST', {}); assert.equal(first.status, 200); assert.equal(first.body.imported, 0); assert.equal(first.body.more_available, true);
      assert.equal(rows("SELECT cursor FROM mail_locks WHERE id='reconcile'")[0].cursor, emails[9].id);
      const newest = incoming({ created_at: new Date(Date.now() + 1000).toISOString() });
      sqlite.prepare('UPDATE mail_locks SET lease_until=0').run();
      const second = await admin('mail/reconcile', 'POST', {}); assert.equal(second.status, 200); assert.equal(second.body.imported, 2); assert.equal(second.body.more_available, false);
      assert.equal(rows("SELECT cursor FROM mail_locks WHERE id='reconcile'")[0].cursor, null);
      sqlite.prepare('UPDATE mail_locks SET lease_until=0').run();
      const third = await admin('mail/reconcile', 'POST', {}); assert.equal(third.status, 200); assert.equal(third.body.imported, 1);
      assert.ok(rows('SELECT resend_email_id FROM mail_messages').some(row => row.resend_email_id === newest.id));
      assert.equal(count('mail_messages'), 13);
    });

    await t.test('reconciliation stops on a wall-clock budget and resumes after the last persisted message', async () => {
      reset(); const emails = [];
      for (let index = 0; index < 10; index++) emails.push(incoming({ created_at: new Date(Date.now() - index * 1000).toISOString() }));
      const realNow = Date.now; let advanced = 0;
      provider.onReceivedGet = () => { advanced += 4000; };
      Date.now = () => realNow() + advanced;
      try {
        const partial = await admin('mail/reconcile', 'POST', {}); assert.equal(partial.status, 200); assert.equal(partial.body.more_available, true);
        assert.ok(count('mail_messages') > 0 && count('mail_messages') < 10);
        const persisted = rows('SELECT resend_email_id FROM mail_messages'), checkpoint = rows("SELECT cursor FROM mail_locks WHERE id='reconcile'")[0].cursor;
        assert.ok(persisted.some(row => row.resend_email_id === checkpoint), 'Checkpoint must be a successfully persisted message');
        assert.equal(checkpoint, emails[persisted.length - 1].id);
      } finally { Date.now = realNow; provider.onReceivedGet = null; }
    });

    await t.test('booking emails enter outgoing history once and customer replies preserve their thread', async () => {
      reset(); const id = crypto.randomUUID(), input = { id: 'booking/' + crypto.randomUUID() + '/1/confirmed', email_id: id, from: bindings.RESEND_FROM, to: ['sarah@example.test'], subject: 'Tanned by Ffy: appointment confirmed', text: 'Your appointment is confirmed.' };
      provider.sent.set(id, { id, message_id: '<booking-' + id + '@resend.test>', created_at: new Date().toISOString() });
      await handlers.mail.recordBookingEmail(input); await handlers.mail.recordBookingEmail(input);
      assert.equal(count('mail_messages'), 1); assert.equal(count('mail_conversations'), 1);
      const stored = rows('SELECT * FROM mail_messages')[0]; assert.equal(stored.status, 'sent'); assert.equal(stored.subject, input.subject);
      const reply = await importOne(incoming({ headers: { 'in-reply-to': stored.message_id } })); assert.equal(reply.conversation_id, stored.conversation_id);
    });

    await t.test('conversation pagination is stable, newest-first and validates cursor input', async () => {
      reset();
      for (let index = 0; index < 5; index++) await importOne(incoming({ created_at: new Date(Date.now() - index * 1000).toISOString() }));
      const first = await admin('mail/conversations?limit=2'); assert.equal(first.status, 200); assert.equal(first.body.conversations.length, 2); assert.ok(first.body.next_cursor);
      assert.ok(first.body.conversations[0].last_message_at >= first.body.conversations[1].last_message_at);
      const second = await admin('mail/conversations?limit=2&cursor=' + encodeURIComponent(first.body.next_cursor)); assert.equal(second.status, 200); assert.equal(second.body.conversations.length, 2);
      assert.equal(new Set([...first.body.conversations, ...second.body.conversations].map(row => row.id)).size, 4);
      const invalid = await admin('mail/conversations?cursor=invalid'); assert.equal(invalid.status, 400);
      assert.equal((await admin('mail/conversations?limit=101')).status, 400);
    });

    await t.test('large Unicode histories stay below the response byte budget and pagination exposes every message', async () => {
      reset(); const base = incoming({ created_at: new Date(Date.now() - 60000).toISOString() }), first = await importOne(base);
      const text = '界'.repeat(200000);
      for (let index = 0; index < 30; index++) await importOne(incoming({ text, html: '<p>' + text + '</p>', created_at: new Date(Date.now() - 59000 + index * 1000).toISOString(), headers: { 'in-reply-to': base.message_id } }));
      const seen = new Set(); let cursor;
      for (let page = 0; page < 10; page++) {
        const result = await admin('mail/conversations/' + first.conversation_id + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
        assert.equal(result.status, 200); assert.ok(result.body.messages.length > 0);
        assert.ok(Buffer.byteLength(JSON.stringify(result.body)) < 8 * 1024 * 1024 + 65536, 'Keep each complete response within the native JSON limit');
        assert.ok(result.body.messages.length <= 20, 'Bound database page allocations before serialising messages');
        for (const message of result.body.messages) { assert.equal(seen.has(message.id), false, 'No pagination duplicates'); assert.equal('html_body' in message, false); seen.add(message.id); }
        const dates = result.body.messages.map(message => message.created_at); assert.deepEqual(dates, [...dates].sort(), 'Messages must display oldest-first within a page');
        if (!result.body.next_cursor) break;
        assert.notEqual(result.body.next_cursor, cursor); cursor = result.body.next_cursor;
      }
      assert.equal(seen.size, 31, 'Byte limits must not strand any older message');
    });

    await t.test('received attachments download through authorized JSON bytes without private URL exposure', async () => {
      reset(); const attachmentId = crypto.randomUUID();
      const stored = await importOne(incoming({ attachments: [{ id: attachmentId, filename: '../invoice.pdf', content_type: 'application/pdf', size: 12 }] }));
      provider.download = new Response('Fixture file');
      const file = await admin('mail/attachments/' + stored.id + '/' + attachmentId); assert.equal(file.status, 200, JSON.stringify(file.body));
      assert.equal(Buffer.from(file.body.base64, 'base64').toString(), 'Fixture file');
      assert.equal(JSON.stringify(file.body).includes('download_url'), false); assert.equal(JSON.stringify(file.body).includes('signature=fixture'), false);
      assert.equal(JSON.stringify(file.body).includes('re_fixture_only'), false);
      const before = provider.calls.length;
      assert.equal((await admin('mail/attachments/' + stored.id + '/' + crypto.randomUUID())).status, 404);
      assert.equal(provider.calls.length, before, 'An unrelated attachment ID must not reach provider');
    });

    await t.test('attachment proxy refuses unsafe origins, credentials, redirects and oversized declared files', async () => {
      reset(); const attachmentId = crypto.randomUUID(), stored = await importOne(incoming({ attachments: [{ id: attachmentId, filename: 'invoice.pdf', content_type: 'application/pdf', size: 12 }] }));
      for (const url of ['http://inbound-cdn.resend.com/file', 'https://127.0.0.1/private', 'https://inbound-cdn.resend.com.attacker.test/file', 'https://user:password@inbound-cdn.resend.com/file']) {
        provider.attachment = Response.json({ id: attachmentId, filename: 'invoice.pdf', size: 12, content_type: 'application/pdf', download_url: url });
        const before = provider.calls.filter(call => call.url.startsWith('https://inbound-cdn.resend.com/')).length;
        const result = await admin('mail/attachments/' + stored.id + '/' + attachmentId); assert.equal(result.status, 503, JSON.stringify(result.body));
        assert.equal(provider.calls.filter(call => call.url.startsWith('https://inbound-cdn.resend.com/')).length, before);
      }
      provider.attachment = Response.json({ id: attachmentId, filename: 'invoice.pdf', size: 16 * 1024 * 1024, content_type: 'application/pdf', download_url: 'https://inbound-cdn.resend.com/file' });
      const oversized = await admin('mail/attachments/' + stored.id + '/' + attachmentId); assert.ok([400, 413, 503].includes(oversized.status));
      provider.attachment = null; provider.download = new Response('', { status: 302, headers: { Location: 'https://attacker.test/file' } });
      const redirect = await admin('mail/attachments/' + stored.id + '/' + attachmentId); assert.equal(redirect.status, 503);
    });

    await t.test('attachment download counts actual streamed bytes rather than trusting metadata or Content-Length', async () => {
      reset(); const attachmentId = crypto.randomUUID(), stored = await importOne(incoming({ attachments: [{ id: attachmentId, filename: 'invoice.pdf', content_type: 'application/pdf', size: 1 }] }));
      let chunks = 0, cancelled = false;
      provider.download = () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); if (++chunks === 30) controller.close(); }, cancel() { cancelled = true; } }), { headers: { 'Content-Length': '1' } });
      const result = await admin('mail/attachments/' + stored.id + '/' + attachmentId); assert.equal(result.status, 413);
      assert.equal(cancelled, true); assert.ok(chunks <= 17, 'Stop the stream when the bound is exceeded, allowing one prefetched chunk');
    });

    await t.test('status and plain-text API never include credentials or untrusted HTML bodies', async () => {
      reset(); const script = '<script>window.mailAttack = true</script><img src="https://tracker.invalid/x" onerror="alert(1)">';
      const original = await importOne(incoming({ text: null, html: script + '<p>Hello from HTML-only email</p>' }));
      const detail = await admin('mail/conversations/' + original.conversation_id); assert.equal(detail.status, 200);
      const serialized = JSON.stringify(detail.body);
      assert.equal(serialized.includes('<script>'), false); assert.equal(serialized.includes('onerror='), false);
      assert.equal('html_body' in detail.body.messages[0], false, 'Client should receive safe text, not raw HTML');
      const status = await admin('mail/status'); assert.equal(status.status, 200); assert.equal(status.body.configured, true);
      assert.equal(JSON.stringify(status.body).includes(bindings.RESEND_API_KEY), false); assert.equal(JSON.stringify(status.body).includes(bindings.RESEND_WEBHOOK_SECRET), false);
      assert.equal(serialized.includes(bindings.RESEND_API_KEY), false);
    });
  } finally {
    globalThis.fetch = realFetch;
    sqlite?.close();
    delete globalThis.__mailFixtureEnv;
  }
});
