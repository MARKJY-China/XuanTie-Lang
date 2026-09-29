// 终端面板:多会话(1 个常驻 shell + N 个运行会话),PTY 在 Rust 侧
// 设计:一键运行用独立会话直连程序(不经 shell),免 PowerShell & 前缀与引号问题;
//       退出检测精确(pty-exit),停止 = 杀会话。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import * as backend from '../backend';

interface TermSession {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  tabEl: HTMLElement;
  alive: boolean;
  isMain: boolean;
  // 进程退出回调(编译等动作借此感知完成时机)
  onExit?: () => void;
}

const TERM_OPTIONS = {
  convertEol: false,
  cursorBlink: true,
  fontSize: 13,
  fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace',
  scrollback: 5000,
  theme: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#e8842c',
    selectionBackground: '#264f78',
  },
};

export class TerminalPane {
  private sessions = new Map<string, TermSession>();
  private unlisten = new Map<string, UnlistenFn[]>();
  private activeId: string | null = null;
  private seq = 0;
  private resizeObs: ResizeObserver;
  private fitQueued = false;

  constructor(
    private host: HTMLElement,
    private tabBar: HTMLElement,
  ) {
    this.resizeObs = new ResizeObserver(() => this.queueFit());
    this.resizeObs.observe(host);
  }

  private queueFit(): void {
    if (this.fitQueued) return;
    this.fitQueued = true;
    window.requestAnimationFrame(() => {
      this.fitQueued = false;
      this.fitActive();
    });
  }

  private fitActive(): void {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (!s) return;
    try {
      s.fit.fit();
    } catch {
      // 视图尚未布局完成时 fit 会抛错,下个尺寸变化事件再试
    }
    if (s.alive) {
      backend
        .ptyResize(s.id, Math.max(4, s.term.cols), Math.max(2, s.term.rows))
        .catch(() => undefined);
    }
  }

  private writeSession(s: TermSession, data: string): void {
    s.term.write(data);
  }

  private buildSession(id: string, title: string, isMain: boolean): TermSession {
    const view = document.createElement('div');
    view.className = 'term-view';
    this.host.appendChild(view);

    const tabEl = document.createElement('div');
    tabEl.className = 'ses-tab';
    const tname = document.createElement('span');
    tname.textContent = title;
    tname.title = title;
    const sclose = document.createElement('span');
    sclose.className = 'sclose';
    const scloseIco = document.createElement('i');
    scloseIco.className = 'codicon codicon-close';
    sclose.appendChild(scloseIco);
    tabEl.append(tname, sclose);
    tabEl.addEventListener('click', () => this.activate(id));
    sclose.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.closeSession(id);
    });
    this.tabBar.appendChild(tabEl);

    const term = new Terminal(TERM_OPTIONS);
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(view);
    term.onData((d) => {
      const s = this.sessions.get(id);
      if (s && s.alive) {
        backend.ptyWrite(id, d).catch(() => undefined);
      }
    });

    return { id, title, term, fit, view, tabEl, alive: false, isMain };
  }

  private registerStreams(s: TermSession): Promise<void> {
    return (async () => {
      const un: UnlistenFn[] = [];
      un.push(
        await listen<string>(`pty-out-${s.id}`, (e) => {
          s.term.write(e.payload);
        }),
      );
      un.push(
        await listen<void>(`pty-exit-${s.id}`, () => {
          s.alive = false;
          this.writeSession(s, '\r\n\x1b[90m[进程已退出,点 × 关闭]\x1b[0m\r\n');
          s.onExit?.();
        }),
      );
      this.unlisten.set(s.id, un);
    })();
  }

  async spawn(
    id: string,
    title: string,
    cwd: string,
    program: string | null,
    args: string[] | null,
    isMain = false,
    onExit?: () => void,
  ): Promise<void> {
    if (this.sessions.has(id)) {
      this.activate(id);
      return;
    }
    const s = this.buildSession(id, title, isMain);
    s.onExit = onExit;
    this.sessions.set(id, s);
    this.activate(id);
    await this.registerStreams(s);
    try {
      await backend.ptyStart(id, cwd, Math.max(20, s.term.cols), Math.max(4, s.term.rows), program, args);
      s.alive = true;
    } catch (err) {
      this.writeSession(s, `\r\n\x1b[31m启动失败: ${String(err)}\x1b[0m\r\n`);
    }
    this.fitActive();
  }

  async ensureMain(cwd: string): Promise<void> {
    const s = this.sessions.get('main');
    if (s) {
      this.activate('main');
      return;
    }
    await this.spawn('main', '终端', cwd, null, null, true);
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  // 菜单「新建终端」:独立常驻会话(与运行会话同类,不经 shell 拉起 PowerShell)
  async newSession(cwd: string): Promise<void> {
    const id = `term-${++this.seq}`;
    const title = `终端 ${this.seq}`;
    await this.spawn(id, title, cwd, null, null);
  }

  async closeActive(): Promise<void> {
    if (this.activeId) await this.closeSession(this.activeId);
  }

  clearActive(): void {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    if (s) {
      s.term.clear();
      s.term.focus();
    }
  }

  async runCommand(
    title: string,
    cwd: string,
    program: string,
    args: string[],
    onExit?: () => void,
  ): Promise<void> {
    this.pruneDeadRuns();
    const id = `run-${++this.seq}`;
    await this.spawn(id, title, cwd, program, args, false, onExit);
  }

  stopRun(): boolean {
    let victim: TermSession | null = null;
    for (const s of this.sessions.values()) {
      if (!s.isMain && s.alive) victim = s;
    }
    if (!victim) return false;
    void this.closeSession(victim.id);
    return true;
  }

  activate(id: string): void {
    if (!this.sessions.has(id)) return;
    this.activeId = id;
    for (const [sid, s] of this.sessions) {
      s.view.classList.toggle('active', sid === id);
      s.tabEl.classList.toggle('active', sid === id);
    }
    window.setTimeout(() => this.fitActive(), 0);
  }

  async closeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) return;
    s.alive = false;
    try {
      await backend.ptyKill(id);
    } catch {
      // 进程已退出:kill 报错属正常竞态
    }
    for (const u of this.unlisten.get(id) ?? []) u();
    this.unlisten.delete(id);
    s.term.dispose();
    s.view.remove();
    s.tabEl.remove();
    this.sessions.delete(id);
    if (this.activeId === id) {
      const next = this.sessions.has('main') ? 'main' : (this.sessions.keys().next().value ?? null);
      if (next !== null && next !== undefined) this.activate(next);
      else this.activeId = null;
    }
  }

  private pruneDeadRuns(): void {
    for (const s of [...this.sessions.values()]) {
      if (!s.isMain && !s.alive) void this.closeSession(s.id);
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) void this.closeSession(id);
    this.resizeObs.disconnect();
  }
}
