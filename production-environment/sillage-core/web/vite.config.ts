import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = dirname(fileURLToPath(import.meta.url));

// On a laptop the API is a sibling process on localhost; in the dev stack it is another container,
// reached by service name. Same config file either way.
const apiTarget = process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:4000";

// Vite refuses requests carrying a Host header it does not know, which is exactly what arrives
// when the dev dashboard is served through Caddy on a real hostname.
const allowedHosts = (process.env.VITE_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  root,
  resolve: {
    alias: { "@": resolve(root, "src") },
  },
  css: {
    postcss: root,
  },
  server: {
    port: 5173,
    // Bind all interfaces so the port is reachable from outside the container. Publishing is
    // still limited to loopback by compose, with Caddy in front.
    host: process.env.VITE_HOST || "127.0.0.1",
    allowedHosts: allowedHosts.length ? allowedHosts : undefined,
    proxy: {
      "/api": apiTarget,
      "/health": apiTarget,
    },
    // The browser talks to Caddy on 443, not to this port, so HMR has to be told where to call
    // back. Without it the client retries wss://host:5173 forever and every save needs F5.
    hmr: process.env.VITE_HMR_HOST
      ? { protocol: "wss", host: process.env.VITE_HMR_HOST, clientPort: 443 }
      : undefined,
  },
  build: {
    outDir: resolve(root, "dist"),
    emptyOutDir: true,
  },
});
