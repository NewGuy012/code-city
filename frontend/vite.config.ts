import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.CODECITY_API_URL || "http://127.0.0.1:8787";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  server: {
    proxy: {
      "/api": apiTarget,
      "/quack": apiTarget,
    },
  },
});
