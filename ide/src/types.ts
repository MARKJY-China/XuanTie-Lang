// 前后端共享 DTO 与 LSP 子集类型(只声明用到的字段;与 lsp/xt_lsp.xt 实际产出对齐)

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileNode[];
}

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

// xt_lsp 发布的诊断结构(发布诊断, lsp/xt_lsp.xt:62-147):severity 1=错 2=警
export interface DiagnosticDto {
  range: LspRange;
  severity: number;
  source?: string;
  message: string;
}

// xt_lsp 补全项(lsp/xt_lsp.xt:439-581):result 为数组(非 CompletionList)
export interface CompletionItemDto {
  label: string;
  kind?: number;
  detail?: string;
  sortText?: string;
  insertText?: string;
  insertTextFormat?: number; // 2 = snippet($0)
}

export interface HoverDto {
  contents: { kind?: string; value: string };
}

// xt_lsp definition 返回单个 Location(路径转URI 格式,见 uri.ts)
export interface LocationDto {
  uri: string;
  range: LspRange;
}

// xt_lsp documentSymbol 返回 SymbolInformation 数组(lsp/xt_lsp.xt:649-671)
export interface SymbolInfoDto {
  name: string;
  kind: number;
  location: LocationDto;
}

export interface AppSettings {
  lspServerPath: string;
  xtcPath: string;
  tiepmPath: string;
  lastWorkspace: string;
}

export function defaultSettings(): AppSettings {
  return { lspServerPath: '', xtcPath: '', tiepmPath: '', lastWorkspace: '' };
}
