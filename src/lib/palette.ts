/**
 * Categorical palette (validated for colour-blind separation, light + dark steps).
 * Categories store the light hex; the dark step is looked up when rendering in dark mode.
 * Always assign in this fixed order — never cycle or generate new hues.
 */
export const PALETTE: { name: string; light: string; dark: string }[] = [
  { name: "Cocoa", light: "#9c4a2a", dark: "#a9552f" },
  { name: "Rose", light: "#e8798f", dark: "#dc6a86" },
  { name: "Blue", light: "#2f7fcf", dark: "#4a8fe0" },
  { name: "Honey", light: "#dca021", dark: "#b88510" },
  { name: "Violet", light: "#7a4aa0", dark: "#9a74cf" },
  { name: "Teal", light: "#1c9a78", dark: "#1a9474" },
  { name: "Coral", light: "#e0603a", dark: "#d8663a" },
  { name: "Berry", light: "#b0305a", dark: "#b0366a" },
];

export function themedColour(hex: string, dark: boolean): string {
  if (!dark) return hex;
  const slot = PALETTE.find((p) => p.light.toLowerCase() === hex.toLowerCase());
  return slot ? slot.dark : hex;
}

/** A translucent wash of a category colour — used for appointment blocks. */
export function tint(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** First palette slot not already used, else the first slot. */
export function nextColour(used: string[]): string {
  const lower = used.map((u) => u.toLowerCase());
  return (PALETTE.find((p) => !lower.includes(p.light.toLowerCase())) ?? PALETTE[0]).light;
}
