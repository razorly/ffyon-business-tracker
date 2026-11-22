import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownLeft, ArrowUpRight, Trash2 } from "lucide-react";
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
import { subDays } from "date-fns";
import { isoDate, money, moneyNeat, parseAmount, penceToInput } from "@/lib/format";
import { businessNow } from "@/lib/dates";
import { listServices, type CloudService } from "@/lib/sync";
import { toastDeleted } from "@/lib/undo";
import { Actions, Button, Chip, ErrorText, Field, Input, Loading, Modal, MoneyInput, Select, Textarea } from "./ui";
import { ChoiceGroup } from "./BookingPickers";
import { EntryModeSwitch, type EntryMode } from "./EntryModeSwitch";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";

type IncomeSource = "service" | "other" | "legacy";
const HISTORICAL_SERVICE = "__historical_service__";
/** Past this many categories, chips would fill the screen: a drop-down takes over. */
const MAX_CHIPS = 8;

export function EntryDialog() {
  const { entry, closeEntry, switchEntryToAppointment, refresh } = useData();
  const editing = entry.editing;

  const [type, setType] = useState<TxType>("income");
  const [incomeSource, setIncomeSource] = useState<IncomeSource>("other");
  const [date, setDate] = useState(() => isoDate(businessNow()));
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
  const [loadedFor, setLoadedFor] = useState<typeof entry | null>(null);
  const ready = loaded && loadedFor === entry;
  const [saving, setSaving] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!entry.open) return;
    let alive = true;
    setLoading(true);
    setLoaded(false);
    setLoadedFor(null);
    setError(null);
    // Show the chosen mode straight away; the rest of the form fills in once loaded.
    setType(editing?.type ?? entry.type);
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
        setDate(editing?.date ?? isoDate(businessNow()));
        setAmount(editing ? penceToInput(editing.amount_pence) : defaultAmount != null ? penceToInput(defaultAmount) : "");
        setAmountIsDefault(!editing && defaultAmount != null);
        setCategoryId(editing ? String(editing.category_id ?? "") : t === "expense" ? String(expenses[0]?.id ?? "") : "");
        const cid = editing?.client_id ?? entry.clientId ?? null;
        setClient({ id: cid, name: cid ? cls.find((c) => c.id === cid)?.name ?? "" : entry.clientName ?? "" });
        setDescription(editing?.description ?? "");
        setLoaded(true);
        setLoadedFor(entry);
        setTimeout(() => alive && amountRef.current?.focus(), 30);
      })
      .catch(() => { if (alive) setError("Couldn't load your payment details. Close this entry and try again."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [entry.open, editing, entry.type, entry.clientId, entry.clientName]);

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

  const switchEntryMode = (value: EntryMode) => {
    if (value !== "appointment") return switchType(value);
    if (editing) return;
    // Whatever has been typed so far carries over, so switching never loses the client.
    switchEntryToAppointment({
      date: ready ? date : isoDate(businessNow()),
      start_time: "09:00",
      clientId: (ready ? client.id : entry.clientId) ?? undefined,
      clientName: ready ? client.name : entry.clientName,
    });
  };

  const pickCategory = (id: string) => {
    setCategoryId(id);
    if (type === "expense") applyDefault(expenseCategories.find((category) => String(category.id) === id)?.default_pence ?? null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (loading || saving || !ready) return;
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
      if (editing) await updateTransaction(editing.id, input, editing);
      else await createTransaction(input);
      toast.success(`${editing ? "Updated" : "Recorded"} ${type === "income" ? "income" : "expense"} of ${money(pence)}`);
      refresh();
      closeEntry();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Couldn't save. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      toastDeleted(await deleteTransaction(editing.id, editing), refresh);
      refresh();
      closeEntry();
    } catch {
      setError("Couldn't delete this entry. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const todayIso = isoDate(businessNow());
  const yesterdayIso = isoDate(subDays(businessNow(), 1));
  const categoryName = (category: Category) => editing?.type === type && editing.category_id === category.id ? editing.category_name_snapshot || category.name : category.name;
  // An edited expense may sit in a category that has since been removed; it stays choosable.
  const historicalExpense = editing?.type === "expense" && editing.category_id != null && !typeCategories.some((category) => category.id === editing.category_id)
    ? { id: String(editing.category_id), name: editing.category_name_snapshot || editing.category_name || "Historical category" } : null;
  const appointmentHint = "Paid for an appointment? Mark it paid from the appointment or Today instead.";

  return (
    <Modal open={entry.open} onClose={() => { if (!saving) closeEntry(); }} title={editing ? "Edit entry" : "New"}>
      {loading && <Loading label="Loading entry details" className="px-0 pb-3 pt-0" />}
      <form onSubmit={submit}><fieldset disabled={loading || saving || !ready} className="flex min-w-0 flex-col gap-4">
        {linkedAppointment ? (
          <p className="flex items-center gap-2 text-small text-ink-2">
            {type === "income" ? <ArrowDownLeft size={16} aria-hidden /> : <ArrowUpRight size={16} aria-hidden />}
            {type === "income" ? "Money in" : "Money out"}
          </p>
        ) : (
          <EntryModeSwitch value={type} onChange={switchEntryMode} modes={editing ? ["income", "expense"] : undefined} />
        )}

        {editing && type === "income" && linkedAppointment ? (
          <Field label="Appointment payment">
            <Input readOnly value={editing.service_name || editing.category_name_snapshot || editing.category_name || "Other income"} />
          </Field>
        ) : type === "income" && (editing || otherCategories.length > 0) ? (
          <Field label="Income type" hint={editing ? undefined : appointmentHint}>
            <Select value={incomeSource === "service" ? `service:${serviceId}` : incomeSource === "legacy" ? "legacy:" : `other:${categoryId}`} onChange={event => pickIncomeType(event.target.value)} disabled={loading}>
              {editing ? (["other", "service", "legacy"] as const).map(source => {
                const choices = incomeChoices.filter(choice => choice.source === source);
                return choices.length > 0 && <optgroup key={source} label={source === "other" ? "Other income" : source === "service" ? "Service payments" : "Historical income"}>
                  {choices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                </optgroup>;
              }) : incomeChoices.map(choice => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
            </Select>
          </Field>
        ) : type === "income" ? (
          <p className="text-small text-ink-2">For tips, product sales and other income. {appointmentHint}</p>
        ) : typeCategories.length + (historicalExpense ? 1 : 0) > MAX_CHIPS ? (
          <Field label="Expense category">
            <Select value={categoryId} onChange={(event) => pickCategory(event.target.value)} disabled={loading}>
              <option value="">Uncategorised</option>
              {typeCategories.map((category) => <option key={category.id} value={category.id}>{categoryName(category)}</option>)}
              {historicalExpense && <option value={historicalExpense.id}>{historicalExpense.name}</option>}
            </Select>
          </Field>
        ) : (
          <ChoiceGroup label="Expense category">
            <div className="flex min-w-0 flex-wrap gap-2">
              {typeCategories.map((category) => (
                <Chip key={category.id} selected={categoryId === String(category.id)} onClick={() => pickCategory(String(category.id))} className="min-w-0 max-w-full shrink">
                  <span className="truncate">{categoryName(category)}</span>
                  {category.default_pence != null && <span className="tabular font-normal opacity-85">{moneyNeat(category.default_pence)}</span>}
                </Chip>
              ))}
              {historicalExpense && <Chip selected={categoryId === historicalExpense.id} onClick={() => pickCategory(historicalExpense.id)} className="min-w-0 max-w-full shrink"><span className="truncate">{historicalExpense.name}</span></Chip>}
              <Chip selected={categoryId === ""} onClick={() => pickCategory("")}>Uncategorised</Chip>
            </div>
          </ChoiceGroup>
        )}

        <Field label="Amount">
          <MoneyInput ref={amountRef} value={amount} onChange={(event) => { setAmount(event.target.value); setAmountIsDefault(false); }} disabled={loading} />
        </Field>

        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-end gap-2">
            <Field label="Date" className="min-w-40 flex-1">
              <Input type="date" value={date} readOnly={!!linkedAppointment} onChange={(event) => setDate(event.target.value)} disabled={loading} />
            </Field>
            {!linkedAppointment && <>
              <Chip selected={date === todayIso} onClick={() => setDate(todayIso)}>Today</Chip>
              <Chip selected={date === yesterdayIso} onClick={() => setDate(yesterdayIso)}>Yesterday</Chip>
            </>}
          </div>
          {linkedAppointment && <p className="mt-1.5 text-small text-ink-2">
            {linkedAppointment.client_name ?? "Appointment"}{linkedAppointment.price_pence != null ? <> · Agreed price <span className="tabular">{money(linkedAppointment.price_pence)}</span></> : ""}
          </p>}
        </div>

        {type === "income" && (
          <Field label="Client (optional)">
            {linkedAppointment ? <Input readOnly value={client.name} /> : <ClientCombobox clients={clients} value={client} onChange={setClient} />}
          </Field>
        )}

        <Field label="Note">
          <Textarea placeholder={type === "income" ? "e.g. Product sale or tip" : "e.g. 1L solution from supplier"}
            value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>

        {error && <ErrorText>{error}</ErrorText>}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {editing && <Button type="button" variant="ghost" className="text-bad hover:text-bad" onClick={remove} disabled={saving || loading || !loaded}>
            <Trash2 size={16} aria-hidden /> Delete
          </Button>}
          <Actions className="ml-auto pt-0">
            <Button type="button" disabled={saving} onClick={closeEntry}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={saving || loading || !loaded}>
              {editing ? "Save changes" : type === "income" ? "Record income" : "Record expense"}
            </Button>
          </Actions>
        </div>
      </fieldset></form>
    </Modal>
  );
}
