// 铁铺(tiepm):远程索引 / 版本比较 / 安装进度事件流 / 独立窗口。
// 安装不再走主窗口终端(pty):Rust 侧管道捕获 tiepm 输出,逐行 emit "tiepm-line",
// 退出时 emit "tiepm-done";前端两个窗口都订阅同一组事件。
import { invoke } from '@tauri-apps/api/core';
import * as backend from '../backend';
import { loadSettings, resolveTiepm } from '../settings';

export const TIEPM_INDEX_URL = 'https://tiepm.xt.markjy.com/api/index';

/** 索引里的一个包(只留界面要用的字段) */
export interface TiepmIndexPkg {
  name: string;
  /** 索引里的最高版本 */
  latest: string;
  /** 全部版本(升序) */
  versions: string[];
  /** 最高版本的简介 */
  desc: string;
}

export interface TiepmLinePayload {
  name: string;
  line: string;
  err: boolean;
}

export interface TiepmDonePayload {
  name: string;
  code: number;
  ok: boolean;
}

export interface TiepmStartPayload {
  name: string;
}

/** 3 段数字版本比较;多段也只看前 3 段(与主窗口原实现一致) */
export function cmpVer(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const n1 = pa[i] ?? 0;
    const n2 = pb[i] ?? 0;
    if (n1 > n2) return 1;
    if (n1 < n2) return -1;
  }
  return 0;
}

/** 拉取远程索引:{包名:{版本:{描述…}}} → Map(包名 → 最新版信息) */
export async function loadTiepmIndex(): Promise<Map<string, TiepmIndexPkg>> {
  const r = await backend.httpJson('GET', TIEPM_INDEX_URL, null);
  let raw: Record<string, Record<string, Record<string, unknown>>>;
  try {
    raw = JSON.parse(r.body) as Record<string, Record<string, Record<string, unknown>>>;
  } catch {
    throw new Error(`索引响应不是合法 JSON(HTTP ${r.status})`);
  }
  const map = new Map<string, TiepmIndexPkg>();
  for (const [name, versions] of Object.entries(raw)) {
    const keys = Object.keys(versions).sort(cmpVer);
    const best = keys.length > 0 ? keys[keys.length - 1] : '';
    const meta = best ? versions[best] : undefined;
    const desc = meta && typeof meta['描述'] === 'string' ? (meta['描述'] as string) : '';
    map.set(name, { name, latest: best, versions: keys, desc });
  }
  return map;
}

/** 搜索:包名或简介包含关键词(忽略大小写,与 tiepm ss 的口径一致但更宽容) */
export function searchIndex(map: Map<string, TiepmIndexPkg>, keyword: string): TiepmIndexPkg[] {
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const hits: TiepmIndexPkg[] = [];
  for (const p of map.values()) {
    if (p.name.toLowerCase().includes(kw) || p.desc.toLowerCase().includes(kw)) hits.push(p);
  }
  hits.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return hits;
}

/** 解析 tiepm 可执行文件(先载设置;窗口独立进程内也走同一份设置文件) */
export async function ensureTiepm(): Promise<string> {
  await loadSettings();
  const p = await resolveTiepm();
  if (!p) throw new Error('未找到 tiepm:请在设置里配置,或把它加入 PATH');
  return p;
}

/** 打开(或聚焦)铁铺独立窗口 */
export function openTiepmWindow(): Promise<void> {
  return invoke('open_tiepm_window');
}

/** 开始安装/升级(立即返回,输出与结果走事件) */
export async function tiepmInstallStart(name: string): Promise<void> {
  const path = await ensureTiepm();
  return invoke('tiepm_install_start', { tiepmPath: path, name });
}

export function tiepmInstallCancel(): Promise<boolean> {
  return invoke('tiepm_install_cancel');
}

export function tiepmInstallBusy(): Promise<boolean> {
  return invoke('tiepm_install_busy');
}

/** 正在安装的包名(没有则空串);窗口后开时认领进度用 */
export function tiepmInstallCurrent(): Promise<string> {
  return invoke('tiepm_install_current');
}
