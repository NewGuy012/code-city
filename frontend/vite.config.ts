import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  oxc: { jsx: { runtime: "automatic" } },
  plugins: [tailwindcss()],
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
