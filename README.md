# Ffyon Business Tracker

A small desktop app for tracking income and outgoings for a tanning business. It runs on Mac and Windows.

- **Dashboard**: shows this month's profit, money in and money out (each compared with last month) and clients this month. It also has a 12-month income vs expenses chart, a monthly profit chart, a tax-year total, income by service, and recent entries.
- **Schedule**: a calendar of appointments, in day, week or month view. Click any empty time to book one; click an appointment to open it. Regulars can be booked as a repeat (every week up to every 4 weeks), and an appointment can be marked cancelled or a no-show. Booking changes nothing about the money — an appointment only becomes an income entry when it's marked **paid**, and anything past that hasn't been marked paid is listed under **Money you're owed**.
- **New entry**: press **Ctrl/⌘ + N** anywhere. Enter the amount, date, category, client and a note. Typing a new client name creates the client automatically. A category with a usual price fills the amount in for you, and you can type over it.
- **Monthly view**: step through the months. It shows the month's totals, a day-by-day chart, and a table of entries you can search, filter and sort, with edit and delete.
- **Clients**: shows visits, total spent and last visit for each client, plus their full history.
- **Settings**: manage income and expense categories (each can have an optional usual price), export to Excel or CSV (with tax-year presets), save and restore backups, turn on automatic backups, check for updates, and switch between light and dark mode.

Anything deleted — an entry, an appointment, a whole repeating run, a client or a category — can be put straight back with **Undo** on the message that appears in the corner. It restores everything the delete touched, so an appointment that was paid comes back paid, with its entry.

All data stays on the computer in a local SQLite database. Nothing is sent anywhere.

### Usual prices

A category can store a usual price (Settings → edit a category). It only ever prefills the amount box on a **new** entry, and only while you haven't typed an amount yourself. Entries store their own amount, so raising the price later changes what the next entry suggests and never rewrites anything already saved.

### Appointments and money

The schedule is a diary, not a second set of books. An appointment that's booked, unpaid or still to come is **never** in the profit, the charts, the tax-year totals or an export — nothing is written to the money side until you open it and press **Mark paid**.

Marking it paid adds one income entry, dated the day of the appointment, with its price, service, client and note. After that the two stay in step:

- Editing the appointment updates the entry it created.
- **Mark unpaid** removes the entry again, and the money leaves the totals.
- Deleting the appointment deletes its entry too.
- Deleting the entry from the monthly view puts the appointment back to unpaid.
- Marking it cancelled or a no-show does the same: the record stays in the diary, the money doesn't.

Repeating bookings are just ordinary appointments that know about each other. Editing one changes only that one; deleting offers to remove the rest of the run as well.

### Backups

**Settings → Save backup** writes a file wherever you choose. **Automatic backups** does it on its own: pick a folder once — ideally one that syncs, like OneDrive or iCloud Drive — and the app writes a dated copy there the first time it's opened each day, keeping the last 10. Restoring is the same either way.

### Updates

The app checks GitHub for a newer version when it starts, and offers to install it. Settings → **Check for updates** does it on demand.

This needs a signing key, one time:

```bash
npm run tauri signer generate -- -w ~/.ffyon-updater.key
```

Put the contents of `~/.ffyon-updater.key` in the repo's `TAURI_SIGNING_PRIVATE_KEY` secret (Settings → Secrets and variables → Actions) and the password you chose in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — leave it empty if you didn't set one. The matching public key is already in `src-tauri/tauri.conf.json`; keep the private key file safe, because a lost key means installed copies stop accepting updates.

A release only reaches people once it's **published** on GitHub — the workflow leaves it as a draft so you can test it first.

The app downloads updates from the releases page without signing in, so **the repo has to be public** for this to work. A private repo's release files need authentication, and the check will quietly find nothing every time. Nothing sensitive lives in the repo: the signing key is kept outside it, and the database never leaves the computer it's on. If you'd rather keep the code private, publish the installers to a separate public repo and point `plugins.updater.endpoints` in `src-tauri/tauri.conf.json` at that one instead.

## Stack

Tauri 2 · React 19 · TypeScript · Vite · Tailwind CSS 4 · Recharts · SQLite (`tauri-plugin-sql`) · SheetJS

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

`npm run dev` on its own runs the UI in a normal browser. It uses a temporary in-memory database (`src/lib/devdb.ts`), which is only useful for UI work.

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
src/lib/db.ts            All database queries
src/lib/export.ts        Excel/CSV export, backup/restore, automatic backups
src/components/          UI pieces, charts, calendar, entry and appointment dialogs
src/pages/               Dashboard, Schedule, Monthly, Clients, Settings
```
