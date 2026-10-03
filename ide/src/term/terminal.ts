// 终端面板:终端会话(1 个常驻 shell + N 个会话) + 独立「构建」输出视图
// PTY 在 Rust 侧;运行/铁铺走直连程序(不经 shell),编译输出进「构建」Tab 专用视图。
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
  tabEl: HTMLElement | null; // 构建视图固定在「构建」Tab,无会话标签
  alive: boolean;
  isMain: boolean;
  host: 'term' | 'build';
  // 进程退出回调(编译等动作借此感知完成时机)
  onExit?: (exitCode: number) => void;
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

export type SpawnOpts = {
  isMain?: boolean;
  onExit?: (exitCode: number) => void;
  target?: 'term' | 'build';
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
    private buildHost: HTMLElement,
  ) {
    this.resizeObs = new ResizeObserver(() => this.queueFit());
    this.resizeObs.observe(host);
    this.resizeObs.observe(buildHost);
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

  fitBuild(): void {
    const s = this.sessions.get('build');
    if (!s) return;
    try {
      s.fit.fit();
    } catch {
      // 同上
    }
    if (s.alive) {
      backend
        .ptyResize('build', Math.max(4, s.term.cols), Math.max(2, s.term.rows))
        .catch(() => undefined);
    }
  }

  private writeSession(s: TermSession, data: string): void {
    s.term.write(data);
  }

  private buildSession(id: string, title: string, target: 'term' | 'build', isMain: boolean): TermSession {
    const view = document.createElement('div');
    view.className = target === 'build' ? 'build-view' : 'term-view';
    (target === 'build' ? this.buildHost : this.host).appendChild(view);

    let tabEl: HTMLElement | null = null;
    if (target === 'term') {
      tabEl = document.createElement('div');
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
    }

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

    return { id, title, term, fit, view, tabEl, alive: false, isMain, host: target };
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
        await listen<string>(`pty-exit-${s.id}`, (e) => {
          s.alive = false;
          const code = Number(e.payload ?? '1');
          const exitCode = Number.isFinite(code) ? code : 1;
          if (s.host === 'build') {
            const line = exitCode === 0 ? '\x1b[32m编译成功\x1b[0m' : `\x1b[31m编译失败(退出码 ${exitCode})\x1b[0m`;
            s.term.write(`\r\n\x1b[90m[铸造厂] 编译进程已结束:${line}\x1b[0m\r\n`);
          } else {
            s.term.write('\r\n\x1b[90m[进程已退出,点 × 关闭]\x1b[0m\r\n');
          }
          s.onExit?.(exitCode);
        }),
      );
      this.unlisten.set(s.id, un);
    })();
  }

  async spawn(id: string, title: string, cwd: string, program: string | null, args: string[] | null, opts: SpawnOpts = {}): Promise<void> {
    const target = opts.target ?? 'term';
    if (this.sessions.has(id)) {
      if (target === 'term') this.activate(id);
      return;
    }
    const s = this.buildSession(id, title, target, opts.isMain === true);
    s.onExit = opts.onExit;
    this.sessions.set(id, s);
    if (target === 'term') this.activate(id);
    await this.registerStreams(s);
    try {
      await backend.ptyStart(id, cwd, Math.max(20, s.term.cols), Math.max(4, s.term.rows), program, args);
      s.alive = true;
    } catch (err) {
      this.writeSession(s, `\r\n\x1b[31m启动失败: ${String(err)}\x1b[0m\r\n`);
    }
    if (target === 'term') this.fitActive();
    else this.fitBuild();
  }

  async ensureMain(cwd: string): Promise<void> {
    const s = this.sessions.get('main');
    if (s) {
      this.activate('main');
      return;
    }
    await this.spawn('main', '终端', cwd, null, null, { isMain: true });
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

  async runCommand(title: string, cwd: string, program: string, args: string[], onExit?: (exitCode: number) => void): Promise<void> {
    this.pruneDeadRuns();
    const id = `run-${++this.seq}`;
    await this.spawn(id, title, cwd, program, args, { onExit });
  }

  // 「构建」Tab:固定单视图,每次编译清场重来(上一次构建会话无论死活先清掉)
  private async resetBuildSession(): Promise<void> {
    const old = this.sessions.get('build');
    if (old) {
      try {
        await backend.ptyKill('build');
      } catch {
        // 已退出属正常
      }
      for (const u of this.unlisten.get('build') ?? []) u();
      this.unlisten.delete('build');
      old.term.dispose();
      old.view.remove();
      this.sessions.delete('build');
    }
  }

  async runBuild(cwd: string, program: string, args: string[], onExit?: (exitCode: number) => void): Promise<void> {
    await this.resetBuildSession();
    await this.spawn('build', '构建', cwd, program, args, { target: 'build', onExit });
  }

  writeBuild(text: string): void {
    const s = this.sessions.get('build');
    if (s) s.term.write(text);
  }

  clearBuild(): void {
    const s = this.sessions.get('build');
    if (s) s.term.clear();
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

  activate(id: string | null): void {
    if (id !== null && !this.sessions.has(id)) return;
    this.activeId = id;
    for (const [sid, s] of this.sessions) {
      const on = s.host === 'term' && sid === id;
      s.view.classList.toggle('active', on);
      if (s.tabEl) s.tabEl.classList.toggle('active', sid === id);
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
    if (s.tabEl) s.tabEl.remove();
    this.sessions.delete(id);
    if (this.activeId === id) {
      const nextTerm = [...this.sessions.values()].find((x) => x.host === 'term');
      this.activate(nextTerm ? nextTerm.id : null);
    }
  }

  private pruneDeadRuns(): void {
    // 构建视图不在此清理:最后一次编译的输出要留在「构建」Tab 供用户查看
    for (const s of [...this.sessions.values()]) {
      if (s.host === 'term' && !s.isMain && !s.alive) void this.closeSession(s.id);
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) void this.closeSession(id);
    this.resizeObs.disconnect();
  }
}
