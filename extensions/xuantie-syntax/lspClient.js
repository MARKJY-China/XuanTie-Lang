// lspClient.js — 玄铁 LSP 瘦客户端(零依赖,node net 手卷 LSP/TCP 帧)
// 连接本机回环上的 xt_lsp.exe(玄铁自写 LSP 服务器)。
// P1 能力:诊断同步(didOpen/didChange/didClose → publishDiagnostics)。
const net = require('net');
const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const fs = require('fs');

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
        this.diagCollection.set(vscode.Uri.parse(uri), diags);
    }

    async start() {
        const cfg = vscode.workspace.getConfiguration('xuantie');
        const port = cfg.get('lspPort', 20807);
        // 先尝试直连(用户可能已手动起服务);失败则尝试拉起自带的 xt_lsp.exe
        try {
            await this.connect(port);
        } catch (e) {
            const serverPath = this.findServer();
            if (!serverPath) { console.log('xt_lsp 未找到,跳过 LSP 启动'); return; }
            this.spawned = cp.spawn(serverPath, [], { stdio: 'ignore' });
            this.spawned.on('exit', () => { this.spawned = null; });
            await new Promise(r => setTimeout(r, 800));
            await this.connect(port);
        }
        // 握手
        await this.request('initialize', { capabilities: {}, rootUri: null, processId: process.pid });
        this.notify('initialized', {});
        console.log('xt_lsp 已连接');
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
            this.sock.on('error', err => { this.connected = false; reject(err); });
            this.sock.on('close', () => { this.connected = false; });
        });
    }

    didOpen(doc) {
        const version = (this.docVersions.get(doc.uri.toString()) || 0) + 1;
        this.docVersions.set(doc.uri.toString(), version);
        this.notify('textDocument/didOpen', {
            textDocument: { uri: doc.uri.toString(), languageId: 'xuantie', version, text: doc.getText() }
        });
    }

    didChange(doc) {
        const version = (this.docVersions.get(doc.uri.toString()) || 0) + 1;
        this.docVersions.set(doc.uri.toString(), version);
        // 全量同步(change:1):每次发全文
        this.notify('textDocument/didChange', {
            textDocument: { uri: doc.uri.toString(), version },
            contentChanges: [{ text: doc.getText() }]
        });
    }

    didClose(doc) {
        this.docVersions.delete(doc.uri.toString());
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
        })
    );
}

async function deactivateLsp() {
    if (client) { await client.stop(); client = null; }
}

module.exports = { activateLsp, deactivateLsp };
