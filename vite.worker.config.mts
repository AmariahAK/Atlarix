import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Node worker bundle — avoid Vite stubbing `node:*` as browser externals.
    ssr: true,
    sourcemap: true,
    // target: "node16",
    lib: {
      entry: path.resolve(__dirname, "workers/tsc/tsc_worker.ts"),
      name: "tsc_worker",
      fileName: "tsc_worker",
      formats: ["cjs"],
    },
    rollupOptions: {
      // Keep `typescript` external: bundling the full compiler exhausts Node heap during forge dev (~2GB+).
      // Runtime resolves workspace copy first, then Atlarix's shipped dependency (see tsc_worker.ts).
      external: [
        "node:fs",
        "node:path",
        "node:worker_threads",
        "node:module",
        "typescript",
      ],
      //   output: {
      //     dir: "dist/workers/tsc",
      //   },
    },
    // outDir: "dist/workers/tsc",
    // emptyOutDir: true,
  },
});
