import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    // Reachable over a Tailscale tailnet without disabling Vite's
    // DNS-rebinding protection: a leading dot matches that domain and its
    // subdomains, so any workspace works and nothing else does.
    allowedHosts: [".ts.net"],
  },
});
