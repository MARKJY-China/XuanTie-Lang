import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// DSH agent 内核(vendor/dsh 预构建产物):懒加载独立 chunk,不经 esbuild 预构建
const DSH_CORE = fileURLToPath(new URL('./vendor/dsh/dist/dsh-core.mjs', import.meta.url));

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

// Tauri 自定义协议(custom-protocol)下模块脚本带 crossorigin 会走 CORS 分支;
// 同源请求不需要它,剥掉可规避协议侧 origin 校验差异(移除无副作用)。
function stripCrossorigin(): Plugin {
  return {
    name: 'strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/ crossorigin(?=[ >])/g, '');
    },
  };
}

// Tauri 前端构建:dev 固定端口(Tauri devUrl 要连它);target 对齐 WebView2(Chromium)
export default defineConfig({
  clearScreen: false,
  plugins: [monacoNlsZh(), stripCrossorigin()],
  resolve: { alias: { '@dsh-core': DSH_CORE } },
  optimizeDeps: { exclude: ['@dsh-core'] },
  server: { port: 5173, strictPort: true },
  build: {
    target: 'chrome105',
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        console: fileURLToPath(new URL('./console.html', import.meta.url)),
      },
    },
  },
});
