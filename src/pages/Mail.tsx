import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, LoaderCircle, Mail, Plus, RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, Segmented, Textarea } from "@/components/ui";
import { useInbox } from "@/lib/inbox";
import { downloadMailAttachment, getMail, getMailStatus, listMail, mailIsThisYear, mailShortTime, mailTime, markMailRead, reconcileMail, restoreMail, sendMail, trashMail,
  MAIL_ATTACHMENT_LIMIT, safeAttachmentName, type MailAttachment, type MailConversation, type MailDetail, type MailFilter, type MailList, type MailMessage, type MailSend, type MailSendResult, type MailStatus } from "@/lib/mail";
import { cn } from "@/lib/utils";

const EMPTY_LIST: MailList = { conversations: [], next_cursor: null };
const errorText = (error: unknown) => error instanceof Error ? error.message : "Please try again.";

export function MailPage() {
  const access = useAccess();
  const online = access.state === "online";
  const { conversationId } = useParams<{ conversationId: string }>();
  const navigate = useNavigate();
  const { mailRevision, refreshMail } = useInbox();
  const [filter, setFilter] = useState<MailFilter>("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const [list, setList] = useState<MailList & { filter: MailFilter }>({ ...EMPTY_LIST, filter });
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [moreLoading, setMoreLoading] = useState(false);
  const listEpoch = useRef(0);
  const moreBusy = useRef(false);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ id: string; restore: boolean; message: string } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionBusyRef = useRef(false);
  const readBusy = useRef(new Set<string>());
  const detailEpoch = useRef(0);
  const earlierBusy = useRef(false);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const currentId = useRef(conversationId);
  currentId.current = conversationId;
  const [checking, setChecking] = useState(false);
  const checkingBusy = useRef(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  // Non-zero while the provider has older mail left to import; each check that
  // still reports more sets a fresh value so the automatic follow-up re-arms.
  const [moreMailAvailable, setMoreMailAvailable] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const history = useRef<HTMLDivElement>(null);
  const historyConversation = useRef<string | null>(null);
  const showEarlier = useRef(false);

  useEffect(() => {
    let active = true;
    if (!online) return;
    setStatusError(null);
    void getMailStatus().then(value => { if (active) setStatus(value); })
      .catch(error => { if (active) { setStatus(null); setStatusError(errorText(error)); } });
    return () => { active = false; };
  }, [online, statusRevision]);

  useEffect(() => {
    const epoch = ++listEpoch.current;
    moreBusy.current = false; setMoreLoading(false);
    setListError(null);
    if (!online) { setListLoading(false); return; }
    setListLoading(true);
    void listMail(filter).then(value => {
      if (listEpoch.current === epoch) setList({ ...value, filter });
    }).catch(error => { if (listEpoch.current === epoch) setListError(errorText(error)); })
      .finally(() => { if (listEpoch.current === epoch) setListLoading(false); });
    return () => { if (listEpoch.current === epoch) listEpoch.current++; };
  }, [filter, mailRevision, online]);

  useEffect(() => {
    const epoch = ++detailEpoch.current;
    earlierBusy.current = false; setEarlierLoading(false);
    setDetailError(null); setReadError(null); setActionError(null);
    if (!conversationId || !online) { setDetailLoading(false); return; }
    setDetailLoading(true);
    void getMail(conversationId).then(value => {
      if (detailEpoch.current === epoch && value.conversation.id !== conversationId) {
        navigate(`/mail/${encodeURIComponent(value.conversation.id)}`, { replace: true });
        refreshMail();
      }
      if (detailEpoch.current === epoch) setDetail(previous => {
        if (previous?.conversation.id !== value.conversation.id) return value;
        const cutoff = value.retention_cutoff || "";
        const cached = previous.messages.filter(message => !cutoff || message.created_at >= cutoff);
        const messages = new Map(cached.map(message => [message.id, message]));
        for (const message of value.messages) messages.set(message.id, message);
        const keptEarlier = cached[0]?.created_at < (value.messages[0]?.created_at || "");
        return { ...value, messages: [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)), next_cursor: keptEarlier ? previous.next_cursor : value.next_cursor };
      });
    }).catch(error => { if (detailEpoch.current === epoch) { setDetailError(errorText(error)); if (/^404\b/.test(errorText(error))) { setDetail(null); setList(previous => ({ ...previous, conversations: previous.conversations.filter(item => item.id !== conversationId) })); } } })
      .finally(() => { if (detailEpoch.current === epoch) setDetailLoading(false); });
    return () => { if (detailEpoch.current === epoch) detailEpoch.current++; };
  }, [conversationId, mailRevision, online]);

  const visibleDetail = detail?.conversation.id === conversationId ? detail : null;
  const visibleList = list.filter === filter ? list : EMPTY_LIST;

  // Capture the exact displayed message IDs. A new arrival between GET and POST
  // remains unread until the next detail fetch actually displays it.
  const readDisplayed = async () => {
    if (!online || !visibleDetail || detailLoading || document.visibilityState !== "visible") return;
    const id = visibleDetail.conversation.id;
    if (readBusy.current.has(id)) return;
    const ids = visibleDetail.messages.filter(message => message.direction === "inbound" && !message.read_at).map(message => message.id).slice(0, 100);
    if (!ids.length) return;
    readBusy.current.add(id);
    setReadError(null);
    try {
      await markMailRead(id, ids);
      if (currentId.current === id) {
        const readAt = new Date().toISOString();
        setDetail(previous => previous?.conversation.id === id ? { ...previous, messages: previous.messages.map(message => ids.includes(message.id) ? { ...message, read_at: readAt } : message) } : previous);
      }
      refreshMail();
    } catch (error) { if (currentId.current === id) setReadError(errorText(error)); }
    finally { readBusy.current.delete(id); }
  };
  useEffect(() => { void readDisplayed(); }, [visibleDetail, detailLoading, online]); // Exact rendered snapshot, not the whole conversation.
  useEffect(() => { if (conversationId) heading.current?.focus({ preventScroll: true }); }, [conversationId, visibleDetail?.conversation.id]);
  useEffect(() => {
    if (!visibleDetail) { historyConversation.current = null; showEarlier.current = false; return; }
    const panel = history.current;
    if (!panel) return;
    if (showEarlier.current) { panel.scrollTop = 0; showEarlier.current = false; }
    else if (historyConversation.current !== visibleDetail.conversation.id || panel.scrollHeight - panel.scrollTop - panel.clientHeight < 180) panel.scrollTop = panel.scrollHeight;
    historyConversation.current = visibleDetail.conversation.id;
  }, [visibleDetail?.messages, visibleDetail?.conversation.id]);

  const loadEarlier = async () => {
    const cursor = visibleDetail?.next_cursor;
    if (!cursor || !conversationId || !online || detailLoading || earlierBusy.current) return;
    const id = conversationId;
    const epoch = detailEpoch.current;
    earlierBusy.current = true; setEarlierLoading(true); setDetailError(null);
    try {
      const value = await getMail(id, cursor);
      if (detailEpoch.current !== epoch) return;
      if (value.conversation.id !== id) { navigate(`/mail/${encodeURIComponent(value.conversation.id)}`, { replace: true }); refreshMail(); return; }
      if (value.next_cursor === cursor) throw new Error("The message history did not advance. Please refresh it.");
      showEarlier.current = true;
      setDetail(previous => {
        if (previous?.conversation.id !== id) return previous;
        const cutoff = value.retention_cutoff || "";
        const messages = new Map(previous.messages.filter(message => !cutoff || message.created_at >= cutoff).map(message => [message.id, message]));
        for (const message of value.messages) messages.set(message.id, message);
        return { ...previous, retention_cutoff: value.retention_cutoff || previous.retention_cutoff, messages: [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)), next_cursor: value.next_cursor };
      });
    } catch (error) { if (detailEpoch.current === epoch) { setDetailError(errorText(error)); if (/^404\b/.test(errorText(error))) { setDetail(null); setList(previous => ({ ...previous, conversations: previous.conversations.filter(item => item.id !== id) })); } } }
    finally { if (detailEpoch.current === epoch) { earlierBusy.current = false; setEarlierLoading(false); } }
  };

  const loadMore = async () => {
    const cursor = visibleList.next_cursor;
    if (!cursor || !online || listLoading || moreBusy.current) return;
    const epoch = listEpoch.current;
    moreBusy.current = true; setMoreLoading(true); setListError(null);
    try {
      const value = await listMail(filter, cursor);
      if (listEpoch.current !== epoch) return;
      if (value.next_cursor === cursor) throw new Error("The mail list did not advance. Please refresh it.");
      setList(previous => {
        const known = new Set(previous.conversations.map(item => item.id));
        return { filter, conversations: [...previous.conversations, ...value.conversations.filter(item => !known.has(item.id))], next_cursor: value.next_cursor };
      });
    } catch (error) { if (listEpoch.current === epoch) setListError(errorText(error)); }
    finally { if (listEpoch.current === epoch) { moreBusy.current = false; setMoreLoading(false); } }
  };

  // One control both imports from the provider and reloads the lists, even when the import fails.
  const checkMail = async () => {
    if (!online || checkingBusy.current) return;
    checkingBusy.current = true; setChecking(true); setCheckError(null);
    try { const result = await reconcileMail(); setMoreMailAvailable(result.more_available ? Date.now() : 0); }
    catch (error) { setCheckError(errorText(error)); }
    finally { checkingBusy.current = false; setChecking(false); refreshMail(); }
  };
  useEffect(() => {
    if (!moreMailAvailable || !online) return;
    const timer = setTimeout(() => void checkMail(), 60_000);
    return () => clearTimeout(timer);
  }, [moreMailAvailable, online]);
  const sent = (result: MailSendResult) => {
    setComposeOpen(false); setFilter("all"); refreshMail();
    navigate(`/mail/${encodeURIComponent(result.conversation_id)}`);
    toast.success("Email sent");
  };
  const sendEnabled = online && !!status?.configured && !!status.sender_address;

  const changeTrash = async (id: string, restore: boolean) => {
    if (!online || actionBusyRef.current) return;
    actionBusyRef.current = true; setActionBusy(true); setActionError(null);
    try {
      await (restore ? restoreMail(id) : trashMail(id));
      setList(previous => ({ ...previous, conversations: previous.conversations.filter(conversation => conversation.id !== id) }));
      if (currentId.current === id) {
        setDetail(previous => previous?.conversation.id === id ? { ...previous, conversation: { ...previous.conversation, trashed_at: restore ? null : new Date().toISOString() } } : previous);
        if (restore) setFilter("all");
        else { setDetail(null); navigate("/mail"); }
      }
      refreshMail();
      if (restore) toast.success("Conversation restored");
      else toast.success("Moved to Trash", { action: { label: "Undo", onClick: () => void changeTrash(id, true) } });
    } catch (error) {
      if (currentId.current === id) setActionError({ id, restore, message: errorText(error) });
      else toast.error(`${restore ? "Couldn't restore" : "Couldn't move to Trash"}: ${errorText(error)}`);
    }
    finally { actionBusyRef.current = false; setActionBusy(false); }
  };

  const receiving = status?.receiving_addresses.join(", ") || "";
  const trashed = !!visibleDetail?.conversation.trashed_at;
  return <>
    <PageHeader title="Mail" subtitle={status?.sender_address || "Business email"}>
      <Button size="icon" className="h-9 w-9" aria-label="Check for mail" title="Check for mail" disabled={!online || checking} onClick={() => void checkMail()}><RefreshCw size={15} className={cn(checking && "animate-spin")} /></Button>
      <Button variant="primary" disabled={!sendEnabled} onClick={() => setComposeOpen(true)}><Plus size={14} /> New email</Button>
    </PageHeader>
    {!online && <Notice>You're offline. Reconnect to load and send email.</Notice>}
    {statusError && <MailError title="Couldn't load mail settings" error={statusError} onRetry={() => setStatusRevision(value => value + 1)} disabled={!online} />}
    {status && !status.configured && <Notice>Sending isn't set up yet.</Notice>}
    {status?.receiving_configured === false && <Notice>Incoming email isn't fully set up yet.</Notice>}
    {checkError && <MailError title="Couldn't check for mail" error={checkError} onRetry={() => void checkMail()} disabled={!online || checking} />}
    {!!moreMailAvailable && <Notice>Older email is still importing. Mail checks again automatically.</Notice>}
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(240px,0.85fr)_minmax(0,1.6fr)] lg:items-start">
      <section aria-label="Email conversations" className={cn("min-w-0", conversationId && "hidden lg:block")}>
        <Segmented<MailFilter> className="mb-3 max-w-full [&>button]:px-2 sm:[&>button]:px-3" value={filter} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread" }, { value: "sent", label: "Sent" }, { value: "trash", label: "Trash" }]} onChange={setFilter} />
        {listError && <MailError title="Couldn't load conversations" error={listError} onRetry={refreshMail} disabled={!online || listLoading} />}
        <Card className="overflow-hidden">
          {listLoading && !visibleList.conversations.length ? <Loading label="Loading conversations" /> : !visibleList.conversations.length ? <EmptyState icon={<Mail size={20} />} title={!online ? "Connect to view mail" : listError ? "Mail unavailable" : filter === "unread" ? "No unread email" : filter === "sent" ? "No sent email yet" : filter === "trash" ? "Trash is empty" : "No email yet"}>{filter === "all" && online && !listError && receiving && <p className="px-4 [overflow-wrap:anywhere]">Customers can email {receiving}</p>}</EmptyState> : <ul className="divide-y divide-line">
            {visibleList.conversations.map(conversation => <ConversationRow key={conversation.id} conversation={conversation} selected={conversationId === conversation.id} />)}
          </ul>}
          {visibleList.next_cursor && <div className="border-t border-line p-2 text-center"><Button size="sm" variant="ghost" disabled={!online || listLoading || moreLoading} onClick={() => void loadMore()}>{moreLoading && <LoaderCircle size={14} className="animate-spin" />} Load more</Button></div>}
        </Card>
        <p className="mt-3 text-center text-xs text-muted">Emails are deleted after 90 days.</p>
      </section>
      <section aria-label="Conversation" className={cn("min-w-0", !conversationId && "hidden lg:block")}>
        {conversationId && <Button size="sm" variant="ghost" className="-ml-2 mb-2 lg:hidden" onClick={() => navigate("/mail")}><ArrowLeft size={14} /> All conversations</Button>}
        {detailError && <MailError title="Couldn't load this conversation" error={detailError} onRetry={refreshMail} disabled={!online || detailLoading} />}
        {readError && <MailError title="Couldn't mark as read" error={readError} onRetry={() => void readDisplayed()} disabled={!online} />}
        {actionError && actionError.id === conversationId && <MailError title={actionError.restore ? "Couldn't restore" : "Couldn't move to Trash"} error={actionError.message} onRetry={() => void changeTrash(actionError.id, actionError.restore)} disabled={!online || actionBusy} />}
        {!conversationId ? <Card><EmptyState icon={<Mail size={20} />} title="Select a conversation" /></Card> : !visibleDetail ? <Card>{detailLoading ? <Loading label="Loading conversation" /> : <EmptyState icon={<Mail size={20} />} title={online ? "Conversation unavailable" : "Connect to view this conversation"} />}</Card> : <Card className="overflow-hidden">
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              <h2 ref={heading} tabIndex={-1} className="font-display text-[23px] leading-tight outline-none [overflow-wrap:anywhere]">{visibleDetail.conversation.subject || "(No subject)"}</h2>
              <p className="mt-1 flex flex-wrap gap-x-2 text-sm text-ink-2">{visibleDetail.conversation.participant_name && <span className="min-w-0 font-medium text-ink [overflow-wrap:anywhere]">{visibleDetail.conversation.participant_name}</span>}<span className="min-w-0 [overflow-wrap:anywhere]">{visibleDetail.conversation.participant_email}</span></p>
            </div>
            {!trashed && <Button variant="ghost" size="icon" className="-mr-2 shrink-0" aria-label="Move to Trash" title="Move to Trash" disabled={!online || actionBusy} onClick={() => void changeTrash(visibleDetail.conversation.id, false)}>{actionBusy ? <LoaderCircle size={15} className="animate-spin" /> : <Trash2 size={15} />}</Button>}
          </div>
          <div ref={history} tabIndex={0} aria-label="Message history" className="max-h-[55vh] min-w-0 overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent">
            {visibleDetail.next_cursor && <div className="border-b border-line p-2 text-center"><Button size="sm" variant="ghost" disabled={!online || detailLoading || earlierLoading} onClick={() => void loadEarlier()}>{earlierLoading && <LoaderCircle size={14} className="animate-spin" />} Load earlier messages</Button></div>}
            {visibleDetail.messages.length ? <div className="divide-y divide-line">{visibleDetail.messages.map(message => <Message key={message.id} message={message} conversation={visibleDetail.conversation} business={status?.sender_address || ""} online={online} />)}</div> : <p className="px-5 py-6 text-sm text-muted">No messages yet.</p>}
          </div>
          {trashed ? <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
            <p className="text-sm text-ink-2">This conversation is in Trash.</p>
            <Button size="sm" aria-label="Restore conversation" disabled={!online || actionBusy} onClick={() => void changeTrash(visibleDetail.conversation.id, true)}>{actionBusy ? <LoaderCircle size={14} className="animate-spin" /> : <RotateCcw size={14} />} Restore</Button>
          </div> : <MailEditor key={visibleDetail.conversation.id} detail={visibleDetail} sender={status?.sender_address || ""} enabled={sendEnabled} onSent={sent} />}
        </Card>}
      </section>
    </div>
    <MailEditor modal open={composeOpen} onClose={() => setComposeOpen(false)} sender={status?.sender_address || ""} enabled={sendEnabled} onSent={sent} />
  </>;
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p role="status" className="mb-3 rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink-2">{children}</p>;
}
function Loading({ label }: { label: string }) {
  return <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> {label}</div>;
}
function MailError({ title, error, onRetry, disabled }: { title: string; error: string; onRetry: () => void; disabled?: boolean }) {
  return <div role="alert" className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-bad/30 bg-surface px-4 py-2.5 text-sm text-bad"><span className="min-w-0 flex-1 break-words">{title}: {error}</span><Button size="sm" disabled={disabled} onClick={onRetry}>Retry</Button></div>;
}

function ConversationRow({ conversation, selected }: { conversation: MailConversation; selected: boolean }) {
  const unread = conversation.unread_count > 0;
  return <li><Link to={`/mail/${encodeURIComponent(conversation.id)}`} aria-current={selected ? "page" : undefined} className={cn("relative block min-w-0 px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent", selected ? "bg-accent-soft" : "hover:bg-surface-2")}>
    {unread && <span aria-hidden className="absolute left-[6px] top-[19px] h-1.5 w-1.5 rounded-full bg-accent" />}
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className={cn("min-w-0 truncate text-sm", unread ? "font-semibold" : "font-medium")}>{conversation.participant_name || conversation.participant_email}</span>
      {conversation.message_count > 1 && <span className="shrink-0 text-xs text-muted">{conversation.message_count}<span className="sr-only"> messages</span></span>}
      <time dateTime={conversation.last_message_at} title={mailTime(conversation.last_message_at, true)} className={cn("ml-auto shrink-0 pl-2 text-xs", unread ? "font-semibold text-ink" : "text-muted")}>{mailShortTime(conversation.last_message_at)}</time>
    </div>
    <p className={cn("mt-0.5 truncate text-sm", unread ? "font-medium text-ink" : "text-ink-2")}>{conversation.subject || "(No subject)"}</p>
    <p className="mt-0.5 truncate text-xs text-muted">{conversation.direction === "outbound" && "You: "}{conversation.preview}</p>
    {unread && <span className="sr-only">{conversation.unread_count} unread</span>}
  </Link></li>;
}

function Message({ message, conversation, business, online }: { message: MailMessage; conversation: MailConversation; business: string; online: boolean }) {
  const outbound = message.direction === "outbound";
  const from = outbound ? "You" : conversation.participant_name && message.from_address.toLowerCase() === conversation.participant_email.toLowerCase() ? conversation.participant_name : message.from_address;
  // Received mail addressed only to the main business address needs no "to" line.
  const to = !outbound && message.to_addresses.length === 1 && message.to_addresses[0].toLowerCase() === business.toLowerCase() ? "" : message.to_addresses.join(", ");
  return <article aria-label={`${outbound ? "Outgoing" : "Received"} message`} className={cn("min-w-0 px-5 py-4", outbound && "bg-surface-2/60")}>
    <div className="flex items-baseline justify-between gap-3">
      <span className="min-w-0 truncate text-sm font-medium" title={message.from_address}>{from}</span>
      <time dateTime={message.created_at} title={mailTime(message.created_at, true)} className="shrink-0 text-xs text-muted">{mailTime(message.created_at, !mailIsThisYear(message.created_at))}</time>
    </div>
    {(to || message.cc_addresses.length > 0) && <p className="mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{to && `to ${to}`}{to && message.cc_addresses.length > 0 && " · "}{message.cc_addresses.length > 0 && `cc ${message.cc_addresses.join(", ")}`}</p>}
    {message.status === "pending" && <p role="status" className="mt-1 text-xs font-medium text-ink-2">Sending not confirmed</p>}
    {message.status === "failed" && <p role="status" className="mt-1 text-xs font-medium text-bad">Not sent</p>}
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{message.text_body || "(No message text)"}</p>
    {message.attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">{message.attachments.map(attachment => <Attachment key={attachment.id} messageId={message.id} attachment={attachment} online={online} />)}</div>}
  </article>;
}
function Attachment({ messageId, attachment, online }: { messageId: string; attachment: MailAttachment; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const tooLarge = attachment.size > MAIL_ATTACHMENT_LIMIT;
  const size = attachment.size >= 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(attachment.size / 1024))} KB`;
  const download = async () => {
    if (busyRef.current || !online || tooLarge) return;
    busyRef.current = true; setBusy(true); setError(null); setSaved(false);
    try { setSaved(await downloadMailAttachment(messageId, attachment)); }
    catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div className="min-w-0 max-w-full">
    <Button className="h-auto max-w-full py-1.5 text-left" size="sm" title={tooLarge ? "Too large to download" : "Save attachment"} disabled={!online || busy || tooLarge} onClick={() => void download()}>{busy ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Download size={14} className="shrink-0" />}<span className="min-w-0 break-all">{safeAttachmentName(attachment.filename)}</span><span className="shrink-0 text-xs text-muted">{size}</span></Button>
    {saved && <p role="status" className="mt-1 text-xs text-good">Saved</p>}
    {tooLarge && <p className="mt-1 text-xs text-muted">Over the 15 MB limit</p>}
    {error && <p role="alert" className="mt-1 break-words text-xs text-bad">Couldn't save: {error}</p>}
  </div>;
}

function MailEditor({ detail, modal = false, open = false, onClose, sender, enabled, onSent }: {
  detail?: MailDetail; modal?: boolean; open?: boolean; onClose?: () => void; sender: string; enabled: boolean; onSent: (result: MailSendResult) => void;
}) {
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const attempt = useRef<MailSend | null>(null);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const incoming = detail?.messages.filter(message => message.direction === "inbound" && message.message_id) || [];
  const latestIncoming = incoming[incoming.length - 1];
  const confirmedOutgoing = detail?.messages.filter(message => message.direction === "outbound" && message.status === "sent" && message.message_id) || [];
  const replyTarget = latestIncoming || confirmedOutgoing[confirmedOutgoing.length - 1];
  const canSend = enabled && (!detail || !!replyTarget);
  const recipient = detail ? latestIncoming?.from_address || detail.conversation.participant_email : to.trim();
  const replySubject = detail ? (/^re:/i.test(detail.conversation.subject) ? detail.conversation.subject : `Re: ${detail.conversation.subject || "Your email"}`).slice(0, 998) : subject.trim();
  const valid = !!recipient && !!replySubject && !!text.trim();
  const clear = () => { attempt.current = null; setLocked(false); setTo(""); setSubject(""); setText(""); setError(null); };
  const submit = async () => {
    if (busyRef.current || !canSend || (!attempt.current && !valid)) return;
    const payload = attempt.current || {
      idempotency_key: crypto.randomUUID(), to: recipient, subject: replySubject, text: text.trim(),
      ...(detail ? { conversation_id: detail.conversation.id, ...(replyTarget ? { reply_to_message_id: replyTarget.id } : {}) } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 65_536) { setError("This message is too large to send. Please shorten it."); return; }
    busyRef.current = true; setBusy(true); setError(null);
    attempt.current = payload;
    setLocked(true);
    try {
      const result = await sendMail(attempt.current);
      if (result.status === "pending") { setError("This email is still being sent. Retry to check on it."); return; }
      if (!result.conversation_id || !result.message_id) throw new Error("Sending wasn't confirmed. Retry to check it.");
      attempt.current = null; setLocked(false); setTo(""); setSubject(""); setText("");
      onSent(result);
    } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const onSubmit = (event: React.FormEvent) => { event.preventDefault(); void submit(); };
  const sendShortcut = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
  };
  const notes = <>
    {error && <p role="alert" className="break-words text-sm text-bad">{error}</p>}
    {locked && !busy && <p className="text-xs leading-relaxed text-ink-2">Not confirmed yet. Retry sends the same email, so it won't arrive twice.</p>}
    {modal && !enabled && <p className="text-xs text-ink-2">Sending is unavailable right now.</p>}
    {enabled && detail && !replyTarget && <p className="text-xs text-ink-2">Replies aren't available for this conversation yet.</p>}
  </>;
  const actions = <div className="flex flex-wrap items-center justify-end gap-2">
    {(text || to || subject || locked) && <Button variant="ghost" disabled={busy} onClick={() => { if (locked) setDiscardOpen(true); else clear(); }}>Discard</Button>}
    <Button type="submit" variant="primary" title="Send (Ctrl+Enter)" disabled={!canSend || busy || (!locked && !valid)}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}{busy ? "Sending…" : locked ? "Retry send" : detail ? "Send reply" : "Send email"}</Button>
  </div>;
  const discard = <ConfirmModal open={discardOpen} title="Discard this draft?" confirmLabel="Discard" message="This email may already have been sent. Discarding won't recall it." onClose={() => setDiscardOpen(false)} onConfirm={clear} />;
  if (!modal) return <>
    <form onSubmit={onSubmit} className="min-w-0 space-y-3 border-t border-line px-5 py-4">
      <Textarea aria-label="Reply message" required maxLength={50_000} rows={3} value={text} readOnly={locked} disabled={busy} onChange={event => { setText(event.target.value); setError(null); }} onKeyDown={sendShortcut} placeholder={`Reply to ${recipient}…`} />
      {notes}
      {actions}
    </form>
    {discard}
  </>;
  // Closing keeps the draft (and any unconfirmed send) until it is sent or discarded.
  return <>
    <Modal open={open} onClose={() => { if (!busyRef.current) onClose?.(); }} title="New email" width="max-w-lg">
      <form onSubmit={onSubmit} className="min-w-0 space-y-4">
        {sender && <p className="break-all text-xs text-muted">From {sender}</p>}
        <Field label="To"><Input type="email" required autoFocus maxLength={254} autoComplete="off" value={to} readOnly={locked} disabled={busy} onChange={event => { setTo(event.target.value); setError(null); }} placeholder="customer@example.com" /></Field>
        <Field label="Subject"><Input required maxLength={200} value={subject} readOnly={locked} disabled={busy} onChange={event => { setSubject(event.target.value); setError(null); }} /></Field>
        <Field label="Message"><Textarea aria-label="Message" required maxLength={50_000} rows={8} value={text} readOnly={locked} disabled={busy} onChange={event => { setText(event.target.value); setError(null); }} onKeyDown={sendShortcut} placeholder="Write your message…" /></Field>
        {notes}
        {actions}
      </form>
    </Modal>
    {discard}
  </>;
}
