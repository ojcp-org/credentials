import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Built once into dist/ui and served by the sandbox on every origin under /_ui/.
export default defineConfig({
  root: import.meta.dirname,
  base: "/_ui/",
  plugins: [react()],
  build: { outDir: "../dist/ui", emptyOutDir: true },
});
