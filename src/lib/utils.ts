import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** The app's six type sizes are named, so class merging must know they are sizes, not colours. */
const merge = extendTailwindMerge({
  extend: { theme: { text: ["label", "small", "body", "heading", "title", "figure"] } },
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
