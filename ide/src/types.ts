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

// 文件树显示模式(眼睛按钮三态):all=完全显示;dim=仅认准类型原位,其余淡化并整组置树尾;hide=仅认准类型
export type TreeDisplay = 'all' | 'dim' | 'hide';

// 文件编码:标签同时是"按编码保存"接受的取值(与 Rust fsops 的 encode_text 对齐)
export const ENCODINGS: string[] = [
  'UTF-8',
  'UTF-8 BOM',
  'UTF-16 LE',
  'UTF-16 BE',
  'GBK',
  'GB18030',
  'Big5',
  'Shift-JIS',
  'Windows-1252',
];

// 账号(社区账号体系,中枢决策见 ide/NOTES.md):登录后持 xt_session 会话令牌
// loginAt = 本地登录时间戳;IDE 侧 7 天强制过期(服务端会话本为 30 天)
export interface AccountState {
  baseUrl: string;
  cookie: string;
  username: string;
  loginAt: number;
}

// 自定义 AI 提供商(OpenAI 兼容 /v1/chat/completions);官方走社区代理
export interface AiProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 多模态能力(用户自报):图片输入 */
  supportsVision?: boolean;
  /** 多模态能力(用户自报):视频输入 */
  supportsVideo?: boolean;
}

export interface AppSettings {
  lspServerPath: string;
  xtcPath: string;
  tiepmPath: string;
  lastWorkspace: string;
  treeDisplay: TreeDisplay;
  // IDE 编译产物目录(「编译」菜单);留空 = 当前工程文件夹\build
  buildDir: string;
  // 启动时自动检查铁器更新(对比 已装版本 vs 远程索引最新版)
  autoCheckTiepmUpdates: boolean;
  // 智器对话:active = '官方' 或自定义提供商名;thinking = off/low/high
  // agentMode:Agent 审批模式 confirm(变更前确认,默认)/auto-edit(自动编辑)/full-control(完全控制)
  // cmdWhitelist:run_command 免审批白名单(命令行首 token 完全匹配,可选字段,老设置缺省为空)
  // dockWidth:AI 面板宽度(px,拖拽结束持久化,可选字段)
  ai: { providers: AiProvider[]; active: string; thinking: string; agentMode?: string; cmdWhitelist?: string[]; dockWidth?: number };
  account: AccountState;
  // 编辑器外观
  editor: { fontSize: number; fontFamily: string };
  // 整窗显示比例(1 = 100%)
  zoom: number;
  theme: 'dark' | 'light';
  // 界面布局记忆(dock 开关、窗口尺寸)
  ui: { aiDock: boolean; w: number; h: number };
  // 开发者模式:开启后智器对话工具栏出现控制台按钮,实时采集 AI 链路日志
  devMode?: boolean;
  // 已拉取的玄铁文档版本(与服务端 /api/ai/docs/version 比对;不同则启动时自动拉取)
  docsVersion?: string;
}

export function defaultSettings(): AppSettings {
  return {
    lspServerPath: '',
    xtcPath: '',
    tiepmPath: '',
    lastWorkspace: '',
    treeDisplay: 'dim',
    buildDir: '',
    autoCheckTiepmUpdates: false,
    ai: { providers: [], active: '官方', thinking: 'off' },
    account: { baseUrl: 'https://bbs.xt.markjy.com', cookie: '', username: '', loginAt: 0 },
    editor: { fontSize: 14, fontFamily: '' },
    zoom: 1,
    theme: 'dark',
    ui: { aiDock: false, w: 0, h: 0 },
  };
}
