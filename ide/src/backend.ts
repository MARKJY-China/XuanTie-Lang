// Rust 后端命令的类型化封装(Tauri v2:JS camelCase 参数自动映射 Rust snake_case)
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppSettings, FileNode } from './types';

// ---- 文件系统 ----
export interface ReadResult {
  text: string;
  encoding: string;
}

export function fsReadFile(path: string): Promise<ReadResult> {
  return invoke('fs_read_file', { path });
}
export function fsReadFileAs(path: string, encoding: string): Promise<string> {
  return invoke('fs_read_file_as', { path, encoding });
}
export function fsWriteFile(path: string, content: string, encoding?: string): Promise<void> {
  return invoke('fs_write_file', { path, content, encoding });
}
export function fsListTree(root: string): Promise<FileNode[]> {
  return invoke('fs_list_tree', { root });
}
export function fsCreateFile(path: string, content: string): Promise<void> {
  return invoke('fs_create_file', { path, content });
}
export function fsCreateDir(path: string): Promise<void> {
  return invoke('fs_create_dir', { path });
}
export function fsRename(from: string, to: string): Promise<void> {
  return invoke('fs_rename', { from, to });
}
export function fsDelete(path: string): Promise<void> {
  return invoke('fs_delete', { path });
}
export function fsExists(path: string): Promise<boolean> {
  return invoke('fs_exists', { path });
}
export function fsListDir(path: string): Promise<string[]> {
  return invoke('fs_list_dir', { path });
}

// ---- LSP 进程桥 ----
export function lspStart(serverPath: string, cwd: string, xtcPath: string): Promise<number> {
  return invoke('lsp_start', { serverPath, cwd, xtcPath });
}
export function lspSend(id: number, message: string): Promise<void> {
  return invoke('lsp_send', { id, message });
}
export function lspStop(id: number): Promise<void> {
  return invoke('lsp_stop', { id });
}
export function onLspMessage(id: number, cb: (json: string) => void): Promise<UnlistenFn> {
  return listen<string>(`lsp-msg-${id}`, (e) => cb(e.payload));
}
export function onLspError(id: number, cb: (line: string) => void): Promise<UnlistenFn> {
  return listen<string>(`lsp-err-${id}`, (e) => cb(e.payload));
}
export function onLspExit(id: number, cb: () => void): Promise<UnlistenFn> {
  return listen<void>(`lsp-exit-${id}`, () => cb());
}

// ---- PTY 终端 ----
export function ptyStart(
  session: string,
  cwd: string,
  cols: number,
  rows: number,
  program: string | null,
  args: string[] | null,
): Promise<void> {
  return invoke('pty_start', { session, cwd, cols, rows, program, args });
}
export function ptyWrite(session: string, data: string): Promise<void> {
  return invoke('pty_write', { session, data });
}
export function ptyResize(session: string, cols: number, rows: number): Promise<void> {
  return invoke('pty_resize', { session, cols, rows });
}
export function ptyKill(session: string): Promise<void> {
  return invoke('pty_kill', { session });
}
export function onPtyOutput(session: string, cb: (data: string) => void): Promise<UnlistenFn> {
  return listen<string>(`pty-out-${session}`, (e) => cb(e.payload));
}
export function onPtyExit(session: string, cb: () => void): Promise<UnlistenFn> {
  return listen<void>(`pty-exit-${session}`, () => cb());
}

// ---- 工具定位 / 设置 / 工程模板 ----
export function toolLocate(name: string): Promise<string> {
  return invoke('tool_locate', { name });
}
export function toolPaoSupport(xtcPath: string): Promise<boolean> {
  return invoke('tool_pao_support', { xtcPath });
}
export function toolVersion(path: string): Promise<string> {
  return invoke('tool_version', { path });
}
export function isElevated(): Promise<boolean> {
  return invoke('is_elevated');
}
export function relaunchAsAdmin(): Promise<void> {
  return invoke('relaunch_as_admin');
}

// ---- 账号(HTTP 走 Rust 侧,绕开 WebView 跨域与 httpOnly 限制) ----
export interface HttpResult {
  status: number;
  body: string;
  sessionCookie: string;
}

export function httpJson(
  method: string,
  url: string,
  body: unknown,
  cookie?: string,
  auth?: string,
  timeoutSecs?: number,
): Promise<HttpResult> {
  return invoke('http_json', {
    method,
    url,
    body: body ?? null,
    cookie: cookie ?? null,
    auth: auth ?? null,
    timeoutSecs: timeoutSecs ?? null,
  });
}

// SSE 流式请求:事件经 ai-stream-{id} 推送(JSON 字符串,形如 {type:text|thinking|usage|error|aborted|done,...};
// format 为 'sse-raw' 时不做协议解析,每个 SSE data 原样包成 {type:"sse",data} 转发,[DONE] 转成 done)
export function httpStream(
  id: string,
  method: string,
  url: string,
  body: unknown,
  cookie?: string,
  auth?: string,
  format?: 'community' | 'openai' | 'sse-raw',
): Promise<void> {
  return invoke('http_stream', {
    id,
    method,
    url,
    body: body ?? null,
    cookie: cookie ?? null,
    auth: auth ?? null,
    format: format ?? 'openai',
  });
}

export function httpStreamAbort(id: string): Promise<void> {
  return invoke('http_stream_abort', { id });
}

// ---- DSH run_command 工具后端(非交互捕获;交互终端用 PTY) ----
export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function execCapture(
  program: string,
  args: string[],
  cwd: string,
  timeoutSecs?: number,
): Promise<ExecResult> {
  return invoke('exec_capture', { program, args, cwd, timeoutSecs: timeoutSecs ?? null });
}

// ---- AI 链路日志(开发者模式)/ 控制台窗口 ----
export function aiLogSetEnabled(enabled: boolean): Promise<void> {
  return invoke('ai_log_set_enabled', { enabled });
}
export function openAiConsole(): Promise<void> {
  return invoke('open_ai_console');
}

// 打开网页取正文(三层联网栈:静态抓取 → 不足时隐藏浏览器渲染 JS 页面)。
// render: 'auto'(默认,自动升级)/'always'(强制渲染)/'never'(仅静态)。安全护栏:仅 https/本机。
export function webFetch(url: string, render?: 'auto' | 'always' | 'never'): Promise<string> {
  return invoke('web_fetch', { url, render: render ?? null });
}

// 隐藏 WebView2 窗口渲染网页并取正文(第三层;web_fetch auto 模式内部会调用)
export function webRender(url: string, timeoutSecs?: number): Promise<string> {
  return invoke('web_render', { url, timeoutSecs: timeoutSecs ?? null });
}

// 联网搜索(第一层;必应国内版直连,零 Key)
export function webSearch(query: string): Promise<string> {
  return invoke('web_search', { query });
}

// 工程指令文件(AGENTS.md / XuanTieAI.md,不区分大小写;只读工程根,不递归)
export interface ProjectInstruction {
  name: string;
  path: string;
  content: string;
}

export function projectInstructions(root: string): Promise<ProjectInstruction[]> {
  return invoke('project_instructions', { root });
}

// ---- 玄铁语言文档库(启动时经服务端版本号比对,不同则从文档站拉取切分落盘) ----
export interface DocsIndexData {
  dir: string;
  index: string;
  count: number;
}

export interface DocsFetchResult {
  count: number;
  dir: string;
}

export function docsDir(): Promise<string> {
  return invoke('docs_dir');
}

export function fetchDocs(baseUrl: string, version: string): Promise<DocsFetchResult> {
  return invoke('fetch_docs', { baseUrl, version });
}

export function docsIndex(): Promise<DocsIndexData | null> {
  return invoke('docs_index');
}

export function docsExamples(query: string, maxExamples?: number): Promise<string> {
  return invoke<string>('docs_examples', { query, maxExamples: maxExamples ?? null });
}
export function docsSearch(query: string, maxResults?: number): Promise<string> {
  return invoke('docs_search', { query, maxResults: maxResults ?? null });
}

// ---- 附件(图片/视频上传:读文件 → base64 data URL) ----
export interface AttachData {
  mime: string;
  dataUrl: string;
  sizeBytes: number;
}

export function attachRead(path: string): Promise<AttachData> {
  return invoke('attach_read', { path });
}

// 强杀所有正在执行的 run_command 进程(终止按钮;连同子进程树)
export function killAllExec(): Promise<number> {
  return invoke('kill_all_exec');
}

// ---- 铁铺(结构化数据,UI 直读;布局与 tiepm/核心.xt 同源) ----
export interface TiepmPkg {
  name: string;
  version: string;
  builtin: boolean;
}

export function tiepmPackages(tiepmPath: string): Promise<TiepmPkg[]> {
  return invoke('tiepm_packages', { tiepmPath });
}

export function tiepmClean(): Promise<string> {
  return invoke('tiepm_clean');
}
export function runCacheDir(): Promise<string> {
  return invoke('run_cache_dir');
}
export function settingsLoad(): Promise<string> {
  return invoke('settings_load');
}
export function settingsSave(content: string): Promise<void> {
  return invoke('settings_save', { content });
}
export function scaffoldProject(dir: string, name: string, template: string): Promise<string> {
  return invoke('scaffold_project', { dir, name, template });
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') || /^[A-Za-z]:/.test(dir) ? '\\' : '/';
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + name : dir + sep + name;
}

export type { AppSettings, FileNode };

// ---- 玄铁基础认知块(社区后台版本覆盖本地缓存;离线用本地/内置) ----
export function primerRead(): Promise<string | null> {
  return invoke<string | null>('primer_read');
}
export function primerWrite(content: string): Promise<void> {
  return invoke('primer_write', { content });
}

// ---- 玄铁环境自检(打开工程后台自动跑;结果注入 AI 环境快照) ----
export interface PreflightItem {
  key: string;
  value: string;
}
export interface PreflightResult {
  ok: boolean;
  items: PreflightItem[];
  detail: string;
  ms: number;
}
export function preflightRun(xtc: string): Promise<PreflightResult> {
  return invoke<PreflightResult>('preflight_run', { xtc });
}
