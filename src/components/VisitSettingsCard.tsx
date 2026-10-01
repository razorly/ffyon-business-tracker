import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button, Card, CardHeader, Field, Input, Textarea } from "@/components/ui";
import { parseAmount, penceToInput } from "@/lib/format";
import { updateCloudSettings, type BusinessSettings } from "@/lib/sync";

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
    catch (e) { setError(e instanceof Error ? e.message : "Settings could not be saved."); onSaved(); } finally { setBusy(false); }
  }
  return <Card className="self-start"><CardHeader title="Studio, home visits & contact" /><form onSubmit={save} className="space-y-4 px-5 pb-5">
    {!settings ? <p className="text-sm text-muted">Synchronize the site to load visit settings.</p> : <>
      <fieldset disabled={!online || busy} className="space-y-4">
        <div className="grid grid-cols-2 gap-3"><Field label="Home-visit fee (GBP)"><Input required inputMode="decimal" value={fee} onChange={e => { setFee(e.target.value); setDirty(true); }} /></Field><Field label="Coverage radius (miles)"><Input type="number" required min={1} max={200} step={1} value={radius} onChange={e => { setRadius(e.target.value); setDirty(true); }} /></Field></div>
        <p className="text-xs text-muted">The fee is added once to new online home-visit requests, after any service discount. Existing bookings keep their quoted total. Coverage is shown to customers; review the address before accepting a request.</p>
        <Field label="Public studio postcode"><Input required maxLength={12} value={postcode} onChange={e => { setPostcode(e.target.value); setDirty(true); }} /></Field>
        <Field label="Private studio address"><Textarea rows={3} maxLength={500} value={address} onChange={e => { setAddress(e.target.value); setDirty(true); }} /></Field>
        <p className="text-xs text-muted">The postcode is public. The full address is only shown in the accounts of customers with a confirmed studio appointment. Leave blank to share it directly after confirmation.</p>
        <Field label="Public contact email"><Input type="email" required maxLength={254} value={email} onChange={e => { setEmail(e.target.value); setDirty(true); }} /></Field>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={monitored} onChange={e => { setMonitored(e.target.checked); setDirty(true); }} className="mt-1 accent-accent" />This inbox is monitored and ready for customer enquiries</label>
      </fieldset>
      {!online && <p className="text-sm text-muted">Connect to the site to save settings.</p>}
      {stale && <p role="alert" className="text-sm text-bad">Settings changed on another device. Reload the latest settings before saving.</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      <div className="flex justify-end gap-2">{dirty && <Button type="button" disabled={busy} onClick={() => { setDirty(false); setError(""); }}>{stale ? "Reload latest" : "Reset"}</Button>}<Button variant="primary" type="submit" disabled={!online || busy || !dirty || stale || !valid}>{busy ? "Saving…" : "Save visit settings"}</Button></div>
    </>}
  </form></Card>;
}
