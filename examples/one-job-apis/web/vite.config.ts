import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_DEV_API ?? "http://127.0.0.1:8787";
const gatewayTarget = process.env.VITE_DEV_GATEWAY ?? "http://127.0.0.1:8790";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.UI_PORT ?? 5180),
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/api/, "") },
      "/gateway": { target: gatewayTarget, changeOrigin: true, rewrite: (path) => path.replace(/^\/gateway/, "") },
    },
  },
});