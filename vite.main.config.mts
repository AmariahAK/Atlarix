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
    rollupOptions: {
      external: [
        "better-sqlite3",
        // elkjs is bundled (use main entry 'elkjs' in code so it bundles without defineProperty issues).
        // OpenTelemetry packages are bundled so the packaged app finds them (no runtime require from node_modules).
      ],
    },
  },
  plugins: [
    {
      name: "restart",
      closeBundle() {
        process.stdin.emit("data", "rs");
      },
    },
  ],
});
