import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dev:api (package.json) runs the API on 8766 while Vite serves the UI on
// 8765; the proxy must point at the API, not the production port.
const API_DEV = process.env.API_DEV_URL || "http://127.0.0.1:8766";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true
  },
  server: {
    port: 8765,
    strictPort: false,
    proxy: {
      "/api": {
        target: API_DEV,
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 8765,
    strictPort: false
  }
});
