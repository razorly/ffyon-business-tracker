import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Trash2 } from "lucide-react";
import {
  createClient,
  createTransaction,
  deleteTransaction,
  listCategories,
  listClients,
  updateTransaction,
  type Category,
  type Client,
  type TxType,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { isoDate, money, parseAmount, penceToInput } from "@/lib/format";
import { Button, Field, Input, Modal, Segmented, Select, Textarea } from "./ui";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";

export function EntryDialog() {
  const { entry, closeEntry, refresh } = useData();
  const editing = entry.editing;

  const [type, setType] = useState<TxType>("income");
  const [date, setDate] = useState(isoDate(new Date()));
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState<string>("");
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [description, setDescription] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  // Reset form each time the dialog opens
  useEffect(() => {
    if (!entry.open) return;
    Promise.all([listCategories(), listClients()]).then(([cats, cls]) => {
      setCategories(cats);
      setClients(cls);
      const t = editing?.type ?? entry.type;
      setType(t);
      setDate(editing?.date ?? isoDate(new Date()));
      setAmount(editing ? penceToInput(editing.amount_pence) : "");
      setCategoryId(
        editing ? String(editing.category_id ?? "") : String(cats.find((c) => c.type === t)?.id ?? ""),
      );
      const cid = editing?.client_id ?? entry.clientId ?? null;
      setClient({ id: cid, name: cid ? (cls.find((c) => c.id === cid)?.name ?? "") : "" });
      setDescription(editing?.description ?? "");
      setError(null);
      setTimeout(() => amountRef.current?.focus(), 30);
    });
  }, [entry.open, editing, entry.type, entry.clientId]);

  const typeCategories = categories.filter((c) => c.type === type);

  const switchType = (t: TxType) => {
    setType(t);
    setCategoryId(String(categories.find((c) => c.type === t)?.id ?? ""));
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const pence = parseAmount(amount);
    if (pence == null || pence <= 0) return setError("Enter an amount, e.g. 10 or 12.50");
    if (!date) return setError("Pick a date");
    setSaving(true);
    try {
      let clientId: number | null = null;
      if (type === "income" && client.name.trim()) {
        clientId = client.id ?? (await createClient({ name: client.name }));
      }
      const input = {
        type,
        date,
        amount_pence: pence,
        category_id: categoryId ? Number(categoryId) : null,
        client_id: clientId,
        description: description.trim() || null,
      };
      if (editing) await updateTransaction(editing.id, input);
      else await createTransaction(input);
      toast.success(`${editing ? "Updated" : "Added"} ${type} of ${money(pence)}`);
      refresh();
      closeEntry();
    } catch (err) {
      console.error(err);
      setError("Couldn't save — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    await deleteTransaction(editing.id);
    toast.success("Entry deleted");
    refresh();
    closeEntry();
  };

  return (
    <Modal open={entry.open} onClose={closeEntry} title={editing ? "Edit entry" : "New entry"}>
      <form onSubmit={submit} className="space-y-4">
        <Segmented
          className="w-full"
          value={type}
          onChange={switchType}
          options={[
            {
              value: "income",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <ArrowDownLeft size={14} /> Money in
                </span>
              ),
            },
            {
              value: "expense",
              label: (
                <span className="inline-flex items-center gap-1.5">
                  <ArrowUpRight size={14} /> Money out
                </span>
              ),
            },
          ]}
        />

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">£</span>
              <Input
                ref={amountRef}
                inputMode="decimal"
                placeholder="0.00"
                className="pl-7 tabular"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        <Field label="Category">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Uncategorised</option>
            {typeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        {type === "income" && (
          <Field label="Client">
            <ClientCombobox clients={clients} value={client} onChange={setClient} />
          </Field>
        )}

        <Field label="Note">
          <Textarea
            placeholder={type === "income" ? "e.g. Full body, dark shade" : "e.g. 1L solution from supplier"}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          {editing ? (
            <Button type="button" variant="ghost" className="text-bad" onClick={remove}>
              <Trash2 size={15} /> Delete
            </Button>
          ) : (
            <span className="text-xs text-muted">Tip: Ctrl/⌘ + N opens this anywhere</span>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={closeEntry}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {editing ? "Save changes" : "Add entry"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
