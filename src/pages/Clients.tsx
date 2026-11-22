import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { differenceInCalendarDays, differenceInMonths, format, parseISO, subWeeks } from "date-fns";
import { toast } from "sonner";
import { ChevronDown, Link2, Plus, Search, Trash2, UserRound, Users } from "lucide-react";
import { createClient, deleteClient, listAppointments, listClients, updateClient, type ClientWithStats } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { linkClientAccount } from "@/lib/sync";
import { useAccess } from "@/components/AccessGate";
import { isoDate, money } from "@/lib/format";
import { useBusinessNow } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { ClientProfile } from "@/components/ClientProfile";
import { Actions, Avatar, Button, Card, Chip, ConfirmModal, EmptyState, ErrorText, Field, Input, ListRow, LoadError, Loading, Modal, Select, Textarea } from "@/components/ui";

type SortKey = "name" | "total" | "recent";
type Filter = "all" | "due";
/** A client is due a visit when her last one was longer ago than this and nothing is booked. */
const DUE_WEEKS = 6;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "3 Oct", or "3 Oct 2025" when it was not this year: the short date Mail already uses, so a row stays on one line. */
const briefDate = (iso: string, today: string) => format(parseISO(iso), iso.slice(0, 4) === today.slice(0, 4) ? "d MMM" : "d MMM yyyy");

/** "5 days ago", "9 weeks ago", "4 months ago". */
function since(date: string, today: string) {
  const from = parseISO(date), to = parseISO(today);
  const days = differenceInCalendarDays(to, from);
  if (days < 1) return "today";
  if (days < 14) return days === 1 ? "yesterday" : `${days} days ago`;
  const months = differenceInMonths(to, from);
  if (months < 3) return `${Math.floor(days / 7)} weeks ago`;
  return months < 12 ? `${months} months ago` : "over a year ago";
}

export function Clients() {
  const access = useAccess();
  const online = access.state === "online";
  const { refresh } = useData();
  const today = isoDate(useBusinessNow());
  const [params, setParams] = useSearchParams();
  const [clients, clientsLoading, clientsLoadError] = useLoad(listClients, [], []);
  // Who already has something in the diary from today on. Null until it has loaded, so nobody is called due by mistake.
  const [booked, , bookedError] = useLoad<Set<number> | null>(async () => new Set(
    (await listAppointments({ from: today })).filter(row => (row.status === "confirmed" || row.status === "pending") && row.client_id != null).map(row => row.client_id!),
  ), [today], null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortKey>("recent");
  const [editing, setEditing] = useState<Partial<ClientWithStats> | null>(null);
  const [toDelete, setToDelete] = useState<ClientWithStats | null>(null);
  const [toDisable, setToDisable] = useState<ClientWithStats | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [linking, setLinking] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const profileHeading = useRef<HTMLHeadingElement>(null);
  const clientList = useRef<HTMLDivElement>(null);

  // The open client lives in the address (/clients?client=12), so Mail and other pages can link straight to her.
  const linked = Number(params.get("client"));
  const selectedId = Number.isSafeInteger(linked) && linked > 0 ? linked : null;
  const select = (id: number | null) => setParams(id == null ? {} : { client: String(id) }, { replace: true });
  const selected = clients.find(c => c.id === selectedId) ?? null;

  const dueCutoff = isoDate(subWeeks(parseISO(today), DUE_WEEKS));
  const isDue = (c: ClientWithStats) => !c.disabled && c.visits > 0 && !!c.last_visit && c.last_visit < dueCutoff && booked != null && !booked.has(c.id);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients
      .filter(c => !q || c.name.toLowerCase().includes(q) || c.phone?.includes(q) || c.email?.toLowerCase().includes(q))
      .filter(c => filter === "all" || isDue(c))
      .sort((a, b) =>
        sort === "name" ? a.name.localeCompare(b.name)
          : sort === "total" ? b.total_pence - a.total_pence
            : (b.last_visit ?? "").localeCompare(a.last_visit ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clients, search, sort, filter, booked, dueCutoff]);

  // Under 1024px the profile takes the place of the list, so move focus with it.
  const profileId = selected?.id;
  useEffect(() => {
    if (profileId !== undefined && matchMedia("(max-width: 63.999rem)").matches) {
      profileHeading.current?.focus({ preventScroll: true });
      profileHeading.current?.scrollIntoView({ block: "center" });
    }
  }, [profileId]);
  const backToClients = () => {
    select(null);
    requestAnimationFrame(() => clientList.current?.focus());
  };

  const enable = async (client: ClientWithStats) => {
    setClientError(null);
    try { await updateClient({ ...client, disabled: 0 }); refresh(); toast.success("Client re-enabled"); }
    catch (e) { setClientError(e instanceof Error ? e.message : "Could not re-enable the client"); }
  };

  const totalRevenue = clients.reduce((s, c) => s + c.total_pence, 0);
  const dueLoading = filter === "due" && booked == null && !bookedError;

  return (
    <>
      <PageHeader title="Clients" subtitle={`${plural(clients.length, "client")} · ${money(totalRevenue)} lifetime income`}>
        <Button variant="primary" disabled={!online} onClick={() => setEditing({ name: "", email: "", phone: "", notes: "" })}>
          <Plus size={16} aria-hidden /> Add client
        </Button>
      </PageHeader>
      <LoadError error={clientsLoadError || bookedError} onRetry={refresh} />
      {clientError && <ErrorText className="mb-4">{clientError}</ErrorText>}

      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card className={cn("overflow-hidden", selected && "hidden lg:block")}>
          <div className="flex flex-col gap-3 px-5 pb-3 pt-4">
            <div className="relative min-w-0">
              <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-2" aria-hidden />
              <Input aria-label="Search clients" className="pl-10" placeholder="Search clients" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip selected={filter === "all"} onClick={() => setFilter("all")}>All</Chip>
              <Chip selected={filter === "due"} disabled={!!bookedError && filter !== "due"} onClick={() => setFilter("due")}>Due a visit</Chip>
              <Select aria-label="Sort clients" className="ml-auto w-auto border-transparent text-small text-ink-2 read-only:bg-transparent hover:text-ink" value={sort} onChange={e => setSort(e.target.value as SortKey)}>
                <option value="recent">Recent</option>
                <option value="total">Top spend</option>
                <option value="name">A to Z</option>
              </Select>
            </div>
            {filter === "due" && <p className="text-small text-ink-2">Clients whose last visit was more than {DUE_WEEKS} weeks ago, with nothing booked.</p>}
          </div>

          {clientsLoading && clients.length === 0 ? <Loading label="Loading clients" />
            : dueLoading ? <Loading label="Checking the diary" />
            : visible.length === 0 ? (
              <EmptyState icon={<Users size={20} aria-hidden />} title={!clients.length ? "No clients yet" : filter === "due" && !search.trim() ? "No one is due a visit" : "No matches"}>
                {!clients.length ? "Clients appear when they book online or when you book them in. You can also add one here."
                  : filter === "due" && !search.trim() ? bookedError ? "The diary couldn't be checked. Retry above." : "Everyone has been in lately or is already booked."
                  : "Try another search."}
              </EmptyState>
            ) : (
              <div ref={clientList} role="region" aria-label="Client list" tabIndex={-1} className="border-t border-line outline-none lg:max-h-[70vh] lg:overflow-y-auto">
                <ul className="divide-y divide-line">
                  {visible.map(c => (
                    <li key={c.id}>
                      <ListRow className="focus-visible:outline-offset-[-2px]!" onClick={() => select(c.id)} selected={selectedId === c.id} aria-label={c.name} aria-describedby={`client-${c.id}-about client-${c.id}-spent`}
                        leading={<Avatar name={c.name} />}
                        title={<><span>{c.name}</span>{!!c.disabled && <span className="ml-2 text-small font-normal text-ink-2">Disabled</span>}</>}
                        subtitle={<span id={`client-${c.id}-about`}>{c.visits > 0 && c.last_visit
                          ? `Last visit ${filter === "due" ? since(c.last_visit, today) : briefDate(c.last_visit, today)} · ${plural(c.visits, "visit")}`
                          : c.phone || "No visits yet"}</span>}
                        trailing={<span id={`client-${c.id}-spent`} className="tabular shrink-0 font-semibold">{money(c.total_pence)}</span>} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
        </Card>

        <div className={cn("min-w-0", !selected && "hidden lg:block")}>
          {selected ? (
            <ClientProfile key={selected.id} client={selected} today={today} online={online} headingRef={profileHeading}
              onBack={backToClients}
              onEdit={() => setEditing(selected)}
              onLink={() => { setLinking(true); setAccountId(""); setLinkError(null); }}
              onDisable={() => { setClientError(null); setToDisable(selected); }}
              onEnable={() => void enable(selected)}
              onDelete={() => { setDeleteError(""); setToDelete(selected); }} />
          ) : (
            <Card>
              <EmptyState icon={<UserRound size={20} aria-hidden />} title="Select a client">
                See their notes, bookings and payments.
              </EmptyState>
            </Card>
          )}
        </div>
      </div>

      <ClientForm
        client={editing}
        onClose={() => setEditing(null)}
        onSaved={(id) => {
          refresh();
          select(id);
        }}
      />

      <ConfirmModal
        open={!!toDisable}
        onClose={() => setToDisable(null)}
        title="Disable client?"
        confirmLabel="Disable"
        message={
          <>
            <span className="font-semibold text-ink">{toDisable?.name}</span> will lose website access. Appointments and financial history are preserved. Existing bookings are not cancelled.
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
        <p className="break-words text-ink-2"><span className="font-semibold text-ink">{toDelete?.name}</span>{toDelete?.account_id ? "'s website account, contact details, notes and all appointments" : "'s contact details, notes and all appointments"} will be permanently removed. Recorded payments stay in financial history without client or booking details. This cannot be undone.</p>
        {deleteError && <ErrorText className="mt-3">{deleteError}</ErrorText>}
        <Actions className="mt-5">
          <Button disabled={deleteBusy} onClick={() => setToDelete(null)}>Keep client</Button>
          <Button variant="danger" disabled={deleteBusy || !online} onClick={async () => { if (!toDelete) return; setDeleteBusy(true); setDeleteError(""); try { await deleteClient(toDelete.id); select(null); setToDelete(null); refresh(); toast.success("Client removed. Payments retained."); } catch (cause) { setDeleteError(cause instanceof Error ? cause.message : "Could not delete the client"); } finally { setDeleteBusy(false); } }}>
            <Trash2 size={16} aria-hidden />{deleteBusy ? "Deleting…" : toDelete?.account_id ? "Delete account" : "Delete client"}
          </Button>
        </Actions>
      </Modal>
      <Modal open={linking && !!selected} onClose={() => { if (!linkBusy) setLinking(false); }} title="Link website account">
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); if (!selected || !accountId || linkBusy) return; setLinkBusy(true); setLinkError(null); try { await linkClientAccount(selected.id, accountId); refresh(); setLinking(false); toast.success("Website account linked"); } catch (cause) { setLinkError(cause instanceof Error ? cause.message : "Could not link the account"); } finally { setLinkBusy(false); } }}>
          <p className="text-ink-2">Choose the existing website account belonging to {selected?.name}. Booking history is preserved.</p>
          <Field label="Website account"><Select disabled={linkBusy} value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">Select an account</option>{clients.filter((c) => c.account_id && c.id !== selected?.id).map((c) => <option key={c.id} value={c.account_id!}>{c.name}{c.email ? ` · ${c.email}` : ""}</option>)}</Select></Field>
          {linkError && <ErrorText>{linkError}</ErrorText>}
          <Actions>
            <Button disabled={linkBusy} onClick={() => setLinking(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={linkBusy || !accountId || !online}><Link2 size={16} aria-hidden /> Link account</Button>
          </Actions>
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
  const offline = access.state !== "online";
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [savedAddress, setSavedAddress] = useState("");
  const [savedPostcode, setSavedPostcode] = useState("");
  const [more, setMore] = useState(false);
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
    // The home-visit address is tucked away unless she already has one.
    setMore(Boolean(client?.saved_address || client?.saved_postcode));
    setError(null);
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    if (Boolean(savedAddress.trim()) !== Boolean(savedPostcode.trim())) { setMore(true); setError("Enter both a saved address and postcode, or leave both blank."); return; }
    setBusy(true); setError(null);
    try {
      let id = client?.id;
      if (id) await updateClient({ id, name, email, phone, saved_address: savedAddress, saved_postcode: savedPostcode, cloud_revision: client?.cloud_revision });
      else id = await createClient({ name, email, phone, notes, saved_address: savedAddress, saved_postcode: savedPostcode });
      toast.success(client?.id ? "Client updated" : "Client added");
      onSaved(id);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save the client"); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={!!client} onClose={() => { if (!busy) onClose(); }} title={client?.id ? "Edit client" : "Add client"}>
      <form onSubmit={submit}><fieldset disabled={busy} className="min-w-0 space-y-4">
        <Field label="Name">
          <Input autoFocus required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sarah Jones" disabled={offline} />
        </Field>
        <Field label="Phone (optional)">
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" disabled={offline} />
        </Field>
        <Field label="Email (optional)"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={offline} /></Field>
        {!client?.id && <Field label="Private client notes (optional)" hint="Only you see these notes.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferred shade, skin notes, allergies…" />
        </Field>}
        <div>
          <Button variant="ghost" size="sm" className="-ml-3" aria-expanded={more} onClick={() => setMore(value => !value)}>
            <ChevronDown size={16} className={cn("transition-transform", more && "rotate-180")} aria-hidden /> More options
          </Button>
        </div>
        {more && <>
          <Field label="Saved visit address (optional)" hint="Used for home visits."><Textarea maxLength={500} autoComplete="street-address" value={savedAddress} onChange={(event) => setSavedAddress(event.target.value)} disabled={offline} /></Field>
          <Field label="Saved postcode (optional)"><Input maxLength={12} autoComplete="postal-code" value={savedPostcode} onChange={(event) => setSavedPostcode(event.target.value.toUpperCase())} disabled={offline} /></Field>
        </>}
        {error && <ErrorText>{error}</ErrorText>}
        <Actions>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>Save</Button>
        </Actions>
      </fieldset></form>
    </Modal>
  );
}
