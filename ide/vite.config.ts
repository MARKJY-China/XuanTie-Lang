import { defineConfig } from 'vite';

// Tauri 前端构建:dev 固定端口(Tauri devUrl 要连它);target 对齐 WebView2(Chromium)
export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'chrome105', chunkSizeWarningLimit: 8000 },
});
