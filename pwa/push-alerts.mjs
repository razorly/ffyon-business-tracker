import { DatabaseSync } from "node:sqlite";

const londonClock = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function paymentDue(appointment, day, clock) {
  if (appointment.status !== "confirmed" || appointment.price_pence === 0) return false;
  if (!appointment.time_confirmed) return appointment.date < day;
  return Date.parse(`${appointment.date}T${appointment.start_time}:00Z`) + appointment.duration_min * 60_000 <= clock;
}

function alertFields(appointment) {
  const { id, date, start_time, time_confirmed, duration_min, price_pence, status,
    proposed_date, proposed_start_time, proposed_time_confirmed } = appointment;
  if (typeof id !== "string" || typeof date !== "string" || typeof start_time !== "string" ||
      !Number.isSafeInteger(duration_min) || typeof status !== "string") throw new Error("Invalid booking alert data.");
  return { id, date, start_time, time_confirmed, duration_min, price_pence, status,
    proposed_date, proposed_start_time, proposed_time_confirmed };
}

export function createAlertReader({ request, ledger, now = () => new Date() }) {
  let appointments = new Map();
  let cursor;
  let ledgerRevision;
  let paymentRows = [];

  async function readBookings(credential) {
    // Follow the same change feed as the apps. Do not persist booking records with the alert subscriptions.
    const next = new Map(appointments);
    let sequence = cursor;
    for (let page = 0; page < 5; page++) {
      const query = sequence === undefined ? "" : `?cursor=${sequence}&limit=250`;
      const result = await request(credential, "sync", query);
      if (!Number.isSafeInteger(result.cursor) || result.cursor < (sequence ?? 0) || !Array.isArray(result.changes)) {
        throw new Error("Invalid booking alert cursor.");
      }
      if (result.snapshot) {
        next.clear();
        for (const source of result.snapshot.appointments) {
          const value = alertFields(source);
          next.set(value.id, value);
        }
      } else if (sequence === undefined) { throw new Error("Missing booking alert snapshot."); }
      for (const change of result.changes) {
        if (change.entity !== "appointment") continue;
        if (change.record) next.set(change.id, alertFields(change.record));
        else next.delete(change.id);
      }
      if (result.has_more && result.cursor === sequence) throw new Error("Booking alert cursor did not advance.");
      sequence = result.cursor;
      if (!result.has_more) {
        appointments = next;
        cursor = sequence;
        return [...next.values()];
      }
    }
    appointments = next;
    cursor = sequence;
    throw new Error("Booking alert sync will continue on the next poll.");
  }

  async function readPayments(bookings) {
    const snapshot = await ledger?.get(ledgerRevision === undefined ? undefined : String(ledgerRevision));
    if (!snapshot?.revision) return undefined;
    if (snapshot.content) {
      // Read only the shared payment markers and fields needed for the due-time check.
      const db = new DatabaseSync(":memory:", { allowExtension: false });
      try {
        db.deserialize(Buffer.from(snapshot.content, "base64"));
        db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON");
        paymentRows = db.prepare(`
          SELECT id, remote_id, date, start_time, time_confirmed, duration_min, price_pence, status, transaction_id
          FROM appointments`).all();
        ledgerRevision = snapshot.revision;
      } finally { db.close(); }
    }
    const paid = new Set(paymentRows.filter(row => row.remote_id && row.transaction_id != null).map(row => row.remote_id));
    // Use the live site for shared bookings, so a cancelled/rescheduled booking cannot alert from an old ledger copy.
    const candidates = [
      ...bookings.filter(row => !paid.has(row.id)),
      ...paymentRows.filter(row => !row.remote_id && row.transaction_id == null),
    ];
    const parts = Object.fromEntries(londonClock.formatToParts(now()).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    // Interpret the wall-clock components on a common timeline, matching the tracker's date/minute comparisons.
    const clock = Date.parse(`${day}T${parts.hour}:${parts.minute}:${parts.second}Z`);
    return candidates.filter(row => paymentDue(row, day, clock)).map(row =>
      JSON.stringify([row.id, row.date, Boolean(row.time_confirmed), row.start_time, row.duration_min]));
  }

  async function readMail(credential) {
    const result = await request(credential, "mail/unread");
    if (!Array.isArray(result.conversations)) throw new Error("Invalid mail alert data.");
    return result.conversations.map(row => {
      const { id, unread_count, message_count, last_message_at, direction } = row;
      if (typeof id !== "string" || !Number.isSafeInteger(unread_count) || unread_count < 1 ||
          !Number.isSafeInteger(message_count) || typeof last_message_at !== "string") throw new Error("Invalid unread mail data.");
      return { id, unread: unread_count, messages: message_count, latest: last_message_at, inbound: direction === "inbound" };
    });
  }

  return async credential => {
    const [bookings, mail] = await Promise.allSettled([readBookings(credential), readMail(credential)]);
    const rows = bookings.status === "fulfilled" ? bookings.value : undefined;
    const requests = rows?.flatMap(row => {
      const keys = [];
      if (row.status === "pending") keys.push(JSON.stringify([row.id, "new", row.date, row.start_time, row.time_confirmed]));
      if (row.proposed_date != null) keys.push(JSON.stringify([row.id, "change", row.proposed_date, row.proposed_start_time, row.proposed_time_confirmed]));
      return keys;
    });
    const payments = rows && await readPayments(rows).catch(() => undefined);
    return { requests, payments, mail: mail.status === "fulfilled" ? mail.value : undefined };
  };
}
