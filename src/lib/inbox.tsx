import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { listPaymentConfirmations, type AppointmentRow } from "./db";
import { useLoad } from "./data";
import { listPendingAppointments } from "./sync";
import { notifyPaymentConfirmations, readPaymentRemindersEnabled, writePaymentRemindersEnabled, type ReminderResult } from "./payment-reminders";

interface InboxItems {
  requests: AppointmentRow[];
  payments: AppointmentRow[];
  error: string | null;
}
const EMPTY: InboxItems = { requests: [], payments: [], error: null };
const Ctx = createContext<InboxItems & {
  loading: boolean;
  remindersEnabled: boolean;
  setRemindersEnabled: (enabled: boolean) => void;
  reminderResult: ReminderResult;
}>(null!);

export function InboxProvider({ children }: { children: ReactNode }) {
  const [clock, setClock] = useState(0);
  const [remindersEnabled, setEnabled] = useState(readPaymentRemindersEnabled);
  const [reminderResult, setReminderResult] = useState<ReminderResult>("idle");
  const [items, loading] = useLoad(async (): Promise<InboxItems> => {
    try {
      const requests = await listPendingAppointments();
      const payments = await listPaymentConfirmations();
      return { requests, payments, error: null };
    } catch (error) {
      return { ...EMPTY, error: error instanceof Error ? error.message : "Could not load Inbox" };
    }
  }, [clock], EMPTY);

  useEffect(() => {
    const tick = () => setClock(value => value + 1);
    const timer = setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  useEffect(() => {
    if (!remindersEnabled || loading || items.error) return;
    let active = true;
    void notifyPaymentConfirmations(items.payments, () => active).then(result => {
      if (active) setReminderResult(result);
    });
    return () => { active = false; };
  }, [remindersEnabled, items, loading]);

  const setRemindersEnabled = (enabled: boolean) => {
    writePaymentRemindersEnabled(enabled);
    setEnabled(enabled);
    setReminderResult("idle");
  };
  return <Ctx.Provider value={{ ...items, loading, remindersEnabled, setRemindersEnabled, reminderResult }}>{children}</Ctx.Provider>;
}

export const useInbox = () => useContext(Ctx);
