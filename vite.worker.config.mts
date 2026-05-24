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
    sourcemap: process.env.E2E_TEST_BUILD === "true",
    // target: "node16",
    lib: {
      entry: path.resolve(__dirname, "workers/tsc/tsc_worker.ts"),
      name: "tsc_worker",
      fileName: "tsc_worker",
      formats: ["cjs"],
    },
    rollupOptions: {
      external: [
        "node:fs",
        "node:path",
        "node:worker_threads",
        "node:module",
      ],
      //   output: {
      //     dir: "dist/workers/tsc",
      //   },
    },
    // outDir: "dist/workers/tsc",
    // emptyOutDir: true,
  },
});
