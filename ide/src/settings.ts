// 设置缓存与工具链路径解析(设置 → PATH → 工作区约定位置 → xtc 锚定位置)
import * as backend from './backend';
import { dirname } from './util';
import { defaultSettings, type AppSettings, type TreeDisplay } from './types';

let cache: AppSettings = defaultSettings();

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await backend.settingsLoad();
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    cache = { ...defaultSettings(), ...parsed };
  } catch {
    // 设置文件缺失/损坏:回默认值(首启的正常路径)
    cache = defaultSettings();
  }
  return cache;
}

export function getSettings(): AppSettings {
  return cache;
}

export async function saveSettings(next: AppSettings): Promise<void> {
  cache = next;
  await backend.settingsSave(JSON.stringify(next, null, 2));
}

async function valid(p: string | undefined): Promise<string | null> {
  if (p && p.length > 0 && (await backend.fsExists(p))) return p;
  return null;
}

export function treeDisplay(): TreeDisplay {
  return cache.treeDisplay;
}

export async function resolveXtc(): Promise<string | null> {
  const hit = await valid(cache.xtcPath);
  if (hit) return hit;
  try {
    const found = await backend.toolLocate('xtc');
    return found || null;
  } catch {
    return null;
  }
}

export async function resolveTiepm(): Promise<string | null> {
  const hit = await valid(cache.tiepmPath);
  if (hit) return hit;
  try {
    const found = await backend.toolLocate('tiepm');
    return found || null;
  } catch {
    return null;
  }
}

// xt_lsp 解析链:
// ① 设置 ② PATH ③ <工作区>\lsp\xt_lsp.exe(玄铁仓库开发布局)
// ④ xtc.exe 同目录(发行布局) ⑤⑥ 从 xtc 目录向上 1-2 级找 lsp\xt_lsp.exe
//    (开发布局 build\env\xtc.exe → 仓库根 lsp\xt_lsp.exe;用户自己的工程靠 ④⑤⑥ 兜底)
export async function resolveLspServer(workspace: string): Promise<string | null> {
  const hit = await valid(cache.lspServerPath);
  if (hit) return hit;
  try {
    const onPath = await backend.toolLocate('xt_lsp');
    if (onPath) return onPath;
  } catch {
    // PATH 无,继续后面的候选
  }
  const candidates: string[] = [];
  if (workspace) {
    candidates.push(backend.joinPath(backend.joinPath(workspace, 'lsp'), 'xt_lsp.exe'));
  }
  const xtc = await resolveXtc();
  if (xtc) {
    const dir = dirname(xtc);
    const up1 = dirname(dir);
    const up2 = dirname(up1);
    candidates.push(backend.joinPath(dir, 'xt_lsp.exe'));
    candidates.push(backend.joinPath(backend.joinPath(up1, 'lsp'), 'xt_lsp.exe'));
    candidates.push(backend.joinPath(backend.joinPath(up2, 'lsp'), 'xt_lsp.exe'));
  }
  for (const c of candidates) {
    if (await backend.fsExists(c)) return c;
  }
  return null;
}
