# Shared Catalogue Validation: 0.5.3

## Scope

Services supply the website and desktop treatment catalogue. Booking quotes and payment amounts remain separate snapshots. Other income and expense categories are retained without duplicate treatment pricing. This desktop-only change needs no hosted deployment or new credentials.

Migration 8 preserves old labels and amounts, reuses explicit links, and leaves unmatched legacy labels for review. Backup format 4 accepts older formats 1-3. Account/appointment deletion remains silent and retains anonymized financial history. Native device authorization and Windows Credential Manager/macOS Keychain are unchanged.

## Reproduction

Validation on Windows with Edge:

- 47/47 JavaScript integration tests and 27/27 native Rust tests pass. Typechecking and the production frontend build pass.
- Both the catalogue and existing desktop feature suites pass at 1280, 1024, 800, 640, 375 and 320px, with no page errors. Form controls and dashboard content remain within their bounds.
- Catalogue checks cover a single service source, discounted defaults with editable actual amounts, standalone payments without new bookings, exactly-once appointment payment, explicit legacy review, archived/renamed service history, source correction and separate other-income/expense reports.
- Tray payloads contain active services at discounted prices with string IDs, never archived services or duplicate income labels. Native ID parsing and authorization tests pass.
- Area, bar and pie chart geometry is nonzero and stable before screenshots. Full income of GBP 12,412.89 and profit of GBP 10,036.22 fit summary containers at every width. A live 1280-to-1024-to-320-to-1280 resize verifies currency values fit and recover their original font size when widened.
- Existing remote/date-only/manual booking, notification settings, map permissions and privacy deletion checks pass using offline map fixtures. No production records or credentials were accessed.
- `npm run tauri build` produced the 0.5.3 Windows x64 NSIS and MSI installers with both updater signatures. This was a local build, not a GitHub release or new tag. No Mac package was built on Windows.

Ignored browser reports and screenshots are in `test-results/catalogue-browser/` and `test-results/features-browser/`.

```powershell
npm test
npm run build
cargo test --lib --manifest-path src-tauri/Cargo.toml
```

The browser suites use the actual native SQL migrations in isolated in-memory SQLite databases and simulated authorized IPC. They do not read or alter the installed business database, OS credential store or hosted records.

```powershell
npm run dev -- --host 127.0.0.1 --port 5188 --strictPort
# In a separate terminal, point FFYON_PLAYWRIGHT_PATH at the Playwright module.
$env:FFYON_BROWSER_CHANNEL = 'msedge'
$env:FFYON_CATALOGUE_ROOT_URL = 'http://127.0.0.1:5188'
node tests/catalogue-browser.js
$env:FFYON_FEATURES_ROOT_URL = 'http://127.0.0.1:5188'
$env:FFYON_FEATURES_MAP_OFFLINE = '1'
node tests/features-browser.js
```

## Boundaries

Browser fixtures exercise desktop frontend behavior, not a native WebView or macOS menu/Keychain interaction. A universal Mac build and native Mac testing require a Mac. Offline map fixtures avoid additional tile traffic; live map/referrer evidence belongs to the earlier [map validation](map-validation.md).
