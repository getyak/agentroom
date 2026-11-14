import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: new URL('./index.html', import.meta.url).pathname, guest: new URL('./guest.html', import.meta.url).pathname } } },
  server: {
    host: "127.0.0.1",
    port: 18741,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:18740" },
  },
});
