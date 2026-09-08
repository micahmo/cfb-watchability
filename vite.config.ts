import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const API_TARGET = process.env.API_TARGET ?? "http://localhost:8787";
/**
 * Extra hostnames the dev server will answer to, e.g. ALLOWED_HOSTS=mybox,mybox.lan
 * Vite rejects requests whose Host header it does not recognise, which otherwise
 * breaks reaching the dev server by hostname rather than by IP.
 */
const EXTRA_HOSTS = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [svelte()],
  server: {
    // Bind all interfaces so other devices on the LAN can load the board.
    host: true,
    // Vite blocks requests whose Host header it does not recognise, which
    // otherwise breaks reaching the box by hostname rather than by IP.
    allowedHosts: EXTRA_HOSTS,
    port: 5180,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
});
