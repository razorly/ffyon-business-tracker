import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Card, CardHeader, Checkbox, Field, Input, MoneyInput, Textarea } from "@/components/ui";
import { parseAmount, penceToInput } from "@/lib/format";
import { updateCloudSettings, type BusinessSettings } from "@/lib/sync";
import { Help, SaveBar, SubHeading } from "@/components/settings/parts";

/** What the website tells customers about home visits, where the studio is and how to get in touch. */
export function VisitSettingsCard({ settings, online, onSaved }: { settings: BusinessSettings | null; online: boolean; onSaved: () => void }) {
  const [fee, setFee] = useState("0"), [radius, setRadius] = useState("15"), [postcode, setPostcode] = useState("LA3 2AS"), [address, setAddress] = useState("");
  const [email, setEmail] = useState("hello@tannedbyffy.co.uk"), [monitored, setMonitored] = useState(false);
  const [dirty, setDirty] = useState(false), [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    if (!settings || dirty) return;
    setFee(penceToInput(settings.home_visit_fee_pence ?? 0)); setRadius(String(settings.home_visit_radius_miles ?? 15)); setPostcode(settings.studio_postcode ?? "LA3 2AS"); setAddress(settings.studio_address ?? ""); setEmail(settings.contact_email ?? "hello@tannedbyffy.co.uk"); setMonitored(settings.contact_email_enabled ?? false); setRevision(settings.revision);
  }, [settings, dirty]);
  const amount = parseAmount(fee), miles = Number(radius), stale = !!settings && dirty && revision !== settings.revision;
  const valid = amount !== null && amount >= 0 && amount <= 1000000 && Number.isInteger(miles) && miles >= 1 && miles <= 200;
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings || !online || !valid || stale || busy) return;
    setBusy(true); setError("");
    try { await updateCloudSettings({ ...settings, revision, home_visit_fee_pence: amount!, home_visit_radius_miles: miles, studio_postcode: postcode.trim(), studio_address: address.trim(), contact_email: email.trim(), contact_email_enabled: monitored }); setDirty(false); toast.success("Visit and contact settings saved"); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Couldn't save. Try again."); onSaved(); } finally { setBusy(false); }
  }
  const change = <T,>(set: (value: T) => void) => (value: T) => { set(value); setDirty(true); };
  return <Card><CardHeader title="Home visits, studio and contact" subtitle="What your website tells customers" /><form onSubmit={save} className="space-y-5 px-5 pb-5 pt-2">
    {!settings ? <Help>Connect to the website to load these settings.</Help> : <>
      <fieldset disabled={!online || busy} className="min-w-0 space-y-5">
        <div className="space-y-3">
          <SubHeading>Home visits</SubHeading>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="Home visit fee"><MoneyInput required value={fee} onChange={e => change(setFee)(e.target.value)} /></Field>
            <Field label="Miles you travel"><Input className="tabular" type="number" required min={1} max={200} step={1} value={radius} onChange={e => change(setRadius)(e.target.value)} /></Field>
          </div>
          <Help>The fee is added once to each new home visit booked online, after any discount. Bookings already made keep their price. Customers see how far you travel, so check the address before you accept a request.</Help>
        </div>
        <div className="space-y-3 border-t border-line pt-4">
          <SubHeading>Studio</SubHeading>
          <Field label="Postcode" hint="Shown to everyone on the website."><Input required maxLength={12} value={postcode} onChange={e => change(setPostcode)(e.target.value)} /></Field>
          <Field label="Full address" hint="Only shown to customers with a confirmed studio appointment. Leave it blank to send it yourself."><Textarea rows={3} maxLength={500} value={address} onChange={e => change(setAddress)(e.target.value)} /></Field>
        </div>
        <div className="space-y-3 border-t border-line pt-4">
          <SubHeading>Contact</SubHeading>
          <Field label="Email shown on the website"><Input type="email" required maxLength={254} value={email} onChange={e => change(setEmail)(e.target.value)} /></Field>
          <Checkbox label="I check this inbox, so customers can email me" checked={monitored} onChange={e => change(setMonitored)(e.target.checked)} />
        </div>
      </fieldset>
      {!online && <Help>Reconnect to change these.</Help>}
      {!valid && dirty && <Help className="text-bad">Enter a fee, and a whole number of miles between 1 and 200.</Help>}
      <SaveBar dirty={dirty} stale={stale} busy={busy} disabled={!online || !valid} label="Save visit settings" onReset={() => { setDirty(false); setError(""); }} error={error} />
    </>}
  </form></Card>;
}
