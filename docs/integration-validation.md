# Integration Validation: 0.5.0

## Verified

- `npm test`: 16 disposable integration tests execute the actual desktop data and sync modules against SQLite using the native migration SQL. Includes payment atomicity, quote preservation, restore rollback, durable retry and account-alias recovery.
- `cargo test --lib` in `src-tauri`: 16 native tests cover fresh-download locks, device-bound signatures, expiry, frozen clocks, persistent revocation/rollback, failed secure storage, restricted SQL and legacy upgrades with safety copies.
- `npm run test:bridge` in the separate customer Site: 108 bridge checks and 28 account checks exercise the actual HTTP route handlers with ephemeral in-memory credentials, signing keys and D1-compatible transactional SQLite.
- Site migrations 0003 and 0004 applied successfully to the local Wrangler database. Existing profiles and booking quotes survive migration; the local Worker returned its active catalogue with booking disabled.
- Production frontend typechecking and builds pass. Release bundles exclude the browser SQLite fixture. Windows MSI and NSIS bundles and their updater signatures build successfully.
- The public Site version 9 deployed successfully from source commit `a0be004287edf6e8a2382255f4368f9110ea0d05`, with its hosted signing/bootstrap configuration. Native Windows bootstrap and subsequent session verification both returned online status, validating the pinned public key against the hosted signer.

## Browser Evidence

`tests/browser-smoke.js` is an opt-in, loopback-only runner. Install Playwright separately or point `FFYON_PLAYWRIGHT_PATH` to an available installation. Set `FFYON_BROWSER_ROOT_URL` for the desktop preview and `FFYON_BROWSER_SITE_URL` for the Site preview, then run `node tests/browser-smoke.js`. The optional `FFYON_BROWSER_CHANNEL` selects the installed browser.

Desktop checks use an isolated native-IPC fixture with actual in-memory SQLite migrations, never an app unlock flag, OS credential or real business database. At 1280px and 375px, the checks cover locking, approval/rejection, both reschedule decisions, service edit/archive, retained historical quotes, offline restrictions, client profiles and removal of already-loaded records on a lock event. Screenshots were inspected for text collisions and overflow.

Customer checks include a real migrated local Worker showing the closed catalogue and disabled booking flow, plus mocked live catalogue/availability responses at 1280px, 768px, 375px and 320px. Changing a service from GBP 27.50/45 minutes to GBP 29.25/60 minutes requires explicit review; the original draft quote stays unchanged until accepted. Screenshots remain in ignored `test-results/browser-smoke/`.

## Boundaries

- Browser fixtures do not prove native macOS behavior. Keychain integration and the existing universal Mac release target are implemented, but a native Intel/Apple Silicon launch, Keychain approval and pairing smoke test must still run on a Mac.
- No production customer accounts, appointments, service edits or financial test entries were created. Production verification only provisioned the intended Windows admin device and checked its authorization.
- Online booking starts disabled. Review real prices, durations, hours and selected legacy imports before enabling it. Finances and private staff notes stay per-device; only the shared business records synchronize.
- Public source can be modified by its downloader. The official application locks unapproved installations, and server-side device authentication protects the real shared data independently of the frontend gate.
- Large frontend chunk and ineffective dynamic-import warnings remain non-fatal build warnings.
