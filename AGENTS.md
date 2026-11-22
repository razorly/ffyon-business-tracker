# Tanned by Ffy Business Tracker

- The Windows/macOS app is Tauri with native commands under `src-tauri/`. The iPhone app is a Home Screen PWA. Both use the React frontend in `src/` and the same business logic. `npm run build` builds the desktop frontend, and `npm run build:pwa` builds the web frontend and its server runtime dependency into `pwa/dist/`.
- Use Node 24 for PWA builds, the PWA server and the full JavaScript test suite. Run `npm test` for the JavaScript tests. For the iPhone-style browser flow, build the PWA and run `node tests/pwa-browser.js` with Playwright WebKit and OpenSSL available. The fixture uses loopback HTTPS and disposable records. It exercises the web UI and the desktop ledger API without writing live business data.

## PWA deployment

- Production runs at [ffyon.home](https://ffyon.home/) in the `ffyon` namespace on the home k3s cluster, with Traefik and the home CA. Use the `install-k3s-home-app` skill for cluster access when available and follow the build, bundle and deploy instructions in [docs/ios-pwa.md](docs/ios-pwa.md). The deployment script uses an immutable bundle ConfigMap and waits for rollout and TLS readiness. Keep the archive below the ConfigMap limit and outside `pwa/dist/`.
- Preserve the `ffyon-ledger` NAS claim and `ffyon-session` Secret across updates. They hold encrypted ledger and push state and the key material needed to open it. The desktop accepts the home endpoint through the bundled public CA certificate. Keep credentials and private keys out of source and deployment artifacts.
- Approve the phone using the existing device pairing flow. iPhone Web Push requires a Home Screen installation and user opt-in. The server checks Today's booking requests and payments, and Mail, even while the app is closed. Push payloads contain counts and app links. A WebKit fixture can verify opt-in and fallback handling. Apple delivery needs a subscribed physical device.

## Business data

- Booking, customer contact and mail records use the existing hosted admin API. Finances and private staff notes sync through the home cluster ledger using revision-checked SQLite snapshots. Client notes belong to `clients.notes`. Customer booking notes and private appointment notes have separate fields. Keep staff notes out of website writes, mail and push payloads.
- Reuse the existing ledger adapter in `src/lib/shared-ledger.ts` and sync flow in `src/lib/sync.ts`. Keep older device copies and migration review intact. Check for stale notes before saving, preserve private fields during site sync, and keep client deletion and account linking consistent with the existing rules.

## Releases

- For a desktop release, keep `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json` on the same version. Pushing the `v<version>` tag runs `.github/workflows/release.yml`. Wait for both Windows and universal macOS jobs, verify the installer and updater assets, then publish the draft and confirm the public updater manifest serves the new version.
- The PWA is deployed separately from GitHub Releases. After deploying, verify the live build and `/healthz`, and check that the ledger and push APIs require a paired device.
