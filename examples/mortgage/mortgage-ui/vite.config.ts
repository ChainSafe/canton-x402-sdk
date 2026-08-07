import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy /api → the mortgage backend (avoids CORS). In docker the UI is
// served by nginx which proxies /api to the backend service instead.
const apiTarget = process.env.VITE_DEV_API ?? "http://localhost:4002";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT ?? 5173),
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
});
