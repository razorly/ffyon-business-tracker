import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarPlus, Check, Pencil, Plus, Search, Trash2, UserRound, Users } from "lucide-react";
import {
  createClient,
  deleteClient,
  listClients,
  listTransactions,
  upcomingForClient,
  updateClient,
  type ClientWithStats,
} from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { isoDate, money, shortDate, timeLabel, ukDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/Layout";
import { Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, Textarea } from "@/components/ui";
import { TransactionList } from "@/components/TransactionList";

type SortKey = "name" | "total" | "recent";

export function Clients() {
  const { refresh, openNewEntry, openNewAppointment, openEditAppointment } = useData();
  const [clients] = useLoad(listClients, [], []);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editing, setEditing] = useState<Partial<ClientWithStats> | null>(null);
  const [toDelete, setToDelete] = useState<ClientWithStats | null>(null);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone?.includes(q))
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

  const totalRevenue = clients.reduce((s, c) => s + c.total_pence, 0);

  return (
    <>
      <PageHeader title="Clients" subtitle={`${clients.length} clients · ${money(totalRevenue)} lifetime income`}>
        <Button variant="primary" onClick={() => setEditing({ name: "", phone: "", notes: "" })}>
          <Plus size={15} /> Add client
        </Button>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <div className="relative">
              <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input className="w-60 rounded-full pl-8" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex items-center gap-1 text-[13px] text-muted">
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
            <table className="w-full text-[13.5px]">
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
                          <div className="font-medium">{c.name}</div>
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
          )}
          <div className="h-2" />
        </Card>

        <Card className="self-start lg:col-span-2">
          {selected ? (
            <>
              <div className="flex items-start justify-between gap-3 px-5 pt-5">
                <div className="flex items-center gap-3">
                  <Avatar name={selected.name} large />
                  <div>
                    <div className="font-display text-[24px] leading-tight">{selected.name}</div>
                    <div className="text-[13px] text-muted">{selected.phone || "No phone number"}</div>
                  </div>
                </div>
                <div className="flex gap-0.5">
                  <Button variant="ghost" size="icon" onClick={() => setEditing(selected)} aria-label="Edit client">
                    <Pencil size={14} />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setToDelete(selected)} aria-label="Delete client">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>
              {selected.notes && <p className="mx-5 mt-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px] text-ink-2">{selected.notes}</p>}
              <div className="grid grid-cols-3 gap-2 px-5 pt-4">
                <MiniStat label="Visits" value={String(selected.visits)} />
                <MiniStat label="Total spent" value={money(selected.total_pence)} />
                <MiniStat label="Average" value={selected.visits ? money(Math.round(selected.total_pence / selected.visits)) : "—"} />
              </div>
              <div className="flex items-center justify-between px-5 pt-5 pb-2">
                <span className="eyebrow text-ink-2">Booked in</span>
                <Button
                  size="sm"
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
                          <span className="text-muted"> · {timeLabel(a.start_time)}</span>
                          {a.category_name && <span className="block text-[12px] text-muted">{a.category_name}</span>}
                        </span>
                        {a.status === "paid" && <Check size={13} strokeWidth={3} className="shrink-0 text-good" />}
                        {a.price_pence != null && <span className="tabular shrink-0">{money(a.price_pence)}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-5 text-[13px] text-muted">Nothing booked in yet.</p>
              )}

              <div className="flex items-center justify-between px-5 pt-5 pb-2">
                <span className="eyebrow text-ink-2">History</span>
                <Button size="sm" onClick={() => openNewEntry("income", selected.id)}>
                  <Plus size={14} /> Log visit
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
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        title="Delete client?"
        message={
          <>
            <b>{toDelete?.name}</b> will be removed. Their {toDelete?.visits} past entries are kept, just without a client name.
          </>
        }
        onConfirm={async () => {
          if (!toDelete) return;
          await deleteClient(toDelete.id);
          toast.success("Client deleted");
          setSelectedId(null);
          refresh();
        }}
      />
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
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [lastClient, setLastClient] = useState<typeof client>(null);

  // Sync form fields when a different client is opened
  if (client !== lastClient) {
    setLastClient(client);
    setName(client?.name ?? "");
    setPhone(client?.phone ?? "");
    setNotes(client?.notes ?? "");
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    let id = client?.id;
    if (id) await updateClient({ id, name, phone, notes });
    else id = await createClient({ name, phone, notes });
    toast.success(client?.id ? "Client updated" : "Client added");
    onSaved(id);
    onClose();
  };

  return (
    <Modal open={!!client} onClose={onClose} title={client?.id ? "Edit client" : "Add client"}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sarah Jones" />
        </Field>
        <Field label="Phone (optional)">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" />
        </Field>
        <Field label="Notes (optional)">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Preferred shade, skin notes, allergies…" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
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
