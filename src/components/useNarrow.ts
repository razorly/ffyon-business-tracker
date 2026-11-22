import { useEffect, useState } from "react";

const PHONE = "(max-width: 639px)";

/** True on a phone-width screen (under 640px), where pages stack and dialogs become sheets. */
export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}
