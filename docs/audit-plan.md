# Booking site and business app audit — 2 October 2026

Customer goal: choose a spray tan and a UK date/time, review the price/location, and send one request. Owner goal: approve requests, see the diary, and record/report actual business income and expenses.

## Fix plan

| Priority | Finding | Resolution and evidence |
| --- | --- | --- |
| High | An in-flight sync may predate a successful booking change | Wait for that read, then fetch a fresh post-mutation sync; race regression |
| High | Backups read separate tables while payments/sync can change them | One native transactional read batch; restore validation |
| High | An old payment undo can detach a replacement receipt | Expected-receipt guards and transactional affected-row assertions |
| High | Load errors look like empty/zero totals; stale results appear across dates/clients | Clear keyed loader state, report failures and offer retry |
| High | Forms can submit stale initial data or be changed/closed during a save | Loading and mutation guards; bounded customer network requests |
| High | Customer draft addresses/notes survive account changes/sign-out | Account-bound, two-hour drafts; clear on sign-out/deletion; privacy regressions |
| High | A stale customer tab can save an old profile after another account signs in | Bind reads and mutations to the rendered account; reject mismatched sessions, clear stale views and remount account-bound components |
| High | A native network response may complete after its approved-device credential is replaced | Compare credentials and re-check access after the response; stale failures cannot revoke a replacement credential |
| Medium | Spreadsheet cells can execute customer-supplied formulas | Neutralize CSV text and keep numeric cells numeric |
| Medium | Backup pruning may match unrelated user files; partial writes can replace good exports | Exact dated filenames and atomic writes |
| Medium | Date/duration/time input validation accepts impossible records | Strict calendar and minute bounds; local data regressions |
| Medium | Diary navigation and keyboard/dialog handling impede routine work | Direct date jump, month booking date fixes, focus management and accessible client/day controls |
| Medium | A scrollable date-change fieldset can draw/hit-test over its dialog footer | Put the disabled fieldset inside a clipping scroll container; verify Back receives taps at desktop and phone sizes |
| Medium | Device timezone and an open app crossing midnight can select the wrong business day | Shared London clock for dashboard, diary, entry defaults and tray; focus/minute refresh and timezone regressions |
| Medium | Dashboard does not expose today's diary or approval work | Today's appointments and Inbox actions beside business totals |
| Medium | Catalogue/availability reads repeatedly execute legacy setup writes | Share successful initialization per database/isolate, retry failures; group reservations by date |
| Medium | Exhausted IP limits still create arbitrary email rate-limit keys | Check atomic IP budget before email-key insertion |
| Medium | Customer reschedule recovery misidentifies date-only saves | Compare normalized time and time-confirmation state |
| Medium | Dependency audit flags outdated Site packages | Apply patched compatible versions; repeat dependency audit/build |
| Medium | Rust lockfile contains a yanked yoke-derive patch | Update only yoke-derive 0.8.3 to 0.8.4; no advisory suppressions |
| Medium | Password-reset links use an older deployment origin | Configure the current public business domain |
| Medium | Unexpected server diagnostics can contain database/customer details | Generic API failure responses and error-class-only logs; uncached API responses and privacy headers |
| Efficiency | SheetJS loads on every desktop startup | Load export library only when exporting |
| Efficiency | All desktop pages and charts ship in the entry bundle | Lazy route loading; keep navigation present during page loading |

## Final review gates

Run app data/integration and native security tests, site account/bridge tests and new regressions. Build both products. Review actual diffs for financial semantics, auth/CSRF, privacy deletion, retry/idempotency, quotes, overlap/time-off, errors, midnight/timezone behaviour, keyboard access, responsive layout and startup payload. Check the visible local booking flow and owner workflow using disposable fixtures. Publish the audited site to its existing public audience and verify deployment status.

Recorded payments remain distinct from quotes, approvals, cancellations and no-shows. No tests should create production customer bookings or send customer email. Native OS credentials, real mail delivery and the installed desktop experience must be reported separately from mocked browser evidence.

## Completed validation

- App: 73 JavaScript tests and 33 native Rust tests passed. Native tests include atomic file replacement/read snapshots, authorization and credential-response guards, and transactional affected-row failures.
- Site: 383 bridge/integration checks plus 28 authentication checks passed against real HTTP handlers and disposable SQLite/D1 fixtures. Added stale-tab read/profile/booking/password/logout/deletion isolation, unchanged setup polling, setup failure/retry, and atomic IP-budget regressions. Draft/API timeout regressions passed.
- Browser: owner UI, features, Inbox and catalogue suites passed at 1280, 375 and 320 pixels. The new owner tests run in an America/Los_Angeles device timezone and exercise London dates, focus handling, paid cancellation/restore, exactly-once payments, loader isolation and failure/retry.
- Customer visual checks: local spray-tan/date/time/review/request success, one visible request in history, phone layout without horizontal overflow, and desktop/phone date-dialog Back preserving the saved appointment. The footer receives the tap instead of an underlying calendar/time option.
- Both TypeScript checks and production builds passed. Windows release executable rebuilt with final frontend assets and the updated Rust lockfile. The app entry bundle is about 265 KB (82 KB gzip), with shared layout/sync chunks; charts and the 492 KB export library are separate chunks. This is bundle-size evidence, not a measured native startup-time claim.
- Complete npm dependency audits for both repositories report zero vulnerabilities. RustSec checked 575 locked packages against 1,288 advisories: zero security vulnerabilities and no yanked package after the patch.
- Password-reset payload, calendar export, and Cloudflare mail-runtime checks passed without sending external mail. Reset links now use https://tannedbyffy.co.uk in the published environment.

Evidence is preserved under `docs/audit-evidence/`. Automated browser suites use disposable IPC/SQLite fixtures; their screenshots were visually reviewed. Native WebView2 interaction, OS credential storage/notification behaviour and actual inbox delivery were not exercised in this audit. No production customer bookings or financial records were used as test data. The built executable is a local artifact; the installed copy has not been replaced or published through the signed desktop updater.

## Upstream dependency warnings

RustSec reports five unmaintained UNIC 0.9.0 crates transitively required by Tauri's urlpattern. There are no patched releases or reported security vulnerabilities for those maintenance advisories. The glib 0.18.5 iterator-unsoundness advisory and proc-macro-error maintenance advisory are Linux-only dependency paths; dependency-tree checks confirm neither is present in supported Windows x64/macOS builds. No advisories were suppressed. Details and platform checks are in the saved Rust audit evidence.

The second review covered customer/admin authorization, CSRF/origin handling, isolation/deletion/tombstones, quote snapshots, diary capacity/time off, stale and ambiguous writes, payments/Undo/backups, failed loads, navigation, responsive controls and keyboard/focus access. Identified actionable issues in these paths have been fixed and the applicable regression/build checks pass.

## Published result

Site version 19 is published successfully to the existing public audience at https://tannedbyffy.co.uk. Source commit: `12fcad6c253ba7280a5a6a5e5cadb199f40b4105`; deployment uses environment revision 5. Source/archive provenance and the desktop executable checksum are recorded under `docs/audit-evidence/`.

Desktop app version 0.5.8 is prepared with the audit fixes. The version is consistent across npm, Cargo and Tauri manifests and lockfiles. All 73 JavaScript tests and 33 native Rust tests passed again, and the production Windows executable was rebuilt with its checksum updated. Release tagging and publishing are deferred.

The audit-tool compilation folder `C:\Users\rober\AppData\Local\Temp\ffyon-cargo-audit-build` remains. Its exact path and ordinary-directory status were verified, but automatic approval review rejected its removal with only “blocked by policy.” The installed official cargo-audit tool and all reports were preserved.
