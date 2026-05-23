import { defineConfig } from "vite";
import path from "path";

/** Matches Electron Forge main output so worker_threads can load astgrep_worker.js in dev. */
const MAIN_OUT_DIR = path.resolve(__dirname, ".vite/build");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: MAIN_OUT_DIR,
    emptyOutDir: false,
    ssr: true,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "workers/blueprint/astgrep_worker.ts"),
      name: "astgrep_worker",
      fileName: "astgrep_worker",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        "node:fs",
        "node:path",
        "node:worker_threads",
        "node:module",
        "@ast-grep/napi",
      ],
    },
  },
});
