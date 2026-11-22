import { useState } from "react";
import { toast } from "sonner";
import { Download, FileSpreadsheet } from "lucide-react";
import { taxYear, useBusinessNow } from "@/lib/dates";
import { exportSpreadsheet } from "@/lib/export";
import { isoDate } from "@/lib/format";
import { Actions, Button, ErrorText, Field, Input, Modal, Select } from "./ui";

type Preset = "thisTax" | "lastTax" | "thisYear" | "all" | "custom";

/** A spreadsheet of income and expenses for her accountant or tax return. */
export function ExportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const now = useBusinessNow();
  const [preset, setPreset] = useState<Preset>("thisTax");
  const [custom, setCustom] = useState({ from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(now) });
  const [busy, setBusy] = useState(false);

  const ranges: Record<Exclude<Preset, "custom">, { from: string; to: string; label: string }> = {
    thisTax: { ...taxYear(now), label: `This tax year (${taxYear(now).label})` },
    lastTax: { ...taxYear(now, -1), label: `Last tax year (${taxYear(now, -1).label})` },
    thisYear: { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31`, label: `Calendar year ${now.getFullYear()}` },
    all: { from: "1900-01-01", to: "2999-12-31", label: "Everything" },
  };
  const range = preset === "custom" ? custom : ranges[preset];
  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to) && range.from <= range.to;

  const run = async (kind: "xlsx" | "csv") => {
    if (busy || !validRange) return;
    setBusy(true);
    try {
      const saved = await exportSpreadsheet(range.from, range.to, kind);
      if (saved) toast.success(`Exported ${kind === "xlsx" ? "Excel file" : "CSV"}`);
    } catch (e) {
      console.error(e);
      toast.error("Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title="Export">
      <div className="space-y-4">
        <p className="text-small text-ink-2">For your accountant or Self Assessment tax return.</p>
        <Field label="Period">
          <Select disabled={busy} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {Object.entries(ranges).map(([k, r]) => <option key={k} value={k}>{r.label}</option>)}
            <option value="custom">Custom dates…</option>
          </Select>
        </Field>
        {preset === "custom" && (
          <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
            <Field label="From">
              <Input type="date" disabled={busy} value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <Input type="date" disabled={busy} value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </div>
        )}
        {!validRange && <ErrorText>Choose both dates, with the end on or after the start.</ErrorText>}
        <p className="text-small text-ink-2">The Excel file includes every transaction, a monthly summary with totals, and your client list.</p>
        <Actions>
          <Button disabled={busy || !validRange} onClick={() => run("csv")}>
            <Download size={16} aria-hidden /> CSV
          </Button>
          <Button variant="primary" disabled={busy || !validRange} onClick={() => run("xlsx")}>
            <FileSpreadsheet size={16} aria-hidden /> Excel (.xlsx)
          </Button>
        </Actions>
      </div>
    </Modal>
  );
}
