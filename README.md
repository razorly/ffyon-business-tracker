# Ffyon Business Tracker

A small desktop app for tracking income and outgoings for a tanning business. It runs on Mac and Windows.

- **Dashboard**: shows this month's profit, money in and money out (each compared with last month) and clients this month. It also has a 12-month income vs expenses chart, a monthly profit chart, a tax-year total, income by service, and recent entries.
- **Schedule**: a calendar of appointments, in day, week or month view. Click any empty time to book one; click an appointment to open it. Regulars can be booked as a repeat (every week up to every 4 weeks), and an appointment can be marked cancelled or a no-show. Booking changes nothing about the money — an appointment only becomes an income entry when it's marked **paid**, and anything past that hasn't been marked paid is listed under **Money you're owed**.
- **New entry**: press **Ctrl/⌘ + N** anywhere. Choose **Appointment** to open the full booking form with the selected date, client and service, without recording income. **Money in** records a service payment, pays an existing appointment, or records other income. Standalone payments do not create bookings. Expenses keep their own categories and usual amounts.
- **Inbox**: customer requests and completed appointments awaiting payment confirmation, in separate sections. Timed appointments appear when their duration has finished; confirmed date-only bookings appear the following day. Confirm the amount received with **Confirm paid**. Cancelled, pending, rejected, no-show, paid and free bookings are excluded from payment reminders.
- **Monthly view**: step through the months. It shows the month's totals, a day-by-day chart, and a table of entries you can search, filter and sort, with edit and delete.
- **Clients**: shows visits, total spent and last visit for each client, plus their full history.
- **Tray**: while the app is running it also sits in the system tray (the menu bar on a Mac), with today's takings, the next appointment, one-click **Quick add** for active services at their current discounted prices, and **Mark paid** for anything waiting. **Ctrl/⌘ + Shift + N** opens a new entry from whatever else you're in.
- **Settings**: manage the shared Services catalogue, other-income labels, expense categories and explicit legacy income review. Export to Excel or CSV (with tax-year presets), save and restore backups, turn on automatic backups, choose what the tray does, check for updates, and switch between light and dark mode.

Local financial entry and category deletion offers **Undo**. Shared appointment/account deletion is permanent privacy cleanup with no undo: it removes personal booking details while retaining anonymized recorded payments. Cancellation and disabling an account remain separate actions.

The official app requires an approved admin device. Customers, services and bookings synchronize with the Ffyon website; income, expenses and private notes stay in the local SQLite database on each computer. A website customer account does not unlock the desktop app.

See [Admin setup](docs/admin-setup.md) for Windows/macOS pairing, device access and recovery.

Customer requests need admin approval; manual entries are confirmed directly. Date-only bookings show **Time to confirm** all day without blocking slots. Home visits require an address and postcode, with optional saved addresses and an on-demand postcode map. Service discounts synchronize to the website without changing existing quotes. Shared settings configure admin request emails; the website sends customer status updates through its private hosted Resend configuration. Deletion sends no email.

### Services and payment defaults

Services are the single treatment catalogue for the website, bookings, service payments, tray shortcuts and reports. Set the name, duration, base price and optional discount once in **Settings > Services**. New payments suggest the current discounted price, but the actual amount received remains editable. Existing bookings and payments keep their saved names, quotes and amounts when a service is renamed or archived.

Use **Other income** for tips, product sales and other non-treatment receipts. Expense categories can still store a usual amount to prefill new expenses. Neither list duplicates service prices. After upgrading, **Legacy income review** reuses existing explicit links and asks you to classify unmatched old labels without guessing by name. Review local financial records separately on each computer.

### Appointments and money

The schedule is a diary, not a second set of books. An appointment that's booked, unpaid or still to come is **never** in the profit, the charts, the tax-year totals or an export — nothing is written to the money side until you open it and press **Mark paid**.

Marking a confirmed appointment paid adds one income entry, dated the day of the appointment. Its recorded payment and original quoted price are separate:

- Editing a quoted booking or its service never rewrites a recorded payment.
- **Mark unpaid** removes the entry again, and the money leaves the totals.
- Cancelling a booking keeps its history and any recorded payment.
- Deleting the entry from the monthly view puts the appointment back to unpaid.
- Marking it cancelled or a no-show preserves recorded income. Use an explicit financial action to correct a payment.

Repeating bookings are just ordinary appointments that know about each other. Editing one changes only that one; deleting offers to remove the rest of the run as well.

### The tray

While Ffyon is running there's an icon in the system tray — the menu bar on a Mac. Clicking it brings the window back or puts it away again; the menu does the day's small jobs without it:

- **Today** — what's come in, what's gone out, and what's next in the diary.
- **Quick add** — one line for each active service with a positive discounted price. Clicking one records a standalone payment at its current cached price, dated today, without creating an appointment. The message offers **Undo**, or **Add details** to put a client and a note on it. Archived services are not offered for new payments.
- **Mark paid** — today's bookings and anything overdue. It's the same money moment as pressing Mark paid in the diary, undo included. A booking with no price yet opens instead of guessing one.
- **Back up now** — once automatic backups have a folder.

Closing the window asks, the first time, whether to leave Ffyon in the tray or close it properly, and remembers the answer. **Settings → Tray & shortcuts** changes it later. Leaving it running is what keeps the one-click entry and the shortcut available.

When the window is out of sight, anything done from the tray says so with a notification from the computer instead of a message in the app.

Payment confirmations also update the Inbox badge and send a count-only desktop reminder, even when the window is open. Repeated syncs do not repeat the same reminder. **Settings > Tray & shortcuts > Desktop payment reminders** turns desktop reminders off without hiding Inbox items. Allow notifications for Ffyon in Windows or macOS notification settings. The app must be running (including in the tray/menu bar); reopening or resuming checks overdue bookings. Reminders follow the Europe/London business clock and never email customers. Payment records and reminder bookkeeping remain local to each approved computer.

### Backups

**Settings → Save backup** writes a file wherever you choose. **Automatic backups** does it on its own: pick a folder once — ideally one that syncs, like OneDrive or iCloud Drive — and the app writes a dated copy there the first time it's opened each day, keeping the last 10. Restoring is the same either way.

Backup format 4 retains saved service/payment attribution and legacy classifications; formats 1-3 remain readable. Credentials are never included. The catalogue upgrade makes a local database safety copy before migration.

### Updates

The app checks GitHub for a newer version when it starts, and offers to install it. Settings → **Check for updates** does it on demand.

This needs a signing key, one time:

```bash
npm run tauri signer generate -- -w ~/.ffyon-updater.key
```

Put the contents of `~/.ffyon-updater.key` in the repo's `TAURI_SIGNING_PRIVATE_KEY` secret (Settings → Secrets and variables → Actions) and the password you chose in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave it empty if you didn't set one. The matching public key is already in `src-tauri/tauri.conf.json`; keep the private key file safe, because a lost key means installed copies stop accepting updates.

A release only reaches people once it's **published** on GitHub — the workflow leaves it as a draft so you can test it first.

The app downloads updates from public GitHub releases. Downloading an installer does not grant admin access: each installation must be approved through trusted owner setup or paired from an authorized device. Private connection credentials remain in Windows Credential Manager or macOS Keychain; server secrets remain in Sites. Updater signing keys stay in GitHub Actions secrets. The public source can be modified to build independent local software, but such modifications cannot authorize access to the Ffyon server.

## Stack

Tauri 2 · React 19 · TypeScript · Vite · Tailwind CSS 4 · Recharts · native guarded SQLite · SheetJS · Cloudflare D1

## Development (Windows or Mac)

Requirements: Node 20 or newer, Rust (via https://rustup.rs), and the Tauri prerequisites (https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build an installer for the current OS
```

Because releases are signed for the updater, a local `npm run tauri build` needs the key:

```bash
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.ffyon-updater.key) TAURI_SIGNING_PRIVATE_KEY_PASSWORD= npm run tauri build
```

`npm run dev` alone cannot authorize the production app. Development fixtures use disposable data and must not connect to the live business database. Native authorization, secure storage and filesystem checks still require the desktop runtime.

## Getting the Mac version

A Mac app can't be built on Windows, so GitHub Actions builds it for free:

1. Push this folder to a GitHub repo.
2. On GitHub, open **Actions → Build apps → Run workflow**.
3. After about 15 minutes, a draft **Release** appears with `Ffyon Business Tracker_x.y.z_universal.dmg`, which works on both Intel and Apple Silicon Macs, plus the Windows installers.

The app isn't signed with an Apple developer certificate, so the first time it's opened on the Mac:
**right-click the app → Open → Open**. If that doesn't work, go to **System Settings → Privacy & Security → "Open Anyway"**. After that it opens normally.

## Where the data lives

| OS      | Database file                                                 |
| ------- | ------------------------------------------------------------- |
| Windows | `%APPDATA%\com.ffyon.tracker\ffyon.db`                        |
| macOS   | `~/Library/Application Support/com.ffyon.tracker/ffyon.db`    |

Turn on **Settings → Automatic backups** and point it at a synced folder, and this looks after itself. A backup file can also be restored on another computer to move the data across.

## Project layout

```
src-tauri/src/lib.rs     Tauri setup + database schema (migrations)
src-tauri/src/tray.rs    The tray icon, its menu and the window's close button
src/lib/db.ts            All database queries
src/lib/export.ts        Excel/CSV export, backup/restore, automatic backups
src/lib/tray.ts          What the tray menu says; the global shortcut
src/components/TrayBridge.tsx  Carries out what's clicked in the tray
src/components/          UI pieces, charts, calendar, entry and appointment dialogs
src/pages/               Dashboard, Schedule, Monthly, Clients, Settings
```
