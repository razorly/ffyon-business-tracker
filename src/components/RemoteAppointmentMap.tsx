import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, MapPin, Navigation, X } from "lucide-react";
import { Button, ErrorText } from "./ui";
import { isPwa } from "@/lib/access";

type PostcodeLocation = { postcode: string; latitude: number; longitude: number };

async function lookupPostcode(postcode: string) {
  if (!isPwa()) return invoke<PostcodeLocation>("lookup_postcode", { postcode });
  const normalized = postcode.trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(normalized)) throw new Error("Enter a valid UK postcode.");
  const response = await fetch(`https://api.postcodes.io/postcodes/${normalized}`, {
    credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("The postcode location is unavailable.");
  const { result } = await response.json() as { result: PostcodeLocation };
  return result;
}

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
      const found = await lookupPostcode(postcode);
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
  const directionsUrl = `https://www.google.com/maps/dir/?${new URLSearchParams({ api: "1", destination: `${address}, ${postcode}` })}`;
  const source = location ? `https://www.openstreetmap.org/export/embed.html?${new URLSearchParams({
    bbox: `${location.longitude - 0.008},${location.latitude - 0.005},${location.longitude + 0.008},${location.latitude + 0.005}`,
    layer: "mapnik",
    marker: `${location.latitude},${location.longitude}`,
  })}` : "";

  return <div className="flex w-full min-w-0 flex-col gap-2">
    <p className="whitespace-pre-line break-words text-body text-ink">{address}<span className="block font-medium">{postcode}</span></p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy || !postcode.trim()} onClick={location ? () => setLocation(null) : () => void show()}>
        {busy ? <LoaderCircle size={16} className="animate-spin" aria-hidden /> : location ? <X size={16} aria-hidden /> : <MapPin size={16} aria-hidden />}
        {busy ? "Finding postcode..." : location ? "Hide map" : "Show map"}
      </Button>
      <Button type="button" disabled={!postcode.trim() || !address.trim()} onClick={() => {
        if (isPwa()) window.open(directionsUrl, "_blank", "noopener,noreferrer");
        else void directions();
      }}><Navigation size={16} aria-hidden /> Directions</Button>
    </div>
    <p className="text-label text-ink-2">Map: postcode area only, via Postcodes.io and OpenStreetMap. Directions sends the address to Google Maps.</p>
    {error && <ErrorText>{error}</ErrorText>}
    {location && <div className="flex w-full min-w-0 flex-col gap-1">
      {/* Keep the external frame on its own origin so tile requests identify OSM.
          The cross-origin frame still cannot read the app or navigate its window. */}
      <iframe title={`Postcode area map for ${location.postcode}`} src={source} className="block h-60 w-full rounded-xl border border-line" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin" loading="lazy" />
      <p className="text-small text-ink-2">Approximate postcode location. Check the address before travelling.</p>
    </div>}
  </div>;
}
