import { invoke } from "@tauri-apps/api/core";
import { adminRequest } from "./sync";

export type MailFilter = "all" | "unread" | "sent" | "trash";
export type MailDirection = "inbound" | "outbound";
export interface MailConversation {
  id: string;
  subject: string;
  participant_email: string;
  participant_name: string | null;
  client_id: string | null;
  unread_count: number;
  message_count: number;
  last_message_at: string;
  preview: string;
  direction: MailDirection;
  trashed_at: string | null;
}
export interface MailAttachment { id: string; filename: string; content_type: string; size: number }
export interface MailMessage {
  id: string;
  direction: MailDirection;
  status: "received" | "pending" | "sent" | "failed";
  from_address: string;
  to_addresses: string[];
  cc_addresses: string[];
  subject: string;
  text_body: string;
  created_at: string;
  read_at: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  references: string[];
  attachments: MailAttachment[];
}
export interface MailList { conversations: MailConversation[]; next_cursor: string | null }
export interface MailDetail { conversation: MailConversation; messages: MailMessage[]; next_cursor: string | null; retention_cutoff?: string }
export interface MailUnread { conversations: MailConversation[]; unread_count: number }
export interface MailStatus { configured: boolean; sender_address: string; receiving_addresses: string[]; receiving_configured?: boolean }
export interface MailSend {
  idempotency_key: string;
  to: string;
  subject: string;
  text: string;
  conversation_id?: string;
  reply_to_message_id?: string;
}
export interface MailSendResult { conversation_id: string; message_id: string; status?: "sent" | "pending" }

// IDs remain a single path segment; the native bridge validates their UUID form.
const segment = (id: string) => encodeURIComponent(id);
export const listMail = (filter: MailFilter, cursor?: string) => adminRequest<MailList>("mail/conversations", "GET", undefined,
  { filter, limit: "30", ...(cursor ? { cursor } : {}) });
export const getMail = (id: string, cursor?: string) => adminRequest<MailDetail>(`mail/conversations/${segment(id)}`, "GET", undefined,
  { limit: "50", ...(cursor ? { cursor } : {}) });
export const getMailUnread = () => adminRequest<MailUnread>("mail/unread", "GET");
export const getMailStatus = () => adminRequest<MailStatus>("mail/status", "GET");
export const markMailRead = (id: string, messageIds: string[]) => adminRequest(`mail/conversations/${segment(id)}/read`, "POST", { message_ids: messageIds });
export const trashMail = (id: string) => adminRequest(`mail/conversations/${segment(id)}/trash`, "POST", {});
export const restoreMail = (id: string) => adminRequest(`mail/conversations/${segment(id)}/restore`, "POST", {});
export const reconcileMail = () => adminRequest<{ imported?: number; more_available?: boolean }>("mail/reconcile", "POST", {});

// The same draft and key are kept by the editor after an uncertain response.
// This guard also joins concurrent submissions instead of sending twice.
const sends = new Map<string, { body: string; promise: Promise<MailSendResult> }>();
export function sendMail(payload: MailSend): Promise<MailSendResult> {
  const body = JSON.stringify(payload);
  const existing = sends.get(payload.idempotency_key);
  if (existing) {
    if (existing.body !== body) return Promise.reject(new Error("A retry must use the original message."));
    return existing.promise;
  }
  const promise = adminRequest<MailSendResult>("mail/send", "POST", payload);
  sends.set(payload.idempotency_key, { body, promise });
  void promise.finally(() => { if (sends.get(payload.idempotency_key)?.promise === promise) sends.delete(payload.idempotency_key); }).catch(() => {});
  return promise;
}

export function mailTime(value: string, full = false) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", ...(full ? { year: "numeric" as const } : {}), hour: "2-digit", minute: "2-digit" }).format(date);
}

const londonDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
/** Compact list time: "14:05" today, "3 Oct" this year, "3 Oct 2025" otherwise. */
export function mailShortTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const day = londonDay(date), today = londonDay(now);
  if (day === today) return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit" }).format(date);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric", month: "short", ...(day.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" as const }) }).format(date);
}
export function mailIsThisYear(value: string, now = new Date()) {
  const date = new Date(value);
  return !Number.isFinite(date.getTime()) || londonDay(date).slice(0, 4) === londonDay(now).slice(0, 4);
}

export const MAIL_ATTACHMENT_LIMIT = 15 * 1024 * 1024;
export function safeAttachmentName(value: string) {
  const base = value.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/[. ]+$/g, "").slice(0, 180) || "attachment";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `attachment-${base}` : base;
}

/** Download bytes through the paired bridge and a user-selected save grant. Never open attachment content. */
export async function downloadMailAttachment(messageId: string, attachment: MailAttachment) {
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAIL_ATTACHMENT_LIMIT) throw new Error("This attachment exceeds the 15 MB download limit.");
  const file = await adminRequest<{ filename: string; content_type: string; base64: string }>(`mail/attachments/${segment(messageId)}/${segment(attachment.id)}`, "GET");
  if (typeof file.base64 !== "string" || file.base64.length > 4 * Math.ceil(MAIL_ATTACHMENT_LIMIT / 3) || file.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error("The attachment download is invalid or too large.");
  const raw = atob(file.base64);
  if (raw.length > MAIL_ATTACHMENT_LIMIT) throw new Error("This attachment exceeds the 15 MB download limit.");
  const name = safeAttachmentName(typeof file.filename === "string" ? file.filename : attachment.filename);
  const extension = name.includes(".") ? name.split(".").pop() : null;
  const filters = extension && /^[a-z0-9]{1,12}$/i.test(extension) ? [{ name: "Attachment", extensions: [extension] }] : [];
  const path = await invoke<string | null>("protected_save_file", { defaultPath: name, filters });
  if (!path) return false;
  await invoke("protected_write_file", { path, data: Array.from(raw, character => character.charCodeAt(0)) });
  return true;
}
