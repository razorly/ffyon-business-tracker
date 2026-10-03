import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { AppointmentRow, TransactionRow, TxType } from "./db";

/** Where a new appointment starts: the slot that was clicked, and who it's for. */
export interface AppointmentDraft {
  date: string;
  start_time: string;
  clientId?: number;
  clientName?: string;
  serviceId?: string;
  /** Opened from New entry, so the form can switch back to income or expense. */
  fromEntry?: boolean;
}

interface DataCtx {
  /** Bumped whenever data changes — pages re-query when it moves. */
  version: number;
  refresh: () => void;
  /** Entry dialog control */
  entry: { open: boolean; type: TxType; editing: TransactionRow | null; clientId?: number; clientName?: string };
  openNewEntry: (type?: TxType, clientId?: number) => void;
  openEditEntry: (tx: TransactionRow) => void;
  closeEntry: () => void;
  /** Appointment dialog control — opened from the schedule, a client, or the money owed list */
  appointment: { open: boolean; editing: AppointmentRow | null; draft: AppointmentDraft | null };
  openNewAppointment: (draft: AppointmentDraft) => void;
  switchEntryToAppointment: (draft: AppointmentDraft) => void;
  switchAppointmentToEntry: (type: TxType, client?: { id: number | null; name: string }) => void;
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
    (type: TxType = "income", clientId?: number) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setAppointment((a) => ({ ...a, open: false }));
      setEntry({ open: true, type, editing: null, clientId });
    },
    [],
  );
  const openEditEntry = useCallback(
    (tx: TransactionRow) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setAppointment((a) => ({ ...a, open: false }));
      setEntry({ open: true, type: tx.type, editing: tx });
    },
    [],
  );
  const closeEntry = useCallback(() => setEntry((e) => ({ ...e, open: false })), []);

  const openNewAppointment = useCallback(
    (draft: AppointmentDraft) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setEntry((e) => ({ ...e, open: false }));
      setAppointment({ open: true, editing: null, draft });
    },
    [],
  );
  const openEditAppointment = useCallback(
    (a: AppointmentRow) => {
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      setEntry((e) => ({ ...e, open: false }));
      setAppointment({ open: true, editing: a, draft: null });
    },
    [],
  );
  const closeAppointment = useCallback(() => setAppointment((a) => ({ ...a, open: false })), []);
  const switchEntryToAppointment = useCallback((draft: AppointmentDraft) => {
    setEntry((e) => ({ ...e, open: false }));
    setAppointment({ open: true, editing: null, draft: { ...draft, fromEntry: true } });
  }, []);
  const switchAppointmentToEntry = useCallback((type: TxType, client?: { id: number | null; name: string }) => {
    setAppointment((a) => ({ ...a, open: false }));
    setEntry({ open: true, type, editing: null, clientId: client?.id ?? undefined, clientName: client?.name || undefined });
  }, []);

  // Ctrl/Cmd + N opens a new entry anywhere in the app
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
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
        switchEntryToAppointment,
        switchAppointmentToEntry,
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
export function useLoad<T>(loader: () => Promise<T>, deps: unknown[], initial: T): [T, boolean, string | null] {
  const { version } = useData();
  const [state, setState] = useState<{ value: T; loading: boolean; error: string | null; deps: unknown[] }>(
    () => ({ value: initial, loading: true, error: null, deps }),
  );
  const sameScope = deps.length === state.deps.length && deps.every((dep, i) => Object.is(dep, state.deps[i]));
  useEffect(() => {
    let alive = true;
    setState((previous) => ({ value: sameScope ? previous.value : initial, loading: true, error: null, deps }));
    Promise.resolve().then(loader)
      .then((value) => { if (alive) setState({ value, loading: false, error: null, deps }); })
      .catch((error: unknown) => {
        if (alive) setState((previous) => ({ ...previous, loading: false,
          error: error instanceof Error ? error.message : "Could not load this information. Please retry." }));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  // A new month/client must never render the previous scope's data, even before
  // its effect starts. Same-scope refreshes keep the last successfully loaded view.
  return sameScope ? [state.value, state.loading, state.error] : [initial, true, null];
}
