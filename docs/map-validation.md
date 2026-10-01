# Desktop Map Patch: 0.5.2

## Change

The OSM embed previously used an opaque sandbox origin and a `no-referrer` navigation policy. The reported 403 tiles are consistent with missing request identification, which the [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) requires for browser requests.

The frame now retains its external OSM origin with `allow-scripts allow-same-origin`, and its initial navigation uses `strict-origin-when-cross-origin`. OSM remains cross-origin to the application. No remote native capabilities, parent navigation, credential access or new connection secrets were added. The map still loads only after an explicit click and contains postcode-area coordinates, not the visit address.

Request actions now sit below the details, so they cannot squeeze the map into a narrow column in a desktop window. This is independent of viewing the desktop over phone RDP.

## Verification

- `npm test`: 36/36 desktop integration checks pass.
- `cargo test --lib`: 23/23 native checks pass.
- Typechecking and the production frontend build pass.
- `npm run tauri build` produced the 0.5.2 Windows x64 NSIS and MSI installers and both updater signatures. No release workflow or new Git tag was used.
- The opt-in `tests/features-browser.js` suite passes in Edge at 1280, 1024, 800, 640, 375 and 320px with an isolated map fixture. It verifies frame permissions, map width, explicit postcode-only lookup, manual remote/date-only entries, nonblocking all-day display, request separation, discounts and destructive deletion with retained payments. No page/form overflow or page errors were observed.
- A separate live-provider check at 1024px passes after one explicit map click using a public landmark postcode. All six visible raster tiles returned HTTP 200 and decoded to 256x256 images. Their referrer was the OSM embed URL with only its existing bounding-box/layer/marker parameters. The final screenshot visibly shows streets, a marker and attribution, not a 403 tile. No automated panning, zooming or bulk tile fetching was used.
- The browser runner now fails on unsuccessful or visually blank provider rendering, and waits for the asynchronous selected-customer form reset before testing salon or remote controls.

Ignored evidence: `test-results/features-browser/map-layout-evidence.json`, `map-provider-evidence.json` and the `admin-postcode-map-1024.png` screenshot.

Reproduction: run a loopback Vite server and set `FFYON_FEATURES_ROOT_URL`, `FFYON_PLAYWRIGHT_PATH` and optionally `FFYON_BROWSER_CHANNEL=msedge`. Use `FFYON_FEATURES_MAP_OFFLINE=1` for the multiwidth fixture suite; omit it and set `FFYON_FEATURES_WIDTHS=1024` for one live map view.

## Boundaries

Browser checks use disposable in-memory SQLite and simulated authorized IPC, not the real business database or credentials. They do not prove rendering inside the installed Windows WebView2 or macOS WKWebView; the user should check the updated native app. No Mac build was performed on Windows. OSM is a best-effort external service and can impose independent network or service blocks.

No production bookings, accounts, services, settings or credentials were changed for this patch. The customer Site requires no redeployment for this desktop change.
