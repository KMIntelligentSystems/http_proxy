import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/ui/",
  root: __dirname,
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
