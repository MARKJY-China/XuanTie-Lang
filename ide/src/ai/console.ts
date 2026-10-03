/**
 * 智器对话控制台窗口:F12 风格日志视图。
 * 历史走 ai_log_fetch(Rust 环形缓冲),实时走 ai-log 广播事件;
 * 级别 chips 多选 + 文本/来源过滤(纯函数 filterEntries 在 log-bus.ts)+ 清空/暂停/自动滚底。
 */
import '../styles.css';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { filterEntries, type AiLogEntry, type AiLogLevel } from './log-bus';

const logEl = document.getElementById('log') as HTMLElement;
const fText = document.getElementById('f-text') as HTMLInputElement;
const fSource = document.getElementById('f-source') as HTMLInputElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnClear = document.getElementById('btn-clear') as HTMLButtonElement;

const activeLevels = new Set<AiLogLevel>(['debug', 'info', 'warn', 'error']);
let paused = false;
let detached = false; // 用户上滚脱离自动滚底
let entries: AiLogEntry[] = [];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function buildRow(e: AiLogEntry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(e.ts);
  const lv = document.createElement('span');
  lv.className = `lv ${e.level}`;
  lv.textContent = e.level;
  const src = document.createElement('span');
  src.className = 'src';
  src.textContent = e.source;
  const cell = document.createElement('div');
  cell.className = 'cell';
  const txt = document.createElement('div');
  txt.className = 'txt';
  txt.textContent = e.text;
  cell.appendChild(txt);
  if (e.data !== undefined) {
    const toggle = document.createElement('span');
    toggle.className = 'data-toggle';
    toggle.textContent = ' ▸ data';
    const pre = document.createElement('pre');
    pre.className = 'data';
    pre.style.display = 'none';
    pre.textContent = typeof e.data === 'string' ? e.data : JSON.stringify(e.data, null, 2);
    toggle.addEventListener('click', () => {
      const open = pre.style.display === 'none';
      pre.style.display = open ? '' : 'none';
      toggle.textContent = open ? ' ▾ data' : ' ▸ data';
    });
    txt.appendChild(toggle);
    cell.appendChild(pre);
  }
  row.append(ts, lv, src, cell);
  return row;
}

function render(): void {
  const visible = filterEntries(entries, {
    levels: activeLevels,
    text: fText.value,
    source: fSource.value,
  });
  logEl.innerHTML = '';
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'empty';
    empty.textContent = entries.length === 0 ? '暂无日志(发起一次 AI 对话即可看到链路日志)' : '无匹配条目';
    logEl.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const e of visible) frag.appendChild(buildRow(e));
  logEl.appendChild(frag);
  if (!detached) logEl.scrollTop = logEl.scrollHeight;
}

let renderPending = false;
function scheduleRender(): void {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

// 级别 chips
for (const chip of document.querySelectorAll<HTMLElement>('.chip')) {
  chip.addEventListener('click', () => {
    const lv = chip.dataset.lv as AiLogLevel;
    if (activeLevels.has(lv)) activeLevels.delete(lv);
    else activeLevels.add(lv);
    chip.classList.toggle('on');
    render();
  });
}
fText.addEventListener('input', () => render());
fSource.addEventListener('input', () => render());

btnPause.addEventListener('click', () => {
  paused = !paused;
  btnPause.textContent = paused ? '继续' : '暂停';
});
btnClear.addEventListener('click', () => {
  entries = [];
  render();
});
logEl.addEventListener('scroll', () => {
  detached = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight >= 60;
});

// 历史 + 实时订阅
void invoke<string[]>('ai_log_fetch').then((history) => {
  for (const line of history) {
    try {
      entries.push(JSON.parse(line) as AiLogEntry);
    } catch {
      // 坏行跳过
    }
  }
  render();
});
void listen<string>('ai-log', (e) => {
  if (paused) return;
  try {
    entries.push(JSON.parse(e.payload) as AiLogEntry);
  } catch {
    return;
  }
  scheduleRender();
});
