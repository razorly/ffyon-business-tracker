# Ffyon Admin Setup

## Windows and macOS

Install the Windows installer or the universal macOS DMG. The Mac build supports Intel and Apple Silicon. The app opens at its admin connection screen until this computer is approved.

The current release workflow signs updater packages but does not Apple-notarize the Mac app. If macOS blocks first launch, use the existing trusted-app opening process described in the main README. Allow the app's Keychain request when connecting. Denying it leaves the app disconnected; no password or connection key is written to a file instead.

## First Approved Computer

1. Choose **Set Up First Admin** and enter a recognizable device name.
2. The app generates a private connection credential inside Windows Credential Manager or macOS Keychain. It displays only a public device ID and SHA-256 hash.
3. In the Ffyon Site's runtime settings, set `FFYON_BOOTSTRAP_DEVICE_ID` to that device ID and `FFYON_BOOTSTRAP_TOKEN_HASH` to its hash. Keep these in hosted configuration, not source. Apply the configuration by publishing the saved site version.
4. Choose **Verify Connection** in the app. The server registers this device once and issues its authorization.
5. Review services, prices, durations, opening hours and existing bookings before enabling online requests.

The server's `FFYON_LEASE_SIGNING_KEY` is an Ed25519 private key in PKCS8 base64 form, managed as a hosted secret. The desktop contains only its public verification key. This key is separate from the GitHub updater signing key. Keep the signing key stable across releases; changing it requires a coordinated desktop verifier update.

## Add Another Computer

1. On an approved computer, open Site Connection and select **Add Device**.
2. On the new Windows or Mac installation, select **Pair Device**, enter its name and the temporary code.
3. The code expires after ten minutes and can approve one new device. Each installation generates and stores its own private credential; never copy connection keys between computers.

Connection credentials survive restarts. A copied database or restored backup does not authorize a new installation, so pair it separately. No customer sign-in, public download or local setting grants admin access.

## Offline Use and Revocation

A successful online device check permits offline diary viewing and local financial work for up to 24 hours. Bookings, customer details, service catalogue, opening hours and time off require an online server response to change.

After the authorization expires, reconnect to verify the device before using the tracker. Unexpected clock rollback also requires an online check. A revoked device locks when it reconnects, or when its existing offline authorization expires. Local activity cannot extend the authorization.

Revoke a lost computer from another approved installation. Outstanding pairing codes issued by that computer stop working. If every approved computer is lost, repeat trusted first-device setup through the Site owner's runtime settings, then revoke the old devices.

## Bookings, Services and Money

Customer requests appear in the admin inbox. Accepting one confirms the appointment and updates the customer's appointment page. Pending requests do not reserve a slot. Concurrent approvals cannot confirm overlapping appointments.

Customers can cancel a confirmed booking. A request to change its time keeps the original reservation until accepted. Rejecting the proposed change leaves the original booking intact.

Edit or archive services in the admin app. The website uses the current active catalogue for new requests. Old bookings retain their saved service name, price and duration even when that service changes or is archived.

Income and expenses are local to each computer. Approval never records income; **Mark paid** does. Cancelling an appointment does not delete a recorded payment. Staff notes remain local and do not appear in customer accounts.

## Backups and Updates

Backups contain business records and mappings, never credentials, pairing codes or offline authorizations. Restoring records does not overwrite the site's current booking decisions. Upgrade migrations preserve existing finance and make a local safety copy before changing the database schema.

Use the existing public GitHub updater workflow for installers. GitHub Actions requires only its existing updater signing secrets, never an admin device credential or the Site's private signing key. A source commit does not publish a desktop release; no tag is required for a manual workflow run.
