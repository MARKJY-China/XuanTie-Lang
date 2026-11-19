/**
 * 铁铺独立窗口:搜索远程索引 / 安装或升级铁器 / 流式查看安装输出。
 * 安装进程在 Rust 侧跑(管道捕获),这里只订阅 "tiepm-line" 与 "tiepm-done"。
 */
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as backend from '../backend';
import {
  cmpVer,
  ensureTiepm,
  loadTiepmIndex,
  searchIndex,
  tiepmInstallBusy,
  tiepmInstallCancel,
  tiepmInstallCurrent,
  tiepmInstallStart,
  type TiepmDonePayload,
  type TiepmIndexPkg,
  type TiepmLinePayload,
  type TiepmStartPayload,
} from './tiepm';

const q = document.getElementById('q') as HTMLInputElement;
const btnSearch = document.getElementById('btn-search') as HTMLButtonElement;
const btnInstall = document.getElementById('btn-install') as HTMLButtonElement;
const btnRefresh = document.getElementById('btn-refresh') as HTMLButtonElement;
const btnCancel = document.getElementById('btn-cancel') as HTMLButtonElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const listEl = document.getElementById('list') as HTMLElement;
const logEl = document.getElementById('log') as HTMLElement;
const logStatus = document.getElementById('log-status') as HTMLElement;

let tiepmPath = '';
/** 远程索引(首次搜索时拉取;刷新时丢弃) */
let index: Map<string, TiepmIndexPkg> | null = null;
/** 已安装(铁铺外置)/内置库 版本表 */
let installed = new Map<string, string>();
let builtin = new Map<string, string>();
/** 正在安装的包名(用于过滤事件) */
let current = '';
let busy = false;
/** 用户点了取消:结束事件按"已取消"呈现,不报安装失败 */
let cancelling = false;
/** 当前搜索结果(安装完就地刷新版本/按钮) */
let hits: TiepmIndexPkg[] = [];

function setHint(text: string, cls: '' | 'err' | 'ok' = ''): void {
  hintEl.textContent = text;
  hintEl.className = cls;
}

function appendLog(text: string, cls: '' | 'err' | 'ok' | 'dim' = ''): void {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function syncBusyUi(): void {
  btnCancel.disabled = !busy;
  btnSearch.disabled = busy;
  btnInstall.disabled = busy;
  btnRefresh.disabled = busy;
  btnCancel.textContent = busy ? '取消安装' : '空闲';
}

async function loadInstalled(): Promise<void> {
  const pkgs = await backend.tiepmPackages(tiepmPath);
  installed = new Map();
  builtin = new Map();
  for (const p of pkgs) {
    if (p.version === '?') continue;
    if (p.builtin) builtin.set(p.name, p.version);
    else installed.set(p.name, p.version);
  }
}

function renderInstalled(): void {
  listEl.innerHTML = '';
  const names = [...installed.keys()].sort((a, b) => a.localeCompare(b, 'zh'));
  if (names.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '还没装过任何铁器 —— 在上面搜索，或输入包名直接安装。';
    listEl.appendChild(empty);
    return;
  }
  for (const name of names) {
    const ver = installed.get(name) ?? '?';
    const b = builtin.get(name);
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = name;
    const v = document.createElement('span');
    v.className = 'ver on';
    v.textContent = `已装 v${ver}${b ? ` · 内置 v${b}` : ''}`;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = '';
    const act = document.createElement('button');
    act.className = 'btn act';
    act.textContent = '重新安装';
    act.title = `重新安装 ${name}（取索引里的最高版本）`;
    act.addEventListener('click', () => void startInstall(name));
    row.append(nm, v, desc, act);
    listEl.appendChild(row);
  }
}

function rowAction(p: TiepmIndexPkg): { label: string; cls: string; disabled: boolean } {
  const cur = installed.get(p.name);
  if (cur && cmpVer(cur, p.latest) >= 0) return { label: '已是最新', cls: '', disabled: true };
  if (cur) return { label: `更新到 v${p.latest}`, cls: 'primary', disabled: false };
  return { label: '安装', cls: 'primary', disabled: false };
}

function renderHits(): void {
  listEl.innerHTML = '';
  if (hits.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '没有匹配的铁器。换个关键词，或确认包名拼写。';
    listEl.appendChild(empty);
    return;
  }
  for (const p of hits) {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name;
    const ver = document.createElement('span');
    ver.className = 'ver' + (installed.has(p.name) ? ' on' : '');
    const cur = installed.get(p.name);
    ver.textContent = cur ? `已装 v${cur} → 最新 v${p.latest}` : `v${p.latest}`;
    const desc = document.createElement('span');
    desc.className = 'desc';
    desc.textContent = p.desc;
    desc.title = p.desc;
    const a = rowAction(p);
    const act = document.createElement('button');
    act.className = 'btn act ' + a.cls;
    act.textContent = a.label;
    act.disabled = a.disabled || busy;
    act.addEventListener('click', () => void startInstall(p.name));
    row.append(nm, ver, desc, act);
    listEl.appendChild(row);
  }
}

async function doSearch(): Promise<void> {
  const kw = q.value.trim();
  if (!kw) {
    setHint('输入包名或关键词再搜索；直接点「安装」则把输入当包名安装。');
    return;
  }
  setHint('正在读取远程索引…');
  try {
    if (!index) index = await loadTiepmIndex();
    hits = searchIndex(index, kw);
    renderHits();
    setHint(`搜索「${kw}」：${hits.length} 个结果`);
  } catch (err) {
    setHint(`搜索失败：${String(err)}`, 'err');
  }
}

async function startInstall(name: string): Promise<void> {
  const pkg = name.trim();
  if (!pkg || busy) return;
  if (!tiepmPath) {
    setHint('未找到 tiepm：请在铸造厂设置里配置 tiepm.exe 路径', 'err');
    return;
  }
  busy = true;
  current = pkg;
  cancelling = false;
  syncBusyUi();
  logEl.innerHTML = '';
  logStatus.textContent = `正在安装 ${pkg}…`;
  appendLog(`[铸造厂] tiepm az ${pkg}`, 'dim');
  setHint(`正在安装 ${pkg}，输出见下方…`);
  try {
    await tiepmInstallStart(pkg);
  } catch (err) {
    busy = false;
    current = '';
    syncBusyUi();
    logStatus.textContent = '安装失败';
    appendLog(String(err), 'err');
    setHint(`安装失败：${String(err)}`, 'err');
  }
}

async function finishInstall(d: TiepmDonePayload): Promise<void> {
  busy = false;
  current = '';
  syncBusyUi();
  if (cancelling) {
    cancelling = false;
    logStatus.textContent = `已取消：${d.name}`;
    appendLog(`[铸造厂] 已取消 ${d.name} 的安装`, 'dim');
    setHint(`已取消安装 ${d.name}`);
    return;
  }
  if (d.ok) {
    logStatus.textContent = `安装完成：${d.name}`;
    appendLog(`[铸造厂] ${d.name} 安装完成`, 'ok');
    setHint(`已安装 ${d.name}`, 'ok');
    try {
      await loadInstalled();
      renderHits();
    } catch {
      // 读列表失败不影响安装结果
    }
  } else {
    logStatus.textContent = `安装失败（退出码 ${d.code}）`;
    appendLog(`[铸造厂] 安装失败，退出码 ${d.code}`, 'err');
    setHint(`安装失败（退出码 ${d.code}），详见下方输出`, 'err');
  }
}

async function cancelInstall(): Promise<void> {
  if (!busy) return;
  cancelling = true;
  try {
    const killed = await tiepmInstallCancel();
    appendLog(killed ? '[铸造厂] 已请求取消安装…' : '[铸造厂] 没有可取消的进程', 'dim');
  } catch (err) {
    appendLog(`取消失败：${String(err)}`, 'err');
  }
}

/** 别的窗口(主窗口「更新铁器」)发起了安装:本窗口接管进度显示 */
function adoptInstall(name: string): void {
  busy = true;
  current = name;
  cancelling = false;
  syncBusyUi();
  logEl.innerHTML = '';
  logStatus.textContent = `正在安装 ${name}…`;
  appendLog(`[铸造厂] ${name} 的安装由主窗口发起,这里同步显示输出`, 'dim');
  setHint(`正在安装 ${name}，输出见下方…`);
}

async function init(): Promise<void> {
  syncBusyUi();
  try {
    tiepmPath = await ensureTiepm();
    await loadInstalled();
    renderInstalled();
    setHint('输入关键词搜索远程铁铺；或直接输入包名点「安装」。');
  } catch (err) {
    setHint(String(err), 'err');
  }
  if (await tiepmInstallBusy().catch(() => false)) {
    const running = await tiepmInstallCurrent().catch(() => '');
    if (running) adoptInstall(running);
    else setHint('已有安装任务在进行（可能是主窗口发起的更新）', 'err');
  }
  q.focus();
}

void listen<TiepmStartPayload>('tiepm-start', (e) => {
  // 自己发起的安装已经置好状态;只有别的窗口发起时才接管
  if (e.payload.name !== current) adoptInstall(e.payload.name);
});
void listen<TiepmLinePayload>('tiepm-line', (e) => {
  if (e.payload.name !== current) return;
  appendLog(e.payload.line, e.payload.err ? 'err' : '');
});
void listen<TiepmDonePayload>('tiepm-done', (e) => {
  if (e.payload.name !== current) return;
  void finishInstall(e.payload);
});

btnSearch.addEventListener('click', () => void doSearch());
btnInstall.addEventListener('click', () => void startInstall(q.value));
btnRefresh.addEventListener('click', () => {
  index = null;
  void (async () => {
    try {
      await loadInstalled();
      if (hits.length > 0 && q.value.trim()) await doSearch();
      else renderInstalled();
      setHint('已刷新已安装列表');
    } catch (err) {
      setHint(`刷新失败：${String(err)}`, 'err');
    }
  })();
});
btnCancel.addEventListener('click', () => void cancelInstall());
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') void doSearch();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') void getCurrentWindow().close();
});
void init();
