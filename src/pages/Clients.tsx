import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, Check, Link2, MapPin, Pencil, Plus, Search, ShieldCheck, ShieldOff, Trash2, UserRound, Users } from "lucide-react";
import {
  createClient,
  deleteClient,
  listClients,
  listAppointments,
  listTransactions,
  upcomingForClient,
  updateClient,
  type ClientWithStats,
} from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { linkClientAccount } from "@/lib/sync";
import { useAccess } from "@/components/AccessGate";
import { isoDate, money, shortDate, timeLabel, ukDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { TransactionList } from "@/components/TransactionList";

type SortKey = "name" | "total" | "recent";

export function Clients() {
  const access = useAccess();
  const { refresh, openNewEntry, openNewAppointment, openEditAppointment } = useData();
  const [clients] = useLoad(listClients, [], []);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Partial<ClientWithStats> | null>(null);
  const [toDelete, setToDelete] = useState<ClientWithStats | null>(null);
  const [toDisable, setToDisable] = useState<ClientWithStats | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [linking, setLinking] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [clientError, setClientError] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone?.includes(q) || c.email?.toLowerCase().includes(q))
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name)
          : sort === "total"
            ? b.total_pence - a.total_pence
            : (b.last_visit ?? "").localeCompare(a.last_visit ?? ""),
      );
  }, [clients, search, sort]);

  const selected = clients.find((c) => c.id === selectedId) ?? null;
  const [history] = useLoad(
    () => (selectedId ? listTransactions({ clientId: selectedId }) : Promise.resolve([])),
    [selectedId],
    [],
  );
  const [upcoming] = useLoad(
    () => (selectedId ? upcomingForClient(selectedId, isoDate(new Date())) : Promise.resolve([])),
    [selectedId],
    [],
  );
  const [appointments] = useLoad(() => selectedId ? listAppointments({ clientId: selectedId }) : Promise.resolve([]), [selectedId], []);
  const pastAppointments = appointments.filter((a) => a.date < isoDate(new Date()) || a.status !== "confirmed").sort((a, b) => b.date.localeCompare(a.date) || b.start_time.localeCompare(a.start_time)).slice(0, 12);

  const totalRevenue = clients.reduce((s, c) => s + c.total_pence, 0);

  return (
    <>
      <PageHeader title="Clients" subtitle={`${clients.length} clients · ${money(totalRevenue)} lifetime income`}>
        <Button variant="primary" disabled={access.state !== "online"} onClick={() => setEditing({ name: "", email: "", phone: "", notes: "" })}>
          <Plus size={15} /> Add client
        </Button>
      </PageHeader>
      {clientError && <p role="alert" className="mb-4 text-sm text-bad">{clientError}</p>}

      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-5">
        <Card className="min-w-0 lg:col-span-3">
          <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4 pb-3">
            <div className="relative w-full min-w-0 sm:w-60">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input className="w-full rounded-full pl-8" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-1 text-[13px] text-muted">
              Sort
              {(["recent", "total", "name"] as SortKey[]).map((k) => (
                <button
                  key={k}
                  onClick={() => setSort(k)}
                  className={cn(
                    "rounded-full px-2.5 py-1 font-medium cursor-pointer",
                    sort === k ? "bg-accent-soft text-ink" : "hover:text-ink",
                  )}
                >
                  {k === "recent" ? "Recent" : k === "total" ? "Top spend" : "A–Z"}
                </button>
              ))}
            </div>
          </div>

          {visible.length === 0 ? (
            <EmptyState icon={<Users size={20} />} title={clients.length ? "No matches" : "No clients yet"}>
              {clients.length ? "Try another search." : "Clients are added automatically when you log a tan, or add one here."}
            </EmptyState>
          ) : (
            <div className="max-w-full overflow-x-auto" role="region" aria-label="Client list" tabIndex={0}>
            <table className="w-full min-w-[480px] text-[13.5px]">
              <thead>
                <tr className="eyebrow border-y border-line bg-surface-2/60 text-left text-ink-2">
                  <th className="py-2 pl-5 pr-3 font-medium">Client</th>
                  <th className="px-3 py-2 text-right font-medium">Visits</th>
                  <th className="px-3 py-2 text-right font-medium">Spent</th>
                  <th className="py-2 pl-3 pr-5 text-right font-medium">Last visit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={cn("cursor-pointer hover:bg-surface-2/50", selectedId === c.id && "bg-accent-soft hover:bg-accent-soft")}
                  >
                    <td className="py-2.5 pl-5 pr-3">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={c.name} />
                        <div>
                          <div className="font-medium">{c.name}{!!c.disabled && <span className="ml-2 text-xs font-normal text-muted">Disabled</span>}</div>
                          {c.phone && <div className="text-[12px] text-muted">{c.phone}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="tabular px-3 py-2.5 text-right">{c.visits}</td>
                    <td className="tabular px-3 py-2.5 text-right font-semibold">{money(c.total_pence)}</td>
                    <td className="tabular py-2.5 pl-3 pr-5 text-right text-ink-2">
                      {c.last_visit ? ukDate(c.last_visit) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          <div className="h-2" />
        </Card>

        <Card className="min-w-0 self-start lg:col-span-2">
          {selected ? (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
                <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-0 sm:flex-1">
                  <Avatar name={selected.name} large />
                  <div className="min-w-0">
                    <div className="break-words font-display text-[24px] leading-tight">{selected.name}</div>
                    <div className="break-words text-[13px] text-muted">{selected.phone || "No phone number"}</div>
                    {selected.email && <div className="mt-1 break-all text-[13px] text-muted">{selected.email}</div>}
                    <div className="mt-1 text-xs text-muted">{selected.account_id ? "Website account linked" : "No website account"}{selected.disabled ? " · disabled" : ""}</div>
                  </div>
                </div>
                <div className="ml-auto flex shrink-0 gap-0.5">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(selected)} aria-label="Edit client">
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={access.state !== "online" || !selected.remote_id || !!selected.disabled} onClick={() => setToDisable(selected)} title={selected.remote_id ? "Disable client" : "Import this client before managing website access"} aria-label="Disable client">
                    <ShieldOff size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" disabled={access.state !== "online"} onClick={() => { setDeleteError(""); setToDelete(selected); }} title={selected.account_id ? "Delete account" : "Delete client"} aria-label={selected.account_id ? "Delete account" : "Delete client"}><Trash2 size={14} /></Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 px-5 pt-3">
                {selected.disabled ? <Button size="sm" disabled={access.state !== "online"} onClick={async () => { try { await updateClient({ ...selected, disabled: 0 }); refresh(); toast.success("Client re-enabled"); } catch (e) { setClientError(e instanceof Error ? e.message : "Could not re-enable the client"); } }}><ShieldCheck size={14} /> Re-enable</Button> : null}
                {!selected.account_id && selected.remote_id && <Button size="sm" disabled={access.state !== "online"} onClick={() => { setLinking(true); setAccountId(""); }}><Link2 size={14} /> Link website account</Button>}
              </div>
              {selected.notes && <p className="mx-5 mt-3 break-words rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{selected.notes}</p>}
              {selected.saved_address && selected.saved_postcode && <p className="mx-5 mt-3 whitespace-pre-line break-words text-[13px] text-ink-2"><MapPin size={13} className="mr-1 inline" />{selected.saved_address}<span className="block text-xs text-muted">{selected.saved_postcode}</span></p>}
              <div className="grid grid-cols-1 gap-2 px-5 pt-4 sm:grid-cols-3">
                <MiniStat label="Visits" value={String(selected.visits)} />
                <MiniStat label="Total spent" value={money(selected.total_pence)} />
                <MiniStat label="Average" value={selected.visits ? money(Math.round(selected.total_pence / selected.visits)) : "—"} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 pb-2">
                <span className="eyebrow text-ink-2">Booked in</span>
                <Button
                  size="sm"
                  disabled={access.state !== "online" || !!selected.disabled}
                  onClick={() =>
                    openNewAppointment({ date: isoDate(new Date()), start_time: "09:00", clientId: selected.id })
                  }
                >
                  <CalendarPlus size={14} /> Book
                </Button>
              </div>
              {upcoming.length ? (
                <ul className="divide-y divide-line">
                  {upcoming.map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => openEditAppointment(a)}
                        className="flex w-full items-center gap-3 px-5 py-2 text-left text-[13px] hover:bg-surface-2/60 cursor-pointer"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{shortDate(a.date)}</span>
                          <span className="text-muted"> · {a.time_confirmed === 0 ? "Time to confirm" : timeLabel(a.start_time)}</span>
                          {(a.service_name || a.category_name) && <span className="block text-[12px] text-muted">{a.service_name || a.category_name}</span>}
                        </span>
                        {a.transaction_id != null && <Check size={13} strokeWidth={3} className="shrink-0 text-good" />}
                        {a.price_pence != null && <span className="tabular shrink-0">{money(a.price_pence)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 text-[13px] text-muted">Nothing booked in yet.</p>
              )}

              <div className="eyebrow px-5 pt-5 pb-2 text-ink-2">Appointment history</div>
              {pastAppointments.length ? <ul className="max-h-[300px] divide-y divide-line overflow-y-auto">
                {pastAppointments.map((a) => <li key={a.id}><button onClick={() => openEditAppointment(a)} className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-2 text-left text-[13px] hover:bg-surface-2 cursor-pointer"><span>{shortDate(a.date)} · {a.time_confirmed === 0 ? "Time to confirm" : timeLabel(a.start_time)}<span className="block text-xs text-muted">{a.service_name || a.category_name || "Appointment"}{a.is_remote ? " · home visit" : ""}</span></span><span className="text-xs text-muted">{a.status.replace("_", " ")}{a.transaction_id != null ? " · paid" : ""}</span></button></li>)}
              </ul> : <p className="px-5 text-[13px] text-muted">No appointment history yet.</p>}

              <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 pb-2">
                <span className="eyebrow text-ink-2">Financial history</span>
                <Button size="sm" onClick={() => openNewEntry("income", selected.id)}>
                  <Plus size={14} /> Record income
                </Button>
              </div>
              {history.length ? (
                <div className="max-h-[420px] overflow-y-auto pb-2">
                  <TransactionList rows={history} />
                </div>
              ) : (
                <p className="px-5 pb-5 text-[13px] text-muted">No visits logged yet.</p>
              )}
            </>
          ) : (
            <EmptyState icon={<UserRound size={20} />} title="Select a client">
              See their visit history and totals.
            </EmptyState>
          )}
        </Card>
      </div>

      <ClientForm
        client={editing}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          refresh();
          setSelectedId(id);
        }}
      />

      <ConfirmModal
        open={!!toDisable}
        onClose={() => setToDisable(null)}
        title="Disable client?"
        confirmLabel="Disable"
        message={
          <>
            <b>{toDisable?.name}</b> will lose website access. Appointments and financial history are preserved. Existing bookings are not cancelled.
          </>
        }
        onConfirm={async () => {
          if (!toDisable) return;
          try {
            await updateClient({ ...toDisable, disabled: 1 });
            refresh();
            toast.success("Client disabled");
          } catch (e) { setClientError(e instanceof Error ? e.message : "Could not disable this client"); }
        }}
      />
      <Modal open={!!toDelete} onClose={() => { if (!deleteBusy) setToDelete(null); }} title={toDelete?.account_id ? "Delete account?" : "Delete client?"} width="max-w-sm">
        <p className="break-words text-sm text-ink-2"><b>{toDelete?.name}</b>{toDelete?.account_id ? "'s website account, contact details and all appointments" : "'s contact details and all appointments"} will be permanently removed. Recorded payments stay in financial history without client or booking details. This cannot be undone.</p>
        {deleteError && <p role="alert" className="mt-3 text-sm text-bad">{deleteError}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2"><Button disabled={deleteBusy} onClick={() => setToDelete(null)}>Keep client</Button><Button variant="danger" disabled={deleteBusy || access.state !== "online"} onClick={async () => { if (!toDelete) return; setDeleteBusy(true); setDeleteError(""); try { await deleteClient(toDelete.id); setSelectedId(null); setToDelete(null); refresh(); toast.success("Client removed. Payments retained."); } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "Could not delete the client"); } finally { setDeleteBusy(false); } }}><Trash2 size={14} />{deleteBusy ? "Deleting..." : toDelete?.account_id ? "Delete account" : "Delete client"}</Button></div>
      </Modal>
      <Modal open={linking && !!selected} onClose={() => setLinking(false)} title="Link website account">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (!selected || !accountId) return; setLinkBusy(true); try { await linkClientAccount(selected.id, accountId); refresh(); setLinking(false); toast.success("Website account linked"); } catch (cause) { setClientError(cause instanceof Error ? cause.message : "Could not link the account"); } finally { setLinkBusy(false); } }}>
          <p className="text-sm text-ink-2">Choose the existing website account belonging to {selected?.name}. Booking history is preserved.</p>
          <Field label="Website account"><Select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Select an account</option>{clients.filter((c) => c.account_id && c.id !== selected?.id).map((c) => <option key={c.id} value={c.account_id!}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}</Select></Field>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setLinking(false)}>Cancel</Button><Button type="submit" variant="primary" disabled={linkBusy || !accountId || access.state !== "online"}><Link2 size={14} /> Link account</Button></div>
        </form>
      </Modal>
    </>
  );
}

function ClientForm({
  client,
  onClose,
  onSaved,
}: {
  client: Partial<ClientWithStats> | null;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const access = useAccess();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [savedAddress, setSavedAddress] = useState("");
  const [savedPostcode, setSavedPostcode] = useState("");
  const [lastClient, setLastClient] = useState<typeof client>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync form fields when a different client is opened
  if (client !== lastClient) {
    setLastClient(client);
    setName(client?.name ?? "");
    setPhone(client?.phone ?? "");
    setEmail(client?.email ?? "");
    setNotes(client?.notes ?? "");
    setSavedAddress(client?.saved_address ?? "");
    setSavedPostcode(client?.saved_postcode ?? "");
    setError(null);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (Boolean(savedAddress.trim()) !== Boolean(savedPostcode.trim())) { setError("Enter both a saved address and postcode, or leave both blank."); return; }
    setBusy(true); setError(null);
    try {
      let id = client?.id;
      if (id) await updateClient({ id, name, email, phone, notes, saved_address: savedAddress, saved_postcode: savedPostcode, cloud_revision: client?.cloud_revision });
      else id = await createClient({ name, email, phone, notes, saved_address: savedAddress, saved_postcode: savedPostcode });
      toast.success(client?.id ? "Client updated" : "Client added");
      onSaved(id);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the client"); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={!!client} onClose={onClose} title={client?.id ? "Edit client" : "Add client"}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sarah Jones" disabled={access.state !== "online"} />
        </Field>
        <Field label="Email (optional)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={access.state !== "online"} /></Field>
        <Field label="Phone (optional)">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" disabled={access.state !== "online"} />
        </Field>
        <Field label="Private staff notes (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferred shade, skin notes, allergies…" />
        </Field>
        <Field label="Saved visit address (optional)"><Textarea maxLength={500} autoComplete="street-address" value={savedAddress} onChange={(event) => setSavedAddress(event.target.value)} disabled={access.state !== "online"} /></Field>
        <Field label="Saved postcode (optional)"><Input maxLength={12} autoComplete="postal-code" value={savedPostcode} onChange={(event) => setSavedPostcode(event.target.value.toUpperCase())} disabled={access.state !== "online"} /></Field>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Avatar({ name, large }: { name: string; large?: boolean }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-display text-ink",
        large ? "h-12 w-12 text-[18px]" : "h-8 w-8 text-[13px]",
      )}
    >
      {initials || "?"}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5">
      <div className="eyebrow text-[10px] text-ink-2">{label}</div>
      <div className="mt-1 font-display text-[19px] leading-none">{value}</div>
    </div>
  );
}
