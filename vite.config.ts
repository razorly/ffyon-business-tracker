import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import process from "node:process";
import { readFileSync, readdirSync } from "node:fs";

const host = process.env.TAURI_DEV_HOST;
const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "./package.json"), "utf8"));

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === "pwa" ? [{
    name: "ffyon-pwa",
    transformIndexHtml(html: string) {
      return {
        html: html.replace("initial-scale=1.0", "initial-scale=1.0, viewport-fit=cover"),
        tags: [
          { tag: "link", attrs: { rel: "manifest", href: "/manifest.webmanifest" }, injectTo: "head" },
          { tag: "link", attrs: { rel: "apple-touch-icon", href: "/apple-touch-icon.png" }, injectTo: "head" },
        ],
      };
    },
    generateBundle() {
      const directory = path.resolve(import.meta.dirname, "pwa/public");
      for (const fileName of readdirSync(directory)) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(path.join(directory, fileName)) });
      }
    },
  }] : [])],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },

  // So the app can tell the user which version they're on, browser preview included.
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __PWA_BUILD__: JSON.stringify(mode === "pwa") },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
