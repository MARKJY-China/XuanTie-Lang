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

// 通用模态:bodyBuilder 拿到 body 与 close;close(result) 结束 Promise
export function showCustomModal(
  title: string,
  bodyBuilder: (body: HTMLElement, close: (result?: unknown) => void) => void,
): Promise<unknown> {
  return new Promise((resolve) => {
    const root = modalRoot();
    root.classList.add('open');
    root.innerHTML = '<div class="overlay"></div>';
    const card = el('div', 'modal');
    card.appendChild(el('div', 'm-head', title));
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
  action: () => void;
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]): void {
  const root = document.getElementById('ctx-root') as HTMLElement;
  root.classList.add('open');
  root.innerHTML = '';
  const menu = el('div', 'ctx-menu');
  for (const item of items) {
    const row = el('div', 'ctx-item' + (item.danger ? ' danger' : ''), item.label);
    row.addEventListener('click', () => {
      closeContextMenu();
      item.action();
    });
    menu.appendChild(row);
  }
  root.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
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
