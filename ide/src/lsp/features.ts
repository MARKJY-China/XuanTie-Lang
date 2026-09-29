// 把 xt_lsp 的能力挂到 Monaco:补全(拼音过滤)/悬停/大纲/诊断/Ctrl+点击与 F12 跳定义
// 服务器能力边界:无 references/rename/formatting/signatureHelp(lsp/xt_lsp.xt 能力声明),
// definition 跳转因此走自定义命令而非 Monaco 内置 provider —— 内置跳转要求目标模型已存在。
import * as monaco from 'monaco-editor';
import { XT_LANGUAGE_ID } from '../lang/xt';
import type { XtLspClient } from './client';
import { withPinyinFilter } from '../pinyin';
import { pathToUri, uriToPath } from '../uri';
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
      triggerCharacters: ['.'],
      async provideCompletionItems(model, position) {
        if (!client.connected) return { suggestions: [] };
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
