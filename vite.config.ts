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
  // Tauri 需要的固定端口与严格端口占用
  clearScreen: false,
  // 必须显式绑 IPv4：只监听 ::1 时 Tauri 的 devUrl 会连不上
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
});
