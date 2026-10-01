# Money In Validation

Version 0.5.5 simplifies New entry > Money in to non-appointment income.

## Behavior

- Money in opens directly on Other income, with a blank amount. There is no Payment for selector, service selector or appointment-payment picker.
- Income type still offers configured non-treatment labels. The submit action is Record income; the Clients shortcut uses the same name.
- Appointment creation and payments remain in the appointment form and Inbox. Switching to Appointment carries the date and client, not the financial amount; the service is chosen in the appointment form.
- Existing payments retain saved amounts, names and attribution. Unlinked historical entries can be explicitly corrected using a single grouped Income type selector. Linked appointment payments keep their booked service attribution.
- No schema migration or credential change is required.

## Evidence

- `npm test`: 65 tests passed.
- `cargo test --lib`: 27 native tests passed.
- `npm run tauri build`: production TypeScript/Vite and Windows release build passed; MSI and NSIS installers and updater signatures were generated for 0.5.5.
- Catalogue, booking-feature and Inbox browser suites passed at 1280, 1024, 800, 640, 375 and 320 pixels. The catalogue suite also passed in dark mode at 1280 and 320 pixels.
- Browser checks verify the Other income default, blank amount, absent service/appointment payment choices, income creation without a booking, custom income labels, carried booking date/client, saved-quote appointment payments, historical corrections without repricing, and exactly-once Inbox payment confirmation.
- Dark-mode Money in screenshots at desktop and 320 pixels were visually inspected. There were no page errors or horizontal overflow. Reports and screenshots are under `test-results/catalogue-browser`, `test-results/catalogue-browser-dark`, `test-results/features-browser` and `test-results/inbox-browser`.

## Limits

Browser validation used disposable SQLite with actual native migrations and mocked approved-device IPC. No production database, customer, booking, hosted Site setting, email or credential was changed. Feature-suite map network access was deliberately stubbed; map handling is unchanged. Native WebView2, OS notification delivery and macOS packaging/Keychain were not exercised. No installer was installed over the running business app. No release tag, push or Site deployment was performed.
