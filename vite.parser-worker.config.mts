import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "oxc-parser": path.resolve(__dirname, "node_modules/oxc-parser/src-js/index.js"),
    },
  },
  build: {
    ssr: true,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, "workers/blueprint/parser_worker.ts"),
      name: "parser_worker",
      fileName: "parser_worker",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        "node:fs",
        "node:path",
        "node:worker_threads",
        "node:module",
        "oxc-parser",
        "@oxc-parser/binding-wasm32-wasi",
        /^@oxc-parser\//,
        /^@oxc-project\//,
      ],
    },
  },
});
