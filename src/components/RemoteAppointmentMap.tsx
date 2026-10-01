import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, MapPin, Navigation, X } from "lucide-react";
import { Button } from "./ui";

type PostcodeLocation = { postcode: string; latitude: number; longitude: number };

export function RemoteAppointmentMap({ address, postcode }: { address: string; postcode: string }) {
  const [location, setLocation] = useState<PostcodeLocation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    request.current += 1;
    setLocation(null);
    setError("");
    setBusy(false);
    return () => { request.current += 1; };
  }, [postcode, address]);

  const show = async () => {
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const found = await invoke<PostcodeLocation>("lookup_postcode", { postcode });
      if (current !== request.current) return;
      if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) throw new Error("The postcode location is unavailable.");
      setLocation(found);
    } catch (cause) {
      if (current === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (current === request.current) setBusy(false); }
  };
  const directions = async () => {
    setError("");
    try { await invoke("open_appointment_directions", { address, postcode }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const source = location ? `https://www.openstreetmap.org/export/embed.html?${new URLSearchParams({
    bbox: `${location.longitude - 0.008},${location.latitude - 0.005},${location.longitude + 0.008},${location.latitude + 0.005}`,
    layer: "mapnik",
    marker: `${location.latitude},${location.longitude}`,
  })}` : "";

  return <div className="min-w-0 space-y-2 border-t border-line pt-3">
    <p className="whitespace-pre-line break-words text-[13px] text-ink-2">{address}<span className="mt-1 block font-medium">{postcode}</span></p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" disabled={busy || !postcode.trim()} onClick={location ? () => setLocation(null) : () => void show()}>
        {busy ? <LoaderCircle size={14} className="animate-spin" /> : location ? <X size={14} /> : <MapPin size={14} />}
        {busy ? "Finding postcode..." : location ? "Hide map" : "Show map"}
      </Button>
      <Button type="button" size="sm" disabled={!postcode.trim() || !address.trim()} onClick={() => void directions()}><Navigation size={14} /> Directions</Button>
    </div>
    <p className="text-[11px] leading-relaxed text-muted">Map: postcode area only, via Postcodes.io and OpenStreetMap. Directions sends the address to Google Maps.</p>
    {error && <p role="alert" className="break-words text-xs text-bad">{error}</p>}
    {location && <div className="space-y-1">
      <iframe title={`Postcode area map for ${location.postcode}`} src={source} className="h-60 w-full rounded-lg border border-line" referrerPolicy="no-referrer" sandbox="allow-scripts" loading="lazy" />
      <p className="text-xs text-muted">Approximate postcode location. Check the address before travelling.</p>
    </div>}
  </div>;
}
