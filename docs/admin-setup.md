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

Manual entries are confirmed immediately and never enter Requests. Choose **Time to confirm** for a date-only booking; it appears all day in the calendar without blocking slots. The app highlights it until a time is assigned. Customer date-only requests still need approval.

For a home visit, enable the remote option and enter the address and postcode. Save the address only when requested; later bookings can reuse it. The remote appointment's map loads on demand and shows an approximate postcode location. **Directions** opens Google Maps and sends the full address only when clicked.

Edit or archive services in the admin app. Services are the single treatment catalogue for the website, bookings, service payments, reports and tray shortcuts. There is no separate income-category mapping or duplicate treatment price to maintain. The website uses the current active catalogue for new requests. Old bookings retain their saved service name, price and duration even when that service changes or is archived.

Set a percentage discount on a service to show the offer and reduced price on the website. Existing bookings keep their agreed price and any original discount snapshot. Changing a booked service requires an explicit edit.

Income and expenses are local to each computer. Approval never records income; **Mark paid** does. In **New entry**, choose **Service payment** for money received without an appointment, **Appointment payment** for an existing unpaid booking, or **Other income** for tips, product sales and similar receipts. A standalone payment does not create a booking or request. Service payments start with the current discounted price, but the amount actually received is editable. Appointment payments use the saved agreed quote and link exactly once. Cancelling an appointment does not delete a recorded payment. Staff notes remain local and do not appear in customer accounts.

**Other income** settings contain only non-treatment labels. Expense categories and their usual amounts remain separate. Reports and exports distinguish service payments, other income and unresolved legacy income. Existing payment amounts and saved labels are not repriced or renamed when the catalogue changes. Unlinked payment entries can be explicitly corrected; payments linked to appointments keep their booked service attribution.

After upgrading, open **Settings > Legacy income review** on each computer that holds local financial records. Existing explicit service links are reused automatically. For each remaining old income label, select its service (including an archived service for historical records), or **Keep as other income**, then apply the review. No label is matched by name. This classification preserves recorded amounts, saved labels and old agreed booking details. Before importing a legacy booking to the website, choose an active service explicitly if its original service is no longer available.

**Delete** is permanent privacy cleanup, separate from cancellation or disabling an account. It removes shared booking/account details and linked saved addresses; payments keep their amount, date and saved service/category attribution, with deleted personal links and descriptions removed. It cannot be undone and sends no email. Old backup files are separate copies and should be handled according to your retention policy.

## Email Settings

In the app's shared business settings, enter the admin email and enable request notifications. A valid address is required. New customer requests include their service, quote, date/time-to-confirm and home-visit details. Manual entries do not produce a request notification.

The website emails account customers when bookings are confirmed, refused or cancelled. Deletion is silent. Delivery failures do not undo bookings; check the delivery status in settings. Request notifications start disabled until you save the intended recipient.

The existing hosted `RESEND_API_KEY`, verified `RESEND_FROM` and `SITE_URL` provide delivery. Keep the API key in Site runtime secrets, never the app, GitHub source or a settings text field. Device pairing on macOS needs no separate Resend credential: approve Keychain access and pair the Mac from your authorized Windows app as described above.

## Backups and Updates

Backup format 4 contains business records, saved payment attribution and legacy classifications, never credentials, pairing codes or offline authorizations. Formats 1-3 remain readable. Restoring shared records requires an online, current site snapshot and commits the restore and reconciliation together, so old backups cannot bring back deleted website records or old booking decisions. A failed connection leaves the current database unchanged. Local-only legacy backups can still be restored offline. Upgrade migrations preserve existing finance and make a local safety copy before changing the database schema.

The existing public GitHub updater workflow requires only its updater signing secrets, never an admin device credential or the Site's private signing key. A source commit does not publish a desktop release. Even a manual workflow run creates a draft release and a `build-*` tag, so do not run it when delivery must remain tag-free. Building the universal Mac package still requires a Mac. This catalogue upgrade requires installing the new app, not changing credentials or redeploying the Site. See [catalogue validation](catalogue-validation.md) and the earlier [map validation](map-validation.md).
