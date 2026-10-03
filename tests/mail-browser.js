import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assertLocal, capture, installDesktopFixture } from "./features-browser.js";

const require = createRequire(import.meta.url);
const url = process.env.FFYON_MAIL_ROOT_URL;
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const copy = value => structuredClone(value);
if (url) await run();
function records() {
  const now = new Date().toISOString();
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const client = { id: uuid(9101), account_id: null, name: "Booking still available", email: "booking@example.invalid", phone: "", saved_address: "", saved_postcode: "", disabled: false, revision: 1, updated_at: now };
  const service = { id: uuid(9102), name: "Mail fixture tan", description: "", duration_min: 30, price_pence: 2500, discount_percent: 0, booking_price_pence: 2500, active: true, revision: 1 };
  return { clients: [client], services: [service], appointments: [{ id: uuid(9103), client_id: client.id, service_id: service.id, service_name: service.name, date, start_time: "10:00", time_confirmed: true, duration_min: 30, price_pence: 2500, base_price_pence: 2500, discount_percent: 0, is_remote: false, visit_address: "", visit_postcode: "", notes: "", status: "pending", revision: 1, proposed_date: null, proposed_start_time: null, proposed_time_confirmed: null, series_id: null, created_at: now, updated_at: now }], blocks: [], settings: { timezone: "Europe/London", slot_minutes: 30, horizon_days: 90, booking_enabled: true, opening_hours: [], admin_notifications_enabled: false, admin_notification_email: "", revision: 1 } };
}

async function fixtureFor(page, { unavailable = false } = {}) {
  const fixture = await installDesktopFixture(page, records());
  const start = Date.now() - 80 * 60_000;
  const messages = Array.from({ length: 70 }, (_, index) => ({ id: uuid(9200 + index), direction: "inbound", status: "received", from_address: "customer@example.invalid", to_addresses: ["hello@business.example.invalid"], cc_addresses: [], subject: "Tan question", text_body: `Earlier customer message ${index}`, created_at: new Date(start + index * 60_000).toISOString(), read_at: null, message_id: `<message-${index}@example.invalid>`, in_reply_to: null, references: [], attachments: [] }));
  messages[69].text_body = '<img src="https://example.invalid/tracking"><script>window.__mailExecuted=true</script>\nCustomer question with <strong>literal markup</strong>.';
  messages[69].attachments = [
    { id: uuid(9801), filename: "../../invoice.pdf", content_type: "application/pdf", size: 3 },
    { id: uuid(9802), filename: "oversized.zip", content_type: "application/zip", size: 15 * 1024 * 1024 + 1 },
    { id: uuid(9803), filename: "invalid.pdf", content_type: "application/pdf", size: 3 },
  ];
  const threads = [{ id: uuid(9001), subject: "Tan question", participant_email: "customer@example.invalid", participant_name: "Customer with a long name for small screens", client_id: null, messages }, { id: uuid(9002), subject: "Another customer's question", participant_email: "another@example.invalid", participant_name: null, client_id: null, messages: [{ ...copy(messages[0]), id: uuid(9701), text_body: "Another customer's unread question", attachments: [], created_at: new Date(start + 71 * 60_000).toISOString() }] }, { id: uuid(9003), subject: "Previous sent email", participant_email: "sent@example.invalid", participant_name: "Sent customer", client_id: null, messages: [{ ...copy(messages[0]), id: uuid(9702), direction: "outbound", status: "pending", from_address: "hello@business.example.invalid", to_addresses: ["sent@example.invalid"], text_body: "Awaiting transport confirmation", read_at: new Date().toISOString(), message_id: null, created_at: new Date(start + 72 * 60_000).toISOString() }, { ...copy(messages[0]), id: uuid(9703), direction: "outbound", status: "failed", from_address: "hello@business.example.invalid", to_addresses: ["sent@example.invalid"], text_body: "Transport rejected this earlier message", read_at: new Date().toISOString(), message_id: null, created_at: new Date(start + 73 * 60_000).toISOString() }] }];
  const summarize = thread => {
    const last = thread.messages.at(-1);
    return { id: thread.id, subject: thread.subject, participant_email: thread.participant_email, participant_name: thread.participant_name, client_id: thread.client_id, unread_count: thread.messages.filter(message => message.direction === "inbound" && !message.read_at).length, message_count: thread.messages.length, last_message_at: last.created_at, preview: last.text_body, direction: last.direction, trashed_at: thread.trashed_at || null };
  };
  const requests = [], sends = [], saved = [], sendIds = new Map();
  let arrival = null;
  let loseResponse = true;
  let pendingNextSend = false;
  let readRace = true;
  let reconcileFails = true;
  let retentionCutoff = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  await page.exposeBinding("__ffyonMailInvoke", async (_source, command, args) => {
    if (command === "protected_save_file") { saved.push({ dialog: copy(args) }); return "C:\\Disposable fixture\\invoice.pdf"; }
    if (command === "protected_write_file") { saved.push({ write: copy(args) }); return null; }
    assert.equal(command, "admin_request");
    requests.push(copy(args));
    if (unavailable) throw new Error("404: Mail is not deployed yet");
    if (args.operation === "mail/status") return { configured: true, sender_address: "hello@business.example.invalid", receiving_addresses: ["hello@business.example.invalid", "bookings@business.example.invalid"] };
    if (args.operation === "mail/unread") {
      const conversations = threads.map(summarize).filter(thread => thread.unread_count > 0 && !thread.trashed_at);
      return copy({ conversations, unread_count: conversations.length });
    }
    if (args.operation === "mail/conversations") {
      assert.equal(args.method, "GET");
      let conversations = threads.map(summarize).sort((a, b) => b.last_message_at.localeCompare(a.last_message_at));
      conversations = conversations.filter(thread => args.query.filter === "trash" ? !!thread.trashed_at : !thread.trashed_at);
      if (args.query.filter === "unread") conversations = conversations.filter(thread => thread.unread_count > 0);
      if (args.query.filter === "sent") conversations = conversations.filter(thread => threads.find(value => value.id === thread.id).messages.some(message => message.direction === "outbound" && message.status === "sent"));
      return copy({ conversations: args.query.cursor ? conversations.slice(2) : conversations.slice(0, 2), next_cursor: !args.query.cursor && conversations.length > 2 ? "bGlzdDI" : null });
    }
    if (args.operation === "mail/reconcile") { if (reconcileFails) { reconcileFails = false; throw new Error("503: Mock mail service busy"); } return { imported: 0, more_available: true }; }
    if (args.operation.startsWith("mail/attachments/")) return { filename: "../../invoice.pdf", content_type: "application/pdf", base64: args.operation.endsWith(uuid(9803)) ? "invalid!" : "YWJj" };
    if (args.operation === "mail/send") {
      sends.push(copy(args.body));
      const previous = sendIds.get(args.body.idempotency_key);
      if (previous) {
        assert.deepEqual(previous.body, args.body, "An ambiguous send retry must retain the original key and payload");
        previous.result.status = "sent";
        for (const thread of threads) for (const message of thread.messages) if (message.id === previous.result.message_id) { message.status = "sent"; message.message_id = `<${message.id}@example.invalid>`; }
        return copy(previous.result);
      }
      const thread = args.body.conversation_id ? threads.find(value => value.id === args.body.conversation_id) : { id: uuid(9900 + sendIds.size), subject: args.body.subject, participant_email: args.body.to, participant_name: null, client_id: null, messages: [] };
      if (!args.body.conversation_id) threads.push(thread);
      const message = { id: uuid(9950 + sendIds.size), direction: "outbound", status: "sent", from_address: "hello@business.example.invalid", to_addresses: [args.body.to], cc_addresses: [], subject: args.body.subject, text_body: args.body.text, created_at: new Date().toISOString(), read_at: new Date().toISOString(), message_id: `<sent-${sendIds.size}@example.invalid>`, in_reply_to: args.body.reply_to_message_id || null, references: [], attachments: [] };
      thread.messages.push(message);
      const result = { conversation_id: thread.id, message_id: message.id, status: "sent" };
      if (pendingNextSend) { pendingNextSend = false; result.status = "pending"; message.status = "pending"; message.message_id = null; }
      sendIds.set(args.body.idempotency_key, { body: copy(args.body), result });
      if (loseResponse) { loseResponse = false; throw new Error("Connection lost after the server accepted the email"); }
      return copy(result);
    }
    const detail = args.operation.match(/^mail\/conversations\/([^/]+)(?:\/(read|trash|restore))?$/);
    assert.ok(detail, `Unexpected mock mail operation ${args.operation}`);
    const thread = threads.find(value => value.id === (detail[1] === uuid(9099) ? uuid(9001) : detail[1]));
    if (!thread) throw new Error("404: This conversation could not be found.");
    if (detail[2] === "trash" || detail[2] === "restore") {
      assert.equal(args.method, "POST"); assert.deepEqual(args.body, {});
      thread.trashed_at = detail[2] === "trash" ? new Date().toISOString() : null;
      return { ok: true };
    }
    if (detail[2] === "read") {
      assert.equal(args.method, "POST");
      let introducedArrival = false;
      if (readRace && thread.id === uuid(9001)) {
        readRace = false;
        introducedArrival = true;
        arrival = { ...copy(thread.messages[69]), id: uuid(9799), text_body: "Arrived after the detail response", attachments: [], created_at: new Date().toISOString() };
        thread.messages.push(arrival);
        assert.ok(!args.body.message_ids.includes(arrival.id), "The read acknowledgement must exclude an arrival absent from the displayed detail");
      }
      for (const id of args.body.message_ids) { const message = thread.messages.find(value => value.id === id); assert.ok(message); assert.equal(message.direction, "inbound"); message.read_at = new Date().toISOString(); }
      if (introducedArrival) assert.equal(arrival.read_at, null, "The newly arrived message stays unread until actually displayed");
      return { ok: true };
    }
    assert.equal(args.method, "GET"); assert.equal(args.query.limit, "50");
    const end = args.query.cursor ? Number(Buffer.from(args.query.cursor, "base64url").toString()) : thread.messages.length;
    const begin = Math.max(0, end - 50);
    return copy({ conversation: summarize(thread), messages: thread.messages.slice(begin, end), next_cursor: begin ? Buffer.from(String(begin)).toString("base64url") : null, retention_cutoff: retentionCutoff });
  });
  await page.addInitScript(() => {
    const original = window.__ffyonFeatureInvoke;
    window.__ffyonFeatureInvoke = (command, args) => command === "protected_save_file" || command === "protected_write_file" || command === "admin_request" && args.operation.startsWith("mail/") ? window.__ffyonMailInvoke(command, args) : original(command, args);
  });
  return { fixture, threads, requests, sends, saved, sendIds, nextSendPending: () => { pendingNextSend = true; }, pruneBefore: cutoff => {
    retentionCutoff = cutoff;
    for (const thread of threads) thread.messages = thread.messages.filter(message => message.created_at >= cutoff);
  } };
}

async function run() {
  assertLocal(url);
  const { chromium } = require(process.env.FFYON_PLAYWRIGHT_PATH || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.FFYON_BROWSER_CHANNEL ? { channel: process.env.FFYON_BROWSER_CHANNEL } : {}) });
  const focused = process.env.FFYON_MAIL_FOCUS === "earlier-404";
  const output = resolve(focused ? "test-results/mail-browser-earlier-404" : "test-results/mail-browser");
  await mkdir(output, { recursive: true });
  const evidence = [];
  try {
    if (!focused) {
      for (const width of [1280, 375, 320]) evidence.push(await flow(browser, width, output));
      evidence.push(await unavailable(browser, output));
      evidence.push(await groupedLegacyLink(browser, output));
    }
    evidence.push(await earlierPageRemoved(browser, output));
    await writeFile(resolve(output, "evidence.json"), JSON.stringify({ evidence, boundary: "Loopback app plus disposable SQLite/native/mail fixtures. No real email, Resend, WebView2 or file writes." }, null, 2));
    console.log(JSON.stringify({ evidence }, null, 2));
  } finally { await browser.close(); }
}

async function groupedLegacyLink(browser, output) {
  const page=await browser.newPage({viewport:{width:1280,height:900},timezoneId:'Europe/London'});
  const mail=await fixtureFor(page);
  try {
    await page.goto(`${url}#/mail/${uuid(9099)}`,{waitUntil:'networkidle'});
    await page.getByRole('heading',{name:'Tan question',exact:true}).waitFor();
    await until(page,()=>page.url().endsWith(`#/mail/${uuid(9001)}`));
    const list=page.getByRole('region',{name:'Email conversations',exact:true});
    assert.equal(await list.getByRole('link').filter({hasText:'Tan question'}).count(),1,'One list entry contains the complete conversation');
    await until(page,async()=>await list.getByText('71 messages',{exact:true}).count()===1);
    const statusCalls=mail.requests.filter(request=>request.operation==='mail/status').length;
    const listCalls=mail.requests.filter(request=>request.operation==='mail/conversations').length;
    await page.getByRole('button',{name:'Check for mail',exact:true}).click();
    await until(page,()=>mail.requests.filter(request=>request.operation==='mail/conversations').length>listCalls);
    assert.equal(mail.requests.filter(request=>request.operation==='mail/status').length,statusCalls,'Checking for mail does not refetch unchanged Mail configuration');
    await capture(page,output,'grouped-conversation.png');
    return {flow:'grouped-legacy-link',canonicalRoute:true,oneConversationRow:true,messageCount:true};
  } finally {await page.close();mail.fixture.close();}
}

async function flow(browser, width, output) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, timezoneId: "Europe/London" });
  const errors = [], remote = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (!request.url().startsWith(url) && !request.url().startsWith("data:")) remote.push(request.url()); });
  const mail = await fixtureFor(page);
  try {
    await page.goto(`${url}#/inbox`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Inbox", exact: true }).waitFor();
    await until(page, async () => await page.getByTestId("inbox-badge").textContent() === "3");
    assert.equal(await page.getByTestId("mail-badge").textContent(), "2", "Mail counts unread conversations, not seventy messages");
    await page.getByRole("button", { name: "Booking still available", exact: true }).waitFor();
    await capture(page, output, `inbox-email-${width}.png`);
    await page.getByRole("link").filter({ hasText: "Tan question" }).click();
    await page.getByRole("heading", { name: "Tan question", exact: true }).waitFor();
    await page.getByLabel("Message history", { exact: true }).getByText("Arrived after the detail response", { exact: true }).waitFor();
    await until(page, () => mail.requests.filter(request => request.operation.endsWith("/read")).length >= 2);
    const reads = mail.requests.filter(request => request.operation.endsWith("/read"));
    assert.equal(reads[0].body.message_ids.length, 50);
    assert.ok(!reads[0].body.message_ids.includes(uuid(9799)));
    assert.ok(reads.slice(1).some(request => request.body.message_ids.includes(uuid(9799))));
    assert.equal(await page.locator('img[src*="example.invalid"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__mailExecuted), undefined);
    await page.getByText(/literal markup/).waitFor();
    await until(page, () => mail.requests.filter(request => request.operation === `mail/conversations/${uuid(9001)}`).length >= 2);
    await page.getByRole("button", { name: "Load earlier messages", exact: true }).click();
    await page.getByText("Earlier customer message 0", { exact: true }).waitFor();
    await until(page, () => mail.threads[0].messages.every(message => message.read_at));
    await capture(page, output, `conversation-${width}.png`);
    mail.pruneBefore(mail.threads[0].messages[20].created_at);
    await page.getByRole("button", { name: "Check for mail", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Mock mail service busy" }).getByRole("button", { name: "Retry", exact: true }).click();
    await until(page, async () => await page.getByText("Earlier customer message 0", { exact: true }).count() === 0);
    await page.getByLabel("Message history", { exact: true }).getByText("Earlier customer message 20", { exact: true }).waitFor();
    await page.getByRole("button", { name: /invoice.pdf/ }).click();
    await until(page, () => mail.saved.some(value => value.write));
    assert.equal(mail.saved[0].dialog.defaultPath, "invoice.pdf", "A remote attachment filename must not create a relative/path-bearing dialog default");
    assert.deepEqual(mail.saved[1].write.data, [97, 98, 99]);
    assert.equal(await page.getByRole("button", { name: /oversized.zip/ }).isDisabled(), true);
    await page.getByRole("button", { name: /invalid.pdf/ }).click();
    await page.getByRole("alert").filter({ hasText: "attachment download is invalid" }).waitFor();
    assert.equal(mail.saved.length, 2, "Invalid base64 must be rejected before the save dialog");

    const reply = page.getByLabel("Reply message", { exact: true });
    await reply.fill("Thanks — here is a safe threaded reply.");
    await page.getByRole("button", { name: "Send reply", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Connection lost" }).waitFor();
    assert.equal(await reply.getAttribute("readonly"), "");
    await page.getByRole("button", { name: "Retry send", exact: true }).click();
    await until(page, () => mail.sends.length === 2);
    assert.deepEqual(mail.sends[0], mail.sends[1]);
    assert.equal(mail.sendIds.size, 1);
    assert.equal(mail.sends[0].conversation_id, uuid(9001));
    assert.equal(mail.sends[0].reply_to_message_id, uuid(9799));
    assert.equal(mail.sends[0].to, "customer@example.invalid");
    await page.getByLabel("Message history", { exact: true }).getByText("Thanks — here is a safe threaded reply.", { exact: true }).waitFor();
    if (width < 1024) await page.getByRole("button", { name: "All conversations", exact: true }).click();
    else await page.locator('nav a[title="Mail"]').click();
    await page.getByRole("link").filter({ hasText: "Tan question" }).click();
    await page.getByLabel("Message history", { exact: true }).waitFor();
    await until(page, async () => await page.getByLabel("Message history", { exact: true }).evaluate(panel => panel.scrollHeight - panel.scrollTop - panel.clientHeight < 2));

    await page.getByRole("button", { name: "New email", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "New email", exact: true });
    await editor.getByLabel("To", { exact: true }).fill("new@example.invalid");
    await editor.getByLabel("Subject", { exact: true }).fill("New appointment question");
    await editor.getByLabel("Message", { exact: true }).fill("😀".repeat(18000));
    await editor.getByRole("button", { name: "Send email", exact: true }).click();
    await editor.getByRole("alert").filter({ hasText: "too large" }).waitFor();
    assert.equal(mail.sends.length, 2, "An oversized UTF-8 JSON body must be rejected before any mail request");
    assert.equal(await editor.getByLabel("Message", { exact: true }).getAttribute("readonly"), null, "A rejected draft remains editable before a send attempt is created");
    await editor.getByLabel("Message", { exact: true }).fill("This is a disposable compose fixture.");
    await capture(page, output, `compose-${width}.png`);
    mail.nextSendPending();
    await editor.locator("form").evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    await editor.getByRole("alert").filter({ hasText: "still being sent" }).waitFor();
    await until(page, () => mail.sendIds.size === 2);
    assert.equal(mail.sends.length, 3, "Synchronous double submit must produce one new server call");
    await editor.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "New email", exact: true }).click();
    assert.equal(await editor.getByLabel("Message", { exact: true }).inputValue(), "This is a disposable compose fixture.");
    await editor.getByRole("button", { name: "Retry send", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    assert.deepEqual(mail.sends[2], mail.sends[3], "Closing and reopening an unconfirmed compose preserves its key and payload");
    assert.equal(mail.sendIds.size, 2);
    await page.getByLabel("Message history", { exact: true }).getByText("This is a disposable compose fixture.", { exact: true }).waitFor();
    if (width < 1024) { assert.equal(await page.getByRole("region", { name: "Email conversations", exact: true }).isVisible(), false); await page.getByRole("button", { name: "All conversations", exact: true }).click(); }
    else await page.locator('nav a[title="Mail"]').click();
    await page.getByRole("button", { name: "Sent", exact: true }).click();
    await page.getByRole("link").filter({ hasText: "New appointment question" }).waitFor();
    assert.equal(await page.getByRole("link").filter({ hasText: "Previous sent email" }).count(), 0, "Sent filter excludes pending/failed-only conversations");
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByRole("link").filter({ hasText: "Previous sent email" }).waitFor();
    await page.getByRole("link").filter({ hasText: "Previous sent email" }).click();
    await page.getByText("Sending not confirmed", { exact: true }).waitFor();
    await page.getByText("Not sent", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send reply", exact: true }).isDisabled(), true, "A pending/failed-only conversation must not invent a reply anchor");
    await page.getByText(/Older email is still importing/).waitFor();
    if (width < 1024) await page.getByRole("button", { name: "All conversations", exact: true }).click();
    else await page.locator('nav a[title="Mail"]').click();
    await page.getByRole("link").filter({ hasText: "Tan question" }).click();
    await page.getByRole("heading", { name: "Tan question", exact: true }).waitFor();
    await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
    await until(page, () => !!mail.threads[0].trashed_at);
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("link").filter({ hasText: "Tan question" }).click();
    await page.getByRole("button", { name: "Restore conversation", exact: true }).waitFor();
    await page.getByText("This conversation is in Trash.", { exact: true }).waitFor();
    assert.equal(await page.getByLabel("Reply message", { exact: true }).count(), 0, "Trash offers Restore instead of a reply editor");
    assert.equal(await page.getByText("Emails are deleted after 90 days.", { exact: true }).count(), 1);
    await page.locator("main").evaluate(panel => { panel.scrollTop = 0; });
    await capture(page, output, `trash-${width}.png`);
    await page.getByRole("button", { name: "Restore conversation", exact: true }).click();
    await until(page, () => !mail.threads[0].trashed_at);
    await page.getByRole("button", { name: "Move to Trash", exact: true }).waitFor();
    await page.getByLabel("Reply message", { exact: true }).fill("Replies work again after Restore.");
    await until(page, async () => !await page.getByRole("button", { name: "Send reply", exact: true }).isDisabled());
    assert.equal(mail.fixture.records.appointments.length, 1, "Moving and restoring mail cannot remove customer bookings");
    assert.equal(mail.fixture.records.appointments[0].status, "pending");
    mail.threads.splice(mail.threads.findIndex(thread => thread.id === uuid(9001)), 1);
    await page.getByRole("button", { name: "Check for mail", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "404" }).waitFor();
    assert.equal(await page.getByLabel("Message history", { exact: true }).count(), 0, "A purged/removed conversation must not leave cached private content visible");
    assert.equal(await page.getByRole("link").filter({ hasText: "Tan question" }).count(), 0, "A primary detail 404 must remove the missing conversation's cached list row");
    assert.deepEqual(remote, [], "Email must not fetch arbitrary message/attachment/remote HTML URLs");
    assert.deepEqual(errors, []);
    return { width, inboxBadges: true, exactReadArrivalRace: true, olderHistory: true, retentionPrunesCachedOlderMessages: true, purgedConversationClearsCache: true, safeText: true, attachmentBasenameAndBounds: true, ambiguousRetryOneSend: true, threadedReply: true, utf8BodyBoundLeavesDraftEditable: true, doubleSubmitOneSend: true, pendingComposeCloseRetry: true, responsiveListDetail: true, pendingFailedLabels: true, reconcileRetryAndMoreAvailable: true, reversibleTrashDisablesReplyUntilRestore: true };
  } catch (error) { await page.screenshot({ path: resolve(output, `failure-${width}.png`), fullPage: true }); throw error; }
  finally { await page.close(); mail.fixture.close(); }
}

async function unavailable(browser, output) {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
  const mail = await fixtureFor(page, { unavailable: true });
  try {
    await page.goto(`${url}#/inbox`, { waitUntil: "networkidle" });
    await page.getByText(/Mail is temporarily unavailable/).waitFor();
    await page.getByRole("button", { name: "Booking still available", exact: true }).waitFor();
    assert.equal(await page.getByTestId("inbox-badge").textContent(), "1");
    await page.getByRole("button", { name: "Accept", exact: true }).click();
    await until(page, () => mail.fixture.records.appointments[0].status === "confirmed");
    await capture(page, output, "mail-unavailable-booking-still-works.png");
    return { unavailableMailPreservesBookingInboxAndAccept: true };
  } finally { await page.close(); mail.fixture.close(); }
}

async function earlierPageRemoved(browser, output) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, timezoneId: "Europe/London" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const mail = await fixtureFor(page);
  const operation = `mail/conversations/${uuid(9001)}`;
  try {
    await page.goto(`${url}#/mail/${uuid(9001)}`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Tan question", exact: true }).waitFor();
    await page.getByLabel("Message history", { exact: true }).getByText("Arrived after the detail response", { exact: true }).waitFor();
    await until(page, () => mail.requests.filter(request => request.operation === operation && !request.query.cursor).length >= 3);
    const loadEarlier = page.getByRole("button", { name: "Load earlier messages", exact: true });
    await until(page, async () => !await loadEarlier.isDisabled());
    const before = mail.requests.length;
    mail.threads.splice(mail.threads.findIndex(thread => thread.id === uuid(9001)), 1);
    await loadEarlier.click();
    await page.getByRole("alert").filter({ hasText: "404: This conversation could not be found." }).waitFor();
    const detailRequests = mail.requests.slice(before).filter(request => request.operation === operation);
    assert.equal(detailRequests.length, 1, "The cache must clear on the older-page response without waiting for a primary refresh");
    assert.ok(detailRequests[0].query.cursor, "This regression must exercise the older-history cursor request");
    assert.equal(await page.getByLabel("Message history", { exact: true }).count(), 0, "A removed conversation's private history must disappear immediately after the older-page 404");
    assert.equal(await page.getByRole("heading", { name: "Tan question", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("Reply message", { exact: true }).count(), 0, "A removed conversation must not retain a reply editor");
    assert.equal(await page.getByRole("link").filter({ hasText: "Tan question" }).count(), 0, "An older-history 404 must remove the missing conversation's cached list row");
    assert.equal(await page.getByText("Arrived after the detail response", { exact: true }).count(), 0, "The missing conversation's cached preview must also disappear");
    await capture(page, output, "earlier-page-404-clears-cache.png");
    assert.deepEqual(errors, []);
    return { olderPage404ClearsCachedConversation: true, cursorRequestOnly: true, privateHistoryAndReplyEditorRemoved: true, cachedConversationRowAndPreviewRemoved: true };
  } catch (error) { await page.screenshot({ path: resolve(output, "failure-earlier-404.png"), fullPage: true }); throw error; }
  finally { await page.close(); mail.fixture.close(); }
}
async function until(page, predicate) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for mail fixture"); await page.waitForTimeout(30); }
}
