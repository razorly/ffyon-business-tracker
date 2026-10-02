import { useEffect, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  createTransaction,
  deleteTransaction,
  getAppointment,
  getTransaction,
  isTauri,
  markAppointmentPaid,
  markAppointmentUnpaid,
  type TxType,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { runAutoBackup } from "@/lib/export";
import { isoDate, money } from "@/lib/format";
import { businessNow } from "@/lib/dates";
import { listServices, serviceDiscountPrice } from "@/lib/sync";
import {
  applyShortcut,
  hideWindow,
  notifyFromTray,
  quitApp,
  QUICK_KEYS_LABEL,
  readCloseAction,
  readShortcutEnabled,
  showWindow,
  syncTray,
  TRAY_EVENT,
  trayName,
  writeCloseAction,
} from "@/lib/tray";
import { Button, Modal } from "./ui";

/** How long a tray message stays put, in step with the undo messages. */
const TOAST_MS = 12_000;

/** Keeps the tray in step with the data and carries out what's clicked there. */
export function TrayBridge() {
  const { version, refresh, openNewEntry, openEditEntry, openEditAppointment } = useData();
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    const adding = new Set<string>();
    /** Read the cached catalogue again because a tray menu can outlive a price or archive change. */
    const quickAdd = async (serviceId: string) => {
      if (adding.has(serviceId)) return;
      adding.add(serviceId);
      try {
        const service = (await listServices()).find((item) => item.id === serviceId && item.active);
        if (!service) {
          await syncTray();
          return toast.info("That service is no longer available");
        }
        const pence = serviceDiscountPrice(service.price_pence, service.discount_percent ?? 0);
        if (pence <= 0) {
          await showWindow();
          return openNewEntry("income");
        }
        const id = await createTransaction({
          type: "income",
          date: isoDate(businessNow()),
          amount_pence: pence,
          category_id: null,
          client_id: null,
          description: null,
          service_id: service.id,
          service_name: service.name,
          category_name_snapshot: service.name,
          income_kind: "service",
        });
        refresh();
        toast.success(`${service.name} · ${money(pence)} added`, {
          description: "Dated today. Add the client or a note whenever you like.",
          duration: TOAST_MS,
          action: {
            label: "Add details",
            onClick: async () => {
              const row = await getTransaction(id);
              await showWindow();
              if (row) openEditEntry(row);
            },
          },
          cancel: {
            label: "Undo",
            onClick: async () => {
              await deleteTransaction(id);
              refresh();
            },
          },
        });
        await notifyFromTray("Added to today", `${service.name} — ${money(pence)}`);
      } catch (err) {
        console.error(err);
        toast.error("Couldn't record that payment. Open Tanned by Ffy and try again.");
      } finally {
        adding.delete(serviceId);
      }
    };

    /** Marking paid from the tray is the same money moment as doing it in the diary. */
    const markPaid = async (id: number) => {
      const appointment = await getAppointment(id);
      if (!appointment) return;
      if (appointment.price_pence == null || appointment.price_pence <= 0) {
        await showWindow();
        openEditAppointment(appointment);
        return toast.info("Add a price to this one before marking it paid");
      }
      try {
        await markAppointmentPaid(id);
      } catch (e) {
        console.error(e);
        return toast.error("Couldn't mark that paid — open the schedule and try there");
      }
      refresh();
      const who = appointment.client_name ?? (appointment.service_name || appointment.category_name || "Appointment");
      toast.success(`${money(appointment.price_pence)} added to your money`, {
        description: who,
        duration: TOAST_MS,
        action: {
          label: "Undo",
          onClick: async () => {
            await markAppointmentUnpaid(id);
            refresh();
          },
        },
      });
      await notifyFromTray("Marked paid", `${who} — ${money(appointment.price_pence)}`);
    };

    const backUpNow = async () => {
      try {
        // Null means the folder was turned off while the menu was still showing it.
        if ((await runAutoBackup(true)) == null) {
          await showWindow();
          return toast.info("Choose a backup folder in Settings first");
        }
        toast.success("Backup saved to your folder");
        await notifyFromTray("Tanned by Ffy backed up", "A fresh copy is in your backup folder");
      } catch (e) {
        console.error(e);
        toast.error("Couldn't write to that folder — check it in Settings");
        await notifyFromTray("Backup failed", "Check the backup folder in Settings");
      }
    };

    const listeners: Promise<UnlistenFn>[] = [
      listen<TxType>(TRAY_EVENT.newEntry, (e) => openNewEntry(e.payload)),
      listen<string>(TRAY_EVENT.quickAdd, (e) => void quickAdd(e.payload)),
      listen<number>(TRAY_EVENT.markPaid, (e) => void markPaid(e.payload)),
      listen(TRAY_EVENT.backup, () => void backUpNow()),
      listen(TRAY_EVENT.askClose, () => setAsking(true)),
    ];
    return () => {
      for (const l of listeners) l.then((off) => off()).catch(() => {});
    };
  }, [refresh, openNewEntry, openEditEntry, openEditAppointment]);

  // Rust keeps its own copy of what the close button does, so the window still
  // closes if the page is busy. Tell it what was chosen last time.
  useEffect(() => {
    void writeCloseAction(readCloseAction());
  }, []);

  // The shortcut that opens a new entry from whatever she's in the middle of.
  useEffect(() => {
    if (!isTauri() || !readShortcutEnabled()) return;
    const open = () => {
      void showWindow();
      openNewEntry();
    };
    applyShortcut(true, open).then((ok) => {
      if (!ok) toast.error(`Something else on this computer uses ${QUICK_KEYS_LABEL}`);
    });
    return () => {
      void applyShortcut(false, open);
    };
  }, [openNewEntry]);

  // The menu follows the data, and the clock — "next appointment" goes stale on its own.
  useEffect(() => {
    void syncTray();
  }, [version]);
  useEffect(() => {
    const timer = setInterval(() => void syncTray(), 5 * 60_000);
    return () => clearInterval(timer);
  }, []);

  const where = trayName();
  return (
    <Modal open={asking} onClose={() => setAsking(false)} title="Keep Tanned by Ffy running?" width="max-w-sm">
      <p className="text-sm text-ink-2">
        Tanned by Ffy can stay in the {where}, where a tan can be booked in with one click and {QUICK_KEYS_LABEL} opens a new
        entry from anywhere. Or it can close properly each time.
      </p>
      <p className="mt-2 text-xs text-muted">You can change this later in Settings.</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          onClick={async () => {
            setAsking(false);
            await writeCloseAction("quit");
            await quitApp();
          }}
        >
          Close it properly
        </Button>
        <Button
          variant="primary"
          onClick={async () => {
            setAsking(false);
            await writeCloseAction("tray");
            await hideWindow();
          }}
        >
          Keep in the {where}
        </Button>
      </div>
    </Modal>
  );
}
