/**
 * Categorical palette (validated for colour-blind separation, light + dark steps).
 * Categories store the light hex; the dark step is looked up when rendering in dark mode.
 * Always assign in this fixed order — never cycle or generate new hues.
 */
export const PALETTE: { name: string; light: string; dark: string }[] = [
  { name: "Blue", light: "#2a78d6", dark: "#3987e5" },
  { name: "Orange", light: "#eb6834", dark: "#d95926" },
  { name: "Aqua", light: "#1baf7a", dark: "#199e70" },
  { name: "Yellow", light: "#eda100", dark: "#c98500" },
  { name: "Magenta", light: "#e87ba4", dark: "#d55181" },
  { name: "Green", light: "#008300", dark: "#008300" },
  { name: "Violet", light: "#4a3aa7", dark: "#9085e9" },
  { name: "Red", light: "#e34948", dark: "#e66767" },
];

export function themedColour(hex: string, dark: boolean): string {
  if (!dark) return hex;
  const slot = PALETTE.find((p) => p.light.toLowerCase() === hex.toLowerCase());
  return slot ? slot.dark : hex;
}

/** First palette slot not already used, else the first slot. */
export function nextColour(used: string[]): string {
  const lower = used.map((u) => u.toLowerCase());
  return (PALETTE.find((p) => !lower.includes(p.light.toLowerCase())) ?? PALETTE[0]).light;
}
