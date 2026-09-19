import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";

const ThemeCtx = createContext<{ pref: ThemePref; dark: boolean; setPref: (p: ThemePref) => void }>({
  pref: "system",
  dark: false,
  setPref: () => {},
});

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem("ffyon-theme");
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable */
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [media] = useState(() => window.matchMedia("(prefers-color-scheme: dark)"));
  const [systemDark, setSystemDark] = useState(media.matches);

  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [media]);

  const dark = pref === "dark" || (pref === "system" && systemDark);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem("ffyon-theme", p);
    } catch {
      /* storage unavailable */
    }
  };

  return <ThemeCtx.Provider value={{ pref, dark, setPref }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
