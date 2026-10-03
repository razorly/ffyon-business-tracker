import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listPaymentConfirmations, type AppointmentRow } from "./db";
import { useLoad } from "./data";
import { listPendingAppointments } from "./sync";
import { notifyPaymentConfirmations, readPaymentRemindersEnabled, writePaymentRemindersEnabled, type ReminderResult } from "./payment-reminders";
import { getMailUnread, type MailUnread } from "./mail";
import { useAccess } from "@/components/AccessGate";

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
  mail: MailUnread;
  mailLoading: boolean;
  mailError: string | null;
  mailRevision: number;
  refreshMail: () => void;
}>(null!);

export function InboxProvider({ children }: { children: ReactNode }) {
  const access = useAccess();
  const [clock, setClock] = useState(0);
  const [mailRevision, setMailRevision] = useState(0);
  const [mail, setMail] = useState<MailUnread>({ conversations: [], unread_count: 0 });
  const [mailLoading, setMailLoading] = useState(true);
  const [mailError, setMailError] = useState<string | null>(null);
  const mailRequest = useRef<Promise<MailUnread> | null>(null);
  const refreshMail = useCallback(() => setMailRevision(value => value + 1), []);
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

  // Mail is independent of the local booking Inbox: an unavailable mail backend
  // must never turn existing requests or payment confirmations into an empty list.
  useEffect(() => {
    let active = true;
    if (access.state !== "online") { setMailLoading(false); setMailError("Reconnect to check email."); return; }
    setMailLoading(true); setMailError(null);
    const previous = mailRequest.current;
    void (async () => {
      // A read acknowledgement can invalidate an older unread request. Wait for
      // it, then let only the latest effect make one fresh follow-up request.
      if (previous) await previous.catch(() => {});
      if (!active) return;
      const request = Promise.resolve().then(getMailUnread);
      mailRequest.current = request;
      try { const value = await request; if (active) setMail(value); }
      catch (error) { if (active) setMailError(error instanceof Error ? error.message : "Could not check email."); }
      finally {
        if (mailRequest.current === request) mailRequest.current = null;
        if (active) setMailLoading(false);
      }
    })();
    return () => { active = false; };
  }, [access.state, mailRevision, clock]);

  useEffect(() => {
    let lastTick = -Infinity;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      // Restoring a window commonly emits both focus and visibilitychange.
      if (now - lastTick < 1000) return;
      lastTick = now;
      setClock(value => value + 1);
      refreshMail();
    };
    const timer = setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refreshMail]);

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
  return <Ctx.Provider value={{ ...items, loading, remindersEnabled, setRemindersEnabled, reminderResult, mail, mailLoading, mailError, mailRevision, refreshMail }}>{children}</Ctx.Provider>;
}

export const useInbox = () => useContext(Ctx);
