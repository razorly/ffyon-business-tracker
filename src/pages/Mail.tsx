import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Download, LoaderCircle, Mail, Plus, RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useAccess } from "@/components/AccessGate";
import { PageHeader } from "@/components/Layout";
import { Button, Card, ConfirmModal, EmptyState, Field, Input, Modal, Segmented, Textarea } from "@/components/ui";
import { useInbox } from "@/lib/inbox";
import { downloadMailAttachment, getMail, getMailStatus, listMail, mailTime, markMailRead, reconcileMail, restoreMail, sendMail, trashMail,
  MAIL_ATTACHMENT_LIMIT, safeAttachmentName, type MailAttachment, type MailDetail, type MailFilter, type MailList, type MailMessage, type MailSend, type MailSendResult, type MailStatus } from "@/lib/mail";
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
  const [moreMailAvailable, setMoreMailAvailable] = useState(false);
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

  const checkMail = async () => {
    if (!online || checkingBusy.current) return;
    checkingBusy.current = true; setChecking(true); setCheckError(null);
    try { const result = await reconcileMail(); setMoreMailAvailable(!!result.more_available); refreshMail(); toast.success(result.more_available ? "Mail updated; older email is still available" : "Mail checked"); }
    catch (error) { setCheckError(errorText(error)); }
    finally { checkingBusy.current = false; setChecking(false); }
  };
  const sent = (result: MailSendResult) => {
    setComposeOpen(false); setFilter("all"); refreshMail();
    navigate(`/mail/${encodeURIComponent(result.conversation_id)}`);
    toast.success("Email sent");
  };
  const sendEnabled = online && !!status?.configured && !!status.sender_address;

  const changeTrash = async (restore: boolean) => {
    const id = visibleDetail?.conversation.id;
    if (!id || !online || actionBusyRef.current) return;
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
      toast.success(restore ? "Conversation restored" : "Conversation moved to Trash");
    } catch (error) { if (currentId.current === id) setActionError({ id, restore, message: errorText(error) }); }
    finally { actionBusyRef.current = false; setActionBusy(false); }
  };

  return <>
    <PageHeader title="Mail" subtitle={status?.sender_address ? `Business email · ${status.sender_address}` : "Business email"}>
      <Button disabled={!online || checking} onClick={() => void checkMail()}>{checking ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />} Check for mail</Button>
      <Button variant="primary" disabled={!sendEnabled} onClick={() => setComposeOpen(true)}><Plus size={14} /> New email</Button>
    </PageHeader>
    <p className="mb-4 text-xs leading-relaxed text-muted">Emails are automatically deleted after 90 days. Trash can be restored before then.</p>
    {!online && <p role="status" className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">You're offline. Reconnect to load email, send messages and download attachments.</p>}
    {statusError && <MailError title="Could not check mail settings" error={statusError} onRetry={() => setStatusRevision(value => value + 1)} disabled={!online} />}
    {status && !status.configured && <p role="status" className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">Business email is not configured yet. Sending will become available when the business sender is connected.</p>}
    {status?.receiving_configured === false && <p role="status" className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">Incoming email setup is incomplete. Existing conversations remain available.</p>}
    {!!status?.receiving_addresses.length && <p className="mb-4 break-words text-xs text-muted">{status.receiving_configured === false ? "Business addresses" : "Receiving at"} {status.receiving_addresses.join(", ")}</p>}
    {checkError && <MailError title="Could not check for mail" error={checkError} onRetry={() => void checkMail()} disabled={!online || checking} />}
    {moreMailAvailable && <p role="status" className="mb-4 text-sm text-ink-2">More older email is available. Check for mail again in a minute to continue importing it.</p>}
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(230px,0.9fr)_minmax(0,1.6fr)]">
      <section aria-label="Email conversations" className={cn("min-w-0", conversationId && "hidden lg:block")}>
        <div className="mb-3 flex min-w-0 flex-wrap items-center justify-between gap-2"><Segmented<MailFilter> className="max-w-full [&>button]:px-2" value={filter} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread" }, { value: "sent", label: "Sent" }, { value: "trash", label: "Trash" }]} onChange={setFilter} /><Button size="icon" aria-label="Refresh conversations" title="Refresh conversations" disabled={!online || listLoading} onClick={refreshMail}><RefreshCw size={14} /></Button></div>
        {listError && <MailError title="Could not load conversations" error={listError} onRetry={refreshMail} disabled={!online || listLoading} />}
        <Card>
          {listLoading && !visibleList.conversations.length ? <Loading label="Loading conversations" /> : !visibleList.conversations.length ? <EmptyState icon={<Mail size={20} />} title={!online ? "Connect to view mail" : listError ? "Mail unavailable" : filter === "unread" ? "No unread conversations" : filter === "sent" ? "No sent email yet" : filter === "trash" ? "Trash is empty" : "No email yet"} /> : <ul className="divide-y divide-line overflow-hidden rounded-3xl">
            {visibleList.conversations.map(conversation => <li key={conversation.id}><Link to={`/mail/${encodeURIComponent(conversation.id)}`} aria-current={conversationId === conversation.id ? "page" : undefined} className={cn("block min-w-0 px-4 py-4 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent", conversationId === conversation.id ? "bg-accent-soft" : "hover:bg-surface-2")}>
              <div className="flex items-start gap-2"><span className={cn("min-w-0 flex-1 break-words text-sm", conversation.unread_count > 0 ? "font-semibold" : "font-medium")}>{conversation.participant_name || conversation.participant_email}</span>{conversation.unread_count > 0 && <span aria-label={`${conversation.unread_count} unread message${conversation.unread_count === 1 ? "" : "s"}`} className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />}</div>
              <p className={cn("mt-1 break-words text-sm", conversation.unread_count > 0 && "font-medium")}>{conversation.subject || "(No subject)"}</p>
              <p className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-ink-2">{conversation.preview}</p>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-muted"><time dateTime={conversation.last_message_at}>{mailTime(conversation.last_message_at)}</time><span>{conversation.message_count > 1 && `${conversation.message_count} messages`}{conversation.message_count > 1 && conversation.direction === "outbound" && " · "}{conversation.direction === "outbound" && "Outgoing"}</span></div>
            </Link></li>)}
          </ul>}
          {visibleList.next_cursor && <div className="border-t border-line p-3 text-center"><Button size="sm" disabled={!online || listLoading || moreLoading} onClick={() => void loadMore()}>{moreLoading && <LoaderCircle size={14} className="animate-spin" />} Load more</Button></div>}
        </Card>
      </section>
      <section aria-label="Conversation" className={cn("min-w-0", !conversationId && "hidden lg:block")}>
        {conversationId && <Button size="sm" className="mb-3 lg:hidden" onClick={() => navigate("/mail")}><ArrowLeft size={14} /> All conversations</Button>}
        {detailError && <MailError title="Could not load this conversation" error={detailError} onRetry={refreshMail} disabled={!online || detailLoading} />}
        {readError && <MailError title="Could not mark displayed messages as read" error={readError} onRetry={() => void readDisplayed()} disabled={!online} />}
        {actionError && actionError.id === conversationId && <MailError title={actionError.restore ? "Could not restore this conversation" : "Could not move this conversation to Trash"} error={actionError.message} onRetry={() => void changeTrash(actionError.restore)} disabled={!online || actionBusy} />}
        {!conversationId ? <Card><EmptyState icon={<Mail size={20} />} title="Choose a conversation"><p>Read customer email and reply here.</p></EmptyState></Card> : !visibleDetail ? <Card>{detailLoading ? <Loading label="Loading conversation" /> : <EmptyState icon={<Mail size={20} />} title={online ? "Conversation unavailable" : "Connect to view this conversation"} />}</Card> : <>
          <Card><div className="border-b border-line px-5 py-4"><h2 ref={heading} tabIndex={-1} className="break-words font-display text-[25px] outline-none">{visibleDetail.conversation.subject || "(No subject)"}</h2><p className="mt-1 break-all text-sm text-ink-2">{visibleDetail.conversation.participant_name && <span className="mr-2">{visibleDetail.conversation.participant_name}</span>}{visibleDetail.conversation.participant_email}</p><div className="mt-3 flex flex-wrap items-center gap-2"><Button size="sm" disabled={!online || actionBusy} onClick={() => void changeTrash(!!visibleDetail.conversation.trashed_at)}>{actionBusy ? <LoaderCircle size={14} className="animate-spin" /> : visibleDetail.conversation.trashed_at ? <RotateCcw size={14} /> : <Trash2 size={14} />}{visibleDetail.conversation.trashed_at ? "Restore conversation" : "Move to Trash"}</Button>{visibleDetail.conversation.trashed_at && <span className="text-xs text-muted">In Trash</span>}</div></div>
            {detailLoading && <p role="status" className="px-5 pt-3 text-xs text-muted">Refreshing conversation…</p>}
            {visibleDetail.next_cursor && <div className="border-b border-line p-3 text-center"><Button size="sm" disabled={!online || detailLoading || earlierLoading} onClick={() => void loadEarlier()}>{earlierLoading && <LoaderCircle size={14} className="animate-spin" />} Load earlier messages</Button></div>}
            <div ref={history} tabIndex={0} aria-label="Message history" className="max-h-[60vh] min-w-0 divide-y divide-line overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent">{visibleDetail.messages.map(message => <Message key={message.id} message={message} online={online} />)}</div>
            {!visibleDetail.messages.length && <p className="px-5 py-6 text-sm text-muted">No messages in this conversation yet.</p>}
          </Card>
          <div className="mt-4"><MailEditor key={visibleDetail.conversation.id} detail={visibleDetail} sender={status?.sender_address || ""} enabled={sendEnabled && !visibleDetail.conversation.trashed_at} onSent={sent} /></div>
        </>}
      </section>
    </div>
    <MailEditor modal open={composeOpen} onClose={() => setComposeOpen(false)} sender={status?.sender_address || ""} enabled={sendEnabled} onSent={sent} />
  </>;
}

function Loading({ label }: { label: string }) {
  return <div role="status" className="flex items-center gap-2 px-5 py-10 text-sm text-muted"><LoaderCircle size={16} className="animate-spin" /> {label}</div>;
}
function MailError({ title, error, onRetry, disabled }: { title: string; error: string; onRetry: () => void; disabled?: boolean }) {
  return <div role="alert" className="mb-3 flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-bad/30 bg-surface px-4 py-3 text-sm text-bad"><span className="min-w-0 flex-1 break-words">{title}: {error}</span><Button size="sm" disabled={disabled} onClick={onRetry}>Retry</Button></div>;
}
function Message({ message, online }: { message: MailMessage; online: boolean }) {
  return <article aria-label={`${message.direction === "outbound" ? "Outgoing" : "Received"} message`} className="min-w-0 px-5 py-5">
    <div className="flex flex-wrap items-start justify-between gap-2 text-xs"><div className="min-w-0"><p className="break-all font-medium">{message.status === "sent" ? "Sent by " : "From "}{message.from_address}</p><p className="mt-1 break-all text-muted">To {message.to_addresses.join(", ")}</p>{message.cc_addresses.length > 0 && <p className="mt-1 break-all text-muted">Cc {message.cc_addresses.join(", ")}</p>}</div><time dateTime={message.created_at} className="text-muted">{mailTime(message.created_at, true)}</time></div>
    {message.status === "pending" && <p role="status" className="mt-2 text-xs font-medium text-ink-2">Sending not confirmed</p>}
    {message.status === "failed" && <p role="status" className="mt-2 text-xs font-medium text-bad">Not sent</p>}
    <p className="mt-4 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">{message.text_body || "(No message text)"}</p>
    {message.attachments.length > 0 && <div className="mt-4 flex flex-col gap-2" aria-label="Attachments">{message.attachments.map(attachment => <Attachment key={attachment.id} messageId={message.id} attachment={attachment} online={online} />)}</div>}
  </article>;
}
function Attachment({ messageId, attachment, online }: { messageId: string; attachment: MailAttachment; online: boolean }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const tooLarge = attachment.size > MAIL_ATTACHMENT_LIMIT;
  const download = async () => {
    if (busyRef.current || !online || tooLarge) return;
    busyRef.current = true; setBusy(true); setError(null); setSaved(false);
    try { setSaved(await downloadMailAttachment(messageId, attachment)); }
    catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return <div><Button className="h-auto max-w-full justify-start py-2 text-left" size="sm" disabled={!online || busy || tooLarge} onClick={() => void download()}>{busy ? <LoaderCircle size={14} className="shrink-0 animate-spin" /> : <Download size={14} className="shrink-0" />}<span className="min-w-0 break-all">{safeAttachmentName(attachment.filename)} <span className="text-xs text-muted">({attachment.size >= 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(attachment.size / 1024))} KB`})</span></span></Button>{saved && <p role="status" className="mt-1 text-xs text-good">Attachment saved</p>}{tooLarge && <p className="mt-1 text-xs text-muted">Downloads are limited to 15 MB.</p>}{error && <p role="alert" className="mt-1 break-words text-xs text-bad">Could not save attachment: {error}. Select the attachment to retry.</p>}</div>;
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
  const submit = async () => {
    if (busyRef.current || !canSend || (!attempt.current && !valid)) return;
    const payload = attempt.current || {
      idempotency_key: crypto.randomUUID(), to: recipient, subject: replySubject, text: text.trim(),
      ...(detail ? { conversation_id: detail.conversation.id, ...(replyTarget ? { reply_to_message_id: replyTarget.id } : {}) } : {}),
    };
    if (new TextEncoder().encode(JSON.stringify(payload)).length > 65_536) { setError("This message is too large. Please shorten it before sending."); return; }
    busyRef.current = true; setBusy(true); setError(null);
    attempt.current = payload;
    setLocked(true);
    try {
      const result = await sendMail(attempt.current);
      if (result.status === "pending") { setError("This email is still being sent. Retry to check its progress using the same message."); return; }
      if (!result.conversation_id || !result.message_id) throw new Error("The server did not confirm the send. Retry the same message to check it.");
      attempt.current = null; setLocked(false); setTo(""); setSubject(""); setText("");
      onSent(result);
    } catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const form = <form onSubmit={event => { event.preventDefault(); void submit(); }} className="min-w-0 space-y-4">
    <p className="break-all text-xs text-muted">From {sender || "the configured business sender"}</p>
    {detail ? <p className="break-all text-sm text-ink-2">Reply to <span className="font-medium text-ink">{recipient}</span></p> : <>
      <Field label="To"><Input type="email" required maxLength={254} autoComplete="off" value={to} readOnly={locked} disabled={busy} onChange={event => setTo(event.target.value)} placeholder="customer@example.com" /></Field>
      <Field label="Subject"><Input required maxLength={200} value={subject} readOnly={locked} disabled={busy} onChange={event => setSubject(event.target.value)} /></Field>
    </>}
    <Field label={detail ? "Reply message" : "Message"}><Textarea aria-label={detail ? "Reply message" : "Message"} required maxLength={50_000} rows={detail ? 5 : 8} value={text} readOnly={locked} disabled={busy} onChange={event => setText(event.target.value)} placeholder={detail ? "Write your reply…" : "Write your message…"} /></Field>
    {error && <p role="alert" className="break-words text-sm text-bad">{error}</p>}
    {locked && !busy && <p className="text-xs leading-relaxed text-ink-2">The send was not yet confirmed. Retry keeps the original message and avoids sending a second copy. {modal ? "Your draft is kept when you close this editor while remaining in Mail." : "Retry this message before leaving the conversation."}</p>}
    {detail?.conversation.trashed_at ? <p className="text-xs text-ink-2">Restore this conversation before replying.</p> : !enabled && <p className="text-xs text-ink-2">Connect to the business mail service to send.</p>}
    {enabled && detail && !replyTarget && <p className="text-xs text-ink-2">This conversation has no reply header yet. Refresh it or compose a new email.</p>}
    <div className="flex flex-wrap justify-end gap-2">{(text || to || subject || locked) && <Button disabled={busy} onClick={() => { if (locked) setDiscardOpen(true); else { setTo(""); setSubject(""); setText(""); setError(null); } }}>Discard draft</Button>}{modal && <Button disabled={busy} onClick={onClose}>Keep draft & close</Button>}<Button type="submit" variant="primary" disabled={!canSend || busy || (!locked && !valid)}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}{busy ? "Sending…" : locked ? "Retry send" : detail ? "Send reply" : "Send email"}</Button></div>
  </form>;
  return <>{modal ? <Modal open={open} onClose={() => { if (!busyRef.current) onClose?.(); }} title="New email" width="max-w-lg">{form}</Modal> : <Card><div className="px-5 py-5"><h3 className="mb-4 font-display text-[22px]">Reply</h3>{form}</div></Card>}<ConfirmModal open={discardOpen} title="Discard this draft?" confirmLabel="Discard draft" message="The previous email may already have been sent. Discarding this draft cannot recall it. Check the conversation before composing another." onClose={() => setDiscardOpen(false)} onConfirm={() => { attempt.current = null; setLocked(false); setTo(""); setSubject(""); setText(""); setError(null); }} /></>;
}
