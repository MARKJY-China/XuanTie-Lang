// 主窗口 → API 文档书独立窗口
import { invoke } from '@tauri-apps/api/core';

/** 打开/聚焦文档书窗口;target 形如 method:取字节 / page:关键字/字节。 */
export function openDocsWindow(target?: string): Promise<void> {
  return invoke('open_docs_window', { target: target ?? null });
}
