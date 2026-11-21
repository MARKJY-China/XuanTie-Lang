// 把 xt_lsp 的能力挂到 Monaco:补全(拼音过滤)/悬停/大纲/诊断/Ctrl+点击与 F12 跳定义
// 服务器能力边界:无 references/rename/formatting/signatureHelp(lsp/xt_lsp.xt 能力声明),
// definition 跳转因此走自定义命令而非 Monaco 内置 provider —— 内置跳转要求目标模型已存在。
import * as monaco from 'monaco-editor';
import { XT_LANGUAGE_ID } from '../lang/xt';
import type { XtLspClient } from './client';
import { withPinyinFilter } from '../pinyin';
import { pathToUri, uriToPath } from '../uri';
import * as backend from '../backend';
import { dirname } from '../util';
import type { CompletionItemDto, DiagnosticDto, HoverDto, LocationDto, SymbolInfoDto } from '../types';

export interface FeatureHooks {
  openAt(path: string, line: number, column: number): void;
  onDiagnostics(path: string, diags: DiagnosticDto[]): void;
}

function mapCompletionKind(k: number | undefined): monaco.languages.CompletionItemKind {
  switch (k) {
    case 3:
      return monaco.languages.CompletionItemKind.Function;
    case 7:
      return monaco.languages.CompletionItemKind.Class;
    case 6:
      return monaco.languages.CompletionItemKind.Variable;
    case 14:
      return monaco.languages.CompletionItemKind.Keyword;
    case 2:
      return monaco.languages.CompletionItemKind.Method;
    case 9:
      return monaco.languages.CompletionItemKind.Module;
    case 22:
      return monaco.languages.CompletionItemKind.Struct;
    default:
      return monaco.languages.CompletionItemKind.Text;
  }
}

function mapSeverity(s: number): monaco.MarkerSeverity {
  if (s === 1) return monaco.MarkerSeverity.Error;
  if (s === 3) return monaco.MarkerSeverity.Info;
  if (s === 4) return monaco.MarkerSeverity.Hint;
  return monaco.MarkerSeverity.Warning;
}

function modelPath(model: monaco.editor.ITextModel): string {
  return uriToPath(model.uri.toString());
}

// ---- 引 "路径" 文件补全 ----
// 只在双引号字符串内、且该字符串是 引 的第一个实参时触发;LSP 未连接也可用。
// 目录一律插 "/"(玄铁相对路径规范,反斜杠会触发 W006)。
function isAbsoluteFsPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\') || p.startsWith('/');
}

function importPathContext(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): { dir: string; leaf: string; startColumn: number } | null {
  const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
  // 引 前面不能是标识符字符，后面允许空白；捕获当前尚未闭合的路径前缀
  const m = /(?:^|[^\w\u4e00-\u9fff])引\s+"([^"]*)$/.exec(before);
  if (!m) return null;
  const partial = m[1];
  const sep = Math.max(partial.lastIndexOf('/'), partial.lastIndexOf('\\'));
  const dirPart = sep >= 0 ? partial.slice(0, sep + 1) : '';
  const leaf = partial.slice(sep + 1);
  const baseDir = dirname(modelPath(model));
  const dir = dirPart
    ? isAbsoluteFsPath(dirPart)
      ? dirPart
      : baseDir + (baseDir.includes('\\') ? '\\' : '/') + dirPart
    : baseDir;
  return { dir, leaf, startColumn: position.column - leaf.length };
}

const importDirCache = new Map<string, { at: number; names: string[] }>();
const IMPORT_DIR_CACHE_MS = 1500;

async function listImportDir(dir: string): Promise<string[]> {
  const key = dir.toLowerCase();
  const hit = importDirCache.get(key);
  if (hit && Date.now() - hit.at < IMPORT_DIR_CACHE_MS) return hit.names;
  try {
    const names = await backend.fsListDir(dir);
    importDirCache.set(key, { at: Date.now(), names });
    return names;
  } catch {
    return [];
  }
}

// 静态符号兜底:逐行提取顶层 函/型/口/设/常 声明(LSP 不可用或请求失败时,大纲仍然可用)
const SYM_LINE_RE =
  /^\s*(?:(?:公|私|护|覆)\s+)*(?:(异步)\s+)?(函|型|口|设|常)\s+([^\s({=:.]+)/;

function staticSymbols(model: monaco.editor.ITextModel): monaco.languages.DocumentSymbol[] {
  const out: monaco.languages.DocumentSymbol[] = [];
  const lines = model.getLinesContent();
  for (let i = 0; i < lines.length; i++) {
    const m = SYM_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const kindMap: Record<string, monaco.languages.SymbolKind> = {
      函: monaco.languages.SymbolKind.Function,
      型: monaco.languages.SymbolKind.Class,
      口: monaco.languages.SymbolKind.Interface,
      设: monaco.languages.SymbolKind.Variable,
      常: monaco.languages.SymbolKind.Constant,
    };
    const line = i + 1;
    const col = lines[i].indexOf(m[3]) + 1;
    const range = new monaco.Range(line, col, line, col + m[3].length);
    out.push({
      name: m[3],
      detail: m[2] + (m[1] ? '(异步)' : ''),
      kind: kindMap[m[2]] ?? monaco.languages.SymbolKind.Variable,
      range,
      selectionRange: range,
      tags: [],
    });
  }
  return out;
}

export function attachLspFeatures(
  client: XtLspClient,
  editor: monaco.editor.IStandaloneCodeEditor,
  hooks: FeatureHooks,
): { dispose(): void } {
  const disposables: monaco.IDisposable[] = [];

  disposables.push(
    monaco.languages.registerCompletionItemProvider(XT_LANGUAGE_ID, {
      triggerCharacters: ['.', '@', '"'],
      async provideCompletionItems(model, position) {
        if (!client.connected) return { suggestions: [] };
        // 先冲刷防抖中的改动,保证 LSP 能看到刚输入的「.」(否则 数学. 退化成关键字补全)
        client.flushChange(modelPath(model));
        let result: unknown;
        try {
          result = await client.request('textDocument/completion', {
            textDocument: { uri: pathToUri(modelPath(model)) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
        } catch (err) {
          console.error('[补全] LSP completion 失败:', err);
          return { suggestions: [] };
        }
        const items = (Array.isArray(result) ? result : []) as CompletionItemDto[];
        const word = model.getWordUntilPosition(position);
        const startColumn = word.startColumn > 0 ? word.startColumn : position.column;
        const range = new monaco.Range(
          position.lineNumber,
          startColumn,
          position.lineNumber,
          word.endColumn > 0 ? word.endColumn : position.column,
        );
        const suggestions = items.map(
          (it): monaco.languages.CompletionItem => ({
            label: it.label,
            kind: mapCompletionKind(it.kind),
            detail: it.detail,
            sortText: it.sortText,
            filterText: withPinyinFilter(it.label),
            insertText: it.insertText ?? it.label,
            insertTextRules:
              it.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
            range,
          }),
        );
        return { suggestions };
      },
    }),
  );

  // 引 "…" 文件路径补全:目录进目录、.xt 文件直接补全;与 LSP 补全并行存在。
  disposables.push(
    monaco.languages.registerCompletionItemProvider(XT_LANGUAGE_ID, {
      triggerCharacters: ['/', '\\', '"'],
      async provideCompletionItems(model, position, _context, token) {
        const ctx = importPathContext(model, position);
        if (!ctx) return { suggestions: [] };
        const entries = await listImportDir(ctx.dir);
        if (token.isCancellationRequested) return { suggestions: [] };
        const range = new monaco.Range(
          position.lineNumber,
          ctx.startColumn,
          position.lineNumber,
          position.column,
        );
        const suggestions: monaco.languages.CompletionItem[] = [
          {
            label: '../',
            kind: monaco.languages.CompletionItemKind.Folder,
            detail: '上一级目录',
            sortText: '00_..',
            filterText: '../',
            insertText: '../',
            range,
          },
        ];
        for (const raw of entries) {
          const isDir = raw.endsWith('/');
          const name = isDir ? raw.slice(0, -1) : raw;
          if (!name) continue;
          if (!isDir && !/\.xt$/i.test(name)) continue;
          const insertText = isDir ? name + '/' : name;
          suggestions.push({
            label: insertText,
            kind: isDir
              ? monaco.languages.CompletionItemKind.Folder
              : monaco.languages.CompletionItemKind.File,
            detail: isDir ? '目录' : '玄铁模块',
            sortText: (isDir ? '0_' : '1_') + name.toLowerCase(),
            filterText: insertText,
            insertText,
            range,
          });
        }
        return { suggestions };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerHoverProvider(XT_LANGUAGE_ID, {
      async provideHover(model, position) {
        if (!client.connected) return null;
        let result: unknown;
        try {
          result = await client.request('textDocument/hover', {
            textDocument: { uri: pathToUri(modelPath(model)) },
            position: { line: position.lineNumber - 1, character: position.column - 1 },
          });
        } catch (err) {
          console.error('[悬停] LSP hover 失败:', err);
          return null;
        }
        const hover = result as HoverDto | null;
        if (!hover || !hover.contents || !hover.contents.value) return null;
        return { range: undefined, contents: [{ value: hover.contents.value }] };
      },
    }),
  );

  disposables.push(
    monaco.languages.registerDocumentSymbolProvider(XT_LANGUAGE_ID, {
      async provideDocumentSymbols(model) {
        if (client.connected) {
          try {
            const result = await client.request('textDocument/documentSymbol', {
              textDocument: { uri: pathToUri(modelPath(model)) },
            });
            const syms = (Array.isArray(result) ? result : []) as SymbolInfoDto[];
            if (syms.length > 0) {
              return syms.map((s) => {
                const r = s.location.range;
                const range = new monaco.Range(
                  r.start.line + 1,
                  r.start.character + 1,
                  r.end.line + 1,
                  r.end.character + 1,
                );
                // LSP SymbolKind 1 起,monaco.languages.SymbolKind 0 起,数值差 1
                return {
                  name: s.name,
                  detail: '',
                  kind: (s.kind - 1) as monaco.languages.SymbolKind,
                  range,
                  selectionRange: range,
                  tags: [],
                };
              });
            }
          } catch (err) {
            // 报错优于静默:留下线索(Ctrl+Shift+I 可见),同时走静态兜底
            console.error('[符号] LSP documentSymbol 失败,走静态兜底:', err);
          }
        }
        return staticSymbols(model);
      },
    }),
  );

  client.onDiagnostics((path, diags) => {
    const model = monaco.editor.getModel(monaco.Uri.file(path));
    if (model) {
      monaco.editor.setModelMarkers(
        model,
        'xt_lsp',
        diags.map((d) => ({
          startLineNumber: d.range.start.line + 1,
          startColumn: d.range.start.character + 1,
          endLineNumber: d.range.end.line + 1,
          endColumn: Math.max(d.range.end.character + 2, d.range.start.character + 2),
          message: d.message,
          severity: mapSeverity(d.severity),
          source: d.source ?? 'xtc',
        })),
      );
    }
    hooks.onDiagnostics(path, diags);
  });

  async function goToDefinition(): Promise<void> {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos || !client.connected) return;
    let result: unknown;
    try {
      result = await client.request('textDocument/definition', {
        textDocument: { uri: pathToUri(modelPath(model)) },
        position: { line: pos.lineNumber - 1, character: pos.column - 1 },
      });
    } catch {
      return;
    }
    const loc = result as LocationDto | null;
    if (!loc || !loc.range) return;
    hooks.openAt(uriToPath(loc.uri), loc.range.start.line + 1, loc.range.start.character + 1);
  }

  // addCommand 返回命令 id(string|null)而非 IDisposable,不进 disposables
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.F12, goToDefinition);
  disposables.push(
    editor.onMouseDown((e) => {
      if (e.event.leftButton && (e.event.ctrlKey || e.event.metaKey) && e.target.position) {
        void goToDefinition();
      }
    }),
  );

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
    },
  };
}
