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
  markAppointmentPaid,
  updateTransaction,
  type AppointmentRow,
  type Category,
  type Client,
  type TransactionInput,
  type TxType,
} from "@/lib/db";
import { useData } from "@/lib/data";
import { isoDate, money, parseAmount, penceToInput, shortDate, timeLabel } from "@/lib/format";
import { listServices, serviceDiscountPrice, type CloudService } from "@/lib/sync";
import { toastDeleted } from "@/lib/undo";
import { Button, Field, Input, Modal, Segmented, Select, Textarea } from "./ui";
import { ClientCombobox, type ClientChoice } from "./ClientCombobox";

type PaymentFor = "service" | "appointment" | "other" | "legacy";
const HISTORICAL_SERVICE = "__historical_service__";

export function EntryDialog() {
  const { entry, closeEntry, refresh } = useData();
  const editing = entry.editing;

  const [type, setType] = useState<TxType>("income");
  const [paymentFor, setPaymentFor] = useState<PaymentFor>("service");
  const [date, setDate] = useState(isoDate(new Date()));
  const [standaloneDate, setStandaloneDate] = useState(isoDate(new Date()));
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [appointmentId, setAppointmentId] = useState("");
  const [linkedAppointment, setLinkedAppointment] = useState<AppointmentRow | null>(null);
  const [client, setClient] = useState<ClientChoice>({ id: null, name: "" });
  const [description, setDescription] = useState("");
  const [expenseCategories, setExpenseCategories] = useState<Category[]>([]);
  const [otherCategories, setOtherCategories] = useState<Category[]>([]);
  const [services, setServices] = useState<CloudService[]>([]);
  const [appointments, setAppointments] = useState<AppointmentRow[]>([]);
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
    Promise.all([listCategories("expense"), listOtherIncomeCategories(), listClients(), listServices(), listAppointments()])
      .then(([expenses, other, cls, catalog, bookings]) => {
        if (!alive) return;
        const active = catalog.filter((service) => service.active);
        const t = editing?.type ?? entry.type;
        const firstService = active[0];
        const linked = editing ? bookings.find((a) => a.transaction_id === editing.id) ?? null : null;
        const defaultAmount = editing ? null : t === "expense" ? expenses[0]?.default_pence ?? null : firstService
          ? serviceDiscountPrice(firstService.price_pence, firstService.discount_percent ?? 0) : null;
        setExpenseCategories(expenses);
        setOtherCategories(other);
        setClients(cls);
        setServices(active);
        setAppointments(bookings.filter((a) => a.status === "confirmed" && a.transaction_id == null));
        setLinkedAppointment(linked);
        setType(t);
        setPaymentFor(editing?.type === "income" ? editing.income_kind === "other" ? "other"
          : editing.service_id || editing.service_name ? "service" : "legacy" : "service");
        setServiceId(editing?.type === "income" && (editing.service_id || editing.service_name)
          ? editing.service_id ?? HISTORICAL_SERVICE : firstService?.id ?? "");
        setAppointmentId("");
        setDate(editing?.date ?? isoDate(new Date()));
        setStandaloneDate(editing?.date ?? isoDate(new Date()));
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
  const selectedAppointment = appointments.find((a) => String(a.id) === appointmentId);
  const appointmentPayment = !editing && type === "income" && paymentFor === "appointment";
  const fixedBooking = linkedAppointment ?? (appointmentPayment ? selectedAppointment : null);
  const typeCategories = type === "expense" ? expenseCategories : otherCategories;
  const historicalServiceSelected = !!editing && type === "income" && paymentFor === "service"
    && (editing.service_id || editing.service_name) && serviceId === (editing.service_id ?? HISTORICAL_SERVICE);
  const savedService = !!editing && (editing.service_id || editing.service_name);

  const applyDefault = (pence: number | null) => {
    if (editing) return;
    if (!amount.trim() || amountIsDefault) {
      setAmount(pence != null ? penceToInput(pence) : "");
      setAmountIsDefault(pence != null);
    }
  };

  const pickService = (id: string) => {
    setServiceId(id);
    const service = services.find((s) => s.id === id);
    applyDefault(service ? serviceDiscountPrice(service.price_pence, service.discount_percent ?? 0) : null);
  };

  const pickPaymentFor = (value: PaymentFor) => {
    setPaymentFor(value);
    if (value !== "appointment" && paymentFor === "appointment") setDate(standaloneDate);
    setCategoryId(editing?.income_kind === "other" && value === "other" ? String(editing.category_id ?? "") : "");
    if (value === "service") {
      applyDefault(selectedService ? serviceDiscountPrice(selectedService.price_pence, selectedService.discount_percent ?? 0) : null);
    } else if (value === "appointment") {
      applyDefault(selectedAppointment?.price_pence ?? null);
      if (selectedAppointment) setDate(selectedAppointment.date);
    } else {
      applyDefault(null);
    }
  };

  const pickAppointment = (id: string) => {
    setAppointmentId(id);
    const booking = appointments.find((a) => String(a.id) === id);
    applyDefault(booking?.price_pence ?? null);
    if (booking) setDate(booking.date);
  };

  const switchType = (value: TxType) => {
    setType(value);
    if (paymentFor === "appointment") setDate(standaloneDate);
    setCategoryId(value === "expense" ? String(expenseCategories[0]?.id ?? "") : "");
    setPaymentFor("service");
    if (value === "income") {
      applyDefault(selectedService ? serviceDiscountPrice(selectedService.price_pence, selectedService.discount_percent ?? 0) : null);
    } else {
      applyDefault(expenseCategories[0]?.default_pence ?? null);
    }
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
    if (!linkedAppointment && type === "income" && paymentFor === "service" && !selectedService && !historicalServiceSelected) return setError("Choose a service");
    if (appointmentPayment && !selectedAppointment) return setError("Choose an unpaid appointment");
    setSaving(true);
    setError(null);
    try {
      if (appointmentPayment && selectedAppointment) {
        await markAppointmentPaid(selectedAppointment.id, pence);
      } else {
        let clientId: number | null = linkedAppointment ? editing!.client_id : null;
        if (!linkedAppointment && type === "income" && client.name.trim()) {
          clientId = client.id ?? await createClient({ name: client.name });
        }
        const preserveAttribution = !!editing && type === editing.type && (type === "expense"
          ? categoryId === String(editing.category_id ?? "")
          : !!linkedAppointment || paymentFor === "legacy" || historicalServiceSelected
            || (paymentFor === "other" && editing.income_kind === "other" && categoryId === String(editing.category_id ?? "")));
        const incomeService = type === "income" && paymentFor === "service" && !preserveAttribution ? selectedService : null;
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
      }
      toast.success(`${editing ? "Updated" : "Recorded"} ${type === "income" ? "payment" : "expense"} of ${money(pence)}`);
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
          <Segmented className="w-full" value={type} onChange={switchType} options={[
            { value: "income", label: <span className="inline-flex items-center gap-1.5"><ArrowDownLeft size={14} /> Money in</span> },
            { value: "expense", label: <span className="inline-flex items-center gap-1.5"><ArrowUpRight size={14} /> Money out</span> },
          ]} />
        )}

        {!linkedAppointment && type === "income" && <Field label="Payment for">
          <Select value={paymentFor} onChange={(event) => pickPaymentFor(event.target.value as PaymentFor)} disabled={loading}>
            <option value="service">Service payment</option>
            {!editing && <option value="appointment">Appointment payment</option>}
            <option value="other">Other income</option>
            {editing && !savedService && editing.income_kind !== "other" && <option value="legacy">Historical income</option>}
          </Select>
        </Field>}

        {editing && type === "income" && (linkedAppointment || paymentFor === "legacy") ? (
          <Field label={linkedAppointment ? "Appointment payment" : "Historical income"}>
            <Input readOnly value={editing.service_name || editing.category_name_snapshot || editing.category_name || "Other income"} />
          </Field>
        ) : type === "income" && paymentFor === "service" ? (
          <Field label="Service">
            <Select value={serviceId} onChange={(event) => pickService(event.target.value)} disabled={loading}>
              <option value="">Choose service</option>
              {services.map((service) => <option key={service.id} value={service.id}>
                {editing?.service_id === service.id && editing.service_name ? editing.service_name : service.name}
              </option>)}
              {savedService && !services.some((service) => service.id === editing.service_id)
                && <option value={editing.service_id ?? HISTORICAL_SERVICE}>{editing.service_name || editing.category_name_snapshot || "Historical service"} (archived)</option>}
            </Select>
          </Field>
        ) : appointmentPayment ? (
          <Field label="Appointment">
            <Select value={appointmentId} onChange={(event) => pickAppointment(event.target.value)} disabled={loading}>
              <option value="">Choose appointment</option>
              {appointments.map((appointment) => <option key={appointment.id} value={appointment.id}>
                {shortDate(appointment.date)} {appointment.time_confirmed === 0 ? "Time to confirm" : timeLabel(appointment.start_time)}
                {" · "}{appointment.client_name ?? "Client"}{" · "}{appointment.service_name || appointment.category_name || "Appointment"}
              </option>)}
            </Select>
          </Field>
        ) : (
          <Field label={type === "expense" ? "Expense category" : "Income type"}>
            <Select value={categoryId} onChange={(event) => pickCategory(event.target.value)} disabled={loading}>
              <option value="">{type === "expense" ? "Uncategorised" : "Other income"}</option>
              {typeCategories.map((category) => <option key={category.id} value={category.id}>
                {editing?.type === type && editing.category_id === category.id ? editing.category_name_snapshot || category.name : category.name}
              </option>)}
              {editing?.category_id != null && (type === "expense" || editing.income_kind === "other")
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
            <Input type="date" value={date} readOnly={!!fixedBooking || appointmentPayment}
              onChange={(event) => { setDate(event.target.value); setStandaloneDate(event.target.value); }} disabled={loading} />
          </Field>
        </div>
        {!editing && type === "income" && paymentFor === "service" && selectedService && (
          <p className="-mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>Service price {money(serviceDiscountPrice(selectedService.price_pence, selectedService.discount_percent ?? 0))}</span>
            {selectedService.discount_percent > 0 && <><span className="line-through">{money(selectedService.price_pence)}</span><span className="text-good">{selectedService.discount_percent}% off</span></>}
          </p>
        )}
        {fixedBooking && <p className="-mt-2 text-xs text-muted">
          {fixedBooking.client_name ?? "Appointment"}{fixedBooking.price_pence != null ? ` · Agreed price ${money(fixedBooking.price_pence)}` : ""}
        </p>}

        {type === "income" && !appointmentPayment && (
          <Field label="Client (optional)">
            {linkedAppointment ? <Input readOnly value={client.name} /> : <ClientCombobox clients={clients} value={client} onChange={setClient} />}
          </Field>
        )}

        {!appointmentPayment && <Field label="Note">
          <Textarea placeholder={type === "income" ? "e.g. Full body, dark shade" : "e.g. 1L solution from supplier"}
            value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>}

        {error && <p className="text-[13px] text-bad">{error}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {editing ? <Button type="button" variant="ghost" className="text-bad" onClick={remove} disabled={saving || loading || !loaded}>
            <Trash2 size={15} /> Delete
          </Button> : <span />}
          <div className="flex gap-2">
            <Button type="button" onClick={closeEntry}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={saving || loading || !loaded}>
              {editing ? "Save changes" : type === "income" ? "Record payment" : "Add expense"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
