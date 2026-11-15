import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// The web app is independent of the API. In dev and preview, /api is proxied to the API
// so the browser sees one origin. The target follows PORT from .env (default 8000).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxy = { "/api": { target: env.API_URL ?? `http://localhost:${env.PORT ?? 8000}`, changeOrigin: true } };
  return {
    root: "web",
    plugins: [tailwindcss(), react()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: { outDir: "dist", emptyOutDir: true },
  };
});
