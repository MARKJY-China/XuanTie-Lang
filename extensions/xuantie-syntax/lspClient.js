// lspClient.js — 玄铁 LSP 瘦客户端(零依赖,node net 手卷 LSP/TCP 帧)
// 连接本机回环上的 xt_lsp.exe(玄铁自写 LSP 服务器)。
// P1 能力:诊断同步(didOpen/didChange/didClose → publishDiagnostics)。
const net = require('net');
const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');
const { pinyin } = require('./pinyin-pro.js');

// 中文标签补 filterText(全拼+首字母),让补全可用拼音/英文筛选
function withPinyinFilter(label) {
    try {
        if (/[\u4e00-\u9fa5]/.test(label)) {
            const arr = pinyin(label, { toneType: 'none', type: 'array' });
            return `${arr.join('')} ${arr.map(p => p[0]).join('')} ${label}`;
        }
    } catch (e) { /* 忽略拼音转换失败 */ }
    return label;
}

class XtLspClient {
    constructor(context) {
        this.context = context;
        this.sock = null;
        this.buffer = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();      // id -> {resolve, reject}
        this.diagCollection = vscode.languages.createDiagnosticCollection('xuantie');
        this.connected = false;
        this.docVersions = new Map();  // uri -> version
        this.spawned = null;
        this.logChannel = vscode.window.createOutputChannel('玄铁 LSP');
        this.retryTimer = null;
    }

    log(msg) {
        const t = new Date().toLocaleTimeString();
        this.logChannel.appendLine(`[${t}] ${msg}`);
    }

    // 查找 xt_lsp.exe:配置项 > 扩展目录 > PATH
    findServer() {
        const cfg = vscode.workspace.getConfiguration('xuantie');
        const confPath = cfg.get('lspServerPath', '');
        if (confPath && fs.existsSync(confPath)) return confPath;
        const bundled = path.join(this.context.extensionPath, 'server', 'xt_lsp.exe');
        if (fs.existsSync(bundled)) return bundled;
        return null;
    }

    encode(payload) {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
    }

    send(obj) {
        if (this.sock && this.connected) this.sock.write(this.encode(obj));
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, params });
    }

    // 帧解码:累积字节流 → Content-Length 分帧
    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const header = this.buffer.slice(0, headerEnd).toString('ascii');
            const m = header.match(/Content-Length:\s*(\d+)/i);
            if (!m) { this.buffer = this.buffer.slice(headerEnd + 4); continue; }
            const len = parseInt(m[1], 10);
            if (this.buffer.length < headerEnd + 4 + len) return;
            const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + len);
            this.buffer = this.buffer.slice(headerEnd + 4 + len);
            try { this.onMessage(JSON.parse(body.toString('utf8'))); } catch (e) { console.error('LSP 帧解析失败', e); }
        }
    }

    onMessage(msg) {
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method === 'textDocument/publishDiagnostics') {
            const { uri, diagnostics } = msg.params;
            this.applyDiagnostics(uri, diagnostics);
        }
    }

    applyDiagnostics(uri, diagnostics) {
        const diags = (diagnostics || []).map(d => {
            const r = d.range;
            const range = new vscode.Range(
                new vscode.Position(r.start.line, r.start.character),
                new vscode.Position(r.end.line, r.end.character));
            const severity = d.severity === 1 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
            const diag = new vscode.Diagnostic(range, d.message || '', severity);
            diag.source = d.source || 'xtc';
            return diag;
        });
        // 优先使用 didOpen 时保存的原生 Uri 对象,规避 Uri.parse 规范化差异导致诊断不落盘
        const native = this.docUris && this.docUris.get(uri);
        this.diagCollection.set(native || vscode.Uri.parse(uri), diags);
        this.log(`诊断发布 ${uri} -> ${diags.length} 条${native ? '' : '(无原生Uri,走parse)'}`);
    }

    async start() {
        const cfg = vscode.workspace.getConfiguration('xuantie');
        const port = cfg.get('lspPort', 20807);
        // 先尝试直连(用户可能已手动起服务);失败则尝试拉起自带的 xt_lsp.exe
        try {
            await this.connect(port);
        } catch (e) {
            const serverPath = this.findServer();
            if (!serverPath) { this.log('xt_lsp 未找到,跳过 LSP 启动'); return; }
            this.log('拉起服务器: ' + serverPath);
            this.spawned = cp.spawn(serverPath, [], { stdio: 'ignore' });
            this.spawned.on('exit', code => {
                this.spawned = null;
                this.log('服务器进程退出 code=' + code);
            });
            await new Promise(r => setTimeout(r, 800));
            await this.connect(port);
        }
        // 握手
        await this.request('initialize', { capabilities: {}, rootUri: null, processId: process.pid });
        this.notify('initialized', {});
        this.log('已连接并完成握手');
        // 已在编辑中的文档补发 didOpen
        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.languageId === 'xuantie') this.didOpen(doc);
        });
    }

    connect(port) {
        return new Promise((resolve, reject) => {
            this.sock = net.createConnection({ host: '127.0.0.1', port }, () => {
                this.connected = true;
                resolve();
            });
            this.sock.on('data', c => this.onData(c));
            this.sock.on('error', err => {
                this.connected = false;
                this.log('连接错误: ' + err.message);
                reject(err);
            });
            this.sock.on('close', () => {
                const wasConnected = this.connected;
                this.connected = false;
                if (wasConnected) {
                    this.log('连接断开,清理陈旧诊断并安排重连');
                    this.diagCollection.clear();   // 防诊断滞留
                    this.scheduleReconnect(port);
                }
            });
        });
    }

    // 断线重连:3 秒后重试(服务器崩溃退出后重新拉起)
    scheduleReconnect(port) {
        if (this.retryTimer) return;
        this.retryTimer = setTimeout(async () => {
            this.retryTimer = null;
            try {
                await this.connect(port);
            } catch (e) {
                const serverPath = this.findServer();
                if (!serverPath) return;
                this.log('重连失败,重新拉起服务器');
                this.spawned = cp.spawn(serverPath, [], { stdio: 'ignore' });
                this.spawned.on('exit', () => { this.spawned = null; });
                await new Promise(r => setTimeout(r, 800));
                try { await this.connect(port); } catch (e2) { this.log('重连再失败: ' + e2.message); return; }
            }
            try {
                await this.request('initialize', { capabilities: {}, rootUri: null, processId: process.pid });
                this.notify('initialized', {});
                this.log('重连成功');
                // 重发所有打开文档
                vscode.workspace.textDocuments.forEach(doc => {
                    if (doc.languageId === 'xuantie') this.didOpen(doc);
                });
            } catch (e) { this.log('重连握手失败: ' + e.message); }
        }, 3000);
    }

    didOpen(doc) {
        const version = (this.docVersions.get(doc.uri.toString()) || 0) + 1;
        this.docVersions.set(doc.uri.toString(), version);
        if (!this.docUris) this.docUris = new Map();
        this.docUris.set(doc.uri.toString(), doc.uri);
        this.log('didOpen ' + doc.uri.toString());
        this.notify('textDocument/didOpen', {
            textDocument: { uri: doc.uri.toString(), languageId: 'xuantie', version, text: doc.getText() }
        });
    }

    didChange(doc) {
        const version = (this.docVersions.get(doc.uri.toString()) || 0) + 1;
        this.docVersions.set(doc.uri.toString(), version);
        if (!this.docUris) this.docUris = new Map();
        this.docUris.set(doc.uri.toString(), doc.uri);
        // 全量同步(change:1):每次发全文
        this.notify('textDocument/didChange', {
            textDocument: { uri: doc.uri.toString(), version },
            contentChanges: [{ text: doc.getText() }]
        });
    }

    didClose(doc) {
        this.docVersions.delete(doc.uri.toString());
        if (this.docUris) this.docUris.delete(doc.uri.toString());
        this.notify('textDocument/didClose', { textDocument: { uri: doc.uri.toString() } });
        this.diagCollection.delete(doc.uri);
    }

    async stop() {
        if (!this.connected) return;
        try {
            await this.request('shutdown', null);
            this.notify('exit', {});
        } catch (e) { /* 忽略关停异常 */ }
        if (this.sock) this.sock.destroy();
        if (this.spawned) { try { this.spawned.kill(); } catch (e) {} }
        this.diagCollection.dispose();
    }
}

let client = null;

// LSP CompletionItemKind → vscode.CompletionItemKind 映射(常用子集)
function mapCompletionKind(k) {
    switch (k) {
        case 3: return vscode.CompletionItemKind.Function;
        case 7: return vscode.CompletionItemKind.Class;
        case 6: return vscode.CompletionItemKind.Variable;
        case 14: return vscode.CompletionItemKind.Keyword;
        case 2: return vscode.CompletionItemKind.Method;
        default: return vscode.CompletionItemKind.Text;
    }
}

function activateLsp(context) {
    client = new XtLspClient(context);
    client.start().catch(err => console.error('xt_lsp 启动失败:', err.message));

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId === 'xuantie' && client) client.didOpen(doc);
        }),
        vscode.workspace.onDidChangeTextDocument(ev => {
            if (ev.document.languageId === 'xuantie' && client) client.didChange(ev.document);
        }),
        vscode.workspace.onDidCloseTextDocument(doc => {
            if (doc.languageId === 'xuantie' && client) client.didClose(doc);
        }),
        // P2:补全转发到 xt_lsp('.' 触发:模块别名. 弹出成员)
        vscode.languages.registerCompletionItemProvider('xuantie', {
            async provideCompletionItems(document, position) {
                if (!client || !client.connected) return [];
                try {
                    const result = await client.request('textDocument/completion', {
                        textDocument: { uri: document.uri.toString() },
                        position: { line: position.line, character: position.character }
                    });
                    return (result || []).map(it => {
                        const ci = new vscode.CompletionItem(it.label, mapCompletionKind(it.kind));
                        if (it.detail) ci.detail = it.detail;
                        if (it.sortText) ci.sortText = it.sortText;
                        ci.filterText = withPinyinFilter(it.label);   // 拼音/英文可筛选
                        if (it.insertTextFormat === 2 && it.insertText) {
                            ci.insertText = new vscode.SnippetString(it.insertText);
                        } else if (it.insertText) {
                            ci.insertText = it.insertText;
                        }
                        return ci;
                    });
                } catch (e) { return []; }
            }
        }, '.'),
        // P2:悬停转发到 xt_lsp
        vscode.languages.registerHoverProvider('xuantie', {
            async provideHover(document, position) {
                if (!client || !client.connected) return null;
                try {
                    const result = await client.request('textDocument/hover', {
                        textDocument: { uri: document.uri.toString() },
                        position: { line: position.line, character: position.character }
                    });
                    if (!result || !result.contents || !result.contents.value) return null;
                    return new vscode.Hover(new vscode.MarkdownString(result.contents.value));
                } catch (e) { return null; }
            }
        }),
        // P3:跳转定义(Ctrl+点击/F12)
        vscode.languages.registerDefinitionProvider('xuantie', {
            async provideDefinition(document, position) {
                if (!client || !client.connected) return null;
                try {
                    const result = await client.request('textDocument/definition', {
                        textDocument: { uri: document.uri.toString() },
                        position: { line: position.line, character: position.character }
                    });
                    if (!result || !result.range) return null;
                    const r = result.range;
                    return new vscode.Location(
                        vscode.Uri.parse(result.uri),
                        new vscode.Range(
                            new vscode.Position(r.start.line, r.start.character),
                            new vscode.Position(r.end.line, r.end.character)));
                } catch (e) { return null; }
            }
        }),
        // P3:文档符号(大纲视图/Ctrl+Shift+O)——LSP SymbolKind 与 vscode.SymbolKind 同编号,直通
        vscode.languages.registerDocumentSymbolProvider('xuantie', {
            async provideDocumentSymbols(document) {
                if (!client || !client.connected) return [];
                try {
                    const result = await client.request('textDocument/documentSymbol', {
                        textDocument: { uri: document.uri.toString() }
                    });
                    return (result || []).map(s => {
                        const r = s.location.range;
                        return new vscode.SymbolInformation(
                            s.name, s.kind, '',
                            new vscode.Location(vscode.Uri.parse(s.location.uri),
                                new vscode.Range(
                                    new vscode.Position(r.start.line, r.start.character),
                                    new vscode.Position(r.end.line, r.end.character))));
                    });
                } catch (e) { return []; }
            }
        })
    );
}

async function deactivateLsp() {
    if (client) { await client.stop(); client = null; }
}

module.exports = { activateLsp, deactivateLsp };
