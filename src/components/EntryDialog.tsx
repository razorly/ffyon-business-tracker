import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, CalendarPlus, Trash2 } from "lucide-react";
import {
  createClient,
  createTransaction,
  deleteTransaction,
  listAppointments,
  listCategories,
  listClients,
  listOtherIncomeCategories,
  updateTransaction,
  type AppointmentRow,
  type Category,
  type Client,
  type TransactionInput,
  type TxType,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { isoDate, money, parseAmount, penceToInput } from "@/lib/format";
import { listServices, type CloudService } from "@/lib/sync";
import { toastDeleted } from "@/lib/undo";
import { Button, Field, Input, Modal, Segmented, Select, Textarea } from "./ui";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";

type IncomeSource = "service" | "other" | "legacy";
const HISTORICAL_SERVICE = "__historical_service__";

export function EntryDialog() {
  const { entry, closeEntry, openNewAppointment, refresh } = useData();
  const editing = entry.editing;

  const [type, setType] = useState<TxType>("income");
  const [incomeSource, setIncomeSource] = useState<IncomeSource>("other");
  const [date, setDate] = useState(isoDate(new Date()));
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [linkedAppointment, setLinkedAppointment] = useState<AppointmentRow | null>(null);
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [description, setDescription] = useState("");
  const [expenseCategories, setExpenseCategories] = useState<Category[]>([]);
  const [otherCategories, setOtherCategories] = useState<Category[]>([]);
  const [services, setServices] = useState<CloudService[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [amountIsDefault, setAmountIsDefault] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!entry.open) return;
    let alive = true;
    setLoading(true);
    setLoaded(false);
    setError(null);
    Promise.all([listCategories("expense"), listOtherIncomeCategories(), listClients(),
      editing ? listServices() : Promise.resolve([]), editing ? listAppointments() : Promise.resolve([])])
      .then(([expenses, other, cls, catalog, bookings]) => {
        if (!alive) return;
        const active = catalog.filter((service) => service.active);
        const t = editing?.type ?? entry.type;
        const linked = editing ? bookings.find((a) => a.transaction_id === editing.id) ?? null : null;
        const defaultAmount = !editing && t === "expense" ? expenses[0]?.default_pence ?? null : null;
        setExpenseCategories(expenses);
        setOtherCategories(other);
        setClients(cls);
        setServices(active);
        setLinkedAppointment(linked);
        setType(t);
        setIncomeSource(editing?.type === "income" ? editing.income_kind === "other" ? "other"
          : editing.service_id || editing.service_name ? "service" : "legacy" : "other");
        setServiceId(editing?.type === "income" && (editing.service_id || editing.service_name)
          ? editing.service_id ?? HISTORICAL_SERVICE : "");
        setDate(editing?.date ?? isoDate(new Date()));
        setAmount(editing ? penceToInput(editing.amount_pence) : defaultAmount != null ? penceToInput(defaultAmount) : "");
        setAmountIsDefault(!editing && defaultAmount != null);
        setCategoryId(editing ? String(editing.category_id ?? "") : t === "expense" ? String(expenses[0]?.id ?? "") : "");
        const cid = editing?.client_id ?? entry.clientId ?? null;
        setClient({ id: cid, name: cid ? cls.find((c) => c.id === cid)?.name ?? "" : "" });
        setDescription(editing?.description ?? "");
        setLoaded(true);
        setTimeout(() => alive && amountRef.current?.focus(), 30);
      })
      .catch(() => { if (alive) setError("Couldn't load your payment details. Close this entry and try again."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entry.open, editing, entry.type, entry.clientId]);

  const selectedService = services.find((s) => s.id === serviceId);
  const typeCategories = type === "expense" ? expenseCategories : otherCategories;
  const historicalServiceSelected = !!editing && type === "income" && incomeSource === "service"
    && (editing.service_id || editing.service_name) && serviceId === (editing.service_id ?? HISTORICAL_SERVICE);
  const savedService = !!editing && (editing.service_id || editing.service_name);

  const incomeChoices: { value: string; label: string; source: IncomeSource; id: string }[] = [
    { value: "other:", label: "Other income", source: "other", id: "" },
    ...otherCategories.map(category => ({ value: `other:${category.id}`, label: editing?.type === "income" && editing.category_id === category.id && editing.income_kind === "other"
      ? editing.category_name_snapshot || category.name : category.name, source: "other" as const, id: String(category.id) })),
  ];
  if (editing) {
    if (editing.type === "income" && editing.income_kind === "other" && editing.category_id != null && !otherCategories.some(category => category.id === editing.category_id)) {
      incomeChoices.push({ value: `other:${editing.category_id}`, label: editing.category_name_snapshot || editing.category_name || "Historical category", source: "other", id: String(editing.category_id) });
    }
    incomeChoices.push(...services.map(service => ({ value: `service:${service.id}`, label: editing.service_id === service.id && editing.service_name ? editing.service_name : service.name, source: "service" as const, id: service.id })));
    if (savedService && !services.some(service => service.id === editing.service_id)) {
      incomeChoices.push({ value: `service:${editing.service_id ?? HISTORICAL_SERVICE}`, label: `${editing.service_name || editing.category_name_snapshot || "Historical service"} (archived)`, source: "service", id: editing.service_id ?? HISTORICAL_SERVICE });
    }
    if (editing.type === "income" && !savedService && editing.income_kind !== "other") {
      incomeChoices.push({ value: "legacy:", label: editing.category_name_snapshot || editing.category_name || "Historical income", source: "legacy", id: "" });
    }
  }

  const applyDefault = (pence: number | null) => {
    if (editing) return;
    if (!amount.trim() || amountIsDefault) {
      setAmount(pence != null ? penceToInput(pence) : "");
      setAmountIsDefault(pence != null);
    }
  };

  const pickIncomeType = (value: string) => {
    const choice = incomeChoices.find(item => item.value === value);
    if (!choice) return;
    setIncomeSource(choice.source);
    setCategoryId(choice.source === "other" ? choice.id : "");
    setServiceId(choice.source === "service" ? choice.id : "");
    applyDefault(null);
  };

  const switchType = (value: TxType) => {
    if (value === type) return;
    setType(value);
    setCategoryId(value === "expense" ? String(expenseCategories[0]?.id ?? "") : "");
    setIncomeSource("other");
    applyDefault(value === "expense" ? expenseCategories[0]?.default_pence ?? null : null);
  };

  const switchEntryMode = (value: TxType | "appointment") => {
    if (value !== "appointment") return switchType(value);
    if (editing) return;
    closeEntry();
    openNewAppointment({
      date: loaded ? date : isoDate(new Date()),
      start_time: "09:00",
      clientId: (loaded ? client.id : entry.clientId) ?? undefined,
      clientName: loaded ? client.name : undefined,
    });
  };

  const pickCategory = (id: string) => {
    setCategoryId(id);
    if (type === "expense") applyDefault(expenseCategories.find((category) => String(category.id) === id)?.default_pence ?? null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving || !loaded) return;
    const pence = parseAmount(amount);
    if (pence == null || !Number.isSafeInteger(pence) || pence <= 0) return setError("Enter an amount, e.g. 10 or 12.50");
    if (!date) return setError("Pick a date");
    if (!linkedAppointment && type === "income" && incomeSource === "service" && !selectedService && !historicalServiceSelected) return setError("Choose an income type");
    setSaving(true);
    setError(null);
    try {
      let clientId: number | null = linkedAppointment ? editing!.client_id : null;
      if (!linkedAppointment && type === "income" && client.name.trim()) {
        clientId = client.id ?? await createClient({ name: client.name });
      }
      const preserveAttribution = !!editing && type === editing.type && (type === "expense"
        ? categoryId === String(editing.category_id ?? "")
        : !!linkedAppointment || incomeSource === "legacy" || historicalServiceSelected
          || (incomeSource === "other" && editing.income_kind === "other" && categoryId === String(editing.category_id ?? "")));
      const incomeService = type === "income" && incomeSource === "service" && !preserveAttribution ? selectedService : null;
      const input: TransactionInput = {
        type,
        date,
        amount_pence: pence,
        category_id: type === "income" && preserveAttribution ? editing!.category_id : incomeService ? null : categoryId ? Number(categoryId) : null,
        client_id: clientId,
        description: description.trim() || null,
        service_id: preserveAttribution ? editing!.service_id : incomeService?.id ?? null,
        service_name: preserveAttribution ? editing!.service_name : incomeService?.name ?? "",
        category_name_snapshot: preserveAttribution ? editing!.category_name_snapshot : incomeService?.name
          ?? typeCategories.find((c) => String(c.id) === categoryId)?.name
          ?? (type === "income" ? "Other income" : ""),
        ...(!preserveAttribution ? { income_kind: type === "expense" ? null : incomeService ? "service" as const : "other" as const } : {}),
      };
      if (editing) await updateTransaction(editing.id, input);
      else await createTransaction(input);
      toast.success(`${editing ? "Updated" : "Recorded"} ${type === "income" ? "income" : "expense"} of ${money(pence)}`);
      refresh();
      closeEntry();
    } catch (err) {
      console.error(err);
      setError("Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      toastDeleted(await deleteTransaction(editing.id), refresh);
      refresh();
      closeEntry();
    } catch {
      setError("Couldn't delete this entry. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={entry.open} onClose={closeEntry} title={editing ? "Edit entry" : "New entry"}>
      <form onSubmit={submit} className="space-y-4">
        {linkedAppointment ? (
          <p className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            {type === "income" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}
            {type === "income" ? "Money in" : "Money out"}
          </p>
        ) : (
          <Segmented<TxType | "appointment"> className={editing ? "w-full" : "w-full flex-col rounded-xl sm:flex-row sm:rounded-full"} value={type} onChange={switchEntryMode} options={[
            ...(!editing ? [{ value: "appointment" as const, label: <span className="inline-flex items-center gap-1.5"><CalendarPlus size={14} /> Appointment</span> }] : []),
            { value: "income", label: <span className="inline-flex items-center gap-1.5"><ArrowDownLeft size={14} /> Money in</span> },
            { value: "expense", label: <span className="inline-flex items-center gap-1.5"><ArrowUpRight size={14} /> Money out</span> },
          ]} />
        )}

        {editing && type === "income" && linkedAppointment ? (
          <Field label="Appointment payment">
            <Input readOnly value={editing.service_name || editing.category_name_snapshot || editing.category_name || "Other income"} />
          </Field>
        ) : type === "income" ? (
          <Field label="Income type">
            <Select value={incomeSource === "service" ? `service:${serviceId}` : incomeSource === "legacy" ? "legacy:" : `other:${categoryId}`} onChange={event => pickIncomeType(event.target.value)} disabled={loading}>
              {editing ? (["other", "service", "legacy"] as const).map(source => {
                const choices = incomeChoices.filter(choice => choice.source === source);
                return choices.length > 0 && <optgroup key={source} label={source === "other" ? "Other income" : source === "service" ? "Service payments" : "Historical income"}>
                  {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </optgroup>;
              }) : incomeChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label="Expense category">
            <Select value={categoryId} onChange={(event) => pickCategory(event.target.value)} disabled={loading}>
              <option value="">Uncategorised</option>
              {typeCategories.map((category) => <option key={category.id} value={category.id}>
                {editing?.type === type && editing.category_id === category.id ? editing.category_name_snapshot || category.name : category.name}
              </option>)}
              {editing?.type === "expense" && editing.category_id != null
                && !typeCategories.some((category) => category.id === editing.category_id)
                && <option value={editing.category_id}>{editing.category_name_snapshot || editing.category_name || "Historical category"}</option>}
            </Select>
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">£</span>
              <Input ref={amountRef} inputMode="decimal" placeholder="0.00" className="pl-7 tabular" value={amount}
                onChange={(event) => { setAmount(event.target.value); setAmountIsDefault(false); }} disabled={loading} />
            </div>
          </Field>
          <Field label="Date">
            <Input type="date" value={date} readOnly={!!linkedAppointment}
              onChange={(event) => setDate(event.target.value)} disabled={loading} />
          </Field>
        </div>
        {linkedAppointment && <p className="-mt-2 text-xs text-muted">
          {linkedAppointment.client_name ?? "Appointment"}{linkedAppointment.price_pence != null ? ` · Agreed price ${money(linkedAppointment.price_pence)}` : ""}
        </p>}

        {type === "income" && (
          <Field label="Client (optional)">
            {linkedAppointment ? <Input readOnly value={client.name} /> : <ClientCombobox clients={clients} value={client} onChange={setClient} />}
          </Field>
        )}

        <Field label="Note">
          <Textarea placeholder={type === "income" ? "e.g. Product sale or tip" : "e.g. 1L solution from supplier"}
            value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {editing ? <Button type="button" variant="ghost" className="text-bad" onClick={remove} disabled={saving || loading || !loaded}>
            <Trash2 size={15} /> Delete
          </Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" onClick={closeEntry}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={saving || loading || !loaded}>
              {editing ? "Save changes" : type === "income" ? "Record income" : "Add expense"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
