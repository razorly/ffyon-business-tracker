# New Entry and Inbox Validation

Version 0.5.4 adds the appointment option to New Entry and renames Requests to Inbox. Existing `/requests` bookmarks redirect to `/inbox`.

## Behavior

- New Entry opens the existing full appointment form, carrying the selected date, client (including an unsaved name) and active service. Cancelling creates no client, booking or payment. Financial entry editing has no appointment-creation option.
- Manual bookings stay confirmed and out of the requests section. Their existing home-visit, saved-address, date-only and repeat controls remain available.
- Payment confirmations include only completed confirmed bookings with no linked payment and a positive or unknown quote. Timed bookings become eligible at their saved start plus duration; date-only bookings become eligible the following day, using the Europe/London clock independently of the device timezone.
- Pending, rejected, cancelled, no-show, future, in-progress, paid and free appointments are excluded. The Inbox badge counts distinct appointments across both sections.
- Confirm paid uses the saved quote as a suggestion, accepts the actual amount received, and reuses the atomic exactly-once payment action. An unknown quote requires an amount. No shared booking mutation or customer email is sent.
- Desktop reminders are count-only, enabled by default, and remembered per approved device after successful OS submission. Repeated syncs/restarts do not repeat a delivered reminder. The local Settings toggle does not disable the Inbox badge or lists.
- The reminder clock checks every minute while the app is running, including when hidden, and checks on focus/visibility changes. Offline reminders use the cached diary. Native notification submission rechecks the approved-device authorization; no credentials or capability grants were added.

## Automated Evidence

- `npm test`: 65 passing tests, including actual native migration SQL applied to disposable in-memory SQLite and production TypeScript modules.
- `cargo test --lib`: 27 passing native tests.
- `npm run build`: production TypeScript/Vite build passed. Existing chunk-size and mixed static/dynamic import warnings remain.
- `tests/features-browser.js`, `tests/catalogue-browser.js` and `tests/inbox-browser.js`: all passed at 1280, 1024, 800, 640, 375 and 320 pixels, using disposable IPC/SQLite fixtures only.
- Browser checks cover appointment creation without income, carried booking defaults, cancellation without writes, financial editing separation, home visits, date-only calendar behavior, retained quotes/history, request/payment separation, eligibility exclusions, badges, actual payment amounts, rapid double submission, unknown-price validation, notification deduplication and persisted Settings preferences.
- Notification unit tests cover denied permissions, retry after native rejection, locked/unidentified devices, cancellation during permission lookup, unavailable storage, new/rescheduled bookings, and explicitly undone payments.
- Screenshots and JSON reports are generated under `test-results/features-browser`, `test-results/catalogue-browser` and `test-results/inbox-browser`. Desktop and 320-pixel screenshots were visually inspected; forms and controls had no horizontal overflow or page errors.

## Limits

No production database, customer account, booking, hosted Site setting or email was changed by validation. Map network access was deliberately stubbed in the feature browser run; this release does not change map handling. Native Windows/macOS OS notification delivery and macOS Keychain integration were not exercised on real approved devices. A Windows build does not produce or validate a Mac package. No installer was installed over the running business app.

Allow Ffyon notifications in the operating system and keep the installed app running in the tray/menu bar. See [Admin setup](admin-setup.md) for macOS/Windows permissions and existing credential setup. No new connection secret or Site deployment is required.
