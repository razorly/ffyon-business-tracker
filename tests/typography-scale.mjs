import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import test from "node:test";

// The app's typography is deliberately strict: six sizes, three weights, sentence case, and the
// serif only on the logo and on page and dialog titles. This keeps a stray class from eroding it.
const root = resolve("src");
const SERIF_ALLOWED = new Set(["components/Layout.tsx", "components/ui.tsx", "components/AccessGate.tsx", "components/LedgerGate.tsx"]);
const RULES = [
  [/\btext-(?:xs|sm|base|lg|xl|[2-9]xl)\b/, "use text-label, text-small, text-body, text-heading, text-title or text-figure"],
  [/\btext-\[\d[\d.]*(?:px|rem|em)\]/, "no one-off font sizes"],
  [/\bleading-(?!\[)[\w.]+/, "line height comes with the size class"],
  [/\bfont-(?:thin|extralight|light|bold|extrabold|black)\b/, "weights are font-normal, font-medium and font-semibold"],
  [/\b(?:uppercase|eyebrow)\b/, "sentence case only"],
  [/\btracking-[\w[\].-]+/, "no letter-spacing"],
];

async function sources(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (/\.tsx$/.test(entry.name)) found.push(path);
  }
  return found;
}

test("components keep to the type scale", async () => {
  const problems = [];
  for (const path of await sources(root)) {
    const name = relative(root, path).replaceAll("\\", "/");
    const lines = (await readFile(path, "utf8")).split("\n");
    lines.forEach((line, index) => {
      // Only class strings matter; comments and copy may say "bold" or "uppercase".
      const classes = [...line.matchAll(/(?:className|class)=(?:"([^"]*)"|\{[^}]*\})|cn\(([^)]*)\)|"([^"]*)"/g)].map(match => match[0]).join(" ");
      if (!/className|cn\(/.test(line)) return;
      for (const [pattern, why] of RULES) {
        const hit = classes.match(pattern);
        if (hit) problems.push(`${name}:${index + 1} "${hit[0]}": ${why}`);
      }
      if (/\bfont-display\b/.test(classes) && !SERIF_ALLOWED.has(name)) problems.push(`${name}:${index + 1} "font-display": the serif is for the logo, page titles and dialog titles`);
    });
  }
  assert.deepEqual(problems, []);
});
