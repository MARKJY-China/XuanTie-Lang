import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// 把 monaco 内部对 vs/nls.js 的一切解析(含相对路径 ../nls.js)重定向到中文 shim。
// nls.messages.js 不拦截(与字符串默认值无关)。
const NLS_SHIM = fileURLToPath(new URL('./src/monaco/nls-zh.ts', import.meta.url));

function monacoNlsZh(): Plugin {
  return {
    name: 'monaco-nls-zh',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !importer.includes('monaco-editor')) return null;
      // 匹配 vs/nls、vs/nls.js、../nls.js、./nls.js 等一切形态;nls.messages.js 明确排除
      if ((source === 'vs/nls' || /(^|\/)nls\.js$/.test(source)) && !source.includes('nls.messages')) {
        return NLS_SHIM;
      }
      return null;
    },
  };
}

// Tauri 前端构建:dev 固定端口(Tauri devUrl 要连它);target 对齐 WebView2(Chromium)
export default defineConfig({
  clearScreen: false,
  plugins: [monacoNlsZh()],
  server: { port: 5173, strictPort: true },
  build: { target: 'chrome105', chunkSizeWarningLimit: 8000 },
});
