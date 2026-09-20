import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppointmentRow, TransactionRow, TxType } from "./db";

/** Where a new appointment starts: the slot that was clicked, and who it's for. */
export interface AppointmentDraft {
  date: string;
  start_time: string;
  clientId?: number;
}

interface DataCtx {
  /** Bumped whenever data changes — pages re-query when it moves. */
  version: number;
  refresh: () => void;
  /** Entry dialog control */
  entry: { open: boolean; type: TxType; editing: TransactionRow | null; clientId?: number };
  openNewEntry: (type?: TxType, clientId?: number) => void;
  openEditEntry: (tx: TransactionRow) => void;
  closeEntry: () => void;
  /** Appointment dialog control — opened from the schedule, a client, or the money owed list */
  appointment: { open: boolean; editing: AppointmentRow | null; draft: AppointmentDraft | null };
  openNewAppointment: (draft: AppointmentDraft) => void;
  openEditAppointment: (a: AppointmentRow) => void;
  closeAppointment: () => void;
}

const Ctx = createContext<DataCtx>(null as unknown as DataCtx);

export function DataProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const [entry, setEntry] = useState<DataCtx["entry"]>({ open: false, type: "income", editing: null });
  const [appointment, setAppointment] = useState<DataCtx["appointment"]>({
    open: false,
    editing: null,
    draft: null,
  });

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const openNewEntry = useCallback(
    (type: TxType = "income", clientId?: number) => setEntry({ open: true, type, editing: null, clientId }),
    [],
  );
  const openEditEntry = useCallback(
    (tx: TransactionRow) => setEntry({ open: true, type: tx.type, editing: tx }),
    [],
  );
  const closeEntry = useCallback(() => setEntry((e) => ({ ...e, open: false })), []);

  const openNewAppointment = useCallback(
    (draft: AppointmentDraft) => setAppointment({ open: true, editing: null, draft }),
    [],
  );
  const openEditAppointment = useCallback(
    (a: AppointmentRow) => setAppointment({ open: true, editing: a, draft: null }),
    [],
  );
  const closeAppointment = useCallback(() => setAppointment((a) => ({ ...a, open: false })), []);

  // Ctrl/Cmd + N opens a new entry anywhere in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        openNewEntry();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openNewEntry]);

  return (
    <Ctx.Provider
      value={{
        version,
        refresh,
        entry,
        openNewEntry,
        openEditEntry,
        closeEntry,
        appointment,
        openNewAppointment,
        openEditAppointment,
        closeAppointment,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export const useData = () => useContext(Ctx);

/** Run an async loader whenever deps or the data version change. */
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], initial: T): [T, boolean] {
  const { version } = useData();
  const [value, setValue] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((v) => alive && setValue(v))
      .catch((e) => console.error(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return [value, loading];
}
