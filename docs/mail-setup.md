# Mail setup and operation

Mail uses the existing public customer Site and approved desktop device connection. Customer booking, diary, and finance workflows continue to use their existing data stores. Received/sent messages and read state are shared in the Site's D1 database; approved computers see the same inbox.

## Configured account

- Sender and receiving mailbox: `hello@tannedbyffy.co.uk`.
- Existing Resend Full access server key reused. No additional API key is required.
- Resend webhook: `https://tannedbyffy.co.uk/api/webhooks/resend`, enabled for `email.received` and `email.sent`.
- Webhook signing secret is stored as the secret `RESEND_WEBHOOK_SECRET` in Sites. Keep it out of Git, screenshots, and app code.
- `MAIL_RECEIVING_ADDRESSES=hello@tannedbyffy.co.uk` restricts imports to this mailbox. `RESEND_FROM`, `RESEND_API_KEY`, and `SITE_URL` retain their existing server configuration.
- Fasthosts apex MX: target `inbound-smtp.eu-west-1.amazonaws.com`, priority `10`. Receiving is enabled in Resend's Ireland region. Existing sending DNS records are preserved.

Changes to production environment settings need a Site deployment to take effect. Example values are in `customer-site/.env.example`; they are placeholders, not real credentials. Sites applies migrations 0008–0011 for conversations, messages, header aliases, reconciliation checkpoints, Trash, and minimal retired-send receipts. Migration 0012 activates the verified `hello@tannedbyffy.co.uk` contact address while preserving other business settings and any different custom contact address. The published contact section at `https://tannedbyffy.co.uk/help#contact` includes enquiries, booking, changes, and account-help guidance.

## Using Mail

Open **Mail** for All, Unread, or Sent conversations. **New email** sends a plain-text email. Open a conversation to read its history and reply. Reading marks only the displayed received messages as read, so an email arriving during that action remains unread. Inbox, Dashboard, and navigation badges use the same unread state. Matching existing customer contact addresses supplies the customer name; it does not grant account ownership.

**Move to Trash** removes the whole conversation from normal lists, Inbox, and unread badges on all approved computers. The **Trash** filter keeps its history and offers **Restore**. A genuinely new incoming reply returns a trashed conversation to the Inbox; replaying an already stored webhook does not. Restore before replying. Trash does not revoke or erase emails already delivered to other people, and there is no permanent-purge action.

Replies use the actual Message-ID, In-Reply-To, and References headers. Matching subjects do not merge conversations. Delivery copies sent to the business mailbox itself join the outgoing history using its matching Message-ID; customer-supplied duplicate IDs and conflicting references cannot merge unrelated histories. Future appointment notification emails appear in outgoing history and their replies join the same conversation. Password reset emails stay outside Mail because they contain authentication links.

**Check for missed mail** imports messages missed during webhook downtime, using saved pagination checkpoints. If more messages remain, check again after a minute. This is a bounded manual recovery action, not a background email sender. Resend API throttling/provider outages leave clear retryable states.

If a send's result is uncertain, use **Retry same send** with its frozen recipient, subject, body, and operation UUID. Do not compose another copy. Sending is recorded before contacting Resend and retries reuse the same provider idempotency key. After 23 hours an uncertain send must be checked against the provider log before creating another copy.

Incoming HTML is displayed as plain text; remote images/scripts are never loaded. Attachments are downloaded only on request through the authenticated server, then saved through the native file dialog. Downloads are capped at 15 MiB, filenames are sanitized, and files are not opened automatically. The app does not send attachments. Very large incoming text is capped at 200,000 characters; histories use bounded pages with **Earlier messages** available. Outgoing text allows up to 50,000 characters within a 64 KiB encoded request limit.

Emails older than 90 days are automatically deleted from D1, including Trash. Newer messages in the same conversation remain; empty conversations and their header aliases are removed. The Site's own server code performs cleanup with Site traffic, signed email webhooks, and authenticated Mail requests, with a shared hourly throttle. Normal Mail checks from the business app also trigger it. Codex is not required: the previously added **Ffyon mail retention cleanup** cloud task has been disabled. If the Site and app are completely idle and no mail arrives, cleanup runs on the next request rather than at a fixed wall-clock time. Only old send operation UUIDs and retirement timestamps remain, without content or addresses, to prevent an ancient retry sending another copy. Raw incoming HTML is transformed into displayed text rather than retained alongside it.

Parallel cleanup checks share one in-flight operation per Worker/database. A successful cleanup skips repeated local lease checks for an hour; another isolate's lease is rechecked after one minute. Failed cleanup clears this cooldown for an immediate retry. The shared D1 lease remains authoritative, and this optimization caches no customer content or device authorization.

Provider-hosted attachment downloads and recovery of previously missed messages depend on Resend's retention window (currently 30 days; see https://resend.com/security). Old desktop exports/backups do not contain this shared Mail store.

## Security and verification

The webhook verifies the untouched raw request using the official Resend SDK and Svix signature headers before fetching content or accessing storage. Duplicate deliveries are idempotent; failed storage/content retrieval returns 503 for provider retries. Mail admin routes require an approved device; the native bridge only allows explicit paths, methods, UUIDs, and bounded queries on its fixed HTTPS origin.

API keys, webhook secrets, HTML, private provider URLs, and internal retry details are not returned to the webview. Attachment URLs require the exact HTTPS Resend inbound CDN host and reject redirects. Revoked/changed credentials and lost online authorization prevent response delivery. Native requests use a bounded 30-second timeout with a 10-second connection limit. An old transport failure cannot overwrite a newer successful connection check; authoritative revocation still locks access and prevents an older session response reopening it.

Run `npm test` in the desktop repository for business regressions and the disposable Mail backend suite; run `npm run build` for the app. `tests/mail-browser.js` exercises the UI with mocked native calls and no provider mail. The Site's `npm run test:bridge`, calendar/reset/runtime fixtures, TypeScript, build, and dependency audit cover the shared backend. Native routing tests live in `src-tauri/src/access.rs`. Automated provider tests are mocked and consume no email allowance.

Setup validation passed 122 app tests, including 49 Mail backend tests; 42 native routing/security tests; and the Site's 383 bridge plus 28 authentication checks. App and Site production builds passed, as did browser fixtures at 1280, 375, and 320 pixels. Live public checks confirmed approved-device enforcement, rejection of unsigned webhooks, acceptance of a valid signed webhook, and the published contact email link. Dependency audits reported no production vulnerabilities. Retention coalescing also passed an actual local workerd check across a background request and eight concurrent requests. See `docs/mail-evidence/validation.json` for the build hash and deployment references.

Initial version 0.5.8 native verification used exactly two self-addressed emails: one compose and one reply. Sending, receiving, Inbox/Mail unread badges, reading from the Inbox link, Trash history, and restoration passed without changing customer appointments or finances. This revealed a self-mail history split and an old-request connection recovery race; future imports and the connection race were fixed at that time. The initial executable launched and exposed the authorized Dashboard, but Windows locked before its final foreground Mail check; the user instructed finishing without another unlock. Attachment saving and provider outage cases have fixture coverage; they have not been exercised with a real incoming attachment. See `docs/mail-evidence/native-mail.json` for that historical evidence.

## Conversation grouping and sync follow-up (0.5.9)

The Mail list has one row per conversation with a message count; opening it displays the entire retained history with older-message pagination. Existing split self-mail histories are repaired in the Site's background using exact email identities. Old links, read acknowledgements, Trash actions and frozen send retries resolve to the canonical history. Concurrent incoming messages and replies resolve the redirect in the same transaction as their insert, preserving every message without reopening the old history. Subject-only grouping is deliberately excluded.

The sync response previously awaited up to two booking email sends (six seconds each), plus header recovery (eight seconds each) and sequential database work. It could approach the native 30-second deadline before delivering the schedule. Delivery now runs through the Site's request-scoped `waitUntil` context with durable, idempotent retries. Outbox maintenance is batched, notification counts share the sync batch, and warm sync makes two foreground database calls instead of eight. Heartbeat throttling preserves fresh authorization/revocation checks. App focus events share one refresh wave, unread loads do not overlap, and unchanged Mail configuration is fetched only on mount/reconnect or explicit settings Retry. These changes preserve post-write sync ordering.

Automated checks use disposable databases, blocked provider fixtures, and desktop/phone browser fixtures; this follow-up sends no real emails. Current build/deployment and live verification are recorded separately in `docs/mail-evidence/grouping-sync.json`. The latest executable remains `src-tauri/target/release/ffyon-tracker.exe`; this build does not replace the installed app.
