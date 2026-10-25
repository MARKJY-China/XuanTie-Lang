// 检查更新：官方 tauri-plugin-updater（semver 比对 + minisign 签名校验 + 静默安装）。
// 契约：XuanTie/xt-ecosystem/contracts/community-ide-bridge.md
//
// 状态机（对应状态栏文案，改文案前先看契约）：
//   idle → available（有新版本 vX）→ downloading（转圈 + 正在下载）→ ready（下载完成，点击安装）
//   失败落到 failed（下载失败，点击重试）；安装调 update.install()，Windows 下插件以
//   NSIS 静默模式启动安装器并退出本进程。
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { getSettings, saveSettings } from '../settings';
import { showToast } from '../ui/dialogs';

type Phase =
  | { kind: 'idle' }
  | { kind: 'available'; upd: Update; mandatory: boolean }
  | { kind: 'downloading'; upd: Update; pct: number }
  | { kind: 'ready'; upd: Update }
  | { kind: 'failed'; upd: Update };

let el: HTMLElement | null = null;
let phase: Phase = { kind: 'idle' };
let busy = false;
let currentVersion = '';
let beforeInstall: () => Promise<boolean> = async () => true;

const AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000; // 契约：每 6 小时
const START_DELAY_MS = 5000;                 // 契约：启动约 5 秒后

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 只比三段数字（忽略 v 前缀与预发布后缀），够用于 minVersion 判定 */
function cmpSemver(a: string, b: string): number {
  const seg = (s: string): number[] =>
    s.replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pa = seg(a);
  const pb = seg(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** mandatory / minVersion 是清单里的扩展字段（插件不认，从 rawJson 读） */
function isMandatory(upd: Update): boolean {
  const raw = (upd.rawJson ?? {}) as { mandatory?: unknown; minVersion?: unknown };
  if (raw.mandatory === true) return true;
  if (typeof raw.minVersion === 'string' && raw.minVersion && currentVersion) {
    return cmpSemver(currentVersion, raw.minVersion) < 0;
  }
  return false;
}

function render(): void {
  if (!el) return;
  el.className = 'sb-item sb-click sb-update';
  el.textContent = '';
  el.title = '';
  el.dataset.phase = phase.kind;
  switch (phase.kind) {
    case 'idle':
      el.style.display = 'none';
      return;
    case 'available':
      el.style.display = '';
      el.textContent = `有新版本 v${phase.upd.version}`;
      el.title = phase.mandatory ? '必须更新：点击下载' : '点击下载；右键跳过此版本';
      return;
    case 'downloading': {
      el.style.display = '';
      const spin = document.createElement('span');
      spin.className = 'sb-spin';
      el.appendChild(spin);
      el.appendChild(
        document.createTextNode(
          phase.pct > 0 ? `正在下载新版本(${phase.pct}%)` : '正在下载新版本',
        ),
      );
      el.title = '下载中，请稍候…';
      return;
    }
    case 'ready':
      el.style.display = '';
      el.textContent = '下载完成，点击安装';
      el.title = '点击后关闭 IDE 并静默安装新版本';
      return;
    case 'failed':
      el.style.display = '';
      el.textContent = '下载失败，点击重试';
      el.title = '点击重试';
  }
}

async function runCheck(manual: boolean): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const upd = await check();
    if (!upd) {
      if (manual) showToast('已是最新版本', 'ok');
      // 别把正在下载/已下载的状态抹掉
      if (phase.kind === 'available' || phase.kind === 'failed') {
        phase = { kind: 'idle' };
        render();
      }
      return;
    }
    const mandatory = isMandatory(upd);
    const skip = getSettings().update?.skipVersion;
    if (!mandatory && skip && skip === upd.version) {
      if (manual) showToast(`已跳过 v${upd.version}，可在设置里恢复`, '');
      return;
    }
    if (phase.kind === 'downloading' || phase.kind === 'ready') return; // 不打断进行中的下载
    phase = { kind: 'available', upd, mandatory };
    render();
    if (manual) showToast(`发现新版本 v${upd.version}`, 'ok');
  } catch (err) {
    // 自动检查失败必须静默：离线、内网、后台没配版本号都是常态
    if (manual) showToast(`检查更新失败：${errText(err)}`, 'err');
  } finally {
    busy = false;
  }
}

async function download(): Promise<void> {
  if (phase.kind !== 'available' && phase.kind !== 'failed') return;
  const upd = phase.upd;
  let total = 0;
  let got = 0;
  let lastPct = -1;
  phase = { kind: 'downloading', upd, pct: 0 };
  render();
  try {
    await upd.download((e) => {
      if (e.event === 'Started') {
        total = e.data.contentLength ?? 0;
      } else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        if (total > 0) {
          const pct = Math.min(99, Math.floor((got / total) * 100));
          if (pct !== lastPct) {
            lastPct = pct;
            phase = { kind: 'downloading', upd, pct };
            render();
          }
        }
      }
    });
    phase = { kind: 'ready', upd };
    render();
    showToast(`v${upd.version} 下载完成，点状态栏安装`, 'ok');
  } catch (err) {
    phase = { kind: 'failed', upd };
    render();
    showToast(`下载更新失败：${errText(err)}`, 'err');
  }
}

async function install(): Promise<void> {
  if (phase.kind !== 'ready') return;
  if (!(await beforeInstall())) return;
  try {
    // Windows：插件以静默模式（/S）运行 NSIS 安装器，随后由插件退出本进程
    await phase.upd.install();
  } catch (err) {
    showToast(`安装失败：${errText(err)}`, 'err');
  }
}

function onClick(): void {
  if (phase.kind === 'available' || phase.kind === 'failed') void download();
  else if (phase.kind === 'ready') void install();
}

function onContextMenu(ev: MouseEvent): void {
  if (phase.kind !== 'available' || phase.mandatory) return;
  ev.preventDefault();
  const v = phase.upd.version;
  const s = getSettings();
  void saveSettings({
    ...s,
    update: { ...(s.update ?? { autoCheck: true }), skipVersion: v },
  })
    .then(() => {
      phase = { kind: 'idle' };
      render();
      showToast(`已跳过 v${v}，可在设置里恢复`, '');
    })
    .catch(() => undefined);
}

/**
 * 挂在 boot 末尾：接管状态栏元素，按设置决定是否自动检查。
 * beforeInstall 由主进程提供（有未保存文件时先询问）。
 */
export function initUpdater(opts: {
  el: HTMLElement;
  beforeInstall: () => Promise<boolean>;
}): void {
  el = opts.el;
  beforeInstall = opts.beforeInstall;
  el.addEventListener('click', onClick);
  el.addEventListener('contextmenu', onContextMenu);
  void getVersion()
    .then((v) => {
      currentVersion = v;
    })
    .catch(() => undefined);

  const auto = getSettings().update?.autoCheck ?? true; // 默认开
  if (auto) {
    window.setTimeout(() => void runCheck(false), START_DELAY_MS);
    window.setInterval(() => {
      if (getSettings().update?.autoCheck ?? true) void runCheck(false);
    }, AUTO_INTERVAL_MS);
  }
  render();
}

/** 关于窗口的「检查更新」按钮 */
export async function manualCheck(): Promise<void> {
  await runCheck(true);
}

/** 设置里「恢复提示」：清掉跳过的版本号 */
export async function resetSkip(): Promise<void> {
  const s = getSettings();
  await saveSettings({ ...s, update: { ...(s.update ?? { autoCheck: true }), skipVersion: '' } });
  showToast('已恢复更新提示', 'ok');
}
