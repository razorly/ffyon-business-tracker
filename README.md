# Ffyon Business Tracker

A small desktop app for tracking income and outgoings for a tanning business. It runs on Mac and Windows.

- **Dashboard**: shows this month's profit, money in and money out (each compared with last month) and clients this month. It also has a 12-month income vs expenses chart, a monthly profit chart, a tax-year total, income by service, and recent entries.
- **New entry**: press **Ctrl/⌘ + N** anywhere. Enter the amount, date, category, client and a note. Typing a new client name creates the client automatically. A category with a usual price fills the amount in for you, and you can type over it.
- **Monthly view**: step through the months. It shows the month's totals, a day-by-day chart, and a table of entries you can search, filter and sort, with edit and delete.
- **Clients**: shows visits, total spent and last visit for each client, plus their full history.
- **Settings**: manage income and expense categories (each can have an optional usual price), export to Excel or CSV (with tax-year presets), save and restore backups, and switch between light and dark mode.

All data stays on the computer in a local SQLite database. Nothing is sent anywhere.

### Usual prices

A category can store a usual price (Settings → edit a category). It only ever prefills the amount box on a **new** entry, and only while you haven't typed an amount yourself. Entries store their own amount, so raising the price later changes what the next entry suggests and never rewrites anything already saved.

## Stack

Tauri 2 · React 19 · TypeScript · Vite · Tailwind CSS 4 · Recharts · SQLite (`tauri-plugin-sql`) · SheetJS

## Development (Windows or Mac)

Requirements: Node 20 or newer, Rust (via https://rustup.rs), and the Tauri prerequisites (https://tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev      # run the desktop app with hot reload
npm run tauri build    # build an installer for the current OS
```

`npm run dev` on its own runs the UI in a normal browser. It uses a temporary in-memory database (`src/lib/devdb.ts`), which is only useful for UI work.

## Getting the Mac version

A Mac app can't be built on Windows, so GitHub Actions builds it for free:

1. Push this folder to a GitHub repo. It can be private.
2. On GitHub, open **Actions → Build apps → Run workflow**.
3. After about 15 minutes, a draft **Release** appears with `Ffyon Business Tracker_x.y.z_universal.dmg`, which works on both Intel and Apple Silicon Macs, plus the Windows installers.

The app isn't signed with an Apple developer certificate, so the first time it's opened on the Mac:
**right-click the app → Open → Open**. If that doesn't work, go to **System Settings → Privacy & Security → "Open Anyway"**. After that it opens normally.

## Where the data lives

| OS      | Database file                                                 |
| ------- | ------------------------------------------------------------- |
| Windows | `%APPDATA%\com.ffyon.tracker\ffyon.db`                        |
| macOS   | `~/Library/Application Support/com.ffyon.tracker/ffyon.db`    |

Use **Settings → Save backup** regularly, for example to iCloud Drive or OneDrive. A backup file can also be restored on another computer to move the data across.

## Project layout

```
src-tauri/src/lib.rs     Tauri setup + database schema (migrations)
src/lib/db.ts            All database queries
src/lib/export.ts        Excel/CSV export, backup/restore
src/components/          UI pieces, charts, entry dialog
src/pages/               Dashboard, Monthly, Clients, Settings
```
