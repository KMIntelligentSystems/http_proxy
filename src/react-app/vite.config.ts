import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  base: "/ui/",
  root: resolve(import.meta.dirname ?? ".", "."),
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/ui/api": "http://localhost:8080",
      "/ui/ws": { target: "ws://localhost:8080", ws: true },
      "/ui/data": "http://localhost:8080",
    },
  },
  // Copy data/lookups/ tree into dist/web/data/ so the built app can fetch
  // lookup files from /ui/data/lookups/*.json
  publicDir: resolve(import.meta.dirname ?? ".", "..", "..", "data"),
});
