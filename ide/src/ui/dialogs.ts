// 弹层:模态框 / 输入框 / 确认框 / 右键菜单 / 轻提示(全部 Promise 化)

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function modalRoot(): HTMLElement {
  return document.getElementById('modal-root') as HTMLElement;
}

// 通用模态:title 主标题;subtitle 可选副标题(小字弱化,换行显示,不用破折号拼接)
export function showCustomModal(
  title: string,
  bodyBuilder: (body: HTMLElement, close: (result?: unknown) => void) => void,
  subtitle?: string,
): Promise<unknown> {
  return new Promise((resolve) => {
    const root = modalRoot();
    root.classList.add('open');
    root.innerHTML = '<div class="overlay"></div>';
    const card = el('div', 'modal');
    card.appendChild(el('div', 'm-head', title));
    if (subtitle) card.appendChild(el('div', 'm-subtitle', subtitle));
    const body = el('div', 'm-body');
    card.appendChild(body);
    root.appendChild(card);

    const done = (result?: unknown): void => {
      root.classList.remove('open');
      root.innerHTML = '';
      resolve(result);
    };
    const overlay = root.querySelector('.overlay');
    overlay?.addEventListener('click', () => done());
    bodyBuilder(body, done);
    const input = body.querySelector('input');
    input?.focus();
  });
}

export function promptText(title: string, label: string, initial = ''): Promise<string | null> {
  return showCustomModal(title, (body, close) => {
    const row = el('div', 'mrow');
    row.appendChild(el('label', undefined, label));
    const input = document.createElement('input');
    input.type = 'text';
    input.value = initial;
    input.spellcheck = false;
    row.appendChild(input);
    body.appendChild(row);
    const foot = el('div', 'm-foot');
    const cancel = el('button', 'mbtn', '取消');
    const ok = el('button', 'mbtn primary', '确定');
    cancel.addEventListener('click', () => close());
    ok.addEventListener('click', () => close(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
      if (e.key === 'Escape') close();
    });
    foot.append(cancel, ok);
    body.appendChild(foot);
  }).then((v) => (typeof v === 'string' && v.length > 0 ? v : null));
}

export function confirmBox(title: string, message: string): Promise<boolean> {
  return showCustomModal(title, (body, close) => {
    body.appendChild(el('div', undefined, message));
    const foot = el('div', 'm-foot');
    const cancel = el('button', 'mbtn', '取消');
    const ok = el('button', 'mbtn primary', '确定');
    cancel.addEventListener('click', () => close(false));
    ok.addEventListener('click', () => close(true));
    foot.append(cancel, ok);
    body.appendChild(foot);
  }).then((v) => v === true);
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  /** 右侧打勾(KIMICODE 式单选菜单) */
  checked?: boolean;
  /** 分组标题:小灰字、不可点(菜单内分区用) */
  header?: boolean;
  action?: () => void;
}

// 菜单项数组元素:分隔符用 CONTEXT_SEP
export type ContextMenuEntry = ContextMenuItem | typeof CONTEXT_SEP;

/** 渲染一个菜单项(header=标题行 / checked=右侧 ✓ / 常规=可点行);两个菜单共用 */
function renderMenuEntry(menu: HTMLElement, item: ContextMenuItem): void {
  if (item.header) {
    menu.appendChild(el('div', 'ctx-header', item.label));
    return;
  }
  const row = el('div', 'ctx-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : ''));
  const label = document.createElement('span');
  label.textContent = item.label;
  row.appendChild(label);
  if (item.checked) {
    const ic = document.createElement('i');
    ic.className = 'codicon codicon-check ctx-check';
    row.appendChild(ic);
  }
  row.addEventListener('click', () => {
    closeContextMenu();
    item.action?.();
  });
  menu.appendChild(row);
}

export function showContextMenu(x: number, y: number, items: ContextMenuEntry[]): void {
  const root = document.getElementById('ctx-root') as HTMLElement;
  root.classList.add('open');
  root.innerHTML = '';
  const menu = el('div', 'ctx-menu');
  for (const item of items) {
    if (item === CONTEXT_SEP) {
      menu.appendChild(el('div', 'ctx-sep'));
      continue;
    }
    renderMenuEntry(menu, item);
  }
  root.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  root.addEventListener('click', closeContextMenu, { once: true });
  root.addEventListener('contextmenu', closeContextMenu, { once: true });
}

// 菜单分隔符哨兵(类型安全,避免调用方塞 undefined)
export const CONTEXT_SEP: unique symbol = Symbol('sep');

/**
 * 向上展开的下拉菜单(输入区底部按钮专用):菜单底边贴 anchor 顶边(留 4px),
 * 左边缘对齐 anchor 左边缘(越界向右收),宽度至少与按钮同宽;点别处/右键关闭与
 * showContextMenu 一致。
 */
export function showDropupMenu(anchor: HTMLElement, items: ContextMenuEntry[]): void {
  const root = document.getElementById('ctx-root') as HTMLElement;
  root.classList.add('open');
  root.innerHTML = '';
  const menu = el('div', 'ctx-menu ctx-dropup');
  for (const item of items) {
    if (item === CONTEXT_SEP) {
      menu.appendChild(el('div', 'ctx-sep'));
      continue;
    }
    renderMenuEntry(menu, item);
  }
  root.appendChild(menu);
  const a = anchor.getBoundingClientRect();
  menu.style.minWidth = `${Math.max(a.width, 170)}px`;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(a.left, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.max(8, a.top - rect.height - 4)}px`;
  root.addEventListener('click', closeContextMenu, { once: true });
  root.addEventListener('contextmenu', closeContextMenu, { once: true });
}

export function closeContextMenu(): void {
  const root = document.getElementById('ctx-root') as HTMLElement;
  root.classList.remove('open');
  root.innerHTML = '';
}

export function showToast(message: string, kind: '' | 'ok' | 'err' = ''): void {
  const host = document.getElementById('toast-host') as HTMLElement;
  const t = el('div', 'toast ' + kind, message);
  host.appendChild(t);
  window.setTimeout(() => t.remove(), 3500);
}
