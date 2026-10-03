// xt_lsp 的 JSON-RPC 客户端(帧解析在 Rust 侧,此处只做消息语义)
// 协议事实(lsp/xt_lsp.xt):
//   全文同步(change:1);_xtcPath 放 initialize params 顶层;
//   _fsPath 放 didOpen/didChange/didSave params 顶层(中文路径免 URI 解码);
//   服务器主动推 textDocument/publishDiagnostics。
import type { UnlistenFn } from '@tauri-apps/api/event';
import * as backend from '../backend';
import { pathToUri, uriToPath } from '../uri';
import type { DiagnosticDto } from '../types';

export type LspStatus = 'connecting' | 'connected' | 'disconnected';

interface PendingCall {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: {
    uri?: string;
    diagnostics?: DiagnosticDto[];
    [k: string]: unknown;
  };
  result?: unknown;
  error?: { message?: string };
}

const REQUEST_TIMEOUT_MS = 15000;
const CHANGE_DEBOUNCE_MS = 300;

export class XtLspClient {
  connected = false;
  // 握手期间放行 request():connected 要到 initialize 应答后才置位,
  // 不放行会导致握手第一个请求被自己的守卫拦截 → LSP 秒失败 + xt_lsp 僵尸
  private handshaking = false;
  private id = -1;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private unlisten: UnlistenFn[] = [];
  private versions = new Map<string, number>();
  private statusCb: ((s: LspStatus, detail: string) => void) | null = null;
  private diagCb: ((path: string, diags: DiagnosticDto[]) => void) | null = null;
  private changeTimers = new Map<string, number>();
  private changeText = new Map<string, string>();
  private changePath = new Map<string, string>();
  // 发送串行链:Tauri 异步命令不保序,乱序会让 didOpen 晚于 hover/大纲请求到达
  // xt_lsp(有状态协议循环),服务器按"文档不存在"返回空——悬停全空/大纲空/补全缺
  // 本地符号的根因。串行化后 didOpen 恒先于依赖它的请求。
  private sendChain: Promise<void> = Promise.resolve();

  onStatus(cb: (s: LspStatus, detail: string) => void): void {
    this.statusCb = cb;
  }

  onDiagnostics(cb: (path: string, diags: DiagnosticDto[]) => void): void {
    this.diagCb = cb;
  }

  async start(serverPath: string, workspace: string, xtcPath: string): Promise<void> {
    this.statusCb?.('connecting', serverPath);
    this.handshaking = true;
    this.sendChain = Promise.resolve();
    try {
      this.id = await backend.lspStart(serverPath, workspace, xtcPath);
      this.unlisten.push(await backend.onLspMessage(this.id, (json) => this.onMessage(json)));
      this.unlisten.push(
        await backend.onLspError(this.id, (line) => {
          console.info('[xt_lsp]', line);
        }),
      );
      this.unlisten.push(
        await backend.onLspExit(this.id, () => {
          this.connected = false;
          this.failAllPending('xt_lsp 进程已退出');
          this.statusCb?.('disconnected', 'xt_lsp 进程退出');
        }),
      );
      await this.request('initialize', {
        capabilities: {},
        rootUri: pathToUri(workspace),
        processId: null,
        _xtcPath: xtcPath,
      });
      this.notify('initialized', {});
      this.connected = true;
      this.statusCb?.('connected', serverPath);
    } catch (e) {
      // 握手失败不留僵尸进程:杀服务器、清监听,错误上抛给状态栏/toast
      const id = this.id;
      this.id = -1;
      this.connected = false;
      this.failAllPending('LSP 启动失败');
      this.unlisten.forEach((u) => u());
      this.unlisten = [];
      if (id >= 0) {
        try {
          await backend.lspStop(id);
        } catch {
          // 进程已死,属正常竞态
        }
      }
      throw e;
    } finally {
      this.handshaking = false;
    }
  }

  async stop(): Promise<void> {
    if (this.id >= 0) {
      const shutdown = JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown', params: null });
      const exit = JSON.stringify({ jsonrpc: '2.0', method: 'exit' });
      const id = this.id;
      this.sendChain = this.sendChain
        .then(() => backend.lspSend(id, shutdown))
        .then(() => backend.lspSend(id, exit))
        .catch(() => undefined);
      try {
        await this.sendChain;
      } catch {
        // 链上已捕获
      }
      try {
        await backend.lspStop(id);
      } catch {
        // 进程已死:直接走 kill 兜底
      }
    }
    this.connected = false;
    this.id = -1;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    this.pending.clear();
    this.versions.clear();
    for (const t of this.changeTimers.values()) window.clearTimeout(t);
    this.changeTimers.clear();
    this.changeText.clear();
    this.changePath.clear();
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.connected && !this.handshaking) return Promise.reject(new Error('LSP 未连接'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`LSP 请求超时: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          window.clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          window.clearTimeout(timer);
          reject(e);
        },
      });
      this.sendRaw({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.connected) return;
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  didOpen(path: string, text: string): void {
    const uri = pathToUri(path);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'xuantie', version, text },
      _fsPath: path,
    });
  }

  // 全文同步(change:1):每次发整篇文本,防抖 300ms
  didChange(path: string, text: string): void {
    const uri = pathToUri(path);
    this.changeText.set(uri, text);
    this.changePath.set(uri, path);
    const old = this.changeTimers.get(uri);
    if (old !== undefined) window.clearTimeout(old);
    const timer = window.setTimeout(() => {
      this.changeTimers.delete(uri);
      const latest = this.changeText.get(uri);
      const fsPath = this.changePath.get(uri);
      if (latest === undefined || fsPath === undefined) return;
      const version = (this.versions.get(uri) ?? 0) + 1;
      this.versions.set(uri, version);
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: latest }],
        _fsPath: fsPath,
      });
    }, CHANGE_DEBOUNCE_MS);
    this.changeTimers.set(uri, timer);
  }

  didSave(path: string): void {
    const uri = pathToUri(path);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.notify('textDocument/didSave', {
      textDocument: { uri, version },
      _fsPath: path,
    });
  }

  didClose(path: string): void {
    const uri = pathToUri(path);
    const timer = this.changeTimers.get(uri);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.changeTimers.delete(uri);
      this.changeText.delete(uri);
      this.changePath.delete(uri);
    }
    this.versions.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  private sendRaw(msg: object): void {
    // 全部发送走同一条 promise 链,严格保序(见 sendChain 注释)
    const data = JSON.stringify(msg);
    this.sendChain = this.sendChain
      .then(() => backend.lspSend(this.id, data))
      .catch((err: unknown) => {
        console.error('LSP 发送失败', err);
      });
  }

  private onMessage(json: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(json) as RpcMessage;
    } catch {
      console.error('LSP 消息非 JSON', json.slice(0, 200));
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (p) {
        if (msg.error) {
          p.reject(new Error(msg.error.message ?? 'LSP 错误'));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const uri = msg.params.uri ?? '';
      const diags = msg.params.diagnostics ?? [];
      this.diagCb?.(uriToPath(uri), diags);
    }
  }

  private failAllPending(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
