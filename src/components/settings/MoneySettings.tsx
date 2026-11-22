import { useState } from "react";
import { toast } from "sonner";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { categoryUsage, createCategory, deleteCategory, listCategories, listOtherIncomeCategories, updateCategory, type Category, type TxType } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { money, parseAmount, penceToInput } from "@/lib/format";
import { nextColour, PALETTE, themedColour } from "@/lib/palette";
import { useTheme } from "@/lib/theme";
import { toastDeleted } from "@/lib/undo";
import { cn } from "@/lib/utils";
import { Actions, Button, Card, CardHeader, ConfirmModal, ErrorText, Field, Input, LoadError, Modal, MoneyInput, Swatch } from "@/components/ui";
import { Help } from "./parts";

/** The labels she files money under: other income (tips, product sales) or what she spends on. */
export function CategoriesCard({ type }: { type: TxType }) {
  const { refresh } = useData();
  const { dark } = useTheme();
  const [cats, loading, loadError] = useLoad(() => type === "income" ? listOtherIncomeCategories() : listCategories(type), [type], []);
  const [editing, setEditing] = useState<Partial<Category> | null>(null);
  const [toDelete, setToDelete] = useState<{ cat: Category; uses: number } | null>(null);

  return (
    <Card>
      <CardHeader
        title={type === "income" ? "Other income" : "Expense categories"}
        subtitle={type === "income" ? "Tips, product sales and anything else outside appointments" : "What you spend money on"}
        action={
          <Button aria-label={type === "income" ? "Add other income" : "Add expense category"} onClick={() =>
            setEditing({ name: "", type, colour: nextColour(cats.map((c) => c.colour)), default_pence: null, income_kind: type === "income" ? "other" : undefined })
          }>
            <Plus size={18} aria-hidden /> Add
          </Button>
        }
      />
      {loadError && <div className="px-5"><LoadError error={loadError} onRetry={refresh} /></div>}
      {!cats.length && !loading && !loadError && <Help className="px-5 pb-4">{type === "income" ? "Nothing here yet. Add one for tips or product sales." : "No categories yet."}</Help>}
      {cats.length > 0 && <ul className="divide-y divide-line border-t border-line">
        {cats.map((c) => (
          <li key={c.id} className="flex items-center gap-2 py-1 pl-5 pr-2">
            <Swatch colour={themedColour(c.colour, dark)} className="h-3 w-3" />
            <span className="min-w-0 flex-1 break-words py-1.5 pl-1">
              {c.name}
              {type === "expense" && c.default_pence != null && <span className="tabular ml-2 text-small text-ink-2">usually {money(c.default_pence)}</span>}
            </span>
            <span className="flex shrink-0">
              <Button variant="ghost" size="icon" onClick={() => setEditing(c)} title={`Edit ${c.name}`} aria-label={`Edit ${c.name}`}>
                <Pencil size={18} aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${c.name}`}
                title={`Delete ${c.name}`}
                onClick={async () => { try { setToDelete({ cat: c, uses: await categoryUsage(c.id) }); } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Couldn't check what uses this. Try again."); } }}
              >
                <Trash2 size={18} aria-hidden />
              </Button>
            </span>
          </li>
        ))}
      </ul>}

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
        title={type === "income" ? "Delete other income item?" : "Delete category?"}
        message={
          <>
            <b className="font-semibold text-ink">{toDelete?.cat.name}</b> will be removed.
            {toDelete?.uses ? ` ${toDelete.uses} recorded ${toDelete.uses === 1 ? "entry keeps its amount and label" : "entries keep their amounts and labels"}.` : " Nothing you've recorded uses it."}
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

function CategoryForm({ category, onClose, onSaved }: { category: Partial<Category> | null; onClose: () => void; onSaved: () => void }) {
  const { dark } = useTheme();
  const [name, setName] = useState("");
  const [colour, setColour] = useState(PALETTE[0].light);
  const [usual, setUsual] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [last, setLast] = useState<typeof category>(null);
  if (category !== last) {
    setLast(category);
    setName(category?.name ?? "");
    setColour(category?.colour ?? PALETTE[0].light);
    setUsual(category?.default_pence != null ? penceToInput(category.default_pence) : "");
    setError("");
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!category || !name.trim() || busy) return;
    const defaultPence = category.type === "expense" && usual.trim() ? parseAmount(usual) : null;
    if (category.type === "expense" && usual.trim() && defaultPence == null) { setError("Enter an amount like 12.50, or leave it blank."); return; }
    setBusy(true);
    setError("");
    try {
      if (category.id) {
        await updateCategory({ ...(category as Category), name: name.trim(), colour, default_pence: defaultPence });
      } else {
        await createCategory({ name: name.trim(), type: category.type!, colour, default_pence: defaultPence, ...(category.type === "income" ? { income_kind: "other" as const } : {}) });
      }
      toast.success(category.type === "income" ? category.id ? "Other income updated" : "Other income added" : category.id ? "Category updated" : "Category added");
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't save. Try again.");
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!category} onClose={() => { if (!busy) onClose(); }} title={category?.type === "income" ? category?.id ? "Edit other income" : "Add other income" : category?.id ? "Edit expense category" : "Add expense category"} width="max-w-sm">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoFocus required maxLength={100} disabled={busy} value={name} onChange={(e) => setName(e.target.value)} placeholder={category?.type === "income" ? "e.g. Tips" : "e.g. Supplies"} />
        </Field>
        {category?.type === "expense" && <Field label="Usual amount (optional)" hint="Fills in the amount when you pick this category.">
          <MoneyInput disabled={busy} placeholder="None" value={usual} onChange={(e) => setUsual(e.target.value)} />
        </Field>}
        <div>
          <span className="mb-1.5 block text-small font-medium text-ink">Colour</span>
          <div role="group" aria-label="Colour" className="flex flex-wrap gap-2">
            {PALETTE.map((p) => (
              <button
                key={p.light}
                type="button"
                disabled={busy}
                title={p.name}
                aria-label={p.name}
                aria-pressed={colour === p.light}
                onClick={() => setColour(p.light)}
                className={cn("flex h-10 w-10 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-surface", colour === p.light && "ring-2 ring-ink")}
                style={{ background: dark ? p.dark : p.light }}
              >
                {colour === p.light && <Check size={18} className="text-white" aria-hidden />}
              </button>
            ))}
          </div>
        </div>
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          <Button disabled={busy} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>{busy ? "Saving…" : "Save"}</Button>
        </Actions>
      </form>
    </Modal>
  );
}
