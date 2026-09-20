import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Download, FileSpreadsheet, FolderCheck, Monitor, Moon, Pencil, Plus, Sun, Trash2, Upload } from "lucide-react";
import {
  categoryUsage,
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
  wipeAll,
  type Category,
  type TxType,
} from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { taxYear } from "@/lib/dates";
import { isoDate, money, parseAmount, penceToInput, ukDate } from "@/lib/format";
import {
  chooseAutoBackupFolder,
  exportSpreadsheet,
  loadBackup,
  readAutoBackup,
  runAutoBackup,
  saveBackup,
  writeAutoBackup,
  type AutoBackup,
} from "@/lib/export";
import { nextColour, PALETTE, themedColour } from "@/lib/palette";
import { useTheme, type ThemePref } from "@/lib/theme";
import { checkForUpdate } from "@/lib/update";
import { isTauri } from "@/lib/db";
import { toastDeleted } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { Button, Card, CardHeader, ConfirmModal, Field, Input, Modal, Segmented, Select, Swatch } from "@/components/ui";

export function Settings() {
  return (
    <>
      <PageHeader title="Settings" subtitle="Categories, exports, backups and appearance" />
      <div className="grid gap-4 lg:grid-cols-2">
        <CategoriesCard type="income" />
        <CategoriesCard type="expense" />
        <ExportCard />
        <BackupCard />
        <AppearanceCard />
        <AboutCard />
      </div>
    </>
  );
}

// ---------- Categories ----------

function CategoriesCard({ type }: { type: TxType }) {
  const { refresh } = useData();
  const { dark } = useTheme();
  const [cats] = useLoad(() => listCategories(type), [type], []);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [toDelete, setToDelete] = useState<{ cat: Category; uses: number } | null>(null);

  return (
    <Card>
      <CardHeader
        title={type === "income" ? "Income categories" : "Expense categories"}
        subtitle={type === "income" ? "The services and products you sell" : "What you spend money on"}
        action={
          <Button size="sm" onClick={() =>
              setEditing({ name: "", type, colour: nextColour(cats.map((c) => c.colour)), default_pence: null })
            }>
            <Plus size={14} /> Add
          </Button>
        }
      />
      <ul className="divide-y divide-line px-2 pb-2">
        {cats.map((c) => (
          <li key={c.id} className="group flex items-center justify-between rounded-lg px-3 py-2">
            <span className="flex items-center gap-2.5 text-sm">
              <Swatch colour={themedColour(c.colour, dark)} className="h-3 w-3" /> {c.name}
              {c.default_pence != null && (
                <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-ink-2">
                  {money(c.default_pence)}
                </span>
              )}
            </span>
            <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Button variant="ghost" size="icon" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                <Pencil size={14} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${c.name}`}
                onClick={async () => setToDelete({ cat: c, uses: await categoryUsage(c.id) })}
              >
                <Trash2 size={14} />
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <CategoryForm
        category={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          refresh();
          setEditing(null);
        }}
      />
      <ConfirmModal
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete category?"
        message={
          <>
            <b>{toDelete?.cat.name}</b> will be removed.
            {toDelete?.uses ? ` ${toDelete.uses} existing entries will become “Uncategorised”.` : " It isn't used by any entries."}
          </>
        }
        onConfirm={async () => {
          if (!toDelete) return;
          toastDeleted(await deleteCategory(toDelete.cat.id), refresh);
          refresh();
        }}
      />
    </Card>
  );
}

function CategoryForm({
  category,
  onClose,
  onSaved,
}: {
  category: Partial<Category> | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { dark } = useTheme();
  const [name, setName] = useState("");
  const [colour, setColour] = useState(PALETTE[0].light);
  const [usual, setUsual] = useState("");
  const [last, setLast] = useState<typeof category>(null);
  if (category !== last) {
    setLast(category);
    setName(category?.name ?? "");
    setColour(category?.colour ?? PALETTE[0].light);
    setUsual(category?.default_pence != null ? penceToInput(category.default_pence) : "");
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !name.trim()) return;
    const defaultPence = usual.trim() ? parseAmount(usual) : null;
    if (usual.trim() && defaultPence == null) return;
    if (category.id) {
      await updateCategory({ ...(category as Category), name: name.trim(), colour, default_pence: defaultPence });
    } else {
      await createCategory({ name: name.trim(), type: category.type!, colour, default_pence: defaultPence });
    }
    toast.success(category.id ? "Category updated" : "Category added");
    onSaved();
  };

  return (
    <Modal open={!!category} onClose={onClose} title={category?.id ? "Edit category" : "New category"} width="max-w-sm">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rapid Tan" />
        </Field>
        <Field
          label="Usual price (optional)"
          hint="Fills in the amount when you pick this category on a new entry. Change it any time — entries you've already saved keep their own amount."
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">£</span>
            <Input
              inputMode="decimal"
              placeholder="Leave blank for none"
              className="pl-7 tabular"
              value={usual}
              onChange={(e) => setUsual(e.target.value)}
            />
          </div>
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap gap-2">
            {PALETTE.map((p) => (
              <button
                key={p.light}
                type="button"
                title={p.name}
                onClick={() => setColour(p.light)}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-surface cursor-pointer",
                  colour === p.light && "ring-2 ring-ink",
                )}
                style={{ background: dark ? p.dark : p.light }}
              >
                {colour === p.light && <Check size={14} className="text-white" />}
              </button>
            ))}
          </div>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Export ----------

type Preset = "thisTax" | "lastTax" | "thisYear" | "all" | "custom";

function ExportCard() {
  const now = new Date();
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

  const run = async (kind: "xlsx" | "csv") => {
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
    <Card>
      <CardHeader title="Export" subtitle="For your accountant or Self Assessment tax return" />
      <div className="space-y-4 px-5 pb-5">
        <Field label="Period">
          <Select value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
            {Object.entries(ranges).map(([k, r]) => (
              <option key={k} value={k}>
                {r.label}
              </option>
            ))}
            <option value="custom">Custom dates…</option>
          </Select>
        </Field>
        {preset === "custom" && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} />
            </Field>
            <Field label="To">
              <Input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} />
            </Field>
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy} onClick={() => run("xlsx")}>
            <FileSpreadsheet size={15} /> Excel (.xlsx)
          </Button>
          <Button disabled={busy} onClick={() => run("csv")}>
            <Download size={15} /> CSV
          </Button>
        </div>
        <p className="text-xs text-muted">
          The Excel file includes every transaction, a monthly summary with totals, and your client list.
        </p>
      </div>
    </Card>
  );
}

// ---------- Backup ----------

function BackupCard() {
  const { refresh } = useData();
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wipeText, setWipeText] = useState("");
  const [auto, setAuto] = useState<AutoBackup | null>(() => readAutoBackup());
  const [backingUp, setBackingUp] = useState(false);

  const backUpNow = async () => {
    setBackingUp(true);
    try {
      await runAutoBackup(true);
      setAuto(readAutoBackup());
      toast.success("Backup saved to your folder");
    } catch (e) {
      console.error(e);
      toast.error("Couldn't write to that folder — try choosing it again");
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Backup & restore" subtitle="Your data lives only on this computer — back it up regularly" />
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
            <Download size={15} /> Save backup
          </Button>
          <Button onClick={() => setConfirmRestore(true)}>
            <Upload size={15} /> Restore from backup
          </Button>
        </div>
        <p className="text-xs text-muted">
          Tip: save backups to iCloud Drive, OneDrive or a USB stick. A backup can also be used to move the data to
          another computer.
        </p>
        <div className="border-t border-line pt-4">
          <div className="text-[13px] font-medium">Automatic backups</div>
          {auto ? (
            <>
              <p className="mt-1 break-all text-xs text-ink-2">{auto.dir}</p>
              <p className="mt-1 text-xs text-muted">
                {auto.lastRun ? `Last copy saved ${ukDate(auto.lastRun)}` : "No copy saved yet"} · a copy each day you
                open the app, keeping the last 10
              </p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" disabled={backingUp} onClick={backUpNow}>
                  <Download size={14} /> Back up now
                </Button>
                <Button
                  size="sm"
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
              <p className="mt-0.5 text-xs text-muted">
                Save a copy on its own every day. Pick a folder that syncs — OneDrive or iCloud Drive — and the data is
                safe even if this computer isn't.
              </p>
              <Button
                size="sm"
                className="mt-2"
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
                <FolderCheck size={14} /> Choose a folder…
              </Button>
            </>
          )}
        </div>

        <div className="border-t border-line pt-4">
          <div className="text-[13px] font-medium">Start fresh</div>
          <p className="mt-0.5 text-xs text-muted">Delete all entries, appointments and clients (categories are kept).</p>
          <Button variant="ghost" className="mt-2 -ml-2 text-bad" onClick={() => setConfirmWipe(true)}>
            <Trash2 size={15} /> Delete all data…
          </Button>
        </div>
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

      <Modal open={confirmWipe} onClose={() => setConfirmWipe(false)} title="Delete all data?" width="max-w-sm">
        <p className="text-sm text-ink-2">
          This permanently deletes every entry, appointment and client. Save a backup first if you might need it. Type <b>DELETE</b> to
          confirm.
        </p>
        <Input className="mt-3" value={wipeText} onChange={(e) => setWipeText(e.target.value)} placeholder="DELETE" />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={() => setConfirmWipe(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={wipeText !== "DELETE"}
            onClick={async () => {
              await wipeAll();
              toast.success("All data deleted");
              setWipeText("");
              setConfirmWipe(false);
              refresh();
            }}
          >
            Delete everything
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

// ---------- Appearance ----------

function AppearanceCard() {
  const { pref, setPref } = useTheme();
  return (
    <Card className="self-start">
      <CardHeader title="Appearance" />
      <div className="px-5 pb-5">
        <Segmented<ThemePref>
          value={pref}
          onChange={setPref}
          options={[
            { value: "light", label: <span className="inline-flex items-center gap-1.5"><Sun size={14} /> Light</span> },
            { value: "dark", label: <span className="inline-flex items-center gap-1.5"><Moon size={14} /> Dark</span> },
            { value: "system", label: <span className="inline-flex items-center gap-1.5"><Monitor size={14} /> System</span> },
          ]}
        />
      </div>
    </Card>
  );
}

// ---------- About ----------

function AboutCard() {
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
      <CardHeader title="About" subtitle="Ffyon Business Tracker" />
      <div className="space-y-4 px-5 pb-5">
        <div className="rounded-2xl bg-surface-2 p-3.5">
          <div className="eyebrow text-[10px] text-ink-2">Installed version</div>
          <div className="tabular mt-1.5 font-display text-[22px] leading-none">{version}</div>
        </div>
        <Button
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            try {
              await checkForUpdate(false);
            } catch (e) {
              console.error(e);
              toast.error("Couldn't reach GitHub — check the internet connection");
            } finally {
              setChecking(false);
            }
          }}
        >
          <Download size={15} /> Check for updates
        </Button>
        <p className="text-xs text-muted">
          New versions install themselves when you say so, and the app restarts. Your data isn't touched.
        </p>
      </div>
    </Card>
  );
}
