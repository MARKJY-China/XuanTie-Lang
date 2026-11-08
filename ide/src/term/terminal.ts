// 终端面板:终端会话(1 个常驻 shell + N 个会话) + 独立「构建」输出视图
// PTY 在 Rust 侧;运行/铁铺走直连程序(不经 shell),编译输出进「构建」Tab 专用视图。
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readText as readClipboard } from '@tauri-apps/plugin-clipboard-manager';
import * as backend from '../backend';
import { copyText } from '../util';
import { CONTEXT_SEP, showContextMenu, showToast, type ContextMenuEntry } from '../ui/dialogs';

interface TermSession {
  id: string;
  title: string;
  term: Terminal;
  fit: FitAddon;
  view: HTMLElement;
  tabEl: HTMLElement | null; // 构建视图固定在「构建」Tab,无会话标签
  alive: boolean;
  isMain: boolean;
  host: 'term' | 'build' | 'output';
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
  target?: 'term' | 'build' | 'output';
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
    private outputHost: HTMLElement,
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

  /** 当前活动终端会话的选中文本(「添加到对话」用);无选中返回空串。 */
  activeSelection(): string {
    const s = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return s ? s.term.getSelection() : '';
  }

  /** 构建视图(编译输出)的选中文本;无选中返回空串。 */
  buildSelection(): string {
    const s = this.sessions.get('build');
    return s ? s.term.getSelection() : '';
  }

  private writeSession(s: TermSession, data: string): void {
    s.term.write(data);
  }

  private buildSession(id: string, title: string, target: 'term' | 'build' | 'output', isMain: boolean): TermSession {
    const view = document.createElement('div');
    view.className = target === 'term' ? 'term-view' : target === 'build' ? 'build-view' : 'output-view';
    (target === 'term' ? this.host : target === 'build' ? this.buildHost : this.outputHost).appendChild(view);
    // 「输出」是单视图(每次运行清场重来),不参与 term 会话的显示/隐藏切换,建好即常显
    if (target === 'output') view.classList.add('active');

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

    // ---- 复制 / 粘贴 ----
    // 终端里 Ctrl+C 默认是"把 ^C 发给进程",所以只有存在选区时才当复制用(与 VS Code 一致);
    // Ctrl+Shift+C 无条件复制,Ctrl+V / Ctrl+Shift+V 粘贴,右键出菜单。
    const canPaste = (): boolean => target === 'term';
    const copySelection = (): boolean => {
      const sel = term.getSelection();
      if (!sel) return false;
      void copyText(sel).then((ok) => {
        if (!ok) showToast('复制失败:剪贴板不可用', 'err');
      });
      return true;
    };
    const paste = async (): Promise<void> => {
      if (!canPaste()) return;
      const s = this.sessions.get(id);
      if (!s || !s.alive) {
        showToast('会话已结束,无法粘贴', 'err');
        return;
      }
      try {
        const text = await readClipboard();
        if (text) await backend.ptyWrite(id, text);
      } catch (err) {
        showToast(`读取剪贴板失败: ${String(err)}`, 'err');
      }
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return true;
      if (e.code === 'KeyC') {
        if (e.shiftKey || term.hasSelection()) {
          e.preventDefault();
          copySelection();
          return false;
        }
        return true; // 无选区:交给终端发 ^C
      }
      if (e.code === 'KeyV') {
        if (!canPaste()) return true;
        e.preventDefault();
        void paste();
        return false;
      }
      return true;
    });

    // 右键菜单:全局 contextmenu 拦截器会跳过"已 preventDefault"的事件(main.ts bindUi)
    view.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const hasSel = term.hasSelection();
      const items: ContextMenuEntry[] = [
        { label: '复制', disabled: !hasSel, action: () => copySelection() },
      ];
      if (canPaste()) items.push({ label: '粘贴', action: () => void paste() });
      items.push(CONTEXT_SEP, { label: '全选', action: () => term.selectAll() });
      items.push({ label: '清屏', action: () => term.clear() });
      showContextMenu(e.clientX, e.clientY, items);
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
    else if (target === 'build') this.fitBuild();
    else this.fitOutput();
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

  /** 运行会话 id(一键运行时创建;顶部「运行」按钮据此切成「停止」) */
  private runId: string | null = null;
  /** 运行状态变化回调,由 main.ts 挂到顶部按钮 */
  onRunState: ((running: boolean) => void) | null = null;

  /**
   * 跑一条命令。target='output' 时进「输出」Tab 的固定单视图(程序运行结果,每次清场);
   * 默认 'term' 用于铁铺等交互命令,仍是终端会话标签。
   */
  async runCommand(
    title: string,
    cwd: string,
    program: string,
    args: string[],
    onExit?: (exitCode: number) => void,
    target: 'term' | 'output' = 'term',
  ): Promise<void> {
    this.pruneDeadRuns();
    let id: string;
    if (target === 'output') {
      await this.resetOutputSession();
      id = 'output';
    } else {
      id = `run-${++this.seq}`;
    }
    this.runId = id;
    this.onRunState?.(true);
    try {
      await this.spawn(id, title, cwd, program, args, {
        target,
        onExit: (code) => {
          if (this.runId === id) this.clearRunState();
          onExit?.(code);
        },
      });
      // spawn 内部把启动失败写进会话、不抛错;这里兜住"没跑起来"的情况,别让按钮卡在「停止」
      if (this.runId === id && !this.isRunning()) this.clearRunState();
    } catch (err) {
      if (this.runId === id) this.clearRunState();
      throw err;
    }
    if (target === 'output') this.fitOutput();
  }

  private clearRunState(): void {
    this.runId = null;
    this.onRunState?.(false);
  }

  /** 是否有正在运行的会话(顶部按钮两态判断) */
  isRunning(): boolean {
    return this.runId !== null && (this.sessions.get(this.runId)?.alive ?? false);
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

  // 「输出」Tab:程序运行结果的固定单视图,每次运行清场重来(与「构建」同构)
  private async resetOutputSession(): Promise<void> {
    const old = this.sessions.get('output');
    if (old) {
      try {
        await backend.ptyKill('output');
      } catch {
        // 已退出属正常
      }
      for (const u of this.unlisten.get('output') ?? []) u();
      this.unlisten.delete('output');
      old.term.dispose();
      old.view.remove();
      this.sessions.delete('output');
    }
  }

  fitOutput(): void {
    const s = this.sessions.get('output');
    if (!s) return;
    try {
      s.fit.fit();
    } catch {
      // 视图尚未布局时忽略
    }
    if (s.alive) {
      backend
        .ptyResize(s.id, Math.max(20, s.term.cols), Math.max(4, s.term.rows))
        .catch(() => undefined);
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
    const id = this.runId;
    if (!id || !this.sessions.has(id)) {
      this.clearRunState();
      return false;
    }
    this.clearRunState();
    void this.closeSession(id);
    return true;
  }

  activate(id: string | null): void {
    if (id !== null && !this.sessions.has(id)) return;
    this.activeId = id;
    for (const [sid, s] of this.sessions) {
      // 只切换终端会话的显隐;「构建」「输出」是各自 Tab 的固定单视图,不参与这里
      if (s.host !== 'term') continue;
      s.view.classList.toggle('active', sid === id);
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
    // 运行会话被直接关掉(关标签/进程退出)时也要把按钮切回「运行」
    if (this.runId === id) this.clearRunState();
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
