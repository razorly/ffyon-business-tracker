# Tanned by Ffy on iPhone

1. Connect the iPhone to the home network and open [ffyon.home](https://ffyon.home/) in Safari. If the iPhone needs the **Rob Home Root CA**, install the home certificate profile and enable it under **Settings → General → About → Certificate Trust Settings**.
2. In Safari, choose **Share → Add to Home Screen**. Enable **Open as Web App** if shown, then tap **Add**.
3. Launch **Tanned by Ffy** from the new icon. On an approved computer, open **Settings → This computer → Site Connection → Add Device**. Enter the resulting ten-minute code and a name for the iPhone.

## Shared finances and private notes

Update each desktop app to 0.7.0 or later, and open it and the iPhone app on the home network. Approved devices join the shared ledger automatically. The first device with existing records starts it. Later devices add distinct entries and fill matching notes where the shared note is still blank. Copies of the same entry are counted once. Earlier records that may duplicate, reverse or overwrite a change stay on the original device and appear under **Review records**.

Changes and deletions made in the shared ledger appear on all connected devices. Kept copies of earlier data cannot recreate a recorded deletion. The earlier apps kept separate ledgers and only stored the records that survived on each device. A deletion made before the upgrade may leave no history to identify it.

Open **Review records** on the device that shows the notice. Use **Add to appointment note** to recover a private note on its matching appointment, or **Add to client notes** if the appointment is missing and the client is linked. Existing shared notes are kept. You can also **Copy note** or **Dismiss review**, which clears the notice for that record and keeps the original device copy.

Shared records require access to the home network and online verification. The previous device ledger is kept for migration review. **Settings → This device → Shared ledger backup** saves a separate copy of the shared records to Files.

Open **Clients**, select a client, and choose **Add notes** or **Edit notes** in **Client notes**. Saving an empty note clears it across approved devices. Staff notes are stored in the shared ledger. If another device changes the note while you are editing, the app keeps your draft and asks you to reopen the latest version.

## Push notifications

Open the Home Screen app on iOS 16.4 or later. Go to **Settings → This device → Push notifications**, tap **Enable push notifications** and allow the iPhone prompt.

The cluster checks for new booking requests, payments to confirm and unread mail about once a minute, even while the app is closed. Alerts show counts and link to **Today** or **Mail**. Payment alerts start when the shared ledger is available. The current queues stay visible in the app when you first enable alerts. Enable notifications separately on each iPhone.

## Deployment

Use Node 24 and run these commands from the repository root. Keep the archive outside `pwa/dist`.

```sh
npm ci
npm run build:pwa
tar -czf ffyon-pwa-bundle.tar.gz -C pwa server.mjs ledger.mjs encrypted-json.mjs push.mjs push-alerts.mjs dist
```

Copy the archive and the three files in `pwa/k3s` to a staging directory on a host with the home cluster's kubeconfig. Run `sh deploy.sh ffyon-pwa-bundle.tar.gz` there. The script validates the manifests against the cluster, uploads a versioned bundle and waits for rollout and the home TLS certificate. Redeploy using the same procedure. Existing bundle ConfigMaps allow Kubernetes rollout undo while those ConfigMaps are retained.

The `ffyon/ffyon-ledger` NAS claim holds encrypted ledger snapshots and push subscriptions. Keep the NAS data and `ffyon/ffyon-session` Secret together for recovery. The server delivers alerts through Apple’s Web Push service. The booking and mail site verifies device approval and continues to serve bookings, clients and mail. Finances and staff notes stay on the home cluster.

## Browser regression test

Build the PWA, then run `node tests/pwa-browser.js` with Playwright WebKit and OpenSSL installed locally. Use `FFYON_PLAYWRIGHT_PATH` or `FFYON_TEST_OPENSSL` to point to existing installations. The test starts a loopback HTTPS server and uses disposable customer and transaction data.
