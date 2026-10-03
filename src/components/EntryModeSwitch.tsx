import { ArrowDownLeft, ArrowUpRight, CalendarPlus } from "lucide-react";
import { Segmented } from "./ui";

export type EntryMode = "appointment" | "income" | "expense";

const LABELS: Record<EntryMode, React.ReactNode> = {
  appointment: <span className="inline-flex items-center gap-1.5"><CalendarPlus size={14} /> Appointment</span>,
  income: <span className="inline-flex items-center gap-1.5"><ArrowDownLeft size={14} /> Income</span>,
  expense: <span className="inline-flex items-center gap-1.5"><ArrowUpRight size={14} /> Expense</span>,
};

/** One switch for "what are you adding?", shared by the New entry and New appointment forms. */
export function EntryModeSwitch({ value, onChange, modes = ["appointment", "income", "expense"] }: {
  value: EntryMode;
  onChange: (mode: EntryMode) => void;
  modes?: EntryMode[];
}) {
  return <Segmented<EntryMode>
    className={modes.length > 2 ? "w-full flex-col rounded-xl sm:flex-row sm:rounded-full" : "w-full"}
    value={value}
    onChange={onChange}
    options={modes.map((mode) => ({ value: mode, label: LABELS[mode] }))}
  />;
}
