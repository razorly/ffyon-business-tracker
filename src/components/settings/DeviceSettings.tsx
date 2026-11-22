import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Download, FolderCheck, Monitor, Moon, Sun, Trash2, Upload } from "lucide-react";
import { isTauri, wipeAll } from "@/lib/db";
import { useData } from "@/lib/data";
import { useInbox } from "@/lib/inbox";
import { isPwa } from "@/lib/access";
import { ukDate } from "@/lib/format";
import { chooseAutoBackupFolder, loadBackup, readAutoBackup, runAutoBackup, saveBackup, writeAutoBackup, type AutoBackup } from "@/lib/export";
import { applyShortcut, QUICK_KEYS_LABEL, readCloseAction, readShortcutEnabled, showWindow, trayName, writeCloseAction, writeShortcutEnabled, type CloseAction } from "@/lib/tray";
import { useTheme, type ThemePref } from "@/lib/theme";
import { checkForUpdate } from "@/lib/update";
import { useSharedLedger } from "@/components/LedgerGate";
import { Actions, Button, Card, CardHeader, Checkbox, ConfirmModal, ErrorText, Input, Modal, Segmented, Switch } from "@/components/ui";
import { Help, SubHeading } from "./parts";

// ---------- Backup ----------

export function BackupCard() {
  const webApp = isPwa();
  const sharing = useSharedLedger().ledger !== null;
  const { refresh } = useData();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [auto, setAuto] = useState<AutoBackup | null>(() => readAutoBackup());
  const [backingUp, setBackingUp] = useState(false);
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState("");

  const backUpNow = async () => {
    setBackingUp(true);
    try {
      await runAutoBackup(true);
      setAuto(readAutoBackup());
      toast.success("Backup saved to your folder");
    } catch (e) {
      console.error(e);
      toast.error("Couldn't save to that folder. Try choosing it again.");
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <Card>
      <CardHeader title={sharing ? "Backup" : "Backup and restore"}
        subtitle={sharing ? "Your money records and private notes are shared between your approved devices" : webApp ? "Your money records and private notes are kept on this device" : "Your money records and private notes are kept on this computer"} />
      <div className="space-y-4 px-5 pb-5">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={async () => {
              try {
                if (await saveBackup()) toast.success("Backup saved");
              } catch (e) {
                console.error(e);
                toast.error("Backup failed");
              }
            }}
          >
            <Download size={16} aria-hidden /> Save backup
          </Button>
          {!sharing && <Button onClick={() => setConfirmRestore(true)}>
            <Upload size={16} aria-hidden /> Restore from backup
          </Button>}
        </div>
        <Help>
          {sharing ? "Save a copy now and then, so you have one of your own." : webApp
            ? "Save a backup to Files or iCloud Drive before removing the app or clearing its website data. You can also restore a backup from the desktop app."
            : "Save backups to iCloud Drive, OneDrive or a USB stick. A backup can also move your records to another approved computer. Restoring doesn't change website bookings."}
        </Help>

        {!webApp && <div className="space-y-2 border-t border-line pt-4">
          <SubHeading>Automatic backups</SubHeading>
          {auto ? (
            <>
              <Help className="break-all">{auto.dir}</Help>
              <Help>{auto.lastRun ? `Last copy saved ${ukDate(auto.lastRun)}.` : "No copy saved yet."} A copy is saved each day you open the app, keeping the last 10.</Help>
              <div className="flex flex-wrap gap-2">
                <Button disabled={backingUp} onClick={backUpNow}>
                  <Download size={16} aria-hidden /> Back up now
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    writeAutoBackup(null);
                    setAuto(null);
                    toast.success("Automatic backups turned off");
                  }}
                >
                  Turn off
                </Button>
              </div>
            </>
          ) : (
            <>
              <Help>Save a copy on its own every day. Pick a folder in OneDrive or iCloud Drive and your records are safe even if this computer isn't.</Help>
              <Button
                onClick={async () => {
                  try {
                    const chosen = await chooseAutoBackupFolder();
                    if (!chosen) return;
                    setAuto(chosen);
                    await backUpNow();
                  } catch (e) {
                    toast.error(e instanceof Error ? e.message : "Couldn't set that up");
                  }
                }}
              >
                <FolderCheck size={16} aria-hidden /> Choose a folder…
              </Button>
            </>
          )}
        </div>}

        {!sharing && <div className="space-y-2 border-t border-line pt-4">
          <SubHeading>Start fresh</SubHeading>
          <Help>Delete all entries, appointments and clients. Services, other income and expense categories are kept.</Help>
          <Button variant="ghost" className="-ml-4 text-bad hover:text-bad" onClick={() => { setWipeText(""); setWipeError(""); setConfirmWipe(true); }}>
            <Trash2 size={16} aria-hidden /> Delete all data…
          </Button>
        </div>}
      </div>

      <ConfirmModal
        open={confirmRestore}
        onClose={() => setConfirmRestore(false)}
        title="Restore from backup?"
        confirmLabel="Choose file"
        message="Everything currently in the app will be replaced with the contents of the backup file."
        onConfirm={async () => {
          try {
            const n = await loadBackup();
            if (n != null) {
              toast.success(`Restored ${n} entries`);
              refresh();
            }
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Restore failed");
          }
        }}
      />

      <Modal open={confirmWipe} onClose={() => { if (!wiping) setConfirmWipe(false); }} title="Delete all data?" width="max-w-sm">
        <p className="text-ink-2">
          This permanently deletes every entry, appointment and client. Save a backup first if you might need it. Type <b className="font-semibold text-ink">DELETE</b> to confirm.
        </p>
        <Input aria-label="Type DELETE to confirm" disabled={wiping} className="mt-3" value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder="DELETE" />
        {wipeError && <ErrorText className="mt-3">{wipeError}</ErrorText>}
        <Actions className="mt-4">
          <Button disabled={wiping} onClick={() => setConfirmWipe(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={wiping || wipeText !== "DELETE"}
            onClick={async () => {
              if (wiping || wipeText !== "DELETE") return;
              setWiping(true); setWipeError("");
              try {
                await wipeAll();
                toast.success("All data deleted");
                setWipeText("");
                setConfirmWipe(false);
                refresh();
              } catch (cause) { setWipeError(cause instanceof Error ? cause.message : "Couldn't delete the data. Try again."); }
              finally { setWiping(false); }
            }}
          >
            Delete everything
          </Button>
        </Actions>
      </Modal>
    </Card>
  );
}

// ---------- Tray ----------

export function TrayCard() {
  const { openNewEntry } = useData();
  const { remindersEnabled, setRemindersEnabled, reminderResult } = useInbox();
  const [closeAction, setCloseAction] = useState<CloseAction>(() => readCloseAction());
  const [shortcut, setShortcut] = useState(() => readShortcutEnabled());
  const where = trayName();

  const chooseClose = async (action: CloseAction) => {
    setCloseAction(action);
    await writeCloseAction(action);
  };

  const toggleShortcut = async (on: boolean) => {
    setShortcut(on);
    writeShortcutEnabled(on);
    const ok = await applyShortcut(on, () => {
      void showWindow();
      openNewEntry();
    });
    if (ok) return;
    // Another app owns those keys — nothing was registered, so don't pretend it was.
    setShortcut(false);
    writeShortcutEnabled(false);
    toast.error(`Something else on this computer uses ${QUICK_KEYS_LABEL}`);
  };

  return (
    <Card>
      <CardHeader title="Tray and shortcuts" subtitle={`Tanned by Ffy sits in the ${where} while it's running`} />
      <div className="space-y-4 px-5 pb-5">
        <div className="space-y-2">
          <SubHeading>When I close the window</SubHeading>
          <Segmented<CloseAction>
            label="When I close the window"
            className="w-full sm:w-96"
            value={closeAction}
            onChange={chooseClose}
            options={[
              { value: "tray", label: "Keep running" },
              { value: "quit", label: "Close the app" },
              { value: "ask", label: "Ask me" },
            ]}
          />
          <Help>Kept in the {where}, it's one click to record a payment, and the daily backup still runs.</Help>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div className="min-w-0">
            <SubHeading>New entry shortcut</SubHeading>
            <Help>{QUICK_KEYS_LABEL} opens a new entry from any app on this computer.</Help>
          </div>
          <Switch label="New entry shortcut" checked={shortcut} onChange={(on) => void toggleShortcut(on)} />
        </div>

        <div className="border-t border-line pt-2">
          <Checkbox label="Desktop payment reminders" hint="A notification when a finished appointment needs its payment confirmed." checked={remindersEnabled} onChange={event => setRemindersEnabled(event.target.checked)} />
          {remindersEnabled && reminderResult === "blocked" && <p role="status" className="text-small text-ink-2">Notifications are blocked. Allow Tanned by Ffy notifications in your Windows or macOS notification settings.</p>}
          {remindersEnabled && reminderResult === "error" && <p role="status" className="text-small text-bad">Couldn't send the reminder. Payments to confirm are still listed on Today.</p>}
        </div>

        <Help>
          The {where} menu shows today's takings, one-click payments for your services, and appointments waiting for payment.
          {!isTauri() && " (Only in the desktop app.)"}
        </Help>
      </div>
    </Card>
  );
}

// ---------- Appearance ----------

export function AppearanceCard() {
  const { pref, setPref } = useTheme();
  const option = (icon: React.ReactNode, text: string) => <span className="inline-flex items-center gap-2">{icon} {text}</span>;
  return (
    <Card>
      <CardHeader title="Appearance" />
      <div className="px-5 pb-5">
        <Segmented<ThemePref>
          label="Appearance"
          className="w-full sm:w-80"
          value={pref}
          onChange={setPref}
          options={[
            { value: "light", label: option(<Sun size={16} aria-hidden />, "Light") },
            { value: "dark", label: option(<Moon size={16} aria-hidden />, "Dark") },
            { value: "system", label: option(<Monitor size={16} aria-hidden />, "System") },
          ]}
        />
      </div>
    </Card>
  );
}

// ---------- About ----------

export function AboutCard() {
  const webApp = isPwa();
  // The bundled version is right for the browser preview; the installed app
  // knows better, so it overrides it once it answers.
  const [version, setVersion] = useState(__APP_VERSION__);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <Card>
      <CardHeader title="About" subtitle="Tanned by Ffy" />
      <div className="space-y-3 px-5 pb-5">
        <p className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl bg-surface-2 px-4 py-3">
          <span className="text-small text-ink-2">{webApp ? "Web app version" : "Installed version"}</span>
          <span className="tabular font-semibold">{version}</span>
        </p>
        {!webApp && <>
          <Button
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await checkForUpdate(false);
              } catch (e) {
                console.error(e);
                toast.error("Couldn't check for updates. Check your internet connection.");
              } finally {
                setChecking(false);
              }
            }}
          >
            <Download size={16} aria-hidden /> Check for updates
          </Button>
          <Help>New versions install when you say so, and the app restarts. Your records aren't touched.</Help>
        </>}
      </div>
    </Card>
  );
}
