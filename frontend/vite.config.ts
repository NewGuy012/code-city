import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/quack": "http://127.0.0.1:8787",
    },
  },
});
