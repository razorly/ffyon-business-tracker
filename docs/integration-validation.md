# Integration Validation: 0.5.1

## Verified

- `npm test`: 36 disposable integration tests execute the actual desktop data and sync modules against SQLite using the native migration SQL. Coverage includes discounts and immutable quotes, confirmed manual/date-only entries, optional saved addresses, retained anonymized payments, deletion/import races, lost responses, atomic authoritative backup restore and the earlier payment/authorization regressions.
- `cargo test --lib` in `src-tauri`: 23 native tests cover migration v7 and safety copies, metadata-less legacy databases, approved-device locks and signed leases, restricted SQL, bounded postcode lookup and fixed-origin directions.
- `npm run test:bridge` in the separate customer Site: 252 integration checks and 28 authentication checks execute actual HTTP route handlers with ephemeral credentials, signing keys and transactional D1-compatible SQLite. Coverage includes remote/date-only/manual/series/import bookings, nonblocking all-day entries, filtered dates, discount snapshots, private settings, legacy receipt compatibility, notification deduplication/retries/suppression/rate limits and silent destructive deletion.
- Production frontend typechecking and builds pass for the app and Site. The desktop release excludes browser SQLite fixtures. The final Windows MSI and NSIS installers and updater signatures build successfully at 0.5.1, including the guest-client conflict/retry fix.
- Read-only security review found no remaining blocking issue in the final source. Private device and server credentials remain in their existing native/hosted stores; no connection secrets were added to public source.
- Public Site version 10 deployed successfully from source commit `098dcfaf7470966a7f03461ac0861e2eb3f458f7` at `https://ffyon-customer.razorly.chatgpt.site`. Hosted configuration revision 4 and its signing/Resend secrets were unchanged. The final Windows release binary's `--ffyon-check` returned `online` with exit code 0 against this deployment. Public catalogue and date-range availability GETs returned HTTP 200, included discount fields and did not expose admin notification settings; booking remained disabled.

## Browser Evidence

`tests/features-browser.js` is an opt-in, loopback-only runner. Install Playwright separately or set `FFYON_PLAYWRIGHT_PATH`; optional `FFYON_BROWSER_CHANNEL` selects the browser. Set `FFYON_FEATURES_ROOT_URL` and/or `FFYON_FEATURES_SITE_URL`, then run `node tests/features-browser.js`.

Desktop checks at 1280px, 375px and 320px use isolated native-IPC fixtures with actual in-memory SQLite migrations, never a production unlock flag, OS credential or real business database. They cover remote request maps, manual remote/date-only entries, all-day calendar and needs-time highlighting, direct confirmation without the Requests inbox, service discounts, retained historical quotes, destructive booking/client deletion with preserved payments and retrying a conflicted new-client booking without duplicate clients.

The real OpenStreetMap provider rendered at all three desktop widths after an explicit click. Tile responses returned HTTP 200 and decoded 256px images; screenshots show streets, the postcode marker and attribution. No full customer address is sent for the embedded postcode map. Directions require a separate explicit action.

Customer checks at 1280px, 768px, 375px and 320px use mocked catalogue/availability/profile responses and disposable deletion HTTP fixtures. They cover unavailable dates disabled before selection, mandatory remote address/postcode, explicit saved-address consent/reuse, date-only booking and reschedule, visible discounts and explicit review of price changes, account/security forms and physical account/appointment deletion confirmations.

All viewports passed page/form/control overflow checks with no page errors. Final map, booking, all-day calendar and deletion screenshots were visually inspected. Evidence and screenshots remain in ignored `test-results/features-browser/`; the earlier integration runner remains in `tests/browser-smoke.js`.

## Boundaries

- Browser fixtures do not prove native macOS behavior. Keychain integration and the universal Mac target remain implemented, but an Intel/Apple Silicon build, launch, Keychain approval and pairing smoke test must still run on a Mac. No Mac installer was built on Windows.
- No production customer accounts, appointments, service edits, financial test entries or notification emails were created. Resend delivery, templates, failure handling and suppression were checked using disposable fixtures, not a real customer inbox.
- Email retries are activity-driven by subsequent site/app requests; there is no autonomous idle scheduler. Indeterminate delivery stops before Resend's 24-hour idempotency retention expires. Disabling admin notifications or changing recipients suppresses stale unsent messages. Already-sent emails cannot be recalled.
- Online booking remains disabled until the owner reviews prices, durations, hours and imports. Admin request emails remain disabled until a valid recipient is saved and the toggle enabled. Finances and private staff notes remain per-device.
- Deletion cannot automatically erase exported backups or native migration safety copies. Handle those separate copies according to the business's retention policy. Restoring shared backups requires a current authoritative online snapshot and cannot resurrect deleted shared identities.
- Public source can be modified by its downloader. The official application locks unapproved installations, and server-side device authentication protects the real shared data independently of the frontend gate.
- No desktop Git tag or GitHub release workflow was created/run for this delivery. The existing manual release workflow itself creates a tag, so it was not used. Signed Windows installers are local artifacts.
- Large frontend chunk and ineffective dynamic-import warnings remain non-fatal build warnings.
