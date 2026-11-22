import { ArrowDownLeft, ArrowUpRight, CalendarPlus } from "lucide-react";
import { Segmented } from "./ui";

export type EntryMode = "appointment" | "income" | "expense";

// The icons step aside on a phone so three labels always fit on one line.
const LABELS: Record<EntryMode, React.ReactNode> = {
  appointment: <span className="inline-flex items-center gap-1.5"><CalendarPlus size={14} aria-hidden className="max-sm:hidden" /> Booking</span>,
  income: <span className="inline-flex items-center gap-1.5"><ArrowDownLeft size={14} aria-hidden className="max-sm:hidden" /> Money in</span>,
  expense: <span className="inline-flex items-center gap-1.5"><ArrowUpRight size={14} aria-hidden className="max-sm:hidden" /> Money out</span>,
};

/** One switch for "what are you adding?", shared by the New dialog's booking and money forms. */
export function EntryModeSwitch({ value, onChange, modes = ["appointment", "income", "expense"] }: {
  value: EntryMode;
  onChange: (mode: EntryMode) => void;
  modes?: EntryMode[];
}) {
  return <Segmented<EntryMode>
    className="flex w-full"
    label="What are you adding?"
    value={value}
    onChange={onChange}
    options={modes.map((mode) => ({ value: mode, label: LABELS[mode] }))}
  />;
}
