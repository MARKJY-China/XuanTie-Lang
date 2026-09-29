// Rust 后端命令的类型化封装(Tauri v2:JS camelCase 参数自动映射 Rust snake_case)
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AppSettings, FileNode } from './types';

// ---- 文件系统 ----
export function fsReadFile(path: string): Promise<string> {
  return invoke('fs_read_file', { path });
}
export function fsWriteFile(path: string, content: string): Promise<void> {
  return invoke('fs_write_file', { path, content });
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
