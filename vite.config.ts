import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // 性能探针页（src/probe-vlist.tsx）：只在探针构建时用，正式产物只引 index.html
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "./index.html"),
        probeVlist: path.resolve(import.meta.dirname, "./probe-vlist.html"),
      },
    },
  },
  // Tauri 需要的固定端口与严格端口占用
  clearScreen: false,
  // 必须显式绑 IPv4：只监听 ::1 时 Tauri 的 devUrl 会连不上
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
