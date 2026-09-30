import { useState } from "react";
import { Check, Clock, Inbox, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import { listPendingAppointments, decideReschedule } from "@/lib/sync";
import { setAppointmentStatus, type AppointmentRow } from "@/lib/db";
import { useData, useLoad } from "@/lib/data";
import { money, shortDate, timeLabel } from "@/lib/format";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { Button, Card, EmptyState } from "@/components/ui";

export function Requests() {
  const access = useAccess();
  const { refresh, openEditAppointment } = useData();
  const [requests, loading] = useLoad(listPendingAppointments, [], []);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = async (row: AppointmentRow, approve: boolean) => {
    setBusy(row.id); setError(null);
    try {
      if (row.proposed_date && row.proposed_start_time) await decideReschedule(row.id, approve, row.cloud_revision);
      else await setAppointmentStatus(row.id, approve ? "confirmed" : "rejected", row.cloud_revision);
      refresh();
      toast.success(row.proposed_date ? approve ? "Reschedule approved" : "Reschedule rejected" : approve ? "Appointment accepted" : "Request rejected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update this request");
    } finally { setBusy(null); }
  };
  return <>
    <PageHeader title="Requests" subtitle={`${requests.length} appointment${requests.length === 1 ? "" : "s"} awaiting a decision`} />
    {access.state !== "online" && <p className="mb-4 rounded-lg border border-line bg-surface px-4 py-3 text-sm text-ink-2">You're offline. Reconnect to accept, reject or approve a new time.</p>}
    {error && <p role="alert" className="mb-4 text-sm text-bad">{error}</p>}
    <Card>
      {loading && requests.length === 0 ? <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> Loading requests</div> : requests.length === 0 ? <EmptyState icon={<Inbox size={20} />} title="All caught up" /> : <ul className="divide-y divide-line">
        {requests.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
            <button onClick={() => openEditAppointment(row)} className="max-w-full break-words text-left font-medium hover:underline cursor-pointer">{row.client_name || "Client"}</button>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-ink-2"><span>{row.service_name || row.category_name || "Appointment"}</span><span>{row.duration_min} min</span>{row.price_pence != null && <span className="tabular">{money(row.price_pence)}</span>}</div>
            {row.account_email && <p className="mt-1 break-all text-xs text-muted">{row.account_email}</p>}
            <p className="mt-2 flex items-center gap-2 text-sm"><Clock size={14} className="shrink-0 text-muted" /> {shortDate(row.date)} · {timeLabel(row.start_time)}{row.proposed_date && <span className="text-muted"> (reserved)</span>}</p>
            {row.proposed_date && row.proposed_start_time && <p className="mt-1 text-sm font-medium">Requested: {shortDate(row.proposed_date)} · {timeLabel(row.proposed_start_time)}</p>}
            {row.customer_notes && <p className="mt-2 break-words text-[13px] text-ink-2">{row.customer_notes}</p>}
          </div>
          <div className="flex w-full flex-wrap gap-2 sm:w-auto sm:shrink-0">
            <Button disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, false)}><X size={14} /> Reject</Button>
            <Button variant="primary" disabled={busy != null || access.state !== "online"} onClick={() => void decide(row, true)}>{busy === row.id ? <LoaderCircle size={14} className="animate-spin" /> : <Check size={14} />} {row.proposed_date ? "Approve time" : "Accept"}</Button>
          </div>
        </li>)}
      </ul>}
    </Card>
  </>;
}
